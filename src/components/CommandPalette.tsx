import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./CommandPalette.css";

export interface CommandPaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  /** Extra strings to match when filtering (e.g. "swarm", "git") */
  keywords?: string[];
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  theme: "light" | "dark";
  items: CommandPaletteItem[];
}

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

export function CommandPalette({ open, onClose, theme, items }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = normalize(query);
    if (!q) return items.filter((i) => !i.disabled);
    return items.filter((item) => {
      if (item.disabled) return false;
      const hay = [
        item.title,
        item.subtitle || "",
        item.id,
        ...(item.keywords || []),
      ]
        .join(" ")
        .toLowerCase();
      return q.split(/\s+/).every((part) => part.length === 0 || hay.includes(part));
    });
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setHighlight((h) => {
      if (filtered.length === 0) return 0;
      return Math.min(h, filtered.length - 1);
    });
  }, [filtered.length]);

  const runHighlighted = useCallback(() => {
    const item = filtered[highlight];
    if (!item) return;
    item.onSelect();
    onClose();
  }, [filtered, highlight, onClose]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (filtered.length ? (h + 1) % filtered.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) =>
          filtered.length ? (h - 1 + filtered.length) % filtered.length : 0,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        runHighlighted();
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, filtered.length, onClose, runHighlighted]);

  if (!open) return null;

  return (
    <div
      className={`command-palette-backdrop ${theme}`}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="command-palette-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="command-palette-field">
          <svg
            className="command-palette-search-icon"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Jump to action…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
          />
          <kbd className="command-palette-kbd-hint">esc</kbd>
        </div>
        <ul className="command-palette-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="command-palette-empty">No matches</li>
          ) : (
            filtered.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  className={`command-palette-row${index === highlight ? " highlighted" : ""}`}
                  disabled={item.disabled}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => {
                    if (item.disabled) return;
                    item.onSelect();
                    onClose();
                  }}
                >
                  <span className="command-palette-row-main">
                    <span className="command-palette-row-title">{item.title}</span>
                    {item.subtitle ? (
                      <span className="command-palette-row-sub">{item.subtitle}</span>
                    ) : null}
                  </span>
                  {item.shortcut ? (
                    <kbd className="command-palette-kbd">{item.shortcut}</kbd>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
