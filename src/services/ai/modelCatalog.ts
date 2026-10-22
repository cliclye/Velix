/**
 * Canonical provider + model catalog for Velix ADE.
 * Single source of truth for API providers, models, and display metadata.
 */

export type ProviderID = 'claude' | 'chatgpt' | 'gemini';

export interface ModelEntry {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface AIProviderCatalogEntry {
  id: ProviderID;
  name: string;
  models: ModelEntry[];
  placeholder: string;
  apiKeyUrl: string;
  apiKeySteps: string[];
  description?: string;
}

export const PROVIDER_CATALOG: AIProviderCatalogEntry[] = [
  {
    id: 'claude',
    name: 'Claude (Anthropic)',
    placeholder: 'sk-ant-...',
    apiKeyUrl: 'https://console.anthropic.com',
    apiKeySteps: [
      'Go to console.anthropic.com',
      'Sign up or log in to your Anthropic account',
      'Click "API Keys" in the left sidebar',
      'Click "Create Key" and give it a name',
      'Copy the key — it starts with sk-ant-',
    ],
    models: [
      { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Strongest Claude model' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Best balance of speed and capability' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', description: 'Fast and cost-effective' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Previous-generation balanced model' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Strongest Claude model' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fast and cost-effective' },
      { id: 'claude-fable-5', label: 'Fable 5', description: 'Coming soon', disabled: true },
    ],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT (OpenAI)',
    placeholder: 'sk-...',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    apiKeySteps: [
      'Go to platform.openai.com',
      'Sign up or log in to your OpenAI account',
      'Click your profile icon → "API keys"',
      'Click "Create new secret key" and name it',
      'Copy the key immediately — it starts with sk- and won\'t be shown again',
    ],
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Best overall' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Best value' },
      { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', description: 'Strongest but most expensive' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini (Google)',
    placeholder: 'AIza...',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    apiKeySteps: [
      'Go to aistudio.google.com',
      'Sign in with your Google account',
      'Click "Get API key" in the top-left area',
      'Click "Create API key in new project" (or select an existing project)',
      'Copy the generated key — it starts with AIza',
    ],
    models: [
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', description: 'Fast and efficient' },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', description: 'Advanced reasoning' },
    ],
  },
];

/** Velix model ID → actual provider API model ID (only where they differ). */
export const MODEL_ID_MAP: Record<string, string> = {
  'claude-opus-4-8': 'claude-opus-4-8',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'gemini-3.5-flash': 'gemini-3.5-flash',
  'gemini-3.1-pro': 'gemini-3.1-pro',
};

export function toActualModelId(velixModelId: string): string {
  return MODEL_ID_MAP[velixModelId] ?? velixModelId;
}

export function getProviderCatalog(id: ProviderID): AIProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}

export function getDefaultModel(provider: ProviderID): string {
  const entry = getProviderCatalog(provider);
  const first = entry?.models.find((m) => !m.disabled);
  return first?.id ?? '';
}

export function formatModelLabel(provider: ProviderID, modelId: string): string {
  const entry = getProviderCatalog(provider)?.models.find((m) => m.id === modelId);
  return entry?.label ?? modelId;
}

/** Legacy shape used by terminal picker and automation panel. */
export const PROVIDERS = PROVIDER_CATALOG.map((p) => ({
  id: p.id,
  name: p.name,
  models: p.models.filter((m) => !m.disabled).map((m) => m.id),
}));
