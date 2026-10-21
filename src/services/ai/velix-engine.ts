/**
 * VelixEngine - Direct AI provider client via Tauri IPC.
 *
 * All provider calls go through the Rust backend (no CORS restrictions).
 */

import { invoke } from '../../platform/native';

export class VelixEngine {
  /**
   * Model ids are sent to the provider exactly as selected. (An earlier alias table rewrote
   * some ids to dated/preview names that may no longer exist, which risks 404s for those models.)
   */
  toActualModelID(velixModelID: string): string {
    return velixModelID;
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
    maxTokens?: number;
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
      maxTokens: params.maxTokens ?? 2048,
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
export const velixEngine = new VelixEngine();
