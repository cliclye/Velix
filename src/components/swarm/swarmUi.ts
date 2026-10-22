import type { Agent, AgentRoleType } from '../../services/swarm/types';
import type { CoordinatorAssignment } from '../../services/swarm/ClaudeCoordinator';
import type { SwarmPhase } from '../../services/swarm';
import type { NodeTone } from './SwarmMindMap';

export type LaunchRole = Extract<AgentRoleType, 'scout' | 'builder' | 'reviewer'>;
export const LAUNCH_ROLES: LaunchRole[] = ['scout', 'builder', 'reviewer'];

export const ROLE_LIMITS: Record<LaunchRole, { min: number; max: number }> = {
  scout: { min: 0, max: 5 },
  builder: { min: 1, max: 20 },
  reviewer: { min: 0, max: 5 },
};
export const MAX_WORKERS = 25;

export const ROLE_COPY: Record<LaunchRole, { title: string; hint: string }> = {
  scout: { title: 'Scouts', hint: 'Map the code and flag risks before anyone edits.' },
  builder: { title: 'Builders', hint: 'Each owns a slice of the work and ships it.' },
  reviewer: { title: 'Reviewers', hint: 'Inspect the real changes and send weak work back.' },
};

export const isLive = (agent: Agent | undefined): boolean =>
  !!agent && (agent.status === 'running' || agent.status === 'initializing');

export interface AssignmentState {
  label: string;
  tone: NodeTone;
}

/** Board/graph status for an assignment, from its latest agent attempt. */
export function assignmentState(assignment: CoordinatorAssignment, agent: Agent | undefined): AssignmentState {
  if (!agent) return { label: 'Queued', tone: 'queued' };
  switch (agent.status) {
    case 'initializing': return { label: 'Starting', tone: 'queued' };
    case 'completed': return { label: 'Done', tone: 'done' };
    case 'failed': return { label: 'Failed', tone: 'blocked' };
    case 'terminated': return { label: 'Stopped', tone: 'blocked' };
    default:
      if (assignment.role === 'reviewer') return { label: 'Reviewing', tone: 'review' };
      if (assignment.role === 'scout') return { label: 'Mapping', tone: 'mapping' };
      return { label: 'Building', tone: 'building' };
  }
}

export const PHASE_STEPS = ['Plan', 'Scout', 'Build', 'Review', 'Done'] as const;

/** Index into PHASE_STEPS the swarm is currently on; steps before it are complete. */
export function phaseIndex(phase: SwarmPhase): number {
  switch (phase) {
    case 'planning': return 0;
    case 'scouting': return 1;
    case 'building': return 2;
    case 'reviewing':
    case 'evaluating': return 3;
    case 'complete': return 5;
    default: return -1;
  }
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function agentElapsed(agent: Agent, now: number): string {
  const end = agent.endedAt ? agent.endedAt.getTime() : now;
  return formatElapsed(end - agent.startedAt.getTime());
}

/** One-line "what is it doing" for a card. */
export function liveLine(agent: Agent | undefined): string {
  if (!agent) return 'Waiting for its turn';
  if (agent.status === 'initializing') return 'Starting…';
  if ((agent.status === 'failed' || agent.status === 'terminated') && agent.failureReason) return agent.failureReason;
  const last = agent.activity[agent.activity.length - 1];
  if (last) return last.text;
  if (agent.status === 'running') {
    const lastOut = agent.output.trim().split('\n').filter(Boolean).pop();
    return lastOut ? lastOut.slice(0, 140) : 'Working — this CLI prints its result when done';
  }
  return agent.status === 'completed' ? 'Finished' : '';
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const normalizeId = (value: string): string =>
  value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Dependency edges (by assignment id) for the graph view. */
export function buildConnections(assignments: CoordinatorAssignment[]): Array<{ from: string; to: string; kind: 'automatic' }> {
  const byKey = new Map<string, string>();
  for (const a of assignments) {
    byKey.set(normalizeId(a.id), a.id);
    byKey.set(normalizeId(a.label), a.id);
  }
  const seen = new Set<string>();
  const out: Array<{ from: string; to: string; kind: 'automatic' }> = [];
  for (const a of assignments) {
    for (const dep of a.dependencies) {
      const from = byKey.get(normalizeId(dep));
      if (!from || from === a.id) continue;
      const key = `${from}->${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, to: a.id, kind: 'automatic' });
    }
  }
  return out;
}

/** Short 2–3 word summary of a task for graph nodes. */
export function workSummary(task: string | undefined, fallback: string): string {
  const words = (task ?? '')
    .replace(/[^a-z0-9\s/-]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^\d+$/.test(w));
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'your', 'inside', 'before']);
  const picked = words.filter((w) => !stop.has(w.toLowerCase())).slice(0, 3);
  return picked.length ? picked.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : fallback;
}
