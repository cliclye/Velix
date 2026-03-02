/**
 * AIClient - Direct AI provider client via Electron IPC.
 *
 * Replaces the previous opencode HTTP server with direct calls to AI provider
 * APIs made from the Electron main process (which has no CORS restrictions).
 */

import { invoke } from '../../platform/native';

/** Velix model ID → actual provider model ID overrides (only where they differ) */
const MODEL_ID_MAP: Record<string, string> = {
  // Anthropic — haiku needs the full dated ID
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  // Google models
  'gemini-2.5-pro': 'gemini-2.5-pro-preview-06-05',
  'gemini-2.0-flash': 'gemini-2.0-flash-001',
};

export class OpenCodeClient {
  /** Map Velix model ID to actual provider model ID */
  toActualModelID(velixModelID: string): string {
    return MODEL_ID_MAP[velixModelID] ?? velixModelID;
  }

  /** No external server — always ready */
  async isRunning(): Promise<boolean> {
    return true;
  }

  /** No external server to wait for */
  async waitUntilReady(_maxMs?: number, _intervalMs?: number): Promise<boolean> {
    return true;
  }

  /** No-op: API keys are passed per-request */
  async setAuth(_velixProviderID: string, _apiKey: string): Promise<void> {
    // Keys are passed directly with each request; no server registration needed.
  }

  /** Returns a placeholder session ID; history is managed by AIService */
  async createSession(): Promise<string> {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** No-op */
  async deleteSession(_sessionID: string): Promise<void> {}

  /** No-op */
  async abortSession(_sessionID: string): Promise<void> {}

  /** No-op: no SSE server */
  subscribeToEvents(_onEvent: unknown): () => void {
    return () => {};
  }

  /** No-op: directory context is embedded in the system prompt by AIService */
  setDirectory(_dir: string): void {}

  /**
   * Send a message to an AI provider via Electron IPC.
   * Returns the full response text.
   */
  async sendMessage(params: {
    sessionID: string;
    text: string;
    system?: string;
    velixProviderID: string;
    velixModelID: string;
    apiKey: string;
    messageHistory?: Array<{ role: string; content: string }>;
    onStream?: (chunk: string) => void;
    signal?: AbortSignal;
  }): Promise<string> {
    const modelID = this.toActualModelID(params.velixModelID);

    const messages = [
      ...(params.messageHistory ?? []),
      { role: 'user', content: params.text },
    ];

    const result = await invoke<string>('ai_chat', {
      provider: params.velixProviderID,
      model: modelID,
      apiKey: params.apiKey,
      messages,
      system: params.system,
      maxTokens: 4096,
    });

    // Deliver the full response to the stream callback so the UI renders it
    if (params.onStream && result) {
      params.onStream(result);
    }

    return result;
  }

  /** List available providers — static list since there's no server to query */
  async listProviders(): Promise<Array<{ id: string; name: string }>> {
    return [];
  }
}

// Singleton instance
export const opencodeClient = new OpenCodeClient();
