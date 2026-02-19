import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Settings.css";

export interface AIProvider {
    id: "claude" | "chatgpt" | "gemini" | "glm4" | "minimax" | "zen" | "kimi" | "deepseek" | "groq";
    name: string;
    models: string[];
    placeholder: string;
    isFree?: boolean;
    description?: string;
}

export const AI_PROVIDERS: AIProvider[] = [
    {
        id: "claude",
        name: "Claude (Anthropic)",
        models: ["claude-sonnet-4-5", "claude-opus-4-6", "claude-haiku-4-5"],
        placeholder: "sk-ant-..."
    },
    {
        id: "chatgpt",
        name: "ChatGPT (OpenAI)",
        models: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo", "o3", "o4-mini"],
        placeholder: "sk-..."
    },
    {
        id: "gemini",
        name: "Gemini (Google)",
        models: ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"],
        placeholder: "AIza..."
    },
    {
        id: "glm4",
        name: "GLM (Z.AI Coding Plan)",
        models: ["glm-4.7", "glm-4.5", "glm-4-flash"],
        placeholder: "zai-...",
        description: "GLM-4.7 — flagship open-source coding model ($3/mo coding plan)"
    },
    {
        id: "minimax",
        name: "MiniMax",
        models: ["MiniMax-M2.5", "MiniMax-M2.1"],
        placeholder: "eyJ...",
        description: "MiniMax M2.5 — strong multi-language coding model"
    },
    {
        id: "zen",
        name: "OpenCode Zen (Free Models)",
        models: ["glm-5-free", "minimax-m2.5-free", "kimi-k2.5-free", "big-pickle"],
        placeholder: "opencode-...",
        isFree: true,
        description: "Free models via OpenCode Zen gateway — GLM 5, MiniMax M2.5, Kimi K2.5, Big Pickle"
    },
    {
        id: "kimi",
        name: "Kimi (Moonshot AI)",
        models: ["kimi-k2", "moonshot-v1-32k", "moonshot-v1-128k"],
        placeholder: "sk-...",
        description: "Kimi K2 — strong reasoning and coding model"
    },
    {
        id: "deepseek",
        name: "DeepSeek",
        models: ["deepseek-chat", "deepseek-reasoner"],
        placeholder: "sk-...",
        description: "DeepSeek — cost-effective models with strong reasoning"
    },
    {
        id: "groq",
        name: "Groq (Fast Inference)",
        models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"],
        placeholder: "gsk_...",
        description: "Ultra-fast inference for open-source models"
    }
];

interface SettingsProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (config: AIConfig) => void;
    currentConfig: AIConfig | null;
    theme: "light" | "dark";
    onThemeChange: (theme: "light" | "dark") => void;
    tabSize: number;
    onTabSizeChange: (size: number) => void;
}

export interface AIConfig {
    provider: AIProvider["id"];
    model: string;
    apiKey: string;
}

// Free providers that don't strictly require an API key (optional/account key)
const FREE_PROVIDERS = new Set(["zen"]);

