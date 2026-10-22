import { useState, useEffect, useCallback } from "react";
import { invoke } from "../platform/native";
import { getWorkerCLIOptions, loadCustomCLIOptions, saveCustomCLIOptions } from "../services/swarm";
import type { WorkerCLIOption } from "../services/swarm";
import { PROVIDER_CATALOG, type ProviderID } from "../services/ai/modelCatalog";
import velixLogo from "../../velixlogo.png";
import "./Settings.css";

export interface AIProvider {
    id: ProviderID;
    name: string;
    models: string[];
    placeholder: string;
    description?: string;
    apiKeySteps?: string[];
    apiKeyUrl?: string;
    isFree?: boolean;
}

export const AI_PROVIDERS: AIProvider[] = PROVIDER_CATALOG.map((p) => ({
    id: p.id,
    name: p.name,
    models: p.models.filter((m) => !m.disabled).map((m) => m.id),
    placeholder: p.placeholder,
    description: p.description,
    apiKeySteps: p.apiKeySteps,
    apiKeyUrl: p.apiKeyUrl,
}));

interface SettingsProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (config: AIConfig) => void;
    currentConfig: AIConfig | null;
    theme: "light" | "dark";
    onThemeChange: (theme: "light" | "dark") => void;
}

export interface AIConfig {
    provider: AIProvider["id"];
    model: string;
    apiKey: string;
}

export function Settings({ isOpen, onClose, onSave, currentConfig, theme, onThemeChange }: SettingsProps) {
    const [activeTab, setActiveTab] = useState<"providers" | "cli" | "appearance" | "about">("providers");
    const [selectedProvider, setSelectedProvider] = useState<AIProvider["id"]>(currentConfig?.provider || "claude");
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
    const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
    const [showSteps, setShowSteps] = useState<Record<string, boolean>>({});

    // Custom CLI state
    const [customCLIs, setCustomCLIs] = useState<WorkerCLIOption[]>(() => loadCustomCLIOptions());
    const [newCLIName, setNewCLIName] = useState("");
    const [newCLICommand, setNewCLICommand] = useState("");

    const handleAddCustomCLI = useCallback(() => {
        const name = newCLIName.trim();
        const command = newCLICommand.trim();
        if (!name || !command) return;

        const id = command.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const allOptions = getWorkerCLIOptions();
        if (allOptions.some(o => o.id === id)) return; // duplicate

        const newOption: WorkerCLIOption = { id, name, command, description: `Custom: ${name}` };
        const updated = [...customCLIs, newOption];
        setCustomCLIs(updated);
        saveCustomCLIOptions(updated);
        setNewCLIName("");
        setNewCLICommand("");
    }, [customCLIs, newCLIName, newCLICommand]);

    const handleRemoveCustomCLI = useCallback((id: string) => {
        const updated = customCLIs.filter(c => c.id !== id);
        setCustomCLIs(updated);
        saveCustomCLIOptions(updated);
    }, [customCLIs]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const loaded: Record<string, string> = {};
            for (const provider of AI_PROVIDERS) {
                try {
                    const key = await invoke<string>("get_api_key", { provider: provider.id });
                    if (key) loaded[provider.id] = key;
                } catch {
                    // Key not found
                }
            }
            if (!cancelled) setApiKeys(loaded);
        })();
        return () => { cancelled = true; };
    }, []);

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

    if (!isOpen) return null;

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div className="settings-modal" onClick={e => e.stopPropagation()}>
                <div className="settings-header">
                    <div className="settings-title-group">
                        <h2>Settings</h2>
                        <span className="settings-beta-tag">BETA</span>
                    </div>
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
                            className={`nav-item ${activeTab === "cli" ? "active" : ""}`}
                            onClick={() => setActiveTab("cli")}
                        >
                            CLI Tools
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
                                                <div className="api-key-label-row">
                                                    <label>API Key</label>
                                                    {provider.apiKeySteps && (
                                                        <button
                                                            className="how-to-get-key-btn"
                                                            onClick={() => setShowSteps(prev => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                                                        >
                                                            {showSteps[provider.id] ? "Hide steps" : "How to get this key"}
                                                        </button>
                                                    )}
                                                </div>

                                                {provider.apiKeySteps && showSteps[provider.id] && (
                                                    <div className="api-key-steps">
                                                        <ol className="steps-list">
                                                            {provider.apiKeySteps.map((step, i) => (
                                                                <li key={i}>{step}</li>
                                                            ))}
                                                        </ol>
                                                        {provider.apiKeyUrl && (
                                                            <a
                                                                className="steps-open-link"
                                                                href={provider.apiKeyUrl}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                            >
                                                                Open {provider.name} console →
                                                            </a>
                                                        )}
                                                    </div>
                                                )}

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

                        {activeTab === "cli" && (
                            <div className="cli-tab">
                                <p className="settings-description">
                                    Manage CLI tools available in Swarm Mode and the terminal quick-launch bar. Built-in CLIs cannot be removed.
                                </p>

                                <div className="cli-list">
                                    {getWorkerCLIOptions().map(option => (
                                        <div key={option.id} className={`cli-row ${option.builtin ? 'builtin' : 'custom'}`}>
                                            <div className="cli-row-info">
                                                <span className="cli-row-name">{option.name}</span>
                                                <code className="cli-row-command">{option.command}</code>
                                            </div>
                                            <div className="cli-row-actions">
                                                {option.builtin ? (
                                                    <span className="cli-row-badge builtin">Built-in</span>
                                                ) : (
                                                    <button
                                                        className="cli-row-remove"
                                                        onClick={() => handleRemoveCustomCLI(option.id)}
                                                        title="Remove custom CLI"
                                                    >
                                                        Remove
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                <div className="cli-add-form">
                                    <h4>Add Custom CLI</h4>
                                    <div className="cli-add-inputs">
                                        <input
                                            type="text"
                                            placeholder="Display name (e.g. Aider)"
                                            value={newCLIName}
                                            onChange={e => setNewCLIName(e.target.value)}
                                            className="cli-add-input"
                                        />
                                        <input
                                            type="text"
                                            placeholder="Command (e.g. aider)"
                                            value={newCLICommand}
                                            onChange={e => setNewCLICommand(e.target.value)}
                                            className="cli-add-input"
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') handleAddCustomCLI();
                                            }}
                                        />
                                        <button
                                            className="cli-add-btn"
                                            onClick={handleAddCustomCLI}
                                            disabled={!newCLIName.trim() || !newCLICommand.trim()}
                                        >
                                            Add
                                        </button>
                                    </div>
                                    <p className="cli-add-hint">
                                        The command must be installed and accessible in your PATH. Custom CLIs will appear in Swarm Mode's worker CLI picker and the terminal quick-launch bar.
                                    </p>
                                </div>
                            </div>
                        )}

                        {activeTab === "appearance" && (
                            <div className="appearance-tab">
                                <p className="settings-description">
                                    Choose the interface theme for Velix.
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
                            </div>
                        )}

                        {activeTab === "about" && (
                            <div className="about-tab">
                                <img src={velixLogo} alt="Velix logo" className="about-logo" />
                                <p className="about-eyebrow">BETA version</p>
                                <h3>Velix</h3>
                                <p>AI-Native Developer Terminal</p>
                                <p className="version">Version 0.2.0 Beta</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
