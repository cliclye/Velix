import { invoke } from '../../platform/native';
import { ProviderID, PROVIDERS } from './types';
import { opencodeClient } from './opencode-client';

/**
 * AIService provides a unified interface to multiple AI providers.
 * All AI inference is routed directly to provider APIs via Electron IPC,
 * with no intermediate server required.
 */
export class AIService {
    private currentProvider: ProviderID = 'claude';
    private currentModel: string = 'claude-sonnet-4-6';
    /** Active session ID for the current conversation */
    private sessionID: string | null = null;
    /** In-memory message history per session (for multi-turn conversations) */
    private sessionHistory: Map<string, Array<{ role: string; content: string }>> = new Map();
    /** API keys stored per provider */
    private storedKeys: Map<ProviderID, string> = new Map();

    /**
     * Initialize the service with a specific provider and model.
     * Loads the saved API key from the backend.
     */
    async initialize(provider: ProviderID, model?: string): Promise<boolean> {
        this.currentProvider = provider;
        const providerConfig = PROVIDERS.find(p => p.id === provider);
        this.currentModel = model || providerConfig?.models[0] || '';

        try {
            const apiKey = await invoke<string>('get_api_key', { provider });
            if (apiKey) {
                this.storedKeys.set(provider, apiKey);
                return true;
            }
        } catch {
            // No key stored or backend unavailable
        }
        return false;
    }

    /**
     * Set the API key for a provider.
     * Persists it via the backend and stores it in memory for requests.
     */
    async setApiKey(provider: ProviderID, apiKey: string): Promise<void> {
        await invoke('save_api_key', { provider, key: apiKey });
        this.storedKeys.set(provider, apiKey);
    }

    /**
     * Switch to a different provider and model.
     * Resets the conversation session so the next chat starts fresh.
     */
    setProvider(provider: ProviderID, model?: string): void {
        this.currentProvider = provider;
        const providerConfig = PROVIDERS.find(p => p.id === provider);
        this.currentModel = model || providerConfig?.models[0] || '';
        this.resetSession();
    }

    /** Get current configuration */
    getConfig(): { provider: ProviderID; model: string } {
        return {
            provider: this.currentProvider,
            model: this.currentModel,
        };
    }

    /** Check if a provider has an API key configured */
    isProviderReady(provider?: ProviderID): boolean {
        const p = provider || this.currentProvider;
        return this.storedKeys.has(p);
    }

    /** Abort active generation — no-op in direct mode (no server to abort) */
    async abortCurrentResponse(): Promise<void> {}

    /** Ensure we have an active session ID */
    private async ensureSession(): Promise<string> {
        if (!this.sessionID) {
            this.sessionID = await opencodeClient.createSession();
            this.sessionHistory.set(this.sessionID, []);
        }
        return this.sessionID;
    }

    /** Reset the current session (creates a fresh one on next chat) */
    private resetSession(): void {
        if (this.sessionID) {
            this.sessionHistory.delete(this.sessionID);
        }
        this.sessionID = null;
    }

