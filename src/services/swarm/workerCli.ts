/**
 * Worker CLI definitions and invocation building.
 *
 * Workers run as plain child processes (see src-tauri/src/agent.rs) — no shell,
 * so there is no quoting to get wrong. A worker invocation is just:
 *   program + argv + optional stdin text.
 */

import { invoke } from '../../platform/native';
import type { WorkerCLI } from './types';

export interface WorkerCLIOption {
  id: WorkerCLI;
  name: string;
  command: string;
  description: string;
  builtin?: boolean;
}

export interface WorkerCLIStatus {
  available: boolean;
  detail: string;
}

export interface WorkerInvocation {
  program: string;
  args: string[];
  /** Prompt text piped to stdin (undefined → prompt is in argv). */
  stdin?: string;
  /** Output is newline-delimited stream-json that `createStreamParser` understands. */
  streamJson: boolean;
}

export interface WorkerModelHint {
  provider: string;
  model: string;
}

const BUILTIN_CLI_OPTIONS: WorkerCLIOption[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', description: 'Anthropic Claude Code CLI', builtin: true },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', description: 'Google Gemini terminal agent', builtin: true },
  { id: 'codex', name: 'Codex CLI', command: 'codex', description: 'OpenAI Codex CLI', builtin: true },
  { id: 'copilot', name: 'Copilot CLI', command: 'copilot', description: 'GitHub Copilot CLI', builtin: true },
  { id: 'velix', name: 'Velix CLI', command: 'velix', description: 'Velix AI CLI', builtin: true },
];

const CUSTOM_CLI_STORAGE_KEY = 'velix-custom-cli-options';

/** Prompts passed through argv are capped; stdin-capable CLIs have no such limit. */
export const MAX_ARGV_PROMPT_CHARS = 100_000;

