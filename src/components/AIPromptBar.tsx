import { useState, useRef, useEffect } from "react";
import "./AIPromptBar.css";

interface AIPromptBarProps {
    onSubmit: (prompt: string, isAI: boolean) => void;
    currentProvider: string;
    currentModel: string;
    disabled?: boolean;
}

export function AIPromptBar({ onSubmit, currentProvider, currentModel, disabled }: AIPromptBarProps) {
    const [input, setInput] = useState("");
    const [isAIMode, setIsAIMode] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        // Detect # at start for AI mode
        if (input.startsWith("#")) {
            setIsAIMode(true);
        } else {
            setIsAIMode(false);
        }
    }, [input]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;

        const prompt = isAIMode ? input.slice(1).trim() : input.trim();
        onSubmit(prompt, isAIMode);
        setInput("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            setInput("");
            inputRef.current?.blur();
        }
    };

    return (
        <div className={`ai-prompt-bar ${isAIMode ? "ai-mode" : ""}`}>
            <form onSubmit={handleSubmit} className="prompt-form">
                <div className="prompt-prefix">
                    {isAIMode ? (
                        <span className="ai-indicator">AI</span>
                    ) : (
                        <span className="shell-indicator">&gt;</span>
                    )}
                </div>

                <input
                    ref={inputRef}
                    type="text"
                    className="prompt-input"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isAIMode ? "Describe what you want to do..." : "Type # for AI, or enter a command..."}
                    disabled={disabled}
                />

                <div className="prompt-actions">
                    {isAIMode && (
                        <div className="model-badge">
                            <span className="provider">{currentProvider}</span>
                            <span className="model">{currentModel}</span>
                        </div>
                    )}

                    <button
                        type="submit"
                        className={`submit-btn ${isAIMode ? "ai" : "shell"}`}
                        disabled={!input.trim() || disabled}
                    >
                        {isAIMode ? "Ask AI" : "Run"}
                        <span className="shortcut">Enter</span>
                    </button>
                </div>
            </form>

            <div className="prompt-hints">
                <span className="hint">
                    <kbd>#</kbd> AI mode
                </span>
                <span className="hint">
                    <kbd>Up</kbd><kbd>Down</kbd> History
                </span>
                <span className="hint">
                    <kbd>Esc</kbd> Clear
                </span>
            </div>
        </div>
    );
}