    /**
     * Send a chat message to the current AI provider.
     * Maintains conversation history for multi-turn context.
     */
    async chat(messages: Array<{ role: string; content: string }>, options?: {
        model?: string;
        maxTokens?: number;
        temperature?: number;
        stream?: boolean;
        onStream?: (chunk: string) => void;
        fileContext?: { path: string; language: string; content: string };
        projectContents?: Record<string, string>;
        tools?: Record<string, boolean>;
        signal?: AbortSignal;
    }): Promise<{ content: string; model: string; provider: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
        const model = options?.model || this.currentModel;
        const apiKey = this.storedKeys.get(this.currentProvider);
        if (!apiKey) {
            throw new Error(`No API key configured for provider "${this.currentProvider}". Add one in Settings.`);
        }

        // Extract system prompt and latest user message
        const systemMsg = messages.find(m => m.role === 'system');
        const userMsg = messages.filter(m => m.role === 'user').pop();

        if (!userMsg) {
            throw new Error('No user message found in messages array');
        }

        let systemPrompt = systemMsg?.content;

        // Append project/file context to the system prompt if provided
        if (options?.projectContents && Object.keys(options.projectContents).length > 0) {
            const fileSnippet = Object.entries(options.projectContents)
                .slice(0, 30)
                .map(([path, content]) => {
                    const ext = path.split('.').pop() || 'text';
                    return `--- ${path} ---\n\`\`\`${ext}\n${content.slice(0, 3000)}\n\`\`\``;
                })
                .join('\n\n');

            systemPrompt = (systemPrompt || '') + `\n\n=== PROJECT FILES ===\n${fileSnippet}`;
        } else if (options?.fileContext) {
            const fc = options.fileContext;
            systemPrompt = (systemPrompt || '') +
                `\n\n=== CURRENT FILE: ${fc.path} ===\n\`\`\`${fc.language}\n${fc.content.slice(0, 15000)}\n\`\`\``;
        }

        const sessionID = await this.ensureSession();
        const history = this.sessionHistory.get(sessionID) ?? [];

        const responseText = await opencodeClient.sendMessage({
            sessionID,
            text: userMsg.content,
            system: systemPrompt,
            velixProviderID: this.currentProvider,
            velixModelID: model,
            apiKey,
            messageHistory: history,
            onStream: options?.stream ? options.onStream : undefined,
            signal: options?.signal,
        });

        // Update in-memory history for next turn
        history.push({ role: 'user', content: userMsg.content });
        history.push({ role: 'assistant', content: responseText });
        this.sessionHistory.set(sessionID, history);

        return {
            content: responseText,
            model,
            provider: this.currentProvider,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
    }

    /**
     * Send a one-shot message without accumulating conversation history.
     * Used for stateless tasks like autocomplete, error explanation, etc.
     */
    private async oneShotChat(system: string, userContent: string): Promise<string> {
        const apiKey = this.storedKeys.get(this.currentProvider);
        if (!apiKey) {
            throw new Error(`No API key configured for provider "${this.currentProvider}". Add one in Settings.`);
        }

        const tempSessionID = await opencodeClient.createSession();
        try {
            return await opencodeClient.sendMessage({
                sessionID: tempSessionID,
                text: userContent,
                system,
                velixProviderID: this.currentProvider,
                velixModelID: this.currentModel,
                apiKey,
            });
        } finally {
            await opencodeClient.deleteSession(tempSessionID);
        }
    }

    /** Suggest a shell command based on a natural language description. */
    async suggestCommand(description: string): Promise<string> {
        const result = await this.oneShotChat(
            'You are a shell command expert. Given a task description, respond with ONLY the shell command, nothing else. No explanation, no markdown, just the raw command.',
            description
        );
        return result.trim();
    }

    /** Explain an error and suggest fixes. */
    async explainError(command: string, error: string): Promise<string> {
        return this.oneShotChat(
            'You are a helpful terminal assistant. Explain errors concisely and suggest fixes. Keep responses brief and practical.',
            `Command: ${command}\n\nError: ${error}\n\nWhat went wrong and how do I fix it?`
        );
    }

    /** Edit a file based on a natural language instruction. */
    async editFile(path: string, content: string, instruction: string): Promise<string> {
        const newContent = await this.oneShotChat(
            `You are an expert code editor. You will receive the content of a file and an instruction to modify it.
Return ONLY the modified file content. Do not include markdown code blocks, backticks, or any explanations.
Just the raw code.`,
            `File: ${path}\n\nContent:\n${content}\n\nInstruction: ${instruction}`
        );
        let cleaned = newContent;
        if (cleaned.startsWith('```')) {
            const lines = cleaned.split('\n');
            if (lines[0].startsWith('```')) lines.shift();
            if (lines[lines.length - 1].startsWith('```')) lines.pop();
            cleaned = lines.join('\n');
        }
        return cleaned;
    }

    /** Analyze a code file and return an explanation. */
    async analyzeCode(options: {
        filePath: string;
        code: string;
        imports: string[];
        gitHistory?: string;
        dangerZones?: import('../analysis').DangerZone | null;
        mode?: 'beginner' | 'senior';
    }): Promise<string> {
        const { CODE_ANALYSIS_SYSTEM_PROMPT, buildFileAnalysisPrompt } = await import('./prompts');
        const prompt = buildFileAnalysisPrompt(options);
        return this.oneShotChat(CODE_ANALYSIS_SYSTEM_PROMPT, prompt);
    }

    /** Analyze a project and return an overview. */
    async analyzeProject(options: {
        projectData: import('../analysis').ProjectData;
        filesContent: Array<{ path: string; content: string; imports: string[] }>;
        mode?: 'beginner' | 'senior';
    }): Promise<string> {
        const { buildProjectAnalysisPrompt } = await import('./prompts');
        const prompt = buildProjectAnalysisPrompt(options);
        return this.oneShotChat(
            'You are a senior software architect analyzing code project structures. Provide clear, structured insights about project organization, file relationships, and architecture patterns. Use markdown formatting with headers and lists.',
            prompt
        );
    }

    /**
     * Generate N distinct prompts for automation agents from a high-level goal.
     */
    async generateAutomationPrompts(goal: string, count: number): Promise<string[]> {
        const raw = await this.oneShotChat(
            `You are a task coordinator for a multi-agent coding workflow. Given a high-level goal, you generate exactly N distinct, focused prompts. Each prompt should be for a different Claude Code agent instance. Prompts should:
- Be specific and actionable
- Cover different aspects or subtasks of the overall goal
- Not overlap significantly with each other
- Be 1-3 sentences each
- Be suitable to paste directly into Claude Code as the initial instruction

Return ONLY a JSON array of exactly ${count} strings. No markdown, no explanation. Example: ["prompt 1", "prompt 2"]`,
            `Goal: ${goal}\n\nGenerate exactly ${count} distinct prompts for ${count} Claude Code agents. Return a JSON array only.`
        );

        let content = raw.trim();
        if (content.startsWith('```')) {
            content = content.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
        }
        try {
            const arr = JSON.parse(content) as string[];
            if (Array.isArray(arr) && arr.length >= count) {
                return arr.slice(0, count).map((p: unknown) => String(p || '').trim()).filter(Boolean);
            }
            const lines = content.split(/\n/).map(s => s.replace(/^\d+[\.\)]\s*/, '').trim()).filter(Boolean);
            return lines.slice(0, count).length >= count ? lines.slice(0, count) : [goal];
        } catch {
            return Array(count).fill(goal);
        }
    }

