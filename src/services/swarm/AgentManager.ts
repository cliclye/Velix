/**
 * AgentManager — spawns worker CLI agents in PTYs, delivers swarm prompts, and streams output.
 *
 * Full rewrite focused on reliability:
 *
 *   1. A single well-defined lifecycle per agent:
 *          spawning  →  launching_cli  →  working  →  exiting  →  (exit)
 *      Each transition is idempotent: the first caller wins, the rest no-op.
 *
 *   2. Prompt delivery uses terminal bracketed-paste sequences so interactive
 *      CLIs (Claude Code, Gemini CLI, Codex, …) reliably receive multi-line
 *      prompts and treat the trailing CR as "submit".
 *
 *   3. Timers are plain setTimeout / setInterval. They check the current phase
 *      when they fire and bail if the agent has already moved on. No timer
 *      cancellation gymnastics.
 *
 *   4. `pty_kill` in the Rust backend now actually kills the child process,
 *      so PTY exit reliably fires when we ask the CLI to quit.
 *
 *   5. Extensive console.log so the user can see exactly where each agent is
 *      in the launch sequence. The swarm has been hard to debug historically
 *      because the logs were too quiet.
 */

import {
  invoke,
  listen,
  type UnlistenFn,
  writeTextFile,
  remove,
} from '../../platform/native';
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
// Payload parsing — Tauri emits snake_case; tolerate camelCase defensively
// ---------------------------------------------------------------------------

