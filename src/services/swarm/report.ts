/**
 * Run report: a Markdown summary of what the swarm did, shareable and saved in history.
 */

import { invoke } from '../../platform/native';
import type { Agent } from './types';
import type { CoordinatorPlan } from './ClaudeCoordinator';
import type { SwarmFinalVerdict } from './SwarmRunner';

export interface ChangedFile {
  path: string;
  status: string;
}

export interface GitSnapshot {
  branch: string;
  files: ChangedFile[];
}

/** Snapshot `git status`; returns null outside a git repo or when git is unavailable. */
export async function captureGitSnapshot(workspacePath: string): Promise<GitSnapshot | null> {
  try {
    const status = await invoke<{ branch: string; files: Array<{ path: string; status: string }> }>(
      'get_git_status',
      { repoPath: workspacePath },
    );
    return { branch: status.branch, files: status.files.map((f) => ({ path: f.path, status: f.status })) };
  } catch {
    return null;
  }
}

/** Files that are new or changed state since `before` — an approximation of "what the swarm touched". */
export function diffSnapshots(before: GitSnapshot | null, after: GitSnapshot | null): ChangedFile[] {
  if (!after) return [];
  const prior = new Map((before?.files ?? []).map((f) => [f.path, f.status]));
  return after.files.filter((f) => prior.get(f.path) !== f.status);
}

export interface SwarmReportInput {
  goal: string;
  workspaceName: string;
  cli: string;
  startedAt: number;
  finishedAt: number;
  verdict: SwarmFinalVerdict | 'stopped' | 'error';
  iterations: number;
  plan: CoordinatorPlan | null;
  agents: Agent[];
  changes: ChangedFile[];
  error?: string;
}

const VERDICT_TEXT: Record<SwarmReportInput['verdict'], string> = {
  approved: 'Approved by reviewers',
  'max-iterations': 'Reviewers still had concerns after the final round',
  unreviewed: 'Completed without a reviewer verdict',
  stopped: 'Stopped before finishing',
  error: 'Failed',
};

export const formatDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const excerpt = (text: string, max: number): string => {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** Latest attempt per assignment. */
function latestAttempts(agents: Agent[]): Map<string, Agent> {
  const latest = new Map<string, Agent>();
  for (const a of agents) {
    const key = a.assignmentId ?? a.id;
    const prev = latest.get(key);
    if (!prev || a.attempt >= prev.attempt) latest.set(key, a);
  }
  return latest;
}

export function buildReportMarkdown(input: SwarmReportInput): string {
  const lines: string[] = [];
  const cost = input.agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);

  lines.push(`# Swarm report — ${input.workspaceName}`, '');
  lines.push(`**Goal:** ${input.goal}`, '');
  lines.push(`- **Result:** ${VERDICT_TEXT[input.verdict]}`);
  const failed = [...latestAttempts(input.agents).values()].filter((a) => a.status === 'failed');
  if (failed.length > 0) {
    lines.push(`- **Failed workers:** ${failed.map((a) => a.label ?? a.role.name).join(', ')}`);
  }
  lines.push(`- **Duration:** ${formatDuration(input.finishedAt - input.startedAt)}`);
  lines.push(`- **Review rounds:** ${input.iterations}`);
  lines.push(`- **Worker CLI:** ${input.cli}`);
  if (cost > 0) lines.push(`- **Reported cost:** $${cost.toFixed(2)}`);
  if (input.error) lines.push(`- **Error:** ${input.error}`);
  lines.push('');

  if (input.plan?.strategy) lines.push('## Strategy', '', input.plan.strategy, '');

  lines.push('## Changes', '');
  if (input.changes.length === 0) {
    lines.push('_No working-tree changes detected (or not a git repository)._', '');
  } else {
    for (const f of input.changes) lines.push(`- \`${f.status}\` ${f.path}`);
    lines.push('');
  }

  lines.push('## Workers', '');
  for (const a of latestAttempts(input.agents).values()) {
    const seconds = a.endedAt ? formatDuration(a.endedAt.getTime() - a.startedAt.getTime()) : 'running';
    lines.push(`### ${a.label ?? a.role.name} — ${a.status} (${seconds}${a.attempt > 1 ? `, attempt ${a.attempt}` : ''})`, '');
    if (a.failureReason) lines.push(`> ${a.failureReason}`, '');
    if (a.filesTouched.length > 0) lines.push(`Files touched: ${a.filesTouched.map((f) => `\`${f}\``).join(', ')}`, '');
  }

  return lines.join('\n').trimEnd() + '\n';
}
