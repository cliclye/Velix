import { useEffect, useRef } from "react";
import "./AIChat.css";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AIChatMessage {
    id: string;
    role: "user" | "assistant";
    content: string;
    /** Set to true while the assistant is still streaming */
    streaming?: boolean;
}

interface AIChatProps {
    messages: AIChatMessage[];
    /** Content currently being streamed (appended to last assistant bubble) */
    streamingContent?: string;
    theme?: "light" | "dark";
    /** name of current project / context shown under user prompt */
    contextLabel?: string;
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

/**
 * Convert a markdown string to sanitised HTML.
 * Supports: # headings, **bold**, *italic*, `code`, ```blocks```,
 *   - bullet lists, 1. numbered lists, ---, and file path colouring.
 */
function mdToHtml(markdown: string): string {
    const lines = markdown.split("\n");
    const out: string[] = [];
    let inCode = false;
    let codeLang = "";
    let codeLines: string[] = [];
    let inList: "ul" | "ol" | null = null;

    const closelist = () => {
        if (inList === "ul") { out.push("</ul>"); inList = null; }
        if (inList === "ol") { out.push("</ol>"); inList = null; }
    };

    const esc = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    /** Apply inline markdown within a line */
    const inline = (raw: string): string => {
        let s = esc(raw);
        // **bold** / __bold__
        s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
        // *italic* / _italic_
        s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
            (_, a, b) => `<em>${a ?? b}</em>`);
        // `inline code`
        s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
        // file paths  /Users/... or ~/...
        s = s.replace(/(~\/[\w/.,-]+|\/[\w/.,-]{3,})/g, m => `<span class="ai-path">${m}</span>`);
        return s;
    };

    for (const raw of lines) {
        const line = raw;

        // ── code fence ──────────────────────────────────────────────────────────
        if (line.startsWith("```")) {
            if (!inCode) {
                closelist();
                inCode = true;
                codeLang = line.slice(3).trim();
                codeLines = [];
            } else {
                const langLabel = codeLang ? `<span class="ai-code-lang">${esc(codeLang)}</span>` : "";
                out.push(`<pre class="ai-code-block">${langLabel}<code>${esc(codeLines.join("\n"))}</code></pre>`);
                inCode = false;
                codeLang = "";
                codeLines = [];
            }
            continue;
        }

        if (inCode) {
            codeLines.push(raw);
            continue;
        }

        // ── horizontal rule ──────────────────────────────────────────────────────
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
            closelist();
            out.push('<hr class="ai-hr" />');
            continue;
        }

        // ── headings ─────────────────────────────────────────────────────────────
        const h4 = line.match(/^#{4,}\s+(.*)/);
        if (h4) { closelist(); out.push(`<h4 class="ai-h4">${inline(h4[1])}</h4>`); continue; }

        const h3 = line.match(/^###\s+(.*)/);
        if (h3) { closelist(); out.push(`<h3 class="ai-h3">${inline(h3[1])}</h3>`); continue; }

        const h2 = line.match(/^##\s+(.*)/);
        if (h2) { closelist(); out.push(`<h2 class="ai-h2">${inline(h2[1])}</h2>`); continue; }

        const h1 = line.match(/^#\s+(.*)/);
        if (h1) { closelist(); out.push(`<h1 class="ai-h1">${inline(h1[1])}</h1>`); continue; }

        // ── unordered list ───────────────────────────────────────────────────────
        const ul = line.match(/^(\s*)[-*]\s+(.*)/);
        if (ul) {
            if (inList !== "ul") { closelist(); out.push('<ul class="ai-list">'); inList = "ul"; }
            out.push(`<li>${inline(ul[2])}</li>`);
            continue;
        }

        // ── ordered list ─────────────────────────────────────────────────────────
        const ol = line.match(/^(\s*)\d+\.\s+(.*)/);
        if (ol) {
            if (inList !== "ol") { closelist(); out.push('<ol class="ai-list">'); inList = "ol"; }
            out.push(`<li>${inline(ol[2])}</li>`);
            continue;
        }

        // ── blank line ───────────────────────────────────────────────────────────
        if (line.trim() === "") {
            closelist();
            out.push('<div class="ai-spacer"></div>');
            continue;
        }

        // ── regular paragraph ────────────────────────────────────────────────────
        closelist();
        out.push(`<p class="ai-p">${inline(line)}</p>`);
    }

    closelist();
    if (inCode && codeLines.length > 0) {
        out.push(`<pre class="ai-code-block"><code>${esc(codeLines.join("\n"))}</code></pre>`);
    }

    return out.join("");
}

// ── Spinner component (dots) ──────────────────────────────────────────────────

function StreamingDots() {
    return (
        <span className="ai-streaming-dots">
            <span /><span /><span />
        </span>
    );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function AIChat({ messages, streamingContent = "", theme = "dark", contextLabel }: AIChatProps) {
    const bottomRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom on new content
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, streamingContent]);

    if (messages.length === 0) return null;

    return (
        <div className={`ai-chat-panel ${theme}`} role="log" aria-live="polite">
            {messages.map((msg) => (
                <div key={msg.id} className={`ai-chat-message ai-chat-${msg.role}`}>
                    {msg.role === "user" ? (
                        <div className="ai-user-row">
                            <span className="ai-user-icon">›</span>
                            <div className="ai-user-content">
                                <span className="ai-user-text">{msg.content}</span>
                                {contextLabel && (
                                    <span className="ai-context-label">{contextLabel}</span>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="ai-assistant-body">
                            {msg.streaming ? (
                                // Show streamed content so far + dots
                                <>
                                    <div
                                        className="ai-markdown"
                                        dangerouslySetInnerHTML={{ __html: mdToHtml(streamingContent) }}
                                    />
                                    <StreamingDots />
                                </>
                            ) : (
                                <div
                                    className="ai-markdown"
                                    dangerouslySetInnerHTML={{ __html: mdToHtml(msg.content) }}
                                />
                            )}
                        </div>
                    )}
                </div>
            ))}
            <div ref={bottomRef} />
        </div>
    );
}
