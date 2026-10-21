/**
 * Swarm run history — the last few runs, kept in localStorage so a finished run's
 * report survives restarts and panel closes.
 */

import type { ChangedFile } from './report';

export interface SwarmHistoryEntry {
  id: string;
  goal: string;
  workspacePath: string;
  workspaceName: string;
  startedAt: number;
  finishedAt: number;
  verdict: 'approved' | 'max-iterations' | 'unreviewed' | 'stopped' | 'error';
  iterations: number;
  workerCount: number;
  cli: string;
  changes: ChangedFile[];
  reportMarkdown: string;
}

const STORAGE_KEY = 'velix-swarm-history';
const MAX_ENTRIES = 15;
const MAX_REPORT_CHARS = 60_000;

export function loadSwarmHistory(): SwarmHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SwarmHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveSwarmRun(entry: SwarmHistoryEntry): SwarmHistoryEntry[] {
  const trimmed: SwarmHistoryEntry = {
    ...entry,
    reportMarkdown: entry.reportMarkdown.slice(0, MAX_REPORT_CHARS),
  };
  const next = [trimmed, ...loadSwarmHistory().filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded: drop the oldest half and try once more.
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(0, Math.ceil(MAX_ENTRIES / 2))));
    } catch {
      /* history is best-effort */
    }
  }
  return next;
}

export function clearSwarmHistory(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