export function loadCustomCLIOptions(): WorkerCLIOption[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_CLI_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as WorkerCLIOption[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomCLIOptions(options: WorkerCLIOption[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CUSTOM_CLI_STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Storage full or unavailable — custom CLIs just won't persist.
  }
}

export function getWorkerCLIOptions(): WorkerCLIOption[] {
  return [...BUILTIN_CLI_OPTIONS, ...loadCustomCLIOptions()];
}

/** @deprecated Use getWorkerCLIOptions() — kept for import compatibility. */
export const WORKER_CLI_OPTIONS = BUILTIN_CLI_OPTIONS;

export async function detectWorkerCLIAvailability(): Promise<Record<WorkerCLI, WorkerCLIStatus>> {
  const entries = await Promise.all(
    getWorkerCLIOptions().map(async (option) => {
      // A custom command may carry flags ("mycli --yolo"); only the binary is probed.
      const binary = splitCommand(option.command)[0] ?? option.command;
      try {
        const path = await invoke<string>('check_cli_available', { command: binary });
        return [option.id, { available: true, detail: path }] as const;
      } catch {
        return [option.id, { available: false, detail: 'Not found in PATH' }] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** Split a command line into argv, honouring single/double quotes. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken || current) out.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (hasToken || current) out.push(current);
  return out;
}

/**
 * Build the headless, non-interactive invocation for a worker CLI.
 * `workerModel` (optional) overrides the CLI's own default model.
 */
export function buildWorkerInvocation(
  workerCLI: WorkerCLI,
  prompt: string,
  workerModel?: string,
): WorkerInvocation {
  const option = getWorkerCLIOptions().find((o) => o.id === workerCLI);
  const argvPrompt = prompt.length > MAX_ARGV_PROMPT_CHARS
    ? `${prompt.slice(0, MAX_ARGV_PROMPT_CHARS)}\n\n[prompt truncated for argv limits]`
    : prompt;
  const model = workerModel?.trim();

  switch (workerCLI) {
    case 'claude': {
      // Prompt on stdin; stream-json gives live tool activity instead of silence until exit.
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      return { program: 'claude', args, stdin: prompt, streamJson: true };
    }
    case 'codex': {
      const args = ['exec', '--full-auto'];
      if (model) args.push('-m', model);
      args.push('-'); // read instructions from stdin
      return { program: 'codex', args, stdin: prompt, streamJson: false };
    }
    case 'gemini': {
      const args = ['--yolo'];
      if (model) args.push('-m', model);
      args.push('-p', argvPrompt);
      return { program: 'gemini', args, streamJson: false };
    }
    case 'copilot': {
      const args = ['-p', argvPrompt, '--allow-all-tools'];
      if (model) args.push('--model', model);
      return { program: 'copilot', args, streamJson: false };
    }
    case 'velix':
      return { program: 'velix', args: ['-p', argvPrompt], streamJson: false };
    default: {
      // Custom CLI: "<command...> -p <prompt>"
      const base = splitCommand(option?.command ?? workerCLI);
      const [program, ...rest] = base.length > 0 ? base : [workerCLI];
      return { program, args: [...rest, '-p', argvPrompt], streamJson: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Claude stream-json parsing
// ---------------------------------------------------------------------------

export interface ActivityEntry {
  at: number;
  kind: 'text' | 'tool' | 'info' | 'error';
  text: string;
}

export interface StreamParseResult {
  /** Final answer text, once the CLI emitted its `result` event. */
  finalText?: string;
  /** True when the CLI reported an error result. */
  isError?: boolean;
  costUsd?: number;
  /** Files that edit/write tools touched, for the run report. */
  filesTouched: string[];
  activity: ActivityEntry[];
}

export interface StreamParser {
  push(chunk: string): void;
  /** Flush a trailing partial line (call at process exit). */
  end(): void;
  snapshot(): StreamParseResult & { assistantText: string };
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_ACTIVITY = 200;

function summarizeToolInput(name: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof obj[k] === 'string' ? (obj[k] as string) : '');
  const target =
    pick('file_path') || pick('path') || pick('notebook_path') || pick('pattern') || pick('url') || pick('description');
  const command = pick('command');
  const detail = command || target;
  const short = detail.length > 120 ? `${detail.slice(0, 117)}…` : detail;
  return short ? `${name} ${short}` : name;
}

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose`.
 * Tolerant by design: non-JSON lines are kept as plain text activity so an older or
 * different CLI never loses output.
 */
export function createStreamParser(now: () => number = Date.now): StreamParser {
  let buffer = '';
  let finalText: string | undefined;
  let isError: boolean | undefined;
  let costUsd: number | undefined;
  const activity: ActivityEntry[] = [];
  const assistantChunks: string[] = [];
  const files = new Set<string>();

  const addActivity = (entry: ActivityEntry) => {
    activity.push(entry);
    if (activity.length > MAX_ACTIVITY) activity.splice(0, activity.length - MAX_ACTIVITY);
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line[0] !== '{') {
      addActivity({ at: now(), kind: 'text', text: line });
      assistantChunks.push(line);
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      addActivity({ at: now(), kind: 'text', text: line });
      assistantChunks.push(line);
      return;
    }

    const type = event.type;
    if (type === 'assistant') {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          assistantChunks.push(block.text);
          const first = block.text.trim().split('\n')[0];
          addActivity({ at: now(), kind: 'text', text: first.length > 160 ? `${first.slice(0, 157)}…` : first });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          addActivity({ at: now(), kind: 'tool', text: summarizeToolInput(block.name, block.input) });
          if (FILE_TOOLS.has(block.name)) {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const p = (input.file_path ?? input.notebook_path ?? input.path) as unknown;
            if (typeof p === 'string' && p) files.add(p);
          }
        }
      }
    } else if (type === 'result') {
      if (typeof event.result === 'string') finalText = event.result;
      if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'))) {
        isError = true;
        addActivity({ at: now(), kind: 'error', text: String(event.result ?? event.subtype ?? 'Run failed') });
      }
      const cost = event.total_cost_usd ?? event.cost_usd;
      if (typeof cost === 'number') costUsd = cost;
    } else if (type === 'system' && event.subtype === 'init') {
      addActivity({ at: now(), kind: 'info', text: `Session started${typeof event.model === 'string' ? ` · ${event.model}` : ''}` });
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    end() {
      if (buffer.trim()) handleLine(buffer);
      buffer = '';
    },
    snapshot() {
      return {
        finalText,
        isError,
        costUsd,
        filesTouched: [...files],
        activity: [...activity],
        assistantText: assistantChunks.join('\n'),
      };
    },
  };
}
