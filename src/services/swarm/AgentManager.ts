/**
 * AgentManager — one-shot headless worker execution engine.
 *
 * Design (rebuilt from the ground up):
 *   Every agent is a single non-interactive CLI run inside a PTY:
 *
 *     <cli> <headless flags> "$(cat promptfile)" ; exit $?
 *
 *   - The prompt is written to a file BEFORE the PTY exists (no delivery races).
 *   - The command is written to the PTY immediately after creation; the login
 *     shell executes it as soon as it boots (tty input is kernel-buffered).
 *   - The CLI runs headless (print/exec mode), streams output, and EXITS when
 *     done. `exit $?` closes the shell, so `pty-exit` is the completion signal
 *     and carries a real exit code.
 *
 *   There are NO readiness regexes, NO completion-marker polling, NO /exit
 *   escalation, and NO delivery timers. The only failsafe is a hard per-agent
 *   timeout. `runTask()` returns a Promise that resolves on exit — the swarm
 *   loop is plain async/await.
 */

import { invoke, listen, type UnlistenFn, writeTextFile, remove } from '../../platform/native';
import {
  Agent,
  AgentRole,
  AgentStatus,
  AgentMetrics,
  PatternMatch,
  WorkerCLI,
} from './types';
import { SwarmEventEmitter } from './SwarmEventEmitter';
import { aiService } from '../ai/AIService';
import { formatCoordinatorHandoff, getRawAgentOutput } from './handoffOutput';

// ---------------------------------------------------------------------------
// Payload parsing — Tauri emits snake_case; tolerate camelCase if serialization changes
// ---------------------------------------------------------------------------

function parsePtyOutputPayload(payload: unknown): { sessionId: string; data: string } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const sid = p.session_id ?? p.sessionId;
  const data = p.data;
  if (typeof sid !== 'string' || typeof data !== 'string') return null;
  return { sessionId: sid, data };
}

function parsePtyExitPayload(
  payload: unknown,
): { sessionId: string; exitCode: number | null } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const sid = p.session_id ?? p.sessionId;
  if (typeof sid !== 'string') return null;
  const raw = p.exit_code ?? p.exitCode;
  let exitCode: number | null = null;
  if (typeof raw === 'number' && !Number.isNaN(raw)) {
    exitCode = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (!Number.isNaN(n)) exitCode = n;
  }
  return { sessionId: sid, exitCode };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BUFFER = 500;
const MAX_TERMINAL_OUTPUT_CHARS = 250_000;

/** Hard per-agent runtime cap. Headless CLIs can be quiet for long stretches
 *  (print mode emits at the end), so this is the ONLY failsafe — never kill on
 *  output inactivity. */
export const DEFAULT_AGENT_TIMEOUT_MS = 20 * 60_000;
export const MAX_MODE_AGENT_TIMEOUT_MS = 45 * 60_000;

// ---------------------------------------------------------------------------
// ANSI sanitizer
// ---------------------------------------------------------------------------

const ANSI_ESCAPE_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g;

const sanitizeChunk = (data: string): string =>
  data
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');

// ---------------------------------------------------------------------------
// Shell quoting
// ---------------------------------------------------------------------------

/** POSIX-safe single-quote wrapping: ' → '"'"' */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------
// Worker CLI configuration (options, detection, persistence)
// ---------------------------------------------------------------------------

export interface WorkerCLIOption {
  id: WorkerCLI;
  name: string;
  command: string;
  description: string;
  builtin?: boolean;
}

const BUILTIN_CLI_OPTIONS: WorkerCLIOption[] = [
  { id: 'claude',  name: 'Claude Code', command: 'claude',  description: 'Anthropic Claude Code CLI', builtin: true },
  { id: 'gemini',  name: 'Gemini CLI',  command: 'gemini',  description: 'Google Gemini terminal agent', builtin: true },
  { id: 'velix',   name: 'Velix CLI',   command: 'velix',   description: 'Velix AI CLI', builtin: true },
  { id: 'codex',   name: 'Codex CLI',   command: 'codex',   description: 'OpenAI Codex CLI', builtin: true },
  { id: 'copilot', name: 'Copilot CLI', command: 'copilot', description: 'GitHub Copilot CLI', builtin: true },
];

const CUSTOM_CLI_STORAGE_KEY = 'velix-custom-cli-options';

export function loadCustomCLIOptions(): WorkerCLIOption[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_CLI_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as WorkerCLIOption[];
  } catch {
    return [];
  }
}

