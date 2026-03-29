/**
 * AgentManager — spawns worker CLI agents in PTYs, delivers swarm prompts, and streams output.
 * Supports any configured worker CLI (Claude Code, Gemini CLI, Codex, Copilot, Velix, custom).
 *
 * Lifecycle per agent:
 *   spawning  →  launching_cli  →  working  →  (exit)
 *
 * Each transition is guarded by checking the current phase. Timers and output-driven
 * detection both call the same idempotent transition functions, so concurrent triggers
 * are harmless — the first one wins, the rest are no-ops.
 *
 * Timers are plain setTimeout (never stored/cancelled). They simply check the phase
 * when they fire and bail if the agent has already moved past the expected phase.
 * This eliminates the entire category of bugs where timers get cancelled too early
 * by exit events or other state cleanup.
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
const READY_ACCUMULATOR_MAX_CHARS = 2000;

/**
 * How long to wait after PTY creation before writing the CLI launch command.
 * This gives the login shell time to source profiles and display a prompt.
 * Output-driven detection can trigger the transition earlier.
 */
const CLI_LAUNCH_DELAY_MS = 3500;

/**
 * How long to wait after the CLI command is written before delivering the prompt.
 * Interactive CLIs can take 8–15 s to start on cold launch.
 * Output-driven detection can trigger the delivery earlier.
 */
const PROMPT_DELIVERY_DELAY_MS = 20_000;

// ---------------------------------------------------------------------------
// Agent lifecycle phases
// ---------------------------------------------------------------------------

type AgentPhase = 'spawning' | 'launching_cli' | 'working';

// ---------------------------------------------------------------------------
// Shell / CLI readiness patterns (used for optional early detection)
// ---------------------------------------------------------------------------

