/**
 * OpenCodeClient - HTTP client for the opencode server (velixcode engine)
 *
 * Communicates with the opencode Hono server running locally at http://localhost:4096
 * The opencode server handles all AI provider routing, session management, and streaming.
 */

const OPENCODE_BASE = 'http://localhost:4096';

/** Velix provider ID → opencode provider ID */
const PROVIDER_ID_MAP: Record<string, string> = {
  claude: 'anthropic',
  chatgpt: 'openai',
  gemini: 'google',
  glm4: 'zai-coding-plan',
  minimax: 'minimax',
  zen: 'opencode',
  kimi: 'moonshot',
  deepseek: 'deepseek',
  groq: 'groq',
};

/** Velix model ID → opencode model ID overrides (only where they differ) */
const MODEL_ID_MAP: Record<string, string> = {
  // Anthropic models
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20251029',
  'claude-opus-4-6': 'claude-opus-4-5-20251101',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251029',
  // Google models
  'gemini-2.5-pro': 'gemini-2.5-pro-preview-06-05',
  'gemini-2.0-flash': 'gemini-2.0-flash-001',
  // GLM / Z.AI models (Coding Plan)
  'glm-4.7': 'glm-4.7',
  'glm-4.5': 'glm-4.5',
  'glm-4-flash': 'glm-4-flash',
  // OpenCode Zen free models
  'glm-5-free': 'glm-5-free',
  'minimax-m2.5-free': 'minimax-m2.5-free',
  'kimi-k2.5-free': 'kimi-k2.5-free',
  'big-pickle': 'big-pickle',
  // MiniMax models
  'MiniMax-M2.5': 'MiniMax-M2.5',
  'MiniMax-M2.1': 'MiniMax-M2.1',
  // Kimi models
  'kimi-k2': 'kimi-k2',
  // DeepSeek models
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-reasoner',
  // OpenAI models stay the same
  // Groq models stay the same
};

export interface OpenCodeSession {
  id: string;
  title: string;
  time: { created: number; updated: number };
}

export interface OpenCodeMessage {
  info: { id: string; role: string; sessionID: string };
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface PartDeltaEvent {
  type: 'message.part.delta';
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
}

type SSEEvent = PartDeltaEvent | { type: string; properties: unknown };

export class OpenCodeClient {
  private currentDirectory = '';
  private sseSource: EventSource | null = null;
  private sseCallbacks: Array<(event: SSEEvent) => void> = [];

  /** Set the working directory sent with every request */
  setDirectory(dir: string) {
    this.currentDirectory = dir;
  }

  /** Map Velix provider ID to opencode provider ID */
  toOpencodeProviderID(velixProviderID: string): string {
    return PROVIDER_ID_MAP[velixProviderID] ?? velixProviderID;
  }

  /** Map Velix model ID to opencode model ID */
  toOpencodeModelID(velixModelID: string): string {
    return MODEL_ID_MAP[velixModelID] ?? velixModelID;
  }

  /** Build query string with directory */
  private dirQuery(extra: Record<string, string> = {}): string {
    const params = new URLSearchParams();
    if (this.currentDirectory) params.set('directory', this.currentDirectory);
    Object.entries(extra).forEach(([k, v]) => params.set(k, v));
    const s = params.toString();
    return s ? `?${s}` : '';
  }

