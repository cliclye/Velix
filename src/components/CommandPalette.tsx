import React, { useEffect, useMemo, useRef, useState } from 'react';
import '../styles/CommandPalette.css';

export interface PaletteCommand {
  id: string;
  title: string;
  group: string;
  hint?: string;
  shortcut?: string;
  /** Hidden when false. */
  when?: boolean;
  run: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

/** Subsequence match with a bonus for contiguous / word-start hits. Higher is better; 0 = no match. */
export function scoreCommand(haystack: string, query: string): number {
  if (!query) return 1;
  const h = haystack.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const at = h.indexOf(q);
  if (at !== -1) return 1000 - at + (at === 0 || h[at - 1] === ' ' ? 200 : 0);
  let hi = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = h.indexOf(ch, hi);
    if (found === -1) return 0;
    streak = found === hi ? streak + 1 : 0;
    score += 10 + streak * 5 + (found === 0 || h[found - 1] === ' ' ? 8 : 0);
    hi = found + 1;
  }
  return score;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, commands }) => {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  const results = useMemo(() => {
    return commands
      .filter((c) => c.when !== false)
      .map((c) => ({ command: c, score: scoreCommand(`${c.group} ${c.title} ${c.hint ?? ''}`, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => (query ? b.score - a.score : 0))
      .map((r) => r.command);
  }, [commands, query]);

  useEffect(() => { setIndex(0); }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, results]);

  if (!isOpen) return null;

  const runAt = (i: number) => {
    const command = results[i];
    if (!command) return;
    onClose();
    // Let the palette unmount first so focus changes made by the command stick.
    setTimeout(command.run, 0);
  };

  return (
    <div className="cp-backdrop" onMouseDown={onClose} role="presentation">
      <div className="cp-dialog" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cp-input"
          value={query}
          placeholder="Type a command…"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); runAt(index); }
          }}
          aria-label="Search commands"
        />
        <ul className="cp-list" ref={listRef} role="listbox">
          {results.length === 0 && <li className="cp-empty">No matching commands</li>}
          {results.map((c, i) => {
            const showGroup = i === 0 || results[i - 1].group !== c.group;
            return (
              <React.Fragment key={c.id}>
                {showGroup && !query && <li className="cp-group" aria-hidden>{c.group}</li>}
                <li
                  role="option"
                  aria-selected={i === index}
                  data-active={i === index}
                  className={`cp-item${i === index ? ' active' : ''}`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => runAt(i)}
                >
                  <span className="cp-title">
                    {query && <span className="cp-group-inline">{c.group}</span>}
                    {c.title}
                  </span>
                  {c.hint && <span className="cp-hint">{c.hint}</span>}
                  {c.shortcut && <kbd className="cp-kbd">{c.shortcut}</kbd>}
                </li>
              </React.Fragment>
            );
          })}
        </ul>
        <div className="cp-footer"><span>↑↓ navigate</span><span>↵ run</span><span>esc close</span></div>
      </div>
    </div>
  );
};
