/**
 * VelixEngine - Direct AI provider client via Tauri IPC.
 */

import { invoke } from '../../platform/native';
import { toActualModelId } from './modelCatalog';

export class VelixEngine {
  /** Map Velix model ID to actual provider model ID */
  toActualModelID(velixModelID: string): string {
    return toActualModelId(velixModelID);
  }

  async isRunning(): Promise<boolean> {
    return true;
  }

  async waitUntilReady(_maxMs?: number, _intervalMs?: number): Promise<boolean> {
    return true;
  }

  async setAuth(_velixProviderID: string, _apiKey: string): Promise<void> {}

  async createSession(): Promise<string> {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async deleteSession(_sessionID: string): Promise<void> {}

  async abortSession(_sessionID: string): Promise<void> {}

  subscribeToEvents(_onEvent: unknown): () => void {
    return () => {};
  }

  setDirectory(_dir: string): void {}

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

    if (params.signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    const result = await invoke<string>('ai_chat', {
      provider: params.velixProviderID,
      model: modelID,
      apiKey: params.apiKey,
      messages,
      system: params.system,
      maxTokens: params.maxTokens ?? 2048,
    });

    if (params.signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    if (params.onStream && result) {
      params.onStream(result);
    }

    return result;
  }

  async listProviders(): Promise<Array<{ id: string; name: string }>> {
    return [];
  }
}

export const velixEngine = new VelixEngine();
