import React, { useEffect } from 'react';
import '../styles/CommandPalette.css';

export interface ShortcutRow { keys: string; action: string }

interface ShortcutsSheetProps {
  isOpen: boolean;
  onClose: () => void;
  rows: ShortcutRow[];
}

export const ShortcutsSheet: React.FC<ShortcutsSheetProps> = ({ isOpen, onClose, rows }) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div className="cp-backdrop" onMouseDown={onClose} role="presentation">
      <div className="cp-dialog cp-sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}>
        <header className="cp-sheet-head">
          <h2>Keyboard shortcuts</h2>
          <button type="button" className="cp-close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <dl className="cp-shortcuts">
          {rows.map((r) => (
            <div key={r.keys + r.action}>
              <dt>{r.action}</dt>
              <dd><kbd className="cp-kbd">{r.keys}</kbd></dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
};
