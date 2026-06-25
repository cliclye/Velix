/**
 * Role presets and custom slot configuration for the agent loop.
 */

import type { ProviderID } from '../ai/modelCatalog';
import { getDefaultModel } from '../ai/modelCatalog';
import type { SlotConfig } from './types';

export type LoopPresetId = 'quick' | 'balanced' | 'cheap' | 'custom';

export interface LoopPreset {
  id: LoopPresetId;
  label: string;
  description: string;
  slots: SlotConfig;
}

function slot(provider: ProviderID, model?: string) {
  return { provider, model: model ?? getDefaultModel(provider) };
}

export const LOOP_PRESETS: LoopPreset[] = [
  {
    id: 'quick',
    label: 'Quick',
    description: 'One model for every stage — simple and fast.',
    slots: {
      planning: slot('claude', 'claude-sonnet-4-6'),
      coding: slot('claude', 'claude-sonnet-4-6'),
      review: slot('claude', 'claude-sonnet-4-6'),
      reasoning: slot('claude', 'claude-sonnet-4-6'),
    },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Claude for planning/coding, GPT for review and reasoning.',
    slots: {
      planning: slot('claude', 'claude-sonnet-4-6'),
      coding: slot('claude', 'claude-sonnet-4-6'),
      review: slot('chatgpt', 'gpt-5.5'),
      reasoning: slot('chatgpt', 'gpt-5.4-mini'),
    },
  },
  {
    id: 'cheap',
    label: 'Cheap',
    description: 'Gemini Flash across all stages to minimize cost.',
    slots: {
      planning: slot('gemini', 'gemini-3.5-flash'),
      coding: slot('gemini', 'gemini-3.5-flash'),
      review: slot('gemini', 'gemini-3.5-flash'),
      reasoning: slot('gemini', 'gemini-3.5-flash'),
    },
  },
  {
    id: 'custom',
    label: 'Power User',
    description: 'Configure each capability slot independently.',
    slots: {
      planning: slot('claude', 'claude-sonnet-4-6'),
      coding: slot('chatgpt', 'gpt-5.5'),
      review: slot('gemini', 'gemini-3.1-pro'),
      reasoning: slot('chatgpt', 'gpt-5.4-mini'),
    },
  },
];

export const SLOT_LABELS: Record<keyof SlotConfig, string> = {
  planning: 'Planning',
  coding: 'Coding',
  review: 'Review',
  reasoning: 'Reasoning',
};

export const DEFAULT_LOOP_CONFIG = {
  mode: 'guided' as const,
  presetId: 'balanced' as LoopPresetId,
  transport: 'api' as const,
  maxIterations: 25,
  maxRetries: 2,
};

export const LOOP_CLI_TRANSPORT_STORAGE_KEY = 'velix-loop-use-cli';

export function getPresetSlots(presetId: LoopPresetId): SlotConfig {
  const preset = LOOP_PRESETS.find((p) => p.id === presetId);
  return preset?.slots ?? LOOP_PRESETS[1].slots;
}
