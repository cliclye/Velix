import { useCallback, useEffect, useState } from 'react';
import { PROVIDERS, type ProviderID } from '../../services/ai/types';
import { getWorkerCLIOptions } from '../../services/swarm';
import type { SwarmRoleCounts } from '../../services/swarm';

export interface SwarmSettings {
  roleCounts: SwarmRoleCounts;
  workerCLI: string;
  workerModel: string;
  coordinatorProvider: ProviderID;
  coordinatorModel: string;
  maxMode: boolean;
  maxReviewIterations: number;
  concurrency: number;
  useSavedClaudeKey: boolean;
}

const STORAGE_KEY = 'velix-swarm-settings';

export const DEFAULT_SETTINGS: SwarmSettings = {
  roleCounts: { scout: 1, builder: 2, reviewer: 1 },
  workerCLI: 'claude',
  workerModel: '',
  coordinatorProvider: 'claude',
  coordinatorModel: '',
  maxMode: false,
  maxReviewIterations: 3,
  concurrency: 6,
  useSavedClaudeKey: false,
};

const clampInt = (n: unknown, min: number, max: number, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(max, Math.max(min, v));
};

/** Validate whatever is in storage; never trust it to have the current shape. */
export function sanitizeSettings(raw: unknown): SwarmSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof SwarmSettings, unknown>>;
  const counts = (r.roleCounts && typeof r.roleCounts === 'object' ? r.roleCounts : {}) as Partial<SwarmRoleCounts>;
  const cliIds = getWorkerCLIOptions().map((o) => o.id);
  const provider = PROVIDERS.some((p) => p.id === r.coordinatorProvider)
    ? (r.coordinatorProvider as ProviderID)
    : DEFAULT_SETTINGS.coordinatorProvider;
  const providerModels = PROVIDERS.find((p) => p.id === provider)?.models ?? [];
  const model = typeof r.coordinatorModel === 'string' && providerModels.includes(r.coordinatorModel) ? r.coordinatorModel : '';

  return {
    roleCounts: {
      scout: clampInt(counts.scout, 0, 5, DEFAULT_SETTINGS.roleCounts.scout),
      builder: clampInt(counts.builder, 1, 20, DEFAULT_SETTINGS.roleCounts.builder),
      reviewer: clampInt(counts.reviewer, 0, 5, DEFAULT_SETTINGS.roleCounts.reviewer),
    },
    workerCLI: typeof r.workerCLI === 'string' && cliIds.includes(r.workerCLI) ? r.workerCLI : DEFAULT_SETTINGS.workerCLI,
    workerModel: typeof r.workerModel === 'string' ? r.workerModel : '',
    coordinatorProvider: provider,
    coordinatorModel: model,
    maxMode: r.maxMode === true,
    maxReviewIterations: clampInt(r.maxReviewIterations, 1, 6, DEFAULT_SETTINGS.maxReviewIterations),
    concurrency: clampInt(r.concurrency, 1, 12, DEFAULT_SETTINGS.concurrency),
    useSavedClaudeKey: r.useSavedClaudeKey === true,
  };
}

function load(): SwarmSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeSettings(JSON.parse(raw));
    // Migrate the individual keys written by earlier versions.
    const legacy = {
      workerCLI: window.localStorage.getItem('velix-swarm-worker-cli') ?? undefined,
      coordinatorProvider: window.localStorage.getItem('velix-swarm-coordinator-provider') ?? undefined,
      coordinatorModel: window.localStorage.getItem('velix-swarm-coordinator-model') ?? undefined,
      maxMode: window.localStorage.getItem('velix-swarm-max-mode') === 'true',
    };
    return sanitizeSettings(legacy);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function useSwarmSettings(): [SwarmSettings, (patch: Partial<SwarmSettings>) => void] {
  const [settings, setSettings] = useState<SwarmSettings>(load);

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* best effort */ }
  }, [settings]);

  const update = useCallback((patch: Partial<SwarmSettings>) => {
    setSettings((prev) => sanitizeSettings({ ...prev, ...patch }));
  }, []);

  return [settings, update];
}
