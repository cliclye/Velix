/**
 * AgentManager — runs swarm workers as one-shot headless CLI processes.
 *
 * Each worker is a single child process started by the Rust agent runner
 * (src-tauri/src/agent.rs). The runner reports `agent-event`s:
 *   - output: stdout/stderr chunks
 *   - exit:   exactly once, after all output was flushed, with the real exit code,
 *             and flags for timeout / explicit kill
 *
 * `runTask()` returns a Promise that settles on that exit event. There are no
 * readiness regexes, no completion heuristics, and no timers here: the hard timeout
 * lives in Rust, so it still fires if the webview is throttled or reloaded.
 */

import { invoke, listen, type UnlistenFn } from '../../platform/native';
import type { Agent, AgentRole, AgentStatus, WorkerCLI } from './types';
import { buildWorkerInvocation, createStreamParser, type StreamParser } from './workerCli';
import { formatCoordinatorHandoff } from './handoffOutput';

export const DEFAULT_AGENT_TIMEOUT_MS = 20 * 60_000;
export const MAX_MODE_AGENT_TIMEOUT_MS = 45 * 60_000;

const MAX_OUTPUT_CHARS = 400_000;
const MAX_STDERR_CHARS = 60_000;

/** Payload of the Rust `agent-event` (serde tag = "kind", snake_case). */
export type AgentRunnerEvent =
  | { kind: 'output'; run_id: string; stream: 'stdout' | 'stderr'; data: string }
  | {
      kind: 'exit';
      run_id: string;
      exit_code: number | null;
      signal: number | null;
      timed_out: boolean;
      killed: boolean;
      duration_ms: number;
      error: string | null;
    };

export interface AgentRunResult {
  agentId: string;
  status: Extract<AgentStatus, 'completed' | 'failed' | 'terminated'>;
  exitCode: number | null;
  /** Structured handoff (or denoised output) for coordinator consumption. */
  output: string;
  failureReason?: string;
}

export interface RunTaskOptions {
  assignmentId?: string;
  label?: string;
  ownedFiles?: string[];
  timeoutMs?: number;
  attempt?: number;
}

/** Transport seam so the manager can be tested without Tauri. */
export interface AgentTransport {
  spawn(request: {
    runId: string;
    program: string;
    args: string[];
    cwd: string;
    stdin?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<void>;
  kill(runId: string): Promise<void>;
  killAll(): Promise<void>;
  subscribe(handler: (event: AgentRunnerEvent) => void): Promise<UnlistenFn>;
}

export const tauriAgentTransport: AgentTransport = {
  async spawn(request) {
    await invoke('agent_spawn', { request });
  },
  async kill(runId) {
    await invoke('agent_kill', { runId });
  },
  async killAll() {
    await invoke('agent_kill_all');
  },
  subscribe(handler) {
    return listen<AgentRunnerEvent>('agent-event', (event) => handler(event.payload));
  },
};

interface RunState {
  agent: Agent;
  parser: StreamParser | null;
  timeoutMs: number;
  settle: (result: AgentRunResult) => void;
}

const tail = (text: string, max: number) => (text.length > max ? text.slice(text.length - max) : text);

function describeExit(event: Extract<AgentRunnerEvent, { kind: 'exit' }>, stderr: string, timeoutMs?: number): string {
  if (event.error) return event.error;
  if (event.timed_out) {
    const mins = timeoutMs ? Math.round(timeoutMs / 60_000) : null;
    return mins ? `Timed out after ${mins} min` : 'Timed out';
  }
  const lastErr = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' · ');
  const base = event.signal ? `Worker CLI was killed by signal ${event.signal}` : `Worker CLI exited with code ${event.exit_code}`;
  return lastErr ? `${base} — ${lastErr.slice(0, 300)}` : base;
}

export class AgentManager {
  private agents = new Map<string, Agent>();
  private runs = new Map<string, RunState>();
  private runIdToAgentId = new Map<string, string>();
  private listeners = new Set<() => void>();
  private unlisten: UnlistenFn | null = null;
  private initPromise: Promise<void> | null = null;
  private workerCLI: WorkerCLI = 'claude';
  private workerModel = '';
  private envForRun: () => Promise<Record<string, string>> = async () => ({});
  private counter = 0;

  constructor(
    private workspacePath: string,
    private transport: AgentTransport = tauriAgentTransport,
  ) {}

