// AI Provider types and interfaces

export type { ProviderID } from './modelCatalog';
export { PROVIDERS } from './modelCatalog';

import type { ProviderID } from './modelCatalog';

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
