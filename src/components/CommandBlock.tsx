import { useState } from "react";
import "./CommandBlock.css";

interface CommandBlockProps {
    command: string;
    output: string;
    timestamp: Date;
    isError?: boolean;
    onAskAI?: (command: string, output: string) => void;
}

export function CommandBlock({ command, output, timestamp, isError, onAskAI }: CommandBlockProps) {
    const [showMenu, setShowMenu] = useState(false);
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(`$ ${command}\n${output}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard unavailable */ }
    };

    const formatTime = (date: Date) => {
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
    };

    return (
        <div
            className={`command-block ${isError ? "error" : ""}`}
            onContextMenu={e => {
                e.preventDefault();
                setShowMenu(true);
            }}
        >
            <div className="block-top-bar">
                <span className="block-timestamp">{formatTime(timestamp)}</span>
                <div className="block-actions">
                    <button
                        className="action-btn"
                        onClick={handleCopy}
                        title="Copy"
                    >
                        {copied ? "OK" : "Copy"}
                    </button>
                    {isError && onAskAI && (
                        <button
                            className="action-btn ask-ai"
                            onClick={() => onAskAI(command, output)}
                            title="Ask AI about this error"
                        >
                            Ask AI
                        </button>
                    )}
                </div>
            </div>

            <div className="block-command">
                <span className="cmd-prompt">&gt;</span>
                <span className="cmd-text">{command}</span>
            </div>

            {output && (
                <div className={`block-output ${isError ? "error-output" : ""}`}>
                    <pre>{output}</pre>
                </div>
            )}

            {showMenu && (
                <>
                    <div className="menu-overlay" onClick={() => setShowMenu(false)} />
                    <div className="context-menu">
                        <button onClick={() => { handleCopy(); setShowMenu(false); }}>
                            Copy Block
                        </button>
                        <button onClick={() => { navigator.clipboard.writeText(command).catch(() => {}); setShowMenu(false); }}>
                            Copy Command
                        </button>
                        <button onClick={() => { navigator.clipboard.writeText(output).catch(() => {}); setShowMenu(false); }}>
                            Copy Output
                        </button>
                        {isError && onAskAI && (
                            <>
                                <hr />
                                <button className="ai-option" onClick={() => { onAskAI(command, output); setShowMenu(false); }}>
                                    Ask AI to Explain
                                </button>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
