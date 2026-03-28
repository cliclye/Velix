// AI Provider types and interfaces

export type ProviderID = 'claude' | 'chatgpt' | 'gemini' | 'glm4' | 'minimax' | 'kimi' | 'deepseek' | 'groq' | 'mistral';

export interface AIProvider {
    id: ProviderID;
    name: string;
    models: string[];
}

export interface AIConfig {
    provider: ProviderID;
    model: string;
    apiKey: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface AIResponse {
    content: string;
    model: string;
    provider: ProviderID;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface AIProviderClient {
    id: ProviderID;
    chat(messages: ChatMessage[], options?: ChatOptions): Promise<AIResponse>;
    suggestCommand(description: string): Promise<string>;
    explainError(command: string, error: string): Promise<string>;
}

export interface FileContext {
    path: string;
    language: string;
    content: string;
}

export interface ChatOptions {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    stream?: boolean;
    onStream?: (chunk: string) => void;
    fileContext?: FileContext;
    projectContents?: Record<string, string>;
}

export const PROVIDERS: AIProvider[] = [
    {
        id: 'claude',
        name: 'Claude (Anthropic)',
        models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'],
    },
    {
        id: 'chatgpt',
        name: 'ChatGPT (OpenAI)',
        models: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o3', 'o4-mini'],
    },
    {
        id: 'gemini',
        name: 'Gemini (Google)',
        models: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    },
    {
        id: 'glm4',
        name: 'GLM (Z.AI Coding Plan)',
        models: ['glm-4.7', 'glm-4.5', 'glm-4-flash'],
    },
    {
        id: 'minimax',
        name: 'MiniMax',
        models: ['MiniMax-M2.5', 'MiniMax-M2.1'],
    },
    {
        id: 'kimi',
        name: 'Kimi (Moonshot AI)',
        models: ['kimi-k2', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    },
    {
        id: 'deepseek',
        name: 'DeepSeek',
        models: ['deepseek-chat', 'deepseek-reasoner'],
    },
    {
        id: 'groq',
        name: 'Groq (Fast Inference)',
        models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    },
    {
        id: 'mistral',
        name: 'Mistral AI',
        models: ['mistral-small-latest', 'open-mistral-nemo', 'codestral-latest'],
    },
];