export function saveCustomCLIOptions(options: WorkerCLIOption[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CUSTOM_CLI_STORAGE_KEY, JSON.stringify(options));
}

export function getWorkerCLIOptions(): WorkerCLIOption[] {
  return [...BUILTIN_CLI_OPTIONS, ...loadCustomCLIOptions()];
}

/** @deprecated Use getWorkerCLIOptions() instead — kept for import compatibility */
export const WORKER_CLI_OPTIONS = BUILTIN_CLI_OPTIONS;

export interface WorkerCLIStatus {
  available: boolean;
  detail: string;
}

export async function detectWorkerCLIAvailability(
  _cwd: string,
): Promise<Record<WorkerCLI, WorkerCLIStatus>> {
  const allOptions = getWorkerCLIOptions();
  const entries = await Promise.all(
    allOptions.map(async (option) => {
      try {
        const path = await invoke<string>('check_cli_available', { command: option.command });
        return [option.id, { available: true, detail: path }] as const;
      } catch {
        return [option.id, { available: false, detail: 'Not found in PATH' }] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Record<WorkerCLI, WorkerCLIStatus>;
}

/**
 * Build the one-shot headless command for a worker CLI.
 * `promptArg` is the shell expression that yields the prompt text
 * (either `"$(cat 'file')"` or an inline quoted string).
 */
export function buildHeadlessCommand(
  workerCLI: WorkerCLI,
  promptArg: string,
  model?: { provider: string; model: string },
): string {
  const allOptions = getWorkerCLIOptions();
  const cliOption = allOptions.find((o) => o.id === workerCLI);
  const parts: string[] = [];

  switch (workerCLI) {
    case 'claude':
      parts.push('claude', '--dangerously-skip-permissions', '-p', promptArg);
      if (model?.provider === 'claude' && model.model) parts.push('--model', shQuote(model.model));
      break;
    case 'gemini':
      parts.push('gemini', '--yolo', '-p', promptArg);
      if (model?.provider === 'gemini' && model.model) parts.push('-m', shQuote(model.model));
      break;
    case 'codex':
      parts.push('codex', 'exec', '--full-auto', promptArg);
      if (model?.provider === 'chatgpt' && model.model) parts.push('-m', shQuote(model.model));
      break;
    case 'copilot':
      parts.push('copilot', '-p', promptArg, '--allow-all-tools');
      break;
    case 'velix':
      parts.push('velix', '-p', promptArg);
      break;
    default:
      parts.push(cliOption ? cliOption.command : 'claude --dangerously-skip-permissions', '-p', promptArg);
      break;
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  agentId: string;
  status: Extract<AgentStatus, 'completed' | 'failed' | 'terminated'>;
  exitCode: number | null;
  /** Structured handoff (or denoised output) for coordinator consumption. */
  output: string;
  failureReason?: string;
}

interface RunHandle {
  resolve: (result: AgentRunResult) => void;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// AgentManager
// ---------------------------------------------------------------------------

export class AgentManager {
  private agents: Map<string, Agent> = new Map();
  private eventEmitter: SwarmEventEmitter;
  private workspacePath: string;
  private workerCLI: WorkerCLI = 'claude';

  private globalOutputListener: UnlistenFn | null = null;
  private globalExitListener: UnlistenFn | null = null;
  private outputCallbacks: Array<(agentId: string, data: string) => void> = [];
  private exitCallbacks: Array<(agentId: string, exitCode: number | null) => void> = [];
  private spawnCallbacks: Array<(agentId: string) => void> = [];
  private patternDetector: ((output: string) => PatternMatch | null) | null = null;

  /** Serialize PTY output handling per agent so chunks never interleave. */
  private outputProcessing = new Map<string, Promise<void>>();
  /** Dedup rapid prompt_detected events for the same pattern on one agent. */
  private lastPromptMatch = new Map<string, string>();
  /** Pending run promises keyed by agentId — resolved exactly once on exit. */
  private runHandles = new Map<string, RunHandle>();

  private initPromise: Promise<void> | null = null;

  constructor(eventEmitter: SwarmEventEmitter, workspacePath: string) {
    this.eventEmitter = eventEmitter;
    this.workspacePath = workspacePath;
  }

  setWorkerCLI(workerCLI: WorkerCLI): void { this.workerCLI = workerCLI; }
  getWorkerCLI(): WorkerCLI { return this.workerCLI; }

  setPatternDetector(detector: (output: string) => PatternMatch | null): void {
    this.patternDetector = detector;
  }

  // -----------------------------------------------------------------------
  // Initialization — global PTY event listeners (idempotent)
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.globalOutputListener = await listen<unknown>('pty-output', (event) => {
        const parsed = parsePtyOutputPayload(event.payload);
        if (!parsed) return;
        const agent = this.findAgentBySessionId(parsed.sessionId);
        if (agent) {
          this.enqueueAgentOutput(agent.id, parsed.data);
        }
      });

      this.globalExitListener = await listen<unknown>('pty-exit', (event) => {
        const parsed = parsePtyExitPayload(event.payload);
        if (!parsed) return;
        const agent = this.findAgentBySessionId(parsed.sessionId);
        if (agent) {
          void this.finalizeAgentExit(agent.id, parsed.exitCode).catch((err) => {
            console.error(`AgentManager: finalize exit failed for ${agent.id}:`, err);
          });
        }
      });
    })();

    return this.initPromise;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  async cleanup(): Promise<void> {
    if (this.agents.size > 0) {
      await this.terminateAll('Agent manager cleanup');
    }

    this.initPromise = null;
    if (this.globalOutputListener) { this.globalOutputListener(); this.globalOutputListener = null; }
    if (this.globalExitListener)   { this.globalExitListener();   this.globalExitListener = null; }
    this.agents.clear();
    this.outputProcessing.clear();
    this.lastPromptMatch.clear();
    for (const handle of this.runHandles.values()) {
      if (handle.timeoutTimer) clearTimeout(handle.timeoutTimer);
    }
    this.runHandles.clear();
    this.outputCallbacks.length = 0;
    this.exitCallbacks.length = 0;
    this.spawnCallbacks.length = 0;
  }

  private findAgentBySessionId(sessionId: string): Agent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.sessionId === sessionId) return agent;
    }
    return undefined;
  }

  // -----------------------------------------------------------------------
  // Output handling — serialized per agent
  // -----------------------------------------------------------------------

  private enqueueAgentOutput(agentId: string, data: string): void {
    const prev = this.outputProcessing.get(agentId) ?? Promise.resolve();
    const next = prev
      .then(() => this.handleAgentOutput(agentId, data))
      .catch((err) => {
        console.error('AgentManager: output handler error:', err);
      });
    this.outputProcessing.set(agentId, next);
    void next.finally(() => {
      if (this.outputProcessing.get(agentId) === next) {
        this.outputProcessing.delete(agentId);
      }
    });
  }

  private async handleAgentOutput(agentId: string, data: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.lastActivityAt = new Date();
    const combined = agent.terminalOutput + data;
    if (combined.length > MAX_TERMINAL_OUTPUT_CHARS) {
      agent.terminalOutputEpoch = (agent.terminalOutputEpoch ?? 0) + 1;
    }
    agent.terminalOutput = combined.slice(-MAX_TERMINAL_OUTPUT_CHARS);

    const sanitized = sanitizeChunk(data);

    const lines = sanitized.split('\n').map((line) => line.trimEnd());
    agent.outputBuffer.push(...lines);
    if (agent.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      agent.outputBuffer = agent.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }

    this.eventEmitter.emitAgentEvent({ type: 'output', agentId, data: sanitized });

    if (this.patternDetector) {
      const match = this.patternDetector(sanitized);
      if (match) {
        const dedupKey = `${match.patternId}:${match.matchedText}`;
        if (this.lastPromptMatch.get(agentId) !== dedupKey) {
          this.lastPromptMatch.set(agentId, dedupKey);
          agent.metrics.promptsProcessed++;
          this.eventEmitter.emitAgentEvent({ type: 'prompt_detected', agentId, match });
        }
      }
    }

    for (const cb of this.outputCallbacks) {
      try { cb(agentId, sanitized); } catch (err) { console.error('AgentManager: output callback error:', err); }
    }
  }

  // -----------------------------------------------------------------------
  // Exit handling — the one true completion signal
  // -----------------------------------------------------------------------

  private async drainAgentOutput(agentId: string): Promise<void> {
    const pending = this.outputProcessing.get(agentId);
    if (pending) {
      await pending;
    }
  }

  private async finalizeAgentExit(agentId: string, exitCode: number | null): Promise<void> {
    // Ensure the last output chunk is folded into terminalOutput before handoff.
    await this.drainAgentOutput(agentId);

    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (agent.status === 'terminated') {
      this.settleRun(agentId, {
        agentId,
        status: 'terminated',
        exitCode,
        output: this.getAgentHandoffOutput(agentId),
        failureReason: agent.failureReason,
      });
      return;
    }

    const handle = this.runHandles.get(agentId);
    const aliveMs = Date.now() - agent.startedAt.getTime();
    console.log(
      `AgentManager: pty-exit for ${agentId} | exitCode=${exitCode} aliveMs=${aliveMs} label=${agent.label}`,
    );

    this.lastPromptMatch.delete(agentId);

    if (agent.promptFilePath) {
      remove(agent.promptFilePath).catch(() => {});
    }

    const code = exitCode ?? 0;
    const timedOut = handle?.timedOut === true;
    agent.status = code === 0 && !timedOut ? 'completed' : 'failed';

    if (agent.status === 'failed') {
      const aliveStr = aliveMs < 1000 ? `${aliveMs}ms` : `${(aliveMs / 1000).toFixed(1)}s`;
      agent.failureReason = timedOut
        ? `Agent timed out after ${aliveStr}`
        : `Worker CLI exited with code ${code} after ${aliveStr}`;
    }

    const output = this.getAgentHandoffOutput(agentId);

    if (agent.status === 'completed') {
      this.eventEmitter.emitAgentEvent({
        type: 'completed',
        agentId,
        result: {
          id: `result_${agentId}`,
          agentId,
          role: agent.role.type,
          description: agent.assignedTask,
          status: 'completed',
          startedAt: agent.startedAt,
          completedAt: new Date(),
          output,
          filesModified: agent.metrics.filesModified,
        },
      });
    } else {
      this.eventEmitter.emitAgentEvent({
        type: 'failed',
        agentId,
        error: agent.failureReason || `Agent exited with code ${code}`,
      });
    }

    this.settleRun(agentId, {
      agentId,
      status: agent.status,
      exitCode,
      output,
      failureReason: agent.failureReason,
    });

    for (const cb of this.exitCallbacks) {
      try { cb(agentId, code); } catch (err) { console.error('AgentManager: exit callback error:', err); }
    }
  }

  private settleRun(agentId: string, result: AgentRunResult): void {
    const handle = this.runHandles.get(agentId);
    if (!handle) return;
    this.runHandles.delete(agentId);
    if (handle.timeoutTimer) clearTimeout(handle.timeoutTimer);
    handle.resolve(result);
  }

  // -----------------------------------------------------------------------
  // Spawn — one-shot headless run
  // -----------------------------------------------------------------------

  async spawnAgent(
    role: AgentRole,
    task: string,
    options?: {
      assignmentId?: string;
      label?: string;
      ownedFiles?: string[];
      timeoutMs?: number;
    },
  ): Promise<Agent> {
    const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const sessionId = `swarm_${agentId}`;

    // ── Step 1: Write the prompt file BEFORE creating the PTY ──────────
    const prompt = this.buildPrompt(role, task);
    const promptFileName = `.velix_swarm_prompt_${agentId}.txt`;
    const promptFilePath = `${this.workspacePath}/${promptFileName}`;

    let promptArg: string;
    let promptFileOk = false;
    try {
      await writeTextFile(promptFilePath, prompt);
      promptFileOk = true;
      promptArg = `"$(cat ${shQuote(promptFileName)})"`;
    } catch (err) {
      console.warn(`AgentManager: prompt file write failed for ${agentId}, embedding inline:`, err);
      promptArg = shQuote(prompt);
    }

    // ── Step 2: Build the one-shot command ─────────────────────────────
    const config = aiService.getConfig();
    const cliCommand = buildHeadlessCommand(this.workerCLI, promptArg, config);
    // `exit $?` propagates the CLI exit code through the shell → pty-exit.
    const oneShot = `set +e 2>/dev/null; clear 2>/dev/null; ${cliCommand}; exit $?\r`;

    // ── Step 3: Create PTY and write the command immediately ───────────
    // Input is kernel-buffered; the login shell executes it once booted.
    await invoke('pty_create', {
      sessionId,
      rows: 50,
      cols: 220,
      cwd: this.workspacePath,
    });

    const agent: Agent = {
      id: agentId,
      role,
      sessionId,
      assignmentId: options?.assignmentId,
      label: options?.label,
      ownedFiles: options?.ownedFiles || [],
      status: 'running',
      assignedTask: task,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      outputBuffer: [],
      terminalOutput: '',
      terminalOutputEpoch: 0,
      metrics: {
        promptsProcessed: 0,
        filesModified: [],
        testsRun: 0,
        errorsEncountered: 0,
        autoApprovals: 0,
        escalations: 0,
      },
      promptFilePath: promptFileOk ? promptFilePath : undefined,
      promptFileWritten: promptFileOk,
      // One-shot mode: the command carries the prompt, so both are true at spawn.
      cliLaunched: true,
      promptDelivered: true,
    };

    this.agents.set(agentId, agent);

    try {
      await invoke('pty_write', { sessionId, data: oneShot });
    } catch (err) {
      console.error(`AgentManager: failed to write one-shot command for ${agentId}:`, err);
      agent.status = 'failed';
      agent.failureReason = `Failed to start worker CLI: ${err}`;
      void invoke('pty_kill', { sessionId }).catch(() => {});
    }

    console.log(
      `AgentManager: spawned one-shot ${agentId} (cli=${this.workerCLI}, session=${sessionId}, promptFile=${promptFileOk})`,
    );

    this.eventEmitter.emitAgentEvent({ type: 'spawned', agentId, role: role.type });

    for (const cb of this.spawnCallbacks) {
      try { cb(agentId); } catch { /* ignore */ }
    }

    return agent;
  }

  /**
   * Spawn an agent and resolve when it finishes (exit, timeout, or termination).
   * This is the primary API for the swarm loop — no event-listener bookkeeping.
   */
  async runTask(
    role: AgentRole,
    task: string,
    options?: {
      assignmentId?: string;
      label?: string;
      ownedFiles?: string[];
      timeoutMs?: number;
    },
  ): Promise<AgentRunResult> {
    const agent = await this.spawnAgent(role, task, options);

    // The agent may already be settled if the shell died during spawn.
    if (agent.status !== 'running') {
      return {
        agentId: agent.id,
        status: agent.status === 'completed' ? 'completed' : agent.status === 'terminated' ? 'terminated' : 'failed',
        exitCode: null,
        output: this.getAgentHandoffOutput(agent.id),
        failureReason: agent.failureReason,
      };
    }

    const timeoutMs = options?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;

    return new Promise<AgentRunResult>((resolve) => {
      const handle: RunHandle = { resolve, timeoutTimer: null, timedOut: false };

      handle.timeoutTimer = setTimeout(() => {
        handle.timedOut = true;
        const a = this.agents.get(agent.id);
        if (!a || a.status !== 'running') return;
        console.warn(`AgentManager: ${agent.id} hit ${timeoutMs}ms timeout — killing PTY`);
        void invoke('pty_kill', { sessionId: a.sessionId }).catch(() => {
          // If the kill fails, resolve directly so the swarm never hangs.
          a.status = 'failed';
          a.failureReason = `Agent timed out after ${Math.round(timeoutMs / 1000)}s (kill failed)`;
          this.settleRun(agent.id, {
            agentId: agent.id,
            status: 'failed',
            exitCode: null,
            output: this.getAgentHandoffOutput(agent.id),
            failureReason: a.failureReason,
          });
        });
      }, timeoutMs);

      this.runHandles.set(agent.id, handle);
    });
  }

  // -----------------------------------------------------------------------
  // Prompt builder
  // -----------------------------------------------------------------------

  private buildPrompt(role: AgentRole, task: string): string {
    const contextInfo = `
Working Directory: ${this.workspacePath}
Role: ${role.name}
Capabilities: ${role.capabilities.join(', ')}
Restrictions: ${role.restrictions.join(', ')}
`;
    return `${role.systemPrompt}\n\n${contextInfo}\n\n${role.initialPrompt}\n\nTask: ${task}`;
  }

  // -----------------------------------------------------------------------
  // Agent interaction
  // -----------------------------------------------------------------------

  async sendToAgent(agentId: string, data: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    await invoke('pty_write', { sessionId: agent.sessionId, data });
  }

  async respondToAgent(agentId: string, response: string): Promise<void> {
    await this.sendToAgent(agentId, `${response}\r`);
  }

  // -----------------------------------------------------------------------
  // Termination
  // -----------------------------------------------------------------------

  async terminateAgent(agentId: string, reason: string = 'User terminated'): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const wasRunning = agent.status === 'running';
    agent.status = 'terminated';
    agent.failureReason = reason;
    this.lastPromptMatch.delete(agentId);

    if (agent.promptFilePath) {
      remove(agent.promptFilePath).catch(() => {});
    }

    if (wasRunning) {
      try {
        await invoke('pty_kill', { sessionId: agent.sessionId });
      } catch (err) {
        console.error(`Failed to terminate agent ${agentId}:`, err);
      }
    }

    // pty_kill drops the session without emitting pty-exit for an already-dead
    // reader, so settle the run promise here to guarantee the loop continues.
    this.settleRun(agentId, {
      agentId,
      status: 'terminated',
      exitCode: null,
      output: this.getAgentHandoffOutput(agentId),
      failureReason: reason,
    });

    this.eventEmitter.emitAgentEvent({ type: 'terminated', agentId, reason });

    for (const cb of this.exitCallbacks) {
      try { cb(agentId, null); } catch (err) { console.error('AgentManager: exit callback error:', err); }
    }

    this.agents.delete(agentId);
  }

  async terminateAll(reason: string = 'Swarm stopped'): Promise<void> {
    const ids = Array.from(this.agents.keys());
    await Promise.all(ids.map((id) => this.terminateAgent(id, reason)));
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  getAgent(agentId: string): Agent | null {
    return this.agents.get(agentId) || null;
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  getAgentsByRole(roleType: string): Agent[] {
    return Array.from(this.agents.values()).filter((a) => a.role.type === roleType);
  }

  getAgentCount(): number { return this.agents.size; }

  getActiveAgentCount(): number {
    return Array.from(this.agents.values()).filter(
      (a) => a.status === 'running' || a.status === 'waiting_for_input',
    ).length;
  }

  getAgentOutput(agentId: string): string[] {
    const agent = this.agents.get(agentId);
    return agent ? [...agent.outputBuffer] : [];
  }

  /** Structured handoff (or denoised full output) for coordinator consumption. */
  getAgentHandoffOutput(agentId: string): string {
    const agent = this.agents.get(agentId);
    if (!agent) return '';
    return formatCoordinatorHandoff(getRawAgentOutput(agent), agent.role.type);
  }

  // -----------------------------------------------------------------------
  // Subscriptions
  // -----------------------------------------------------------------------

  onAgentOutput(callback: (agentId: string, data: string) => void): () => void {
    this.outputCallbacks.push(callback);
    return () => {
      const i = this.outputCallbacks.indexOf(callback);
      if (i !== -1) this.outputCallbacks.splice(i, 1);
    };
  }

  onAgentExit(callback: (agentId: string, exitCode: number | null) => void): () => void {
    this.exitCallbacks.push(callback);
    return () => {
      const i = this.exitCallbacks.indexOf(callback);
      if (i !== -1) this.exitCallbacks.splice(i, 1);
    };
  }

  onAgentSpawned(callback: (agentId: string) => void): () => void {
    this.spawnCallbacks.push(callback);
    return () => {
      const i = this.spawnCallbacks.indexOf(callback);
      if (i !== -1) this.spawnCallbacks.splice(i, 1);
    };
  }

  // -----------------------------------------------------------------------
  // Metrics helpers
  // -----------------------------------------------------------------------

  updateAgentMetrics(agentId: string, updates: Partial<AgentMetrics>): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.metrics = { ...agent.metrics, ...updates };
  }

  updateAgentStatus(agentId: string, status: AgentStatus): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.status = status;
  }

  getStalledAgents(thresholdMs: number = 60000): Agent[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter((a) => {
      if (a.status !== 'running') return false;
      return now - a.lastActivityAt.getTime() > thresholdMs;
    });
  }

  getAgentHealth(agentId: string): {
    status: 'healthy' | 'stalled' | 'erroring' | 'completed';
    lastActivity: Date;
    errorRate: number;
  } | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const timeSinceActivity = Date.now() - agent.lastActivityAt.getTime();
    const errorRate = agent.metrics.errorsEncountered / Math.max(agent.metrics.promptsProcessed, 1);
    let status: 'healthy' | 'stalled' | 'erroring' | 'completed' = 'healthy';
    if (agent.status === 'completed' || agent.status === 'failed') status = 'completed';
    else if (timeSinceActivity > 60000) status = 'stalled';
    else if (errorRate > 0.5) status = 'erroring';
    return { status, lastActivity: agent.lastActivityAt, errorRate };
  }
}