  setWorkerCLI(cli: WorkerCLI): void { this.workerCLI = cli; }
  getWorkerCLI(): WorkerCLI { return this.workerCLI; }
  setWorkerModel(model: string): void { this.workerModel = model; }
  /** Provide per-run environment (e.g. API keys) lazily, so keys are read at spawn time. */
  setEnvProvider(provider: () => Promise<Record<string, string>>): void { this.envForRun = provider; }

  /** Subscribe to any agent change (output, status). Returns unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const l of this.listeners) {
      try { l(); } catch (err) { console.error('AgentManager listener error:', err); }
    }
  }

  /** Register the global event listener. Idempotent. */
  initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.transport.subscribe((event) => this.handleEvent(event)).then((un) => {
        this.unlisten = un;
      }).catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  async dispose(): Promise<void> {
    await this.terminateAll('Agent manager disposed');
    this.unlisten?.();
    this.unlisten = null;
    this.initPromise = null;
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private handleEvent(event: AgentRunnerEvent): void {
    const run = this.runs.get(event.run_id);
    if (!run) return;
    const { agent } = run;

    if (event.kind === 'output') {
      agent.lastActivityAt = new Date();
      if (event.stream === 'stderr') {
        agent.stderr = tail(agent.stderr + event.data, MAX_STDERR_CHARS);
      } else if (run.parser) {
        run.parser.push(event.data);
        this.syncFromParser(agent, run.parser);
        agent.output = tail(agent.output + event.data, MAX_OUTPUT_CHARS);
      } else {
        agent.output = tail(agent.output + event.data, MAX_OUTPUT_CHARS);
      }
      this.notify();
      return;
    }

    // exit
    run.parser?.end();
    if (run.parser) this.syncFromParser(agent, run.parser);
    agent.endedAt = new Date();
    agent.exitCode = event.exit_code;

    const parsed = run.parser?.snapshot();
    const streamFailed = parsed?.isError === true;
    const cleanExit = !event.error && !event.timed_out && !event.killed && event.exit_code === 0 && !streamFailed;

    if (agent.status === 'terminated' || event.killed) {
      agent.status = 'terminated';
      agent.failureReason ||= 'Stopped by user';
    } else if (cleanExit) {
      agent.status = 'completed';
    } else {
      agent.status = 'failed';
      agent.failureReason = streamFailed && parsed?.finalText
        ? parsed.finalText.slice(0, 300)
        : describeExit(event, agent.stderr, run.timeoutMs);
    }

    agent.result = this.handoffText(agent);
    this.runs.delete(event.run_id);
    this.runIdToAgentId.delete(event.run_id);
    this.notify();
    run.settle(this.resultFor(agent));
  }

  private syncFromParser(agent: Agent, parser: StreamParser): void {
    const snap = parser.snapshot();
    agent.activity = snap.activity;
    agent.filesTouched = snap.filesTouched;
    if (snap.costUsd !== undefined) agent.costUsd = snap.costUsd;
  }

  /** Text handed to downstream agents / the coordinator. */
  private handoffText(agent: Agent): string {
    const parsed = agent.output ? this.parsedText(agent) : '';
    const text = parsed || agent.output;
    return formatCoordinatorHandoff(text, agent.role.type);
  }

  private parsedText(agent: Agent): string {
    // Re-derive from raw stream-json so the final `result` text wins over partial narration.
    if (!agent.output.includes('"type":')) return '';
    const parser = createStreamParser();
    parser.push(agent.output);
    parser.end();
    const snap = parser.snapshot();
    return snap.finalText ?? snap.assistantText;
  }

  private resultFor(agent: Agent): AgentRunResult {
    const status: AgentRunResult['status'] =
      agent.status === 'completed' ? 'completed' : agent.status === 'terminated' ? 'terminated' : 'failed';
    return {
      agentId: agent.id,
      status,
      exitCode: agent.exitCode ?? null,
      output: this.handoffText(agent),
      failureReason: agent.failureReason,
    };
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  private buildPrompt(role: AgentRole, task: string): string {
    return [
      role.systemPrompt,
      '',
      `Working Directory: ${this.workspacePath}`,
      `Role: ${role.name}`,
      `Capabilities: ${role.capabilities.join(', ')}`,
      `Restrictions: ${role.restrictions.join(', ')}`,
      '',
      role.initialPrompt,
      '',
      `Task: ${task}`,
    ].join('\n');
  }

  /**
   * Start a worker and resolve when it finishes (exit, timeout, or termination).
   * Never rejects: spawn failures resolve as `failed` with a readable reason.
   */
  async runTask(role: AgentRole, task: string, options: RunTaskOptions = {}): Promise<AgentRunResult> {
    await this.initialize();

    const id = `agent_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
    const runId = `swarm_${id}`;
    const agent: Agent = {
      id,
      role,
      runId,
      assignmentId: options.assignmentId,
      label: options.label,
      ownedFiles: options.ownedFiles ?? [],
      status: 'initializing',
      assignedTask: task,
      attempt: options.attempt ?? 1,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      output: '',
      stderr: '',
      activity: [],
      filesTouched: [],
    };
    this.agents.set(id, agent);
    this.notify();

    const invocation = buildWorkerInvocation(this.workerCLI, this.buildPrompt(role, task), this.workerModel);
    const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

    return new Promise<AgentRunResult>((resolve) => {
      const state: RunState = {
        agent,
        parser: invocation.streamJson ? createStreamParser() : null,
        timeoutMs,
        settle: resolve,
      };
      this.runs.set(runId, state);
      this.runIdToAgentId.set(runId, id);

      // Status can change while we await (a stop request); a function defeats TS narrowing.
      const stopRequested = () => agent.status === 'terminated';

      void (async () => {
        try {
          const env = await this.envForRun();
          // Honour a stop request that arrived while we were preparing.
          if (stopRequested()) {
            this.finishWithoutProcess(runId, 'terminated', 'Stopped before start');
            return;
          }
          agent.status = 'running';
          this.notify();
          await this.transport.spawn({
            runId,
            program: invocation.program,
            args: invocation.args,
            cwd: this.workspacePath,
            stdin: invocation.stdin,
            env,
            timeoutMs,
          });
          // A stop that raced the spawn: the process exists now, so kill it.
          if (stopRequested()) await this.transport.kill(runId).catch(() => {});
        } catch (err) {
          this.finishWithoutProcess(runId, 'failed', err instanceof Error ? err.message : String(err));
        }
      })();
    });
  }

  private finishWithoutProcess(runId: string, status: 'failed' | 'terminated', reason: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.agent.status = status;
    run.agent.failureReason = reason;
    run.agent.endedAt = new Date();
    run.agent.result = this.handoffText(run.agent);
    this.runs.delete(runId);
    this.runIdToAgentId.delete(runId);
    this.notify();
    run.settle(this.resultFor(run.agent));
  }

  // -------------------------------------------------------------------------
  // Termination
  // -------------------------------------------------------------------------

  async terminateAgent(agentId: string, reason = 'Stopped by user'): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || (agent.status !== 'running' && agent.status !== 'initializing')) return;
    const wasRunning = agent.status === 'running';
    agent.status = 'terminated';
    agent.failureReason = reason;
    this.notify();
    if (wasRunning) {
      // The Rust side delivers SIGTERM→SIGKILL and then the exit event settles the run.
      try {
        await this.transport.kill(agent.runId);
      } catch (err) {
        console.error(`AgentManager: kill failed for ${agentId}:`, err);
        this.finishWithoutProcess(agent.runId, 'terminated', reason);
      }
    } else {
      this.finishWithoutProcess(agent.runId, 'terminated', reason);
    }
  }

  async terminateAll(reason = 'Swarm stopped'): Promise<void> {
    const live = this.getAllAgents().filter((a) => a.status === 'running' || a.status === 'initializing');
    await Promise.all(live.map((a) => this.terminateAgent(a.id, reason)));
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getAgent(agentId: string): Agent | null { return this.agents.get(agentId) ?? null; }
  getAllAgents(): Agent[] { return [...this.agents.values()]; }

  /** Latest attempt per assignment (what the UI shows on the board). */
  getLatestAgents(): Agent[] {
    const latest = new Map<string, Agent>();
    for (const a of this.agents.values()) {
      const key = a.assignmentId ?? a.id;
      const prev = latest.get(key);
      if (!prev || a.attempt >= prev.attempt) latest.set(key, a);
    }
    return [...latest.values()];
  }

  getActiveAgentCount(): number {
    return this.getAllAgents().filter((a) => a.status === 'running' || a.status === 'initializing').length;
  }

  clearFinished(): void {
    for (const [id, a] of this.agents) {
      if (a.status !== 'running' && a.status !== 'initializing') this.agents.delete(id);
    }
    this.notify();
  }
}
