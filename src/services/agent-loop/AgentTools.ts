import { invoke, readTextFile, writeTextFile } from '../../platform/native';
import type { ApprovalKind, ApprovalRequest, ExecutionAction, ExecutionResult } from './types';

export function actionsAreResearchOnly(actions: ExecutionAction[]): boolean {
  return (
    actions.length > 0 &&
    actions.every((a) => a.type === 'read_file' || a.type === 'search_files' || a.type === 'noop')
  );
}

export function actionsProduceDeliverables(actions: ExecutionAction[]): boolean {
  return actions.some(
    (a) => a.type === 'write_file' || a.type === 'edit_file' || a.type === 'run_terminal',
  );
}

export interface ToolContext {
  workspacePath: string;
  requireApprovalForEdits?: boolean;
  onApprovalRequired: (request: ApprovalRequest) => Promise<boolean>;
  onFilesModified: (paths: string[]) => void;
  onCommandsExecuted: (commands: string[]) => void;
}

function resolvePath(workspacePath: string, relativePath: string): string {
  const trimmed = relativePath.trim().replace(/^\.\//, '');
  if (trimmed.startsWith('/')) return trimmed;
  return `${workspacePath.replace(/\/$/, '')}/${trimmed}`;
}

function classifyApproval(action: ExecutionAction): ApprovalKind | null {
  if (action.type === 'run_terminal') {
    const cmd = (action.command ?? '').toLowerCase();
    if (/\bgit\s+(push|reset|rebase|checkout|merge|commit)\b/.test(cmd)) return 'git_operation';
    if (/\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b/.test(cmd)) return 'install_deps';
  }
  if (action.type === 'write_file' || action.type === 'edit_file') {
    const path = (action.path ?? '').toLowerCase();
    if (path.includes('migration') || path.includes('migrate')) return 'migration';
  }
  return null;
}

export async function executeAction(
  action: ExecutionAction,
  ctx: ToolContext,
): Promise<ExecutionResult> {
  try {
    switch (action.type) {
      case 'read_file': {
        const path = resolvePath(ctx.workspacePath, action.path ?? '');
        const content = await readTextFile(path);
        return { success: true, output: content.slice(0, 12_000), action };
      }
      case 'write_file':
      case 'edit_file': {
        const path = resolvePath(ctx.workspacePath, action.path ?? '');
        const approvalKind = classifyApproval(action);
        const needsApproval = ctx.requireApprovalForEdits || approvalKind;
        if (needsApproval) {
          const approved = await ctx.onApprovalRequired({
            id: `approval-${Date.now()}`,
            kind: approvalKind ?? 'large_refactor',
            title: `${action.type === 'write_file' ? 'Write' : 'Edit'} ${action.path}`,
            description: action.summary ?? `Modify ${action.path}`,
            diffPreview: action.content?.slice(0, 2000),
            createdAt: Date.now(),
          });
          if (!approved) {
            return { success: false, output: 'User declined approval.', action };
          }
        }
        let nextContent = action.content ?? '';
        if (action.type === 'edit_file' && action.oldString != null && action.newString != null) {
          const existing = await readTextFile(path);
          if (!existing.includes(action.oldString)) {
            return {
              success: false,
              output: `edit_file: old_string not found in ${action.path}`,
              action,
            };
          }
          nextContent = existing.replace(action.oldString, action.newString);
        } else if (action.type === 'edit_file' && !nextContent) {
          return { success: false, output: 'edit_file requires content or old_string + new_string.', action };
        }
        await writeTextFile(path, nextContent);
        ctx.onFilesModified([path]);
        return { success: true, output: `Wrote ${action.path}`, action };
      }
      case 'search_files': {
        const result = await invoke<Array<{ file: string; line: number; text: string }>>('search_in_files', {
          directory: ctx.workspacePath,
          pattern: action.search ?? '',
          maxResults: 20,
        });
        const formatted = result
          .map((hit) => `${hit.file}:${hit.line}\n${hit.text}`)
          .join('\n---\n');
        return { success: true, output: formatted || 'No matches.', action };
      }
      case 'run_terminal': {
        const command = action.command ?? '';
        const approvalKind = classifyApproval(action);
        const needsApproval = ctx.requireApprovalForEdits || approvalKind;
        if (needsApproval) {
          const approved = await ctx.onApprovalRequired({
            id: `approval-${Date.now()}`,
            kind: approvalKind ?? 'git_operation',
            title: 'Run terminal command',
            description: command,
            createdAt: Date.now(),
          });
          if (!approved) {
            return { success: false, output: 'User declined approval.', action };
          }
        }
        const shell = await invoke<{ stdout: string; stderr: string; exitCode: number }>(
          'execute_shell_command',
          { command, cwd: ctx.workspacePath },
        );
        ctx.onCommandsExecuted([command]);
        const output = [shell.stdout, shell.stderr].filter(Boolean).join('\n').slice(0, 8000);
        return {
          success: shell.exitCode === 0,
          output: output || `(exit ${shell.exitCode})`,
          action,
        };
      }
      case 'noop':
      default:
        return { success: true, output: action.summary ?? 'No operation.', action };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: message, action };
  }
}

export interface ParsedActions {
  actions: ExecutionAction[];
  error?: string;
}

function extractBalancedJsonObject(text: string, start: number): string | null {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
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

function normalizeAction(raw: Record<string, unknown>): ExecutionAction | null {
  if (typeof raw.function === 'string' && raw.arguments && typeof raw.arguments === 'object') {
    return normalizeAction({
      type: raw.function,
      ...(raw.arguments as Record<string, unknown>),
    });
  }

  const typeRaw = String(raw.type ?? raw.tool ?? raw.action ?? raw.name ?? '')
    .toLowerCase()
    .replace(/-/g, '_');
  const aliases: Record<string, ExecutionAction['type']> = {
    read: 'read_file',
    read_file: 'read_file',
    readfile: 'read_file',
    write: 'write_file',
    write_file: 'write_file',
    writefile: 'write_file',
    edit: 'edit_file',
    edit_file: 'edit_file',
    patch: 'edit_file',
    apply_patch: 'edit_file',
    search: 'search_files',
    search_files: 'search_files',
    grep: 'search_files',
    find: 'search_files',
    glob: 'search_files',
    list: 'search_files',
    list_dir: 'search_files',
    list_directory: 'search_files',
    ripgrep: 'search_files',
    terminal: 'run_terminal',
    run_terminal: 'run_terminal',
    run_terminal_cmd: 'run_terminal',
    run_command: 'run_terminal',
    shell: 'run_terminal',
    bash: 'run_terminal',
    command: 'run_terminal',
    exec: 'run_terminal',
    execute: 'run_terminal',
    noop: 'noop',
  };
  let type = aliases[typeRaw];
  if (!type) {
    if (typeof raw.command === 'string' || typeof raw.cmd === 'string') {
      type = 'run_terminal';
    } else if (
      (typeof raw.path === 'string' || typeof raw.file === 'string') &&
      typeof raw.content !== 'string'
    ) {
      type = 'read_file';
    } else if (
      typeof raw.search === 'string' ||
      typeof raw.query === 'string' ||
      typeof raw.pattern === 'string'
    ) {
      type = 'search_files';
    }
  }
  if (!type) return null;
  return {
    type,
    path: typeof raw.path === 'string' ? raw.path : typeof raw.file === 'string' ? raw.file : undefined,
    content: typeof raw.content === 'string' ? raw.content : undefined,
    search:
      typeof raw.search === 'string'
        ? raw.search
        : typeof raw.query === 'string'
          ? raw.query
          : typeof raw.pattern === 'string'
            ? raw.pattern
            : undefined,
    command:
      typeof raw.command === 'string'
        ? raw.command
        : typeof raw.cmd === 'string'
          ? raw.cmd
          : undefined,
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    oldString:
      typeof raw.old_string === 'string'
        ? raw.old_string
        : typeof raw.oldString === 'string'
          ? raw.oldString
          : undefined,
    newString:
      typeof raw.new_string === 'string'
        ? raw.new_string
        : typeof raw.newString === 'string'
          ? raw.newString
          : typeof raw.replace === 'string'
            ? raw.replace
            : undefined,
  };
}

function tryParseActionsJson(text: string): ExecutionAction[] | null {
  try {
    const parsed = JSON.parse(text) as { actions?: unknown[] };
    if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) return null;
    const actions = parsed.actions
      .map((item) =>
        item && typeof item === 'object' ? normalizeAction(item as Record<string, unknown>) : null,
      )
      .filter((action): action is ExecutionAction => action !== null);
    return actions.length > 0 ? actions : null;
  } catch {
    return null;
  }
}

/** Parse coder JSON — tolerates bare JSON, generic fences, and common field aliases. */
export function parseActionsFromResponse(raw: string): ParsedActions {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { actions: [], error: 'Model returned an empty response.' };
  }

  const candidates: string[] = [];

  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) candidates.push(jsonFence[1].trim());

  const anyFence = trimmed.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (anyFence) candidates.push(anyFence[1].trim());

  candidates.push(trimmed);

  const actionsIdx = trimmed.indexOf('"actions"');
  if (actionsIdx >= 0) {
    const start = trimmed.lastIndexOf('{', actionsIdx);
    if (start >= 0) {
      const slice = extractBalancedJsonObject(trimmed, start);
      if (slice) candidates.push(slice);
    }
  }

  for (const candidate of candidates) {
    const actions = tryParseActionsJson(candidate);
    if (actions) return { actions };
  }

  return {
    actions: [],
    error:
      'Could not parse a non-empty "actions" array from the model response. Expected JSON with actions[].',
  };
}