    /** Analyze the complexity of a task and suggest agent count. */
    async analyzeTaskComplexity(goal: string): Promise<{ complexity: number; agentCount: number; reasoning: string }> {
        const raw = await this.oneShotChat(
            `You are an expert project manager. Analyze the given coding task and determine its complexity on a scale of 1-10.
Based on the complexity, suggest the optimal number of parallel agents (1-5) to handle it.
1-3 complexity: 1 agent
4-6 complexity: 2-3 agents
7-10 complexity: 4-5 agents

Return ONLY a JSON object with this format:
{
    "complexity": number,
    "agentCount": number,
    "reasoning": "Brief explanation of why"
}`,
            `Task: ${goal}`
        );

        try {
            let content = raw.trim();
            if (content.startsWith('```')) {
                content = content.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
            }
            const parsed = JSON.parse(content);
            return {
                complexity: parsed.complexity || 1,
                agentCount: Math.min(Math.max(parsed.agentCount || 1, 1), 5),
                reasoning: parsed.reasoning || 'Simple task',
            };
        } catch {
            return { complexity: 1, agentCount: 1, reasoning: 'Failed to analyze complexity, defaulting to 1 agent.' };
        }
    }

    /** Chat about code with context. */
    async chatAboutCode(options: {
        question: string;
        filePath?: string;
        fileContent?: string;
        previousAnalysis?: string;
        projectContext?: string;
    }): Promise<string> {
        const { CHAT_SYSTEM_PROMPT, buildChatContextPrompt } = await import('./prompts');
        const prompt = buildChatContextPrompt({
            userQuestion: options.question,
            filePath: options.filePath,
            fileContent: options.fileContent,
            previousAnalysis: options.previousAnalysis,
            projectContext: options.projectContext,
        });
        return this.oneShotChat(CHAT_SYSTEM_PROMPT, prompt);
    }
}

// Export singleton instance
export const aiService = new AIService();