export function Settings({ isOpen, onClose, onSave, currentConfig, theme, onThemeChange, tabSize, onTabSizeChange }: SettingsProps) {
    const [activeTab, setActiveTab] = useState<"providers" | "appearance" | "about">("providers");
    const [selectedProvider, setSelectedProvider] = useState<AIProvider["id"]>(currentConfig?.provider || "claude");
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
    const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

    useEffect(() => {
        loadApiKeys();
    }, []);

    const loadApiKeys = async () => {
        for (const provider of AI_PROVIDERS) {
            try {
                const key = await invoke<string>("get_api_key", { provider: provider.id });
                if (key) {
                    setApiKeys(prev => ({ ...prev, [provider.id]: key }));
                }
            } catch (e) {
                // Key not found
            }
        }
    };

    const handleSaveKey = async (providerId: string, key: string) => {
        try {
            await invoke("save_api_key", { provider: providerId, key });
            setApiKeys(prev => ({ ...prev, [providerId]: key }));

            // If this is the currently selected provider, update the global config immediately
            if (providerId === selectedProvider) {
                const provider = AI_PROVIDERS.find(p => p.id === providerId);
                const model = selectedModels[providerId] || provider?.models[0] || "";
                onSave({ provider: providerId, model, apiKey: key });
            }
        } catch (e) {
            console.error("Failed to save API key:", e);
        }
    };

    const handleSelectProvider = (providerId: AIProvider["id"]) => {
        setSelectedProvider(providerId);
        const provider = AI_PROVIDERS.find(p => p.id === providerId);
        const model = selectedModels[providerId] || provider?.models[0] || "";
        const apiKey = apiKeys[providerId] || "";

        onSave({ provider: providerId, model, apiKey });
    };

    // Model is now changed in terminal section, not here
    const _handleModelChange = (providerId: string, model: string) => {
        setSelectedModels(prev => ({ ...prev, [providerId]: model }));
        if (providerId === selectedProvider) {
            onSave({ provider: selectedProvider, model, apiKey: apiKeys[providerId] || "" });
        }
    };
    void _handleModelChange; // Suppress unused warning

    if (!isOpen) return null;

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-modal" onClick={e => e.stopPropagation()}>
                <div className="settings-header">
                    <h2>Settings</h2>
                    <button className="close-btn" onClick={onClose}>x</button>
                </div>

                <div className="settings-layout">
                    <nav className="settings-nav">
                        <button
                            className={`nav-item ${activeTab === "providers" ? "active" : ""}`}
                            onClick={() => setActiveTab("providers")}
                        >
                            AI Providers
                        </button>
                        <button
                            className={`nav-item ${activeTab === "appearance" ? "active" : ""}`}
                            onClick={() => setActiveTab("appearance")}
                        >
                            Appearance
                        </button>
                        <button
                            className={`nav-item ${activeTab === "about" ? "active" : ""}`}
                            onClick={() => setActiveTab("about")}
                        >
                            About
                        </button>
                    </nav>

                    <div className="settings-content">
                        {activeTab === "providers" && (
                            <div className="providers-tab">
                                <p className="settings-description">
                                    Configure your AI provider. Enter your API key to enable AI features.
                                </p>

                                {AI_PROVIDERS.map(provider => (
                                    <div
                                        key={provider.id}
                                        className={`provider-card ${selectedProvider === provider.id ? "active" : ""}`}
                                    >
                                        <div className="provider-header">
                                            <label className="provider-select">
                                                <input
                                                    type="radio"
                                                    name="provider"
                                                    checked={selectedProvider === provider.id}
                                                    onChange={() => handleSelectProvider(provider.id)}
                                                />
                                                <span className="provider-name">{provider.name}</span>
                                            </label>
                                            <div className="provider-badges">
                                                {provider.isFree && (
                                                    <span className="free-badge">FREE</span>
                                                )}
                                                {selectedProvider === provider.id && (
                                                    <span className="active-badge">Active</span>
                                                )}
                                            </div>
                                        </div>

                                        {provider.description && (
                                            <p className="provider-description">{provider.description}</p>
                                        )}

                                        <div className="provider-config">
                                            <div className="input-group">
                                                <label>
                                                    {FREE_PROVIDERS.has(provider.id) ? "API Key (optional — get from opencode.ai)" : "API Key"}
                                                </label>
                                                <div className="key-input-wrapper">
                                                    <input
                                                        type={showKeys[provider.id] ? "text" : "password"}
                                                        placeholder={provider.placeholder}
                                                        value={apiKeys[provider.id] || ""}
                                                        onChange={e => setApiKeys(prev => ({ ...prev, [provider.id]: e.target.value }))}
                                                        onBlur={e => handleSaveKey(provider.id, e.target.value)}
                                                    />
                                                    <button
                                                        className="toggle-visibility"
                                                        onClick={() => setShowKeys(prev => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                                                    >
                                                        {showKeys[provider.id] ? "Hide" : "Show"}
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="input-group">
                                                <p className="model-hint">Model can be changed in the terminal section</p>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeTab === "appearance" && (
                            <div className="appearance-tab">
                                <p className="settings-description">
                                    Customize the look and feel of Velix.
                                </p>

                                <div className="appearance-section">
                                    <h4>Theme</h4>
                                    <div className="theme-toggle-container">
                                        <button
                                            className={`theme-option ${theme === "light" ? "active" : ""}`}
                                            onClick={() => onThemeChange("light")}
                                        >
                                            <span className="theme-icon">&#9788;</span>
                                            <span className="theme-label">Light</span>
                                        </button>
                                        <button
                                            className={`theme-option ${theme === "dark" ? "active" : ""}`}
                                            onClick={() => onThemeChange("dark")}
                                        >
                                            <span className="theme-icon">&#9790;</span>
                                            <span className="theme-label">Dark</span>
                                        </button>
                                    </div>
                                </div>

                                <div className="appearance-section">
                                    <h4>Tab Size</h4>
                                    <div className="theme-toggle-container">
                                        {[2, 4, 8].map(size => (
                                            <button
                                                key={size}
                                                className={`theme-option ${tabSize === size ? "active" : ""}`}
                                                onClick={() => onTabSizeChange(size)}
                                            >
                                                <span className="theme-label">{size} spaces</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="appearance-section">
                                    <h4>Color Scheme</h4>
                                    <div className="color-preview">
                                        <div className="color-swatch primary" style={{ background: theme === "dark" ? "#5a9e54" : "#345830" }}></div>
                                        <div className="color-swatch secondary" style={{ background: theme === "dark" ? "#0a0a0a" : "#ffffff" }}></div>
                                        <div className="color-swatch tertiary" style={{ background: theme === "dark" ? "#fafafa" : "#0a0a0a" }}></div>
                                    </div>
                                    <p className="color-hint">Forest Green (#345830) with monochrome accents</p>
                                </div>
                            </div>
                        )}

                        {activeTab === "about" && (
                            <div className="about-tab">
                                <h3>Velix</h3>
                                <p>AI-Native Developer Terminal</p>
                                <p className="version">Version 0.1.0</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