const SHELL_READY_PATTERNS = [
  /%\s*$/m,
  /\$\s*$/m,
  /#\s*$/m,
  /❯\s*$/m,
  /➜\s*$/m,
  /›\s*$/m,
  /\[.*\][%$#]\s*$/m,
  /\n[%$#]\s*$/m,
  /:\s*\S+\s+%\s*$/m,
  /\S+@\S+\s+\S+\s+%\s*$/m,
];

const CLI_READY_COMMON: RegExp[] = [
  />\s*$/m,
  /❯\s*$/m,
  /›\s*$/m,
  /\?\s*$/m,
  /Type your message/i,
  /Tips for getting started/i,
  /awaiting (your )?(input|message|reply)/i,
  /Press enter to continue/i,
];
const CLI_READY_HINTS_CLAUDE: RegExp[] = [
  /╰─+╯/,
  /[✻✦]\s*\w+\s+for\s+\d/,
];
const CLI_READY_HINTS_GEMINI: RegExp[] = [/gemini\s+cli/i, /google\s+gemini/i];
const CLI_READY_HINTS_CODEX: RegExp[] = [/openai\s*codex/i, /\bcodex\b.*[>›:?]/i];
const CLI_READY_HINTS_COPILOT: RegExp[] = [/github\s*copilot/i, /copilot\s*cli/i];
const CLI_READY_HINTS_VELIX: RegExp[] = [/\bvelix\b.*[>›:?]/i];

const BUILTIN_WORKER_CLI_IDS = new Set<string>([
  'claude', 'gemini', 'velix', 'codex', 'copilot',
]);

function mergeUniqueRegexPatterns(base: RegExp[], extras: RegExp[][]): RegExp[] {
  const seen = new Set<string>();
  const out: RegExp[] = [];
  const add = (list: RegExp[]) => {
    for (const r of list) {
      const key = `${r.source}\u0000${r.flags}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  };
  add(base);
  for (const list of extras) add(list);
  return out;
}

export function getCliReadyPatterns(workerCLI: WorkerCLI): RegExp[] {
  const common = [...CLI_READY_COMMON];
  if (BUILTIN_WORKER_CLI_IDS.has(workerCLI)) {
    switch (workerCLI) {
      case 'claude':  return mergeUniqueRegexPatterns(common, [CLI_READY_HINTS_CLAUDE]);
      case 'gemini':  return mergeUniqueRegexPatterns(common, [CLI_READY_HINTS_GEMINI]);
      case 'codex':   return mergeUniqueRegexPatterns(common, [CLI_READY_HINTS_CODEX]);
      case 'copilot': return mergeUniqueRegexPatterns(common, [CLI_READY_HINTS_COPILOT]);
      case 'velix':   return mergeUniqueRegexPatterns(common, [CLI_READY_HINTS_VELIX]);
      default:        return common;
    }
  }
  return mergeUniqueRegexPatterns(common, [
    CLI_READY_HINTS_CLAUDE, CLI_READY_HINTS_GEMINI,
    CLI_READY_HINTS_CODEX, CLI_READY_HINTS_COPILOT, CLI_READY_HINTS_VELIX,
  ]);
}

// ---------------------------------------------------------------------------
// ANSI sanitizer
// ---------------------------------------------------------------------------

const ANSI_ESCAPE_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g;

const sanitizeTerminalOutput = (data: string): string =>
  data
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');

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

  private pendingPrompts: Map<string, string> = new Map();
  private agentPhase: Map<string, AgentPhase> = new Map();
  private outputAccumulator: Map<string, string> = new Map();
  private cliLaunchedAt: Map<string, number> = new Map();
  private promptDeliveredAt: Map<string, number> = new Map();
  private completionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private initPromise: Promise<void> | null = null;

  constructor(eventEmitter: SwarmEventEmitter, workspacePath: string) {
    this.eventEmitter = eventEmitter;
    this.workspacePath = workspacePath;
  }

  setWorkerCLI(workerCLI: WorkerCLI): void { this.workerCLI = workerCLI; }
  getWorkerCLI(): WorkerCLI { return this.workerCLI; }

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
          void this.handleAgentOutput(agent.id, parsed.data).catch((err) => {
            console.error('AgentManager: output handler error:', err);
          });
        }
      });

      this.globalExitListener = await listen<unknown>('pty-exit', (event) => {
        const parsed = parsePtyExitPayload(event.payload);
        if (!parsed) return;
        const agent = this.findAgentBySessionId(parsed.sessionId);
        if (agent) {
          this.handleAgentExit(agent.id, parsed.exitCode);
        }
      });
    })();

    return this.initPromise;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  async cleanup(): Promise<void> {
    this.initPromise = null;
    if (this.globalOutputListener) { this.globalOutputListener(); this.globalOutputListener = null; }
    if (this.globalExitListener)   { this.globalExitListener();   this.globalExitListener = null; }
    this.agentPhase.clear();
    this.pendingPrompts.clear();
    this.outputAccumulator.clear();
    this.cliLaunchedAt.clear();
    this.promptDeliveredAt.clear();
    for (const t of this.completionTimers.values()) clearTimeout(t);
    this.completionTimers.clear();
  }

  setPatternDetector(detector: (output: string) => PatternMatch | null): void {
    this.patternDetector = detector;
  }

  private findAgentBySessionId(sessionId: string): Agent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.sessionId === sessionId) return agent;
    }
    return undefined;
  }

  // -----------------------------------------------------------------------
  // Phase transitions — idempotent, safe for concurrent calls
  // -----------------------------------------------------------------------

  /**
   * Transition from 'spawning' → 'launching_cli'.
   * Writes the CLI start command to the PTY.
   * Called by both the fallback timer and output-driven shell detection.
   * Only the first call wins; subsequent calls are no-ops.
   */
  private async tryLaunchCli(agentId: string): Promise<void> {
    if (this.agentPhase.get(agentId) !== 'spawning') return;
    const agent = this.agents.get(agentId);
    if (!agent || agent.status === 'terminated' || agent.status === 'failed') return;

    this.agentPhase.set(agentId, 'launching_cli');
    this.cliLaunchedAt.set(agentId, Date.now());
    this.outputAccumulator.set(agentId, '');
    agent.cliLaunched = true;

    const startCommand = this.buildWorkerStartCommand();
    console.log(`AgentManager: launching CLI "${this.workerCLI}" for ${agentId}`);

    try {
      await invoke('pty_write', { sessionId: agent.sessionId, data: startCommand });
    } catch (err) {
      console.error(`AgentManager: pty_write failed (CLI launch) for ${agentId}:`, err);
    }

    // Arm prompt delivery fallback — plain setTimeout, checks phase when it fires
    setTimeout(() => {
      void this.tryDeliverPrompt(agentId).catch(console.error);
    }, PROMPT_DELIVERY_DELAY_MS);
  }

  /**
   * Transition from 'launching_cli' → 'working'.
   * Writes the short instruction prompt to the PTY.
   * Called by both the fallback timer and output-driven CLI detection.
   */
  private async tryDeliverPrompt(agentId: string): Promise<void> {
    if (this.agentPhase.get(agentId) !== 'launching_cli') return;
    const agent = this.agents.get(agentId);
    if (!agent || agent.status === 'terminated' || agent.status === 'failed') return;

    const prompt = this.pendingPrompts.get(agentId);
    if (!prompt) return;

    this.agentPhase.set(agentId, 'working');
    this.pendingPrompts.delete(agentId);
    this.promptDeliveredAt.set(agentId, Date.now());
    agent.promptDelivered = true;

    console.log(`AgentManager: delivering prompt to ${agentId}`);

    try {
      // Write the prompt text first, then send Enter separately.
      // Interactive CLIs (Claude Code, Gemini, etc.) use bracketed paste mode —
      // if we send `text\r` in one write, the \r is absorbed into the paste
      // content and the CLI never actually submits. Splitting into two writes
      // with a short gap ensures the Enter is processed as a keypress.
      await invoke('pty_write', { sessionId: agent.sessionId, data: prompt });
      await new Promise((r) => setTimeout(r, 300));
      await invoke('pty_write', { sessionId: agent.sessionId, data: '\r' });
    } catch (err) {
      console.error(`AgentManager: prompt delivery failed for ${agentId}:`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Completion detection — poll every 5s, scan full output for done markers
  // -----------------------------------------------------------------------

  /**
   * Patterns that indicate the CLI finished its task (not just "idle at prompt").
   * These are scanned line-by-line across the ENTIRE output buffer, not just the tail.
   */
  private static readonly CLI_DONE_MARKERS: RegExp[] = [
    /[✻✦]\s*\w+\s+for\s+\d/,
  ];

  private startCompletionPolling(agentId: string): void {
    if (this.completionTimers.has(agentId)) return;

    const poll = setInterval(() => {
      const agent = this.agents.get(agentId);
      if (!agent || agent.status !== 'running') {
        clearInterval(poll);
        this.completionTimers.delete(agentId);
        return;
      }
      if (this.agentPhase.get(agentId) !== 'working') return;

      const deliveredAt = this.promptDeliveredAt.get(agentId) || 0;
      if (Date.now() - deliveredAt < 15_000) return;

      // Scan every line in the buffer for a "done" marker
      const hasDoneMarker = agent.outputBuffer.some((line) =>
        AgentManager.CLI_DONE_MARKERS.some((re) => re.test(line)),
      );
      if (!hasDoneMarker) return;

      // Also verify the CLI is back at an idle prompt (not mid-output)
      const tail = agent.outputBuffer.slice(-15).join('\n');
      const idlePatterns = getCliReadyPatterns(this.workerCLI);
      if (!idlePatterns.some((p) => p.test(tail))) return;

      console.log(`AgentManager: ${agentId} done marker + idle prompt detected — sending /exit`);
      clearInterval(poll);
      this.completionTimers.delete(agentId);
      void invoke('pty_write', { sessionId: agent.sessionId, data: '/exit\r' }).catch(() => {});
    }, 5000);

    this.completionTimers.set(agentId, poll as unknown as ReturnType<typeof setTimeout>);
  }

  private cancelCompletionTimer(agentId: string): void {
    const timer = this.completionTimers.get(agentId);
    if (timer) {
      clearInterval(timer as unknown as ReturnType<typeof setInterval>);
      clearTimeout(timer);
      this.completionTimers.delete(agentId);
    }
  }

  // -----------------------------------------------------------------------
  // PTY output handler
  // -----------------------------------------------------------------------

  private async handleAgentOutput(agentId: string, data: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.lastActivityAt = new Date();
    agent.terminalOutput = (agent.terminalOutput + data).slice(-MAX_TERMINAL_OUTPUT_CHARS);

    const sanitized = sanitizeTerminalOutput(data);
    const phase = this.agentPhase.get(agentId);

    // Accumulate sanitized output for pattern matching during launch
    if (phase === 'spawning' || phase === 'launching_cli') {
      const prev = this.outputAccumulator.get(agentId) || '';
      this.outputAccumulator.set(agentId, (prev + sanitized).slice(-READY_ACCUMULATOR_MAX_CHARS));
    }

    // Re-read phase after each await since tryLaunchCli/tryDeliverPrompt change it
    let currentPhase = this.agentPhase.get(agentId);

    if (currentPhase === 'spawning') {
      const accumulated = this.outputAccumulator.get(agentId) || '';
      if (SHELL_READY_PATTERNS.some((p) => p.test(accumulated))) {
        console.log(`AgentManager: shell ready detected for ${agentId} — launching CLI early`);
        await this.tryLaunchCli(agentId);
        currentPhase = this.agentPhase.get(agentId);
      }
    }

    if (currentPhase === 'launching_cli') {
      const launchedAt = this.cliLaunchedAt.get(agentId) || 0;
      if (Date.now() - launchedAt > 2000) {
        const accumulated = this.outputAccumulator.get(agentId) || '';
        const patterns = getCliReadyPatterns(this.workerCLI);
        if (patterns.some((p) => p.test(accumulated))) {
          console.log(`AgentManager: CLI ready detected for ${agentId} — delivering prompt early`);
          await this.tryDeliverPrompt(agentId);
          currentPhase = this.agentPhase.get(agentId);
        }
      }
    }

    // Start polling for completion once the agent is working
    if (currentPhase === 'working') {
      this.startCompletionPolling(agentId);
    }

    // Add to sanitized line buffer
    const lines = sanitized.split('\n').map((line) => line.trimEnd());
    agent.outputBuffer.push(...lines);
    if (agent.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      agent.outputBuffer = agent.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }

    this.eventEmitter.emitAgentEvent({ type: 'output', agentId, data: sanitized });

    if (this.patternDetector) {
      const match = this.patternDetector(sanitized);
      if (match) {
        agent.metrics.promptsProcessed++;
        this.eventEmitter.emitAgentEvent({ type: 'prompt_detected', agentId, match });
      }
    }

    for (const cb of this.outputCallbacks) {
      try { cb(agentId, sanitized); } catch (err) { console.error('AgentManager: output callback error:', err); }
    }
  }

  // -----------------------------------------------------------------------
  // PTY exit handler
  // -----------------------------------------------------------------------

  private handleAgentExit(agentId: string, exitCode: number | null): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (agent.status === 'terminated') return;

    const phase = this.agentPhase.get(agentId);
    const aliveMs = Date.now() - agent.startedAt.getTime();
    console.log(
      `AgentManager: pty-exit for ${agentId} | exitCode=${exitCode} phase=${phase} aliveMs=${aliveMs} label=${agent.label}`,
    );

    this.agentPhase.delete(agentId);
    this.pendingPrompts.delete(agentId);
    this.outputAccumulator.delete(agentId);
    this.cliLaunchedAt.delete(agentId);
    this.cancelCompletionTimer(agentId);

    if (agent.promptFilePath) {
      remove(agent.promptFilePath).catch(() => {});
    }

    const rawCode = exitCode ?? 0;
    const neverWorked = phase === 'spawning' || phase === 'launching_cli';
    const code = neverWorked ? 0 : rawCode;
    agent.status = code === 0 ? 'completed' : 'failed';

    if (agent.status === 'failed') {
      const aliveStr = aliveMs < 1000 ? `${aliveMs}ms` : `${(aliveMs / 1000).toFixed(1)}s`;
      if (phase === 'working') {
        agent.failureReason = `CLI exited with code ${rawCode} after ${aliveStr}`;
      } else if (phase === 'launching_cli') {
        agent.failureReason = `CLI failed to start (exit code ${rawCode}, alive ${aliveStr})`;
      } else {
        agent.failureReason = `Shell exited before CLI launched (exit code ${rawCode}, alive ${aliveStr})`;
      }
    }

    if (neverWorked && rawCode !== 0) {
      console.warn(
        `AgentManager: ${agentId} exited with code ${rawCode} before CLI launched (phase=${phase}) — treating as completed so swarm can continue`,
      );
    }

    if (code === 0) {
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
          output: agent.outputBuffer.join('\n'),
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

    for (const cb of this.exitCallbacks) {
      try { cb(agentId, code); } catch (err) { console.error('AgentManager: exit callback error:', err); }
    }
  }

  // -----------------------------------------------------------------------
  // Spawn
  // -----------------------------------------------------------------------

  async spawnAgent(
    role: AgentRole,
    task: string,
    options?: {
      assignmentId?: string;
      label?: string;
      ownedFiles?: string[];
    },
  ): Promise<Agent> {
    const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const sessionId = `swarm_${agentId}`;

    // ── Step 1: Write prompt file BEFORE creating the PTY ──────────────
    // This await happens before any PTY exists, so there's no race with
    // pty-output or pty-exit events. If it fails, we fall back to inline.
    const prompt = this.buildPrompt(role, task);
    const promptFileName = `.velix_swarm_prompt_${agentId}.txt`;
    const promptFilePath = `${this.workspacePath}/${promptFileName}`;

    let promptFileOk = false;
    try {
      await writeTextFile(promptFilePath, prompt);
      promptFileOk = true;
    } catch (err) {
      console.warn(`AgentManager: prompt file write failed for ${agentId}, will deliver inline:`, err);
    }
    const promptFileWritten = promptFileOk;

    const noFollowUp = 'Do NOT ask follow-up questions or request clarification. Work with the information provided. Begin immediately and exit when done.';

    const shortInstruction = promptFileOk
      ? `Read the file ${promptFileName} in the current directory. It contains your full task instructions. Follow every instruction in that file exactly — do not summarize or skip anything. ${noFollowUp}`
      : `${prompt}\n\n${noFollowUp}`;

    // ── Step 2: Create PTY — shell starts immediately ──────────────────
    await invoke('pty_create', {
      sessionId,
      rows: 50,
      cols: 220,
      cwd: this.workspacePath,
    });

    // ── Step 3: ALL remaining setup is synchronous (no awaits) ─────────
    // This guarantees that when handleAgentOutput fires (on the next
    // event-loop tick), the agent, phase, prompt, and timer are all ready.

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
      metrics: {
        promptsProcessed: 0,
        filesModified: [],
        testsRun: 0,
        errorsEncountered: 0,
        autoApprovals: 0,
        escalations: 0,
      },
      promptFilePath: promptFileOk ? promptFilePath : undefined,
      promptFileWritten,
      cliLaunched: false,
      promptDelivered: false,
    };

    this.agents.set(agentId, agent);
    this.agentPhase.set(agentId, 'spawning');
    this.outputAccumulator.set(agentId, '');
    this.pendingPrompts.set(agentId, shortInstruction);

    // Arm CLI launch fallback (plain setTimeout — checks phase when it fires)
    setTimeout(() => {
      void this.tryLaunchCli(agentId).catch(console.error);
    }, CLI_LAUNCH_DELAY_MS);

    console.log(`AgentManager: spawned ${agentId} (session=${sessionId}, promptFile=${promptFileOk})`);

    this.eventEmitter.emitAgentEvent({ type: 'spawned', agentId, role: role.type });

    for (const cb of this.spawnCallbacks) {
      try { cb(agentId); } catch { /* ignore */ }
    }

    return agent;
  }

  // -----------------------------------------------------------------------
  // Prompt / command builders
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

  private buildWorkerStartCommand(): string {
    const config = aiService.getConfig();
    const parts: string[] = [];
    const allOptions = getWorkerCLIOptions();
    const cliOption = allOptions.find((o) => o.id === this.workerCLI);

    switch (this.workerCLI) {
      case 'claude':
        parts.push('claude', '--dangerously-skip-permissions');
        if (config.provider === 'claude' && config.model) parts.push('--model', config.model);
        break;
      case 'gemini':
        parts.push('gemini');
        if (config.provider === 'gemini' && config.model) parts.push('-m', config.model);
        break;
      case 'codex':
        parts.push('codex');
        if (config.provider === 'chatgpt' && config.model) parts.push('-m', config.model);
        break;
      case 'velix':
        parts.push('velix');
        break;
      case 'copilot':
        parts.push('copilot');
        break;
      default:
        if (cliOption) { parts.push(cliOption.command); }
        else { parts.push('claude', '--dangerously-skip-permissions'); }
        break;
    }

    return 'set +e 2>/dev/null; ' + parts.join(' ') + '\r';
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

    agent.status = 'terminated';
    agent.failureReason = reason;
    this.agentPhase.delete(agentId);
    this.pendingPrompts.delete(agentId);
    this.cancelCompletionTimer(agentId);

    if (agent.promptFilePath) {
      remove(agent.promptFilePath).catch(() => {});
    }

    try {
      await invoke('pty_write', { sessionId: agent.sessionId, data: '\x03' });
      await new Promise((r) => setTimeout(r, 500));
      await invoke('pty_kill', { sessionId: agent.sessionId });
    } catch (err) {
      console.error(`Failed to terminate agent ${agentId}:`, err);
    }

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