function parsePtyOutputPayload(
  payload: unknown,
): { sessionId: string; data: string } | null {
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
// Tunables
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BUFFER = 500;
const MAX_TERMINAL_OUTPUT_CHARS = 250_000;
const READY_ACCUMULATOR_MAX_CHARS = 4000;

/** Fallback delay before writing the CLI start command. Output-driven
 *  shell-prompt detection can trigger earlier. */
const CLI_LAUNCH_FALLBACK_MS = 4_000;

/** Fallback delay before delivering the prompt after the CLI launches.
 *  Interactive CLIs cold-start in 5–15s; output-driven detection usually
 *  fires earlier than this. */
const PROMPT_DELIVERY_FALLBACK_MS = 18_000;

/** Poll interval for checking whether an agent is done. */
const COMPLETION_POLL_INTERVAL_MS = 4_000;

/** Minimum time after prompt delivery before we start checking for completion. */
const COMPLETION_GRACE_MS = 12_000;

/** Quiet-time after a completion marker before we decide "yes, really done". */
const COMPLETION_QUIET_AFTER_MARKER_MS = 8_000;

/** Absolute quiet-time without any output (no marker) before we assume stuck at idle prompt. */
const COMPLETION_IDLE_TIMEOUT_MS = 45_000;

/** Time after sending `/exit` before we force-kill the PTY. */
const EXIT_ESCALATION_MS = 12_000;

// ---------------------------------------------------------------------------
// Lifecycle phases
// ---------------------------------------------------------------------------

type AgentPhase = 'spawning' | 'launching_cli' | 'working' | 'exiting';

// ---------------------------------------------------------------------------
// Shell / CLI readiness detection patterns
// ---------------------------------------------------------------------------

/** Common shell prompts (zsh %, bash $, root #, oh-my-zsh arrows, etc.). */
const SHELL_READY_PATTERNS: RegExp[] = [
  /%\s*$/m,
  /\$\s*$/m,
  /#\s*$/m,
  /❯\s*$/m,
  /➜\s*$/m,
  /›\s*$/m,
  /\[.*\][%$#]\s*$/m,
];

/** Patterns that indicate a TUI CLI has fully loaded and is waiting for input. */
const CLI_READY_COMMON: RegExp[] = [
  // Explicit prompts
  /Type your message/i,
  /Tips for getting started/i,
  /awaiting (your )?(input|message|reply)/i,
  /Press enter to continue/i,
  // Claude Code's rounded bottom border appears once the TUI is mounted
  /╰─+╯/,
  // Several TUIs draw a chevron or arrow on the input line
  /›\s*$/m,
  /❯\s*$/m,
  /▎\s*$/m,
];

const CLI_READY_HINTS_CLAUDE: RegExp[] = [
  /[✢✻✦✳✽]/,
  /Welcome to Claude/i,
];
const CLI_READY_HINTS_GEMINI: RegExp[] = [/gemini/i, /google/i];
const CLI_READY_HINTS_CODEX: RegExp[] = [/codex/i];
const CLI_READY_HINTS_COPILOT: RegExp[] = [/copilot/i];
const CLI_READY_HINTS_VELIX: RegExp[] = [/velix/i];

const BUILTIN_WORKER_CLI_IDS = new Set<string>([
  'claude', 'gemini', 'codex',
]);

function mergePatterns(...groups: RegExp[][]): RegExp[] {
  const seen = new Set<string>();
  const out: RegExp[] = [];
  for (const group of groups) {
    for (const r of group) {
      const key = `${r.source}\u0000${r.flags}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

export function getCliReadyPatterns(workerCLI: WorkerCLI): RegExp[] {
  if (BUILTIN_WORKER_CLI_IDS.has(workerCLI)) {
    switch (workerCLI) {
      case 'claude':  return mergePatterns(CLI_READY_COMMON, CLI_READY_HINTS_CLAUDE);
      case 'gemini':  return mergePatterns(CLI_READY_COMMON, CLI_READY_HINTS_GEMINI);
      case 'codex':   return mergePatterns(CLI_READY_COMMON, CLI_READY_HINTS_CODEX);
      default:        return CLI_READY_COMMON;
    }
  }
  return mergePatterns(
    CLI_READY_COMMON,
    CLI_READY_HINTS_CLAUDE,
    CLI_READY_HINTS_GEMINI,
    CLI_READY_HINTS_CODEX,
    CLI_READY_HINTS_COPILOT,
    CLI_READY_HINTS_VELIX,
  );
}

// ---------------------------------------------------------------------------
// ANSI sanitizer
// ---------------------------------------------------------------------------

const ANSI_ESCAPE_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g;

function sanitizeTerminalOutput(data: string): string {
  return data
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');
}

// ---------------------------------------------------------------------------
// Completion markers — any one of these plus a quiet PTY means "the CLI is done"
// ---------------------------------------------------------------------------

const COMPLETION_MARKERS: RegExp[] = [
  /---END-SCOUT-FINDINGS---/,
  /---END-BUILDER-REPORT---/,
  /---END-REVIEW-VERDICT---/,
  // Claude Code timing/usage lines that only appear after the assistant finishes
  /\b(Baked|Brewed|Worked|Churned|Cogitated|Processed|Finished)\s+for\s+/i,
  // Claude Code prints this once the CLI has fully exited back to the shell
  /Resume this session with:/i,
  // Some CLIs print this on successful completion
  /^\s*Done\.\s*$/m,
];

function hasCompletionMarker(text: string): boolean {
  return COMPLETION_MARKERS.some((r) => r.test(text));
}

function hasJsonFence(text: string): boolean {
  return /```json\s*[\s\S]*?```/i.test(text);
}

function isParseableJsonObject(text: string): boolean {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

type JsonCompletionShape = 'plan' | 'actions' | 'any';

function satisfiesJsonShape(text: string, shape: JsonCompletionShape): boolean {
  if (shape === 'any') {
    const jsonText = extractLastJsonObjectText(text);
    return (jsonText !== null && isParseableJsonObject(jsonText)) || hasJsonFence(text);
  }

  const jsonText = extractLastJsonObjectText(text);
  if (!jsonText) return false;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (shape === 'plan') {
      return Array.isArray(parsed.tasks) && parsed.tasks.length > 0;
    }
    if (shape === 'actions') {
      return Array.isArray(parsed.actions) && parsed.actions.length > 0;
    }
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMarkerLine(
  text: string,
  marker: string,
  fromIndex = 0,
): { contentStart: number; afterLine: number } | null {
  const regex = new RegExp(`(^|\\n)[\\t ]*${escapeRegExp(marker)}[\\t ]*(\\n|$)`, 'g');
  regex.lastIndex = fromIndex;
  const match = regex.exec(text);
  if (!match) return null;
  return {
    contentStart: match.index + match[1].length,
    afterLine: match.index + match[0].length,
  };
}

function extractBalancedJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function collectResponseCandidates(
  text: string,
  startMarker: string,
  endMarker: string,
): string[] {
  const candidates: string[] = [];
  const delimited = extractDelimitedResult(text, startMarker, endMarker);
  if (delimited) candidates.push(delimited);

  for (const match of text.matchAll(/```json\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  for (const match of text.matchAll(/```(?:\w+)?\s*([\s\S]*?)```/g)) {
    candidates.push(match[1].trim());
  }

  const actionsIdx = text.indexOf('"actions"');
  if (actionsIdx >= 0) {
    const start = text.lastIndexOf('{', actionsIdx);
    if (start >= 0) {
      const slice = extractBalancedJsonObject(text, start);
      if (slice) candidates.push(slice);
    }
  }

  const tasksIdx = text.indexOf('"tasks"');
  if (tasksIdx >= 0) {
    const start = text.lastIndexOf('{', tasksIdx);
    if (start >= 0) {
      const slice = extractBalancedJsonObject(text, start);
      if (slice) candidates.push(slice);
    }
  }

  const lastJson = extractLastJsonObjectText(text);
  if (lastJson) candidates.push(lastJson);

  candidates.push(text.trim());
  return [...new Set(candidates.filter(Boolean))];
}

function pickValidatedResult(
  text: string,
  validate: (candidate: string) => boolean,
  startMarker: string,
  endMarker: string,
): string | null {
  for (const candidate of collectResponseCandidates(text, startMarker, endMarker)) {
    if (validate(candidate)) return candidate;
  }
  return null;
}

function extractDelimitedResult(text: string, startMarker: string, endMarker: string): string | null {
  const start = findMarkerLine(text, startMarker);
  if (!start) return null;
  const end = findMarkerLine(text, endMarker, start.afterLine);
  if (!end) return null;
  return text.slice(start.afterLine, end.contentStart).trim();
}

function extractLastJsonObjectText(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastJson: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (char !== '}' || depth === 0) continue;

    depth--;
    if (depth !== 0 || start === -1) continue;

    const candidate = text.slice(start, i + 1).trim();
    try {
      JSON.parse(candidate);
      lastJson = candidate;
    } catch {
      // Ignore non-JSON brace blocks from echoed prompts or terminal output.
    }
    start = -1;
  }

  return lastJson;
}

// ---------------------------------------------------------------------------
// Worker CLI configuration (built-ins + custom + availability detection)
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
  { id: 'codex',   name: 'Codex CLI',   command: 'codex',   description: 'OpenAI Codex CLI', builtin: true },
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

function getCommandExecutable(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match?.[1] || match?.[2] || match?.[3] || trimmed;
}

export async function detectWorkerCLIAvailability(
  _cwd: string,
): Promise<Record<WorkerCLI, WorkerCLIStatus>> {
  const allOptions = getWorkerCLIOptions();
  const entries = await Promise.all(
    allOptions.map(async (option) => {
      const executable = getCommandExecutable(option.command);
      try {
        const path = await invoke<string>('check_cli_available', { command: executable });
        return [option.id, { available: true, detail: path }] as const;
      } catch {
        return [option.id, { available: false, detail: `${executable} not found in PATH` }] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as Record<WorkerCLI, WorkerCLIStatus>;
}

export interface CoordinatorCliRunOptions {
  label?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Complete once a parseable JSON object appears (agent loop planner/coder). */
  expectJson?: boolean;
  /** Require a specific JSON shape before completing (avoids waiting on CLI UI spinners). */
  jsonShape?: 'plan' | 'actions' | 'any';
  validateResult?: (text: string) => boolean;
  onProgress?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// AgentManager
// ---------------------------------------------------------------------------

interface AgentRuntimeState {
  phase: AgentPhase;
  pendingPrompt: string;
  launchCommand: string;
  cliLaunchedAt: number;
  promptDeliveredAt: number;
  outputAccumulator: string;
  /** Latest rolling chunk of sanitized output, scanned for completion markers. */
  completionWindow: string;
  /** Set true once we've written `/exit` (or equivalent) so we know to fall back to kill. */
  exitRequested: boolean;
  /** Set true when we issue `pty_kill` after a clean completion, so the resulting
   *  exit code is treated as success regardless of what the CLI returned. */
  forcedKillAfterCompletion: boolean;
  /** setInterval handle for completion polling. */
  completionTimer: ReturnType<typeof setInterval> | null;
  /** setTimeout handle for the kill-after-exit fallback. */
  exitKillTimer: ReturnType<typeof setTimeout> | null;
  /** Fallback timer for CLI launch. */
  launchTimer: ReturnType<typeof setTimeout> | null;
  /** Fallback timer for prompt delivery. */
  promptTimer: ReturnType<typeof setTimeout> | null;
}

export class AgentManager {
  private agents = new Map<string, Agent>();
  private runtime = new Map<string, AgentRuntimeState>();
  private sessionToAgent = new Map<string, string>();

  private eventEmitter: SwarmEventEmitter;
  /** Active coordinator PTY sessions (not in agents map). */
  private coordinatorSessions = new Set<string>();
  private workspacePath: string;
  private workerCLI: WorkerCLI = 'claude';

  private outputListener: UnlistenFn | null = null;
  private exitListener: UnlistenFn | null = null;
  private initPromise: Promise<void> | null = null;

  private outputCallbacks: Array<(agentId: string, data: string) => void> = [];
  private exitCallbacks: Array<(agentId: string, exitCode: number | null) => void> = [];
  private spawnCallbacks: Array<(agentId: string) => void> = [];
  private patternDetector: ((output: string) => PatternMatch | null) | null = null;

  constructor(eventEmitter: SwarmEventEmitter, workspacePath: string) {
    this.eventEmitter = eventEmitter;
    this.workspacePath = workspacePath;
  }

  setWorkerCLI(workerCLI: WorkerCLI): void {
    this.workerCLI = workerCLI;
  }

  getWorkerCLI(): WorkerCLI {
    return this.workerCLI;
  }

  setPatternDetector(detector: (output: string) => PatternMatch | null): void {
    this.patternDetector = detector;
  }

  // -----------------------------------------------------------------------
  // Initialization & cleanup
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      this.outputListener = await listen<unknown>('pty-output', (event) => {
        const parsed = parsePtyOutputPayload(event.payload);
        if (!parsed) return;
        const agentId = this.sessionToAgent.get(parsed.sessionId);
        if (agentId) this.handleAgentOutput(agentId, parsed.data);
      });

      this.exitListener = await listen<unknown>('pty-exit', (event) => {
        const parsed = parsePtyExitPayload(event.payload);
        if (!parsed) return;
        const agentId = this.sessionToAgent.get(parsed.sessionId);
        if (agentId) this.handleAgentExit(agentId, parsed.exitCode);
      });

      console.log('AgentManager: initialized (listeners registered)');
    })();

    return this.initPromise;
  }

  async cleanup(): Promise<void> {
    console.log('AgentManager: cleanup()');
    this.initPromise = null;
    if (this.outputListener) { this.outputListener(); this.outputListener = null; }
    if (this.exitListener)   { this.exitListener();   this.exitListener = null; }

    for (const rt of this.runtime.values()) {
      if (rt.completionTimer) clearInterval(rt.completionTimer);
      if (rt.exitKillTimer) clearTimeout(rt.exitKillTimer);
      if (rt.launchTimer) clearTimeout(rt.launchTimer);
      if (rt.promptTimer) clearTimeout(rt.promptTimer);
    }
    for (const sessionId of this.coordinatorSessions) {
      void invoke('pty_kill', { sessionId }).catch(() => {});
    }
    this.coordinatorSessions.clear();
    this.runtime.clear();
    this.sessionToAgent.clear();
  }

  // -----------------------------------------------------------------------
  // Spawn — create PTY, schedule launch & prompt delivery
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

    // ── 1. Write the full prompt to a file so the agent can read it
    //       without us having to stream it through the PTY line-by-line.
    const fullPrompt = this.buildPrompt(role, task);
    const promptFileName = `.velix_swarm_prompt_${agentId}.txt`;
    const promptFilePath = `${this.workspacePath}/${promptFileName}`;
    let promptFileOk = false;
    try {
      await writeTextFile(promptFilePath, fullPrompt);
      promptFileOk = true;
    } catch (err) {
      console.warn(
        `AgentManager: prompt-file write failed for ${agentId}, falling back to inline delivery:`,
        err,
      );
    }

    const noFollowUp =
      'Do NOT ask follow-up questions or request clarification. Work with the information provided. Begin immediately. When finished with your assigned task, quit the CLI (use /exit, /quit, or your CLI\'s exit command) so the swarm can continue.';

    const shortInstruction = promptFileOk
      ? `Read the file ./${promptFileName} in the current directory. It contains your full task instructions. Follow every instruction in that file exactly — do not summarize or skip anything. ${noFollowUp}`
      : `${fullPrompt}\n\n${noFollowUp}`;

    // ── 2. Create the PTY. This spawns `sh -l` with the workspace as cwd.
    //       We deliberately launch a shell (not the CLI directly) so the
    //       user's login environment (PATH, keys) is fully loaded before
    //       the CLI starts.
    console.log(`AgentManager: creating PTY for ${agentId} (cwd=${this.workspacePath})`);
    await invoke('pty_create', {
      sessionId,
      rows: 50,
      cols: 220,
      cwd: this.workspacePath,
    });

    // ── 3. Register agent state synchronously so output events arriving
    //       on the very next tick find a target to dispatch to.
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
      promptFileWritten: promptFileOk,
      cliLaunched: false,
      promptDelivered: false,
    };

    const runtime: AgentRuntimeState = {
      phase: 'spawning',
      pendingPrompt: shortInstruction,
      launchCommand: this.buildWorkerStartCommand(),
      cliLaunchedAt: 0,
      promptDeliveredAt: 0,
      outputAccumulator: '',
      completionWindow: '',
      exitRequested: false,
      forcedKillAfterCompletion: false,
      completionTimer: null,
      exitKillTimer: null,
      launchTimer: null,
      promptTimer: null,
    };

    this.agents.set(agentId, agent);
    this.runtime.set(agentId, runtime);
    this.sessionToAgent.set(sessionId, agentId);

    // ── 4. Arm the fallback timers. Output-driven detection may fire earlier.
    runtime.launchTimer = setTimeout(() => {
      runtime.launchTimer = null;
      void this.tryLaunchCli(agentId, 'fallback-timer');
    }, CLI_LAUNCH_FALLBACK_MS);
    runtime.promptTimer = setTimeout(() => {
      runtime.promptTimer = null;
      void this.tryDeliverPromptWhenReady(agentId, 'fallback-timer');
    }, CLI_LAUNCH_FALLBACK_MS + PROMPT_DELIVERY_FALLBACK_MS);

    console.log(
      `AgentManager: spawned ${agentId}`,
      `(role=${role.type}, promptFile=${promptFileOk}, sessionId=${sessionId})`,
    );

    this.eventEmitter.emitAgentEvent({ type: 'spawned', agentId, role: role.type });
    for (const cb of this.spawnCallbacks) {
      try { cb(agentId); } catch (err) { console.error('AgentManager: spawn cb error:', err); }
    }

    return agent;
  }

  async runCoordinatorPrompt(
    prompt: string,
    options: CoordinatorCliRunOptions = {},
  ): Promise<string> {
    await this.initialize();

    const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const sessionId = `swarm_coordinator_${runId}`;
    this.coordinatorSessions.add(sessionId);
    const label = options.label || 'Coordinator';
    const timeoutMs = options.timeoutMs ?? 180_000;
    const expectJson = options.expectJson ?? false;
    const jsonShape: JsonCompletionShape = options.jsonShape ?? (expectJson ? 'any' : 'any');
    const reportProgress = (message: string) => {
      options.onProgress?.(message);
    };
    const markerStart = `__VELIX_COORDINATOR_RESULT_START__${runId}`;
    const markerEnd = `__VELIX_COORDINATOR_RESULT_END__${runId}`;

    const promptWithContract = [
      prompt,
      '',
      '## Coordinator CLI output contract',
      expectJson
        ? 'Respond with the requested JSON. Put the JSON between these exact marker lines (you may wrap it in a ```json fence inside the markers):'
        : 'Produce the final answer between these exact marker lines:',
      markerStart,
      expectJson ? '```json\n{ ... }\n```' : '<final answer>',
      markerEnd,
      expectJson
        ? 'The JSON between the markers must be valid and complete. After printing the end marker, exit the CLI session (/exit or equivalent).'
        : 'The final answer between the markers must satisfy the requested format exactly. After printing the end marker, exit the CLI session.',
    ].join('\n');

    const promptFileName = `.velix_swarm_coordinator_${runId}.txt`;
    const promptFilePath = `${this.workspacePath}/${promptFileName}`;
    let promptFileOk = false;
    try {
      await writeTextFile(promptFilePath, promptWithContract);
      promptFileOk = true;
    } catch (err) {
      console.warn(`AgentManager[${label}]: coordinator prompt-file write failed:`, err);
    }

    const deliveryPrompt = promptFileOk
      ? [
          `Read ./${promptFileName} in the current directory.`,
          'It contains your full coordinator instructions and output contract.',
          `Return only the final answer between ${markerStart} and ${markerEnd}.`,
          'Begin now. Do not ask follow-up questions.',
        ].join(' ')
      : promptWithContract;

    console.log(`AgentManager[${label}]: starting coordinator CLI "${this.workerCLI}"`);
    reportProgress(`Starting ${label} via ${this.workerCLI} CLI…`);

    return new Promise<string>(async (resolve, reject) => {
      let output = '';
      let sanitizedOutput = '';
      let settled = false;
      let cliLaunched = false;
      let promptDelivered = false;
      let cliLaunchedAt = 0;
      let promptDeliveredAt = 0;
      let lastOutputAt = Date.now();
      let outputUnlisten: UnlistenFn | null = null;
      let exitUnlisten: UnlistenFn | null = null;
      let launchTimer: ReturnType<typeof setTimeout> | null = null;
      let promptTimer: ReturnType<typeof setTimeout> | null = null;
      let completionTimer: ReturnType<typeof setInterval> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let jsonShapeStableSince = 0;

      const cleanup = () => {
        if (launchTimer) clearTimeout(launchTimer);
        if (promptTimer) clearTimeout(promptTimer);
        if (completionTimer) clearInterval(completionTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        options.signal?.removeEventListener('abort', onAbort);
        outputUnlisten?.();
        exitUnlisten?.();
        if (promptFileOk) {
          remove(promptFilePath).catch(() => {});
        }
      };

      const extractResult = (): string => {
        if (options.validateResult) {
          const picked = pickValidatedResult(
            sanitizedOutput,
            options.validateResult,
            markerStart,
            markerEnd,
          );
          if (picked) return picked;
        }

        const delimitedResult = extractDelimitedResult(sanitizedOutput, markerStart, markerEnd);
        if (delimitedResult !== null) {
          if (!options.validateResult || options.validateResult(delimitedResult)) {
            return delimitedResult;
          }
        }

        if (jsonShape !== 'any') {
          const shaped = pickValidatedResult(
            sanitizedOutput,
            (candidate) => satisfiesJsonShape(candidate, jsonShape),
            markerStart,
            markerEnd,
          );
          if (shaped) return shaped;
        }

        const json = extractLastJsonObjectText(sanitizedOutput);
        if (json) return json;
        return sanitizedOutput.trim();
      };

      const finish = (ok: boolean, error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.coordinatorSessions.delete(sessionId);
        void invoke('pty_kill', { sessionId }).catch(() => {});

        if (!ok) {
          reject(error || new Error(`${label} CLI run failed.`));
          return;
        }

        const result = extractResult();
        if (!result) {
          reject(new Error(`${label} CLI produced no coordinator output.`));
          return;
        }
        if (options.validateResult && !options.validateResult(result)) {
          reject(
            new Error(
              `${label} CLI response did not contain a usable result. Check the activity log and retry.`,
            ),
          );
          return;
        }
        resolve(result);
      };

      const onAbort = () => {
        finish(false, new DOMException('Coordinator CLI run stopped', 'AbortError'));
      };

      const tryLaunchCli = async (reason: string) => {
        if (settled || cliLaunched) return;
        cliLaunched = true;
        cliLaunchedAt = Date.now();
        sanitizedOutput = '';
        console.log(`AgentManager[${label}]: launching coordinator CLI (${reason})`);
        reportProgress(`Launching ${this.workerCLI} CLI…`);
        try {
          await invoke('pty_write', {
            sessionId,
            data: this.buildWorkerStartCommand(),
          });
        } catch (err) {
          finish(false, new Error(`Failed to launch coordinator CLI: ${err}`));
        }
      };

      const tryDeliverPrompt = async (reason: string) => {
        if (settled || !cliLaunched || promptDelivered) return;
        promptDelivered = true;
        promptDeliveredAt = Date.now();
        console.log(`AgentManager[${label}]: delivering coordinator prompt (${reason})`);
        reportProgress(`${label} is thinking…`);
        const BRACKETED_PASTE_START = '\x1b[200~';
        const BRACKETED_PASTE_END = '\x1b[201~';
        try {
          await invoke('pty_write', {
            sessionId,
            data: BRACKETED_PASTE_START + deliveryPrompt + BRACKETED_PASTE_END,
          });
          await delay(250);
          await invoke('pty_write', { sessionId, data: '\r' });
        } catch (err) {
          finish(false, new Error(`Failed to deliver coordinator prompt: ${err}`));
        }
      };

      const checkCompletion = () => {
        if (settled || !promptDelivered) return;
        const quietMs = Date.now() - lastOutputAt;
        const sincePromptDelivery = Date.now() - promptDeliveredAt;
        const hasDelimitedResult = extractDelimitedResult(sanitizedOutput, markerStart, markerEnd) !== null;

        if (options.validateResult) {
          const picked = pickValidatedResult(
            sanitizedOutput,
            options.validateResult,
            markerStart,
            markerEnd,
          );
          if (picked) {
            if (!jsonShapeStableSince) jsonShapeStableSince = Date.now();
            const stableMs = Date.now() - jsonShapeStableSince;
            if (sincePromptDelivery >= 1000 && stableMs >= 600) {
              reportProgress('Valid response received — finishing CLI session…');
              finish(true);
            }
            return;
          }
          jsonShapeStableSince = 0;
        }

        if (hasDelimitedResult && quietMs >= 1200) {
          if (!options.validateResult || options.validateResult(extractResult())) {
            finish(true);
            return;
          }
        }

        if (expectJson && !options.validateResult) {
          const shapeReady = satisfiesJsonShape(sanitizedOutput, jsonShape);
          if (shapeReady) {
            if (!jsonShapeStableSince) jsonShapeStableSince = Date.now();
            const stableMs = Date.now() - jsonShapeStableSince;
            const minWait = jsonShape === 'any' ? 1500 : 1000;
            const stableRequired = jsonShape === 'any' ? 800 : 600;
            if (sincePromptDelivery >= minWait && stableMs >= stableRequired) {
            if (jsonShape !== 'any') {
                reportProgress('Valid JSON received — finishing CLI session…');
              }
              finish(true);
              return;
            }
          } else {
            jsonShapeStableSince = 0;
          }

          if (jsonShape === 'any') {
            const jsonText = extractLastJsonObjectText(sanitizedOutput);
            const jsonReady =
              (jsonText && isParseableJsonObject(jsonText)) || hasJsonFence(sanitizedOutput);
            if (jsonReady && sincePromptDelivery >= 1500 && quietMs >= 800) {
              finish(true);
              return;
            }
          }
        }

        if (hasCompletionMarker(sanitizedOutput) && quietMs >= 1500) {
          finish(true);
          return;
        }

        const hasJsonCandidate = extractLastJsonObjectText(sanitizedOutput) !== null;
        const jsonQuietMs = expectJson ? 2000 : 5000;
        const jsonWaitMs = expectJson ? 3000 : 10_000;
        if (hasJsonCandidate && sincePromptDelivery >= jsonWaitMs && quietMs >= jsonQuietMs) {
          finish(true);
        }
      };

      try {
        outputUnlisten = await listen<unknown>('pty-output', (event) => {
          const parsed = parsePtyOutputPayload(event.payload);
          if (!parsed || parsed.sessionId !== sessionId || settled) return;

          output = (output + parsed.data).slice(-MAX_TERMINAL_OUTPUT_CHARS);
          sanitizedOutput = sanitizeTerminalOutput(output);
          lastOutputAt = Date.now();

          const accumulator = sanitizedOutput.slice(-READY_ACCUMULATOR_MAX_CHARS);
          if (!cliLaunched && SHELL_READY_PATTERNS.some((p) => p.test(accumulator))) {
            void tryLaunchCli('shell-ready');
            return;
          }

          if (cliLaunched && !promptDelivered && Date.now() - cliLaunchedAt > 1500) {
            const patterns = getCliReadyPatterns(this.workerCLI);
            if (patterns.some((p) => p.test(accumulator))) {
              void tryDeliverPrompt('cli-ready');
            }
          }

          checkCompletion();
        });

        exitUnlisten = await listen<unknown>('pty-exit', (event) => {
          const parsed = parsePtyExitPayload(event.payload);
          if (!parsed || parsed.sessionId !== sessionId || settled) return;
          const hasDelimited = extractDelimitedResult(sanitizedOutput, markerStart, markerEnd) !== null;
          const hasJson = extractLastJsonObjectText(sanitizedOutput) !== null;
          const hasMarker = hasCompletionMarker(sanitizedOutput);
          if (hasDelimited || hasJson || hasMarker) {
            finish(true);
          } else if (sanitizedOutput.trim()) {
            finish(false, new Error(`${label} CLI exited without a valid coordinator result.`));
          } else {
            finish(false, new Error(`Coordinator CLI exited before producing output.`));
          }
        });

        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }

        reportProgress('Opening terminal session…');
        await invoke('pty_create', {
          sessionId,
          rows: 50,
          cols: 220,
          cwd: this.workspacePath,
        });

        launchTimer = setTimeout(() => { void tryLaunchCli('fallback-timer'); }, CLI_LAUNCH_FALLBACK_MS);
        const promptDeliveryBaseMs = expectJson
          ? 6_000
          : CLI_LAUNCH_FALLBACK_MS + PROMPT_DELIVERY_FALLBACK_MS;
        const schedulePromptFallback = (delayMs: number) => {
          promptTimer = setTimeout(() => {
            if (settled || promptDelivered) return;
            if (!cliLaunched) {
              schedulePromptFallback(2_000);
              return;
            }
            const patterns = getCliReadyPatterns(this.workerCLI);
            const accumulator = sanitizedOutput.slice(-READY_ACCUMULATOR_MAX_CHARS);
            const cliReady = patterns.some((p) => p.test(accumulator));
            const waitedLongEnough = Date.now() - cliLaunchedAt > (expectJson ? 12_000 : 30_000);
            if (cliReady || waitedLongEnough) {
              void tryDeliverPrompt('fallback-timer');
            } else {
              reportProgress(`Waiting for ${this.workerCLI} CLI to become ready…`);
              schedulePromptFallback(2_000);
            }
          }, delayMs);
        };
        schedulePromptFallback(promptDeliveryBaseMs);
        completionTimer = setInterval(checkCompletion, expectJson ? 400 : 1000);
        timeoutTimer = setTimeout(() => {
          finish(false, new Error(`${label} CLI timed out after ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      } catch (err) {
        finish(false, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // -----------------------------------------------------------------------
  // Phase transitions — idempotent, safe for concurrent triggers
  // -----------------------------------------------------------------------

  /** spawning → launching_cli. Writes the CLI start command to the PTY. */
  private async tryLaunchCli(agentId: string, reason: string): Promise<void> {
    const rt = this.runtime.get(agentId);
    const agent = this.agents.get(agentId);
    if (!rt || !agent) return;
    if (rt.phase !== 'spawning') return;
    if (agent.status !== 'running') return;

    rt.phase = 'launching_cli';
    rt.cliLaunchedAt = Date.now();
    rt.outputAccumulator = '';
    agent.cliLaunched = true;

    console.log(
      `AgentManager[${agent.label || agent.role.name}]: launching CLI "${this.workerCLI}" (${reason})`,
    );

    try {
      await invoke('pty_write', {
        sessionId: agent.sessionId,
        data: rt.launchCommand,
      });
    } catch (err) {
      console.error(`AgentManager[${agentId}]: pty_write (CLI launch) failed:`, err);
      agent.status = 'failed';
      agent.failureReason = `Failed to launch CLI: ${err}`;
      rt.phase = 'exiting';
      if (rt.launchTimer) clearTimeout(rt.launchTimer);
      if (rt.promptTimer) clearTimeout(rt.promptTimer);
      this.eventEmitter.emitAgentEvent({
        type: 'failed',
        agentId,
        error: agent.failureReason,
      });
      try {
        await invoke('pty_kill', { sessionId: agent.sessionId });
      } catch (killErr) {
        console.error(`AgentManager[${agentId}]: pty_kill after launch failure:`, killErr);
      }
    }
  }

  /** Wait for CLI-ready patterns before delivering prompt (fallback timer path). */
  private async tryDeliverPromptWhenReady(agentId: string, reason: string): Promise<void> {
    const rt = this.runtime.get(agentId);
    const agent = this.agents.get(agentId);
    if (!rt || !agent || agent.status !== 'running') return;
    if (rt.phase !== 'launching_cli') return;
    if (!agent.cliLaunched) {
      rt.promptTimer = setTimeout(() => {
        rt.promptTimer = null;
        void this.tryDeliverPromptWhenReady(agentId, reason);
      }, 2_000);
      return;
    }
    const patterns = getCliReadyPatterns(this.workerCLI);
    const accumulator = sanitizeTerminalOutput(agent.terminalOutput).slice(-READY_ACCUMULATOR_MAX_CHARS);
    const cliReady = patterns.some((p) => p.test(accumulator));
    const waitedLongEnough = Date.now() - rt.cliLaunchedAt > 30_000;
    if (!cliReady && !waitedLongEnough) {
      rt.promptTimer = setTimeout(() => {
        rt.promptTimer = null;
        void this.tryDeliverPromptWhenReady(agentId, reason);
      }, 2_000);
      return;
    }
    await this.tryDeliverPrompt(agentId, reason);
  }

  /** launching_cli → working. Writes the short instruction prompt to the PTY. */
  private async tryDeliverPrompt(agentId: string, reason: string): Promise<void> {
    const rt = this.runtime.get(agentId);
    const agent = this.agents.get(agentId);
    if (!rt || !agent) return;
    if (rt.phase !== 'launching_cli') return;
    if (agent.status !== 'running') return;
    if (!rt.pendingPrompt) return;

    rt.phase = 'working';
    rt.promptDeliveredAt = Date.now();
    agent.promptDelivered = true;

    console.log(
      `AgentManager[${agent.label || agent.role.name}]: delivering prompt (${reason}, ${rt.pendingPrompt.length} chars)`,
    );

    // Deliver the prompt using bracketed paste sequences. Modern TUI CLIs
    // (Claude Code, Gemini, Codex, …) recognize \e[200~ / \e[201~ as "this
    // is a paste" so multi-line content doesn't get misinterpreted as a
    // stream of Enter keypresses. The final CR after the close bracket is
    // then processed as a real "submit" keystroke.
    const BRACKETED_PASTE_START = '\x1b[200~';
    const BRACKETED_PASTE_END = '\x1b[201~';

    try {
      await invoke('pty_write', {
        sessionId: agent.sessionId,
        data: BRACKETED_PASTE_START + rt.pendingPrompt + BRACKETED_PASTE_END,
      });
      // Short gap so the CLI processes the paste before seeing the Enter.
      await delay(250);
      await invoke('pty_write', {
        sessionId: agent.sessionId,
        data: '\r',
      });
    } catch (err) {
      console.error(`AgentManager[${agentId}]: prompt delivery failed:`, err);
      agent.failureReason = `Failed to deliver prompt: ${err}`;
    }

    rt.pendingPrompt = '';
    this.startCompletionPolling(agentId);
  }

  // -----------------------------------------------------------------------
  // Completion detection
  // -----------------------------------------------------------------------

  private startCompletionPolling(agentId: string): void {
    const rt = this.runtime.get(agentId);
    if (!rt || rt.completionTimer) return;

    rt.completionTimer = setInterval(() => {
      this.pollCompletion(agentId);
    }, COMPLETION_POLL_INTERVAL_MS);
  }

  private stopCompletionPolling(agentId: string): void {
    const rt = this.runtime.get(agentId);
    if (!rt || !rt.completionTimer) return;
    clearInterval(rt.completionTimer);
    rt.completionTimer = null;
  }

  private pollCompletion(agentId: string): void {
    const rt = this.runtime.get(agentId);
    const agent = this.agents.get(agentId);
    if (!rt || !agent || agent.status !== 'running') {
      this.stopCompletionPolling(agentId);
      return;
    }

    if (rt.phase !== 'working') return;

    const sinceDelivery = Date.now() - rt.promptDeliveredAt;
    if (sinceDelivery < COMPLETION_GRACE_MS) return;

    const quietMs = Date.now() - agent.lastActivityAt.getTime();
    const sanitizedTail = sanitizeTerminalOutput(
      agent.terminalOutput.slice(-80_000),
    );
    const hasMarker = hasCompletionMarker(sanitizedTail);

    if (hasMarker && quietMs >= COMPLETION_QUIET_AFTER_MARKER_MS) {
      console.log(
        `AgentManager[${agent.label || agent.role.name}]:`,
        `completion marker + quiet ${quietMs}ms — sending /exit`,
      );
      this.stopCompletionPolling(agentId);
      this.requestCliExit(agentId);
      return;
    }

    // Heuristic fallback: if the agent has been completely silent for a long
    // time AND has been working for at least 60s, assume it's sitting at a
    // prompt and tell it to quit.
    if (quietMs >= COMPLETION_IDLE_TIMEOUT_MS && sinceDelivery > 60_000) {
      console.log(
        `AgentManager[${agent.label || agent.role.name}]:`,
        `idle ${quietMs}ms after ${sinceDelivery}ms of work — sending /exit`,
      );
      this.stopCompletionPolling(agentId);
      this.requestCliExit(agentId);
    }
  }

  /** Quit the CLI, then escalate to a shell exit, then a hard kill. */
  private requestCliExit(agentId: string): void {
    const rt = this.runtime.get(agentId);
    const agent = this.agents.get(agentId);
    if (!rt || !agent) return;
    if (rt.exitRequested) return;

    rt.exitRequested = true;
    rt.phase = 'exiting';

    const sessionId = agent.sessionId;
    const sanitized = sanitizeTerminalOutput(agent.terminalOutput);
    const alreadyAtShell = /Resume this session with:/i.test(sanitized);

    if (alreadyAtShell) {
      // Claude Code already quit on its own; just close the shell.
      console.log(`AgentManager[${agentId}]: CLI already exited — closing shell`);
      void invoke('pty_write', { sessionId, data: 'exit\r' }).catch(() => {});
    } else {
      // Send `/exit` (for Claude-style TUIs) and `exit` (for plain shells)
      // as sequential writes. The CLI that's listening will handle the
      // appropriate one; the other becomes a harmless echo.
      void invoke('pty_write', { sessionId, data: '/exit\r' })
        .catch((err) => console.warn(`AgentManager[${agentId}]: /exit write failed:`, err));
      setTimeout(() => {
        const latest = this.agents.get(agentId);
        if (!latest || latest.status !== 'running') return;
        void invoke('pty_write', { sessionId, data: 'exit\r' }).catch(() => {});
      }, 4_000);
    }

    // Final escalation: if the PTY hasn't closed in time, force-kill it.
    rt.exitKillTimer = setTimeout(() => {
      const latest = this.agents.get(agentId);
      const latestRt = this.runtime.get(agentId);
      if (!latest || !latestRt) return;
      if (latest.status !== 'running') return;

      console.warn(
        `AgentManager[${agentId}]: PTY still alive after /exit — forcing kill`,
      );
      latestRt.forcedKillAfterCompletion = true;
      void invoke('pty_kill', { sessionId }).catch((err) =>
        console.error(`AgentManager[${agentId}]: pty_kill failed:`, err),
      );
    }, EXIT_ESCALATION_MS);
  }

  // -----------------------------------------------------------------------
  // PTY event handlers
  // -----------------------------------------------------------------------

  private handleAgentOutput(agentId: string, rawData: string): void {
    const agent = this.agents.get(agentId);
    const rt = this.runtime.get(agentId);
    if (!agent || !rt) return;

    agent.lastActivityAt = new Date();
    agent.terminalOutput = (agent.terminalOutput + rawData).slice(-MAX_TERMINAL_OUTPUT_CHARS);

    const sanitized = sanitizeTerminalOutput(rawData);

    // Accumulate output for readiness pattern matching during launch.
    if (rt.phase === 'spawning' || rt.phase === 'launching_cli') {
      rt.outputAccumulator = (rt.outputAccumulator + sanitized).slice(-READY_ACCUMULATOR_MAX_CHARS);
    }

    // Add sanitized output to the line buffer.
    const lines = sanitized.split('\n').map((line) => line.trimEnd());
    agent.outputBuffer.push(...lines);
    if (agent.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      agent.outputBuffer = agent.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }

    // Output-driven early transitions.
    if (rt.phase === 'spawning') {
      if (SHELL_READY_PATTERNS.some((p) => p.test(rt.outputAccumulator))) {
        console.log(
          `AgentManager[${agent.label || agent.role.name}]: shell ready detected — launching CLI early`,
        );
        void this.tryLaunchCli(agentId, 'shell-ready');
      }
    } else if (rt.phase === 'launching_cli') {
      const sinceLaunch = Date.now() - rt.cliLaunchedAt;
      // Give the CLI at least 1.5s after launch so we don't misinterpret
      // the CLI command echo itself as a "ready" prompt.
      if (sinceLaunch > 1500) {
        const patterns = getCliReadyPatterns(this.workerCLI);
        if (patterns.some((p) => p.test(rt.outputAccumulator))) {
          console.log(
            `AgentManager[${agent.label || agent.role.name}]: CLI ready detected — delivering prompt early`,
          );
          void this.tryDeliverPrompt(agentId, 'cli-ready');
        }
      }
    }

    // Pattern-based automation hooks (confirm dialogs etc.)
    if (this.patternDetector) {
      const match = this.patternDetector(sanitized);
      if (match) {
        agent.metrics.promptsProcessed++;
        this.eventEmitter.emitAgentEvent({ type: 'prompt_detected', agentId, match });
      }
    }

    // Fan-out to subscribers.
    this.eventEmitter.emitAgentEvent({ type: 'output', agentId, data: sanitized });
    for (const cb of this.outputCallbacks) {
      try { cb(agentId, sanitized); } catch (err) { console.error('AgentManager: output cb error:', err); }
    }
  }

  private handleAgentExit(agentId: string, exitCode: number | null): void {
    const agent = this.agents.get(agentId);
    const rt = this.runtime.get(agentId);
    if (!agent) return;
    if (agent.status === 'terminated') return;

    const aliveMs = Date.now() - agent.startedAt.getTime();
    const phase = rt?.phase ?? 'unknown';
    console.log(
      `AgentManager[${agent.label || agent.role.name}]: pty-exit`,
      `| exitCode=${exitCode} phase=${phase} aliveMs=${aliveMs}`,
    );

    // Clean up runtime state & prompt file.
    if (rt) {
      if (rt.completionTimer) clearInterval(rt.completionTimer);
      if (rt.exitKillTimer) clearTimeout(rt.exitKillTimer);
      if (rt.launchTimer) clearTimeout(rt.launchTimer);
      if (rt.promptTimer) clearTimeout(rt.promptTimer);
    }

    if (agent.promptFilePath) {
      remove(agent.promptFilePath).catch(() => {});
    }

    const rawCode = exitCode ?? 0;
    const neverWorked = phase === 'spawning' || phase === 'launching_cli';
    const forcedOK = rt?.forcedKillAfterCompletion && (phase === 'working' || phase === 'exiting');
    const launchFailed = Boolean(agent.failureReason) && neverWorked;

    let finalCode = rawCode;
    if (launchFailed || (neverWorked && rawCode !== 0)) {
      finalCode = rawCode !== 0 ? rawCode : 1;
      if (!agent.failureReason) {
        agent.failureReason =
          phase === 'launching_cli'
            ? `CLI failed to start (exit code ${rawCode})`
            : `Shell exited before CLI launched (exit code ${rawCode})`;
      }
    }
    if (forcedOK) finalCode = 0;

    agent.status = finalCode === 0 && !launchFailed ? 'completed' : 'failed';

    if (agent.status === 'failed') {
      const aliveStr = aliveMs < 1000 ? `${aliveMs}ms` : `${(aliveMs / 1000).toFixed(1)}s`;
      if (!agent.failureReason) {
        if (phase === 'working' || phase === 'exiting') {
          agent.failureReason = `CLI exited with code ${rawCode} after ${aliveStr}`;
        } else if (phase === 'launching_cli') {
          agent.failureReason = `CLI failed to start (exit code ${rawCode}, alive ${aliveStr})`;
        } else {
          agent.failureReason = `Shell exited before CLI launched (exit code ${rawCode}, alive ${aliveStr})`;
        }
      }
    }

    this.runtime.delete(agentId);
    this.sessionToAgent.delete(agent.sessionId);

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
          output: this.getAgentHandoffOutput(agentId),
          filesModified: agent.metrics.filesModified,
        },
      });
    } else {
      this.eventEmitter.emitAgentEvent({
        type: 'failed',
        agentId,
        error: agent.failureReason || `Agent exited with code ${finalCode}`,
      });
    }

    for (const cb of this.exitCallbacks) {
      try { cb(agentId, finalCode); } catch (err) { console.error('AgentManager: exit cb error:', err); }
    }
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
      default:
        if (cliOption) { parts.push(cliOption.command); }
        else { parts.push('claude', '--dangerously-skip-permissions'); }
        break;
    }

    // `set +e` keeps the shell from exiting if the CLI returns non-zero.
    // Trailing \r submits the command.
    return `set +e 2>/dev/null; ${parts.join(' ')}\r`;
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

    console.log(`AgentManager[${agent.label || agent.role.name}]: terminate (${reason})`);

    agent.status = 'terminated';
    agent.failureReason = reason;

    const rt = this.runtime.get(agentId);
    if (rt) {
      if (rt.completionTimer) clearInterval(rt.completionTimer);
      if (rt.exitKillTimer) clearTimeout(rt.exitKillTimer);
      if (rt.launchTimer) clearTimeout(rt.launchTimer);
      if (rt.promptTimer) clearTimeout(rt.promptTimer);
    }

    if (agent.promptFilePath) {
      remove(agent.promptFilePath).catch(() => {});
    }

    try {
      // Send Ctrl-C first in case the CLI is prompting interactively.
      await invoke('pty_write', { sessionId: agent.sessionId, data: '\x03' });
      await delay(300);
      await invoke('pty_kill', { sessionId: agent.sessionId });
    } catch (err) {
      console.error(`AgentManager[${agentId}]: terminate failed:`, err);
    }

    this.runtime.delete(agentId);
    this.sessionToAgent.delete(agent.sessionId);

    this.eventEmitter.emitAgentEvent({ type: 'terminated', agentId, reason });
    for (const cb of this.exitCallbacks) {
      try { cb(agentId, null); } catch (err) { console.error('AgentManager: exit cb error:', err); }
    }

    this.agents.delete(agentId);
  }

  async terminateAll(reason: string = 'Swarm stopped'): Promise<void> {
    const ids = Array.from(this.agents.keys());
    await Promise.all(ids.map((id) => this.terminateAgent(id, reason)));
    for (const sessionId of [...this.coordinatorSessions]) {
      this.coordinatorSessions.delete(sessionId);
      try {
        await invoke('pty_kill', { sessionId });
      } catch (err) {
        console.error(`AgentManager: coordinator session kill failed (${sessionId}):`, err);
      }
    }
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

  getAgentCount(): number {
    return this.agents.size;
  }

  getActiveAgentCount(): number {
    return Array.from(this.agents.values()).filter(
      (a) => a.status === 'running' || a.status === 'waiting_for_input',
    ).length;
  }

  getAgentOutput(agentId: string): string[] {
    const agent = this.agents.get(agentId);
    return agent ? [...agent.outputBuffer] : [];
  }

  /** Full session text for coordinator handoff — prefers sanitized PTY replay. */
  getAgentHandoffOutput(agentId: string): string {
    const agent = this.agents.get(agentId);
    if (!agent) return '';
    const fromTerm = sanitizeTerminalOutput(agent.terminalOutput).trim();
    if (fromTerm.length > 0) return fromTerm;
    return agent.outputBuffer.join('\n');
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