  /** Check if the opencode server is running */
  async isRunning(): Promise<boolean> {
    try {
      const res = await fetch(`${OPENCODE_BASE}/path`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Wait for the server to be ready (up to maxMs milliseconds) */
  async waitUntilReady(maxMs = 15000, intervalMs = 500): Promise<boolean> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (await this.isRunning()) return true;
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
  }

  /**
   * Set API key for a provider in the opencode server.
   * velixProviderID: 'claude' | 'chatgpt' | 'gemini' | 'glm4' | 'minimax' | 'zen' | 'kimi' | 'deepseek' | 'groq'
   */
  async setAuth(velixProviderID: string, apiKey: string): Promise<void> {
    const providerID = this.toOpencodeProviderID(velixProviderID);
    const res = await fetch(`${OPENCODE_BASE}/auth/${providerID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'api', key: apiKey }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`opencode setAuth failed (${res.status}): ${text}`);
    }
  }

  /** Create a new opencode session. Returns the session ID. */
  async createSession(): Promise<string> {
    const res = await fetch(`${OPENCODE_BASE}/session${this.dirQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`opencode createSession failed (${res.status}): ${text}`);
    }
    const session: OpenCodeSession = await res.json();
    return session.id;
  }

  /** Delete a session */
  async deleteSession(sessionID: string): Promise<void> {
    await fetch(`${OPENCODE_BASE}/session/${sessionID}${this.dirQuery()}`, {
      method: 'DELETE',
    }).catch(() => {});
  }

  /**
   * Subscribe to SSE events from the opencode server.
   * Returns an unsubscribe function.
   */
  subscribeToEvents(onEvent: (event: SSEEvent) => void): () => void {
    this.sseCallbacks.push(onEvent);

    if (!this.sseSource) {
      const url = `${OPENCODE_BASE}/event${this.dirQuery()}`;
      this.sseSource = new EventSource(url);
      this.sseSource.onmessage = (e) => {
        try {
          const event: SSEEvent = JSON.parse(e.data);
          this.sseCallbacks.forEach(cb => cb(event));
        } catch {
          // ignore parse errors
        }
      };
      this.sseSource.onerror = () => {
        // Reconnect logic is handled by EventSource natively
      };
    }

    return () => {
      this.sseCallbacks = this.sseCallbacks.filter(cb => cb !== onEvent);
      if (this.sseCallbacks.length === 0 && this.sseSource) {
        this.sseSource.close();
        this.sseSource = null;
      }
    };
  }

  /**
   * Send a message to an opencode session.
   * Supports real streaming via SSE `message.part.delta` events.
   * Returns the full response text when complete.
   */
  async sendMessage(params: {
    sessionID: string;
    text: string;
    system?: string;
    velixProviderID: string;
    velixModelID: string;
    onStream?: (chunk: string) => void;
  }): Promise<string> {
    const providerID = this.toOpencodeProviderID(params.velixProviderID);
    const modelID = this.toOpencodeModelID(params.velixModelID);

    let unsub: (() => void) | null = null;
    let streamedText = '';

    // If streaming is requested, subscribe to SSE events BEFORE sending
    if (params.onStream) {
      unsub = this.subscribeToEvents((event) => {
        if (
          event.type === 'message.part.delta' &&
          (event as PartDeltaEvent).properties.sessionID === params.sessionID &&
          (event as PartDeltaEvent).properties.field === 'text'
        ) {
          const chunk = (event as PartDeltaEvent).properties.delta;
          streamedText += chunk;
          params.onStream!(chunk);
        }
      });
    }

    try {
      const body: Record<string, unknown> = {
        model: { providerID, modelID },
        parts: [{ type: 'text', text: params.text }],
      };
      if (params.system) {
        body.system = params.system;
      }

      const res = await fetch(
        `${OPENCODE_BASE}/session/${params.sessionID}/message${this.dirQuery()}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`opencode sendMessage failed (${res.status}): ${text}`);
      }

      const msg: OpenCodeMessage = await res.json();

      // Extract text from message parts
      const responseText = this.extractText(msg);

      // If streaming was active, the SSE already delivered most content.
      // Return the full response from the HTTP body as authoritative.
      return responseText || streamedText;
    } finally {
      if (unsub) unsub();
    }
  }

  /** Extract text content from an opencode message */
  private extractText(msg: OpenCodeMessage): string {
    if (!msg?.parts) return '';
    return msg.parts
      .filter(p => p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text as string)
      .join('');
  }

  /** List available providers from the opencode server */
  async listProviders(): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await fetch(`${OPENCODE_BASE}/provider${this.dirQuery()}`);
      if (!res.ok) return [];
      const data: { all: Array<{ id: string; name: string }> } = await res.json();
      return data.all ?? [];
    } catch {
      return [];
    }
  }
}

// Singleton instance
export const opencodeClient = new OpenCodeClient();
