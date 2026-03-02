import React, { useEffect, useMemo, useState } from 'react';
import './DiffPanel.css';
import type { DiffHunk, DiffLine } from '../utils/diff';

export interface PendingFileChange {
  filePath: string;
  displayPath: string;
  originalContent: string | null;
  newContent: string;
}

export interface FileDiff {
  change: PendingFileChange;
  hunks: DiffHunk[];
  addedCount: number;
  removedCount: number;
  isNewFile: boolean;
}

export interface DiffPanelProps {
  fileDiffs: FileDiff[];
  onRevertAll: () => void;
  onRevertFile: (filePath: string) => void;
  onKeepAll: () => void;
  onClose: () => void;
  theme: 'dark' | 'light';
}

type FileTreeNode = {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  fileDiff?: FileDiff;
};

type TreeEntry =
  | { type: 'folder'; id: string; path: string; label: string; depth: number }
  | { type: 'file'; id: string; path: string; label: string; depth: number; fileDiff: FileDiff };

function buildFileTreeEntries(files: FileDiff[]): TreeEntry[] {
  const root: FileTreeNode = { name: '', path: '', children: new Map() };

  for (const fileDiff of files) {
    const parts = fileDiff.change.displayPath.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, index) => {
      const currentPath = parts.slice(0, index + 1).join('/');
      let next = node.children.get(part);
      if (!next) {
        next = { name: part, path: currentPath, children: new Map() };
        node.children.set(part, next);
      }
      node = next;
      if (index === parts.length - 1) {
        node.fileDiff = fileDiff;
      }
    });
  }

  const entries: TreeEntry[] = [];

  const walk = (node: FileTreeNode, depth: number) => {
    const children = Array.from(node.children.values()).sort((a, b) => {
      const aIsFile = !!a.fileDiff && a.children.size === 0;
      const bIsFile = !!b.fileDiff && b.children.size === 0;
      if (aIsFile !== bIsFile) return aIsFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    for (const child of children) {
      const isFile = !!child.fileDiff && child.children.size === 0;
      if (isFile && child.fileDiff) {
        entries.push({
          type: 'file',
          id: `file-${child.path}`,
          path: child.path,
          label: child.name,
          depth,
          fileDiff: child.fileDiff,
        });
      } else {
        entries.push({
          type: 'folder',
          id: `dir-${child.path}`,
          path: child.path,
          label: child.name,
          depth,
        });
        walk(child, depth + 1);
      }
    }
  };

  walk(root, 0);
  return entries;
}

function HunkHeader({ hunk }: { hunk: DiffHunk }) {
  const oldCount = hunk.lines.filter(l => l.kind !== 'added').length;
  const newCount = hunk.lines.filter(l => l.kind !== 'removed').length;
  return <div className="review-hunk-header">@@ -{hunk.oldStart},{oldCount} +{hunk.newStart},{newCount} @@</div>;
}

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <div className={`review-diff-line ${line.kind}`}>
      <span className="review-line-num">{line.oldLineNum ?? ''}</span>
      <span className="review-line-num">{line.newLineNum ?? ''}</span>
      <span className="review-line-text">{line.text || ' '}</span>
    </div>
  );
}

function FileDiffView({ fileDiff }: { fileDiff: FileDiff }) {
  if (fileDiff.hunks.length === 0) {
    return <div className="review-empty">No line-level changes for this file.</div>;
  }

  const blocks: Array<{ type: 'gap'; count: number; key: string } | { type: 'hunk'; hunk: DiffHunk; key: string }> = [];
  let previousOldEnd: number | null = null;
  let previousNewEnd: number | null = null;

  fileDiff.hunks.forEach((hunk, index) => {
    if (index > 0) {
      const oldGap = previousOldEnd !== null ? hunk.oldStart - previousOldEnd - 1 : 0;
      const newGap = previousNewEnd !== null ? hunk.newStart - previousNewEnd - 1 : 0;
      const gapCount = Math.max(oldGap, newGap);
      if (gapCount > 0) {
        blocks.push({ type: 'gap', count: gapCount, key: `gap-${index}` });
      }
    }

    blocks.push({ type: 'hunk', hunk, key: `hunk-${index}` });

    const oldNumbers = hunk.lines.map(line => line.oldLineNum).filter((n): n is number => n !== null);
    const newNumbers = hunk.lines.map(line => line.newLineNum).filter((n): n is number => n !== null);
    if (oldNumbers.length > 0) previousOldEnd = oldNumbers[oldNumbers.length - 1];
    if (newNumbers.length > 0) previousNewEnd = newNumbers[newNumbers.length - 1];
  });

  return (
    <div className="review-diff-body">
      {blocks.map((block) => {
        if (block.type === 'gap') {
          return (
            <div key={block.key} className="review-gap">
              <span>{block.count} unmodified line{block.count !== 1 ? 's' : ''}</span>
            </div>
          );
        }
        return (
          <div key={block.key} className="review-hunk">
            <HunkHeader hunk={block.hunk} />
            {block.hunk.lines.map((line, lineIndex) => (
              <DiffLineRow key={`${block.key}-${lineIndex}`} line={line} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function DiffPanel({
  fileDiffs,
  onRevertAll,
  onRevertFile,
  onKeepAll,
  onClose,
  theme,
}: DiffPanelProps) {
  const [fileFilter, setFileFilter] = useState('');
  const [activeFilePath, setActiveFilePath] = useState<string | null>(fileDiffs[0]?.change.filePath ?? null);

  const filteredFileDiffs = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();
    if (!query) return fileDiffs;
    return fileDiffs.filter((fd) => fd.change.displayPath.toLowerCase().includes(query));
  }, [fileDiffs, fileFilter]);

  useEffect(() => {
    if (filteredFileDiffs.length === 0) {
      setActiveFilePath(null);
      return;
    }
    if (!activeFilePath || !filteredFileDiffs.some(fd => fd.change.filePath === activeFilePath)) {
      setActiveFilePath(filteredFileDiffs[0].change.filePath);
    }
  }, [filteredFileDiffs, activeFilePath]);

  const activeFile = filteredFileDiffs.find(fd => fd.change.filePath === activeFilePath) ?? null;
  const totalAdded = fileDiffs.reduce((sum, fd) => sum + fd.addedCount, 0);
  const totalRemoved = fileDiffs.reduce((sum, fd) => sum + fd.removedCount, 0);

  const sidebarEntries = useMemo(() => buildFileTreeEntries(filteredFileDiffs), [filteredFileDiffs]);

  return (
    <div className={`review-panel ${theme}`}>
      <div className="review-panel-header">
        <div className="review-title-wrap">
          <span className="review-title">Uncommitted changes</span>
          <span className="review-summary">
            +{totalAdded} −{totalRemoved}
          </span>
        </div>
        <div className="review-header-actions">
          <button className="review-chip active" type="button">
            Unstaged · {fileDiffs.length}
          </button>
          <button className="review-chip muted" type="button" disabled>
            Staged
          </button>
          <button className="review-close" onClick={onClose} type="button" title="Close review panel">
            ×
          </button>
        </div>
      </div>

      <div className="review-content">
        <div className="review-main">
          <div className="review-banner">Large diff detected — showing one file at a time.</div>

          {activeFile ? (
            <>
              <div className="review-file-head">
                <div className="review-file-name">
                  <span>{activeFile.change.displayPath}</span>
                  <span className="review-file-stats">
                    <span className="add">+{activeFile.addedCount}</span>
                    <span className="remove">−{activeFile.removedCount}</span>
                  </span>
                </div>
                <button
                  className="review-revert-file"
                  type="button"
                  onClick={() => onRevertFile(activeFile.change.filePath)}
                >
                  Revert file
                </button>
              </div>
              <FileDiffView fileDiff={activeFile} />
            </>
          ) : (
            <div className="review-empty">No files match your filter.</div>
          )}

          <div className="review-footer-actions">
            <button className="review-footer-btn revert" type="button" onClick={onRevertAll}>
              Revert all
            </button>
            <button className="review-footer-btn keep" type="button" onClick={onKeepAll}>
              Keep all
            </button>
          </div>
        </div>

        <aside className="review-sidebar">
          <div className="review-filter-wrap">
            <input
              className="review-filter"
              type="text"
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder="Filter files..."
            />
          </div>
          <div className="review-tree">
            {sidebarEntries.length === 0 ? (
              <div className="review-tree-empty">No matching files.</div>
            ) : (
              sidebarEntries.map((entry) => {
                if (entry.type === 'folder') {
                  return (
                    <div key={entry.id} className="review-tree-folder" style={{ paddingLeft: `${10 + entry.depth * 14}px` }}>
                      <span className="icon">▸</span>
                      <span>{entry.label}</span>
                    </div>
                  );
                }

                const isActive = entry.fileDiff.change.filePath === activeFilePath;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={`review-tree-file ${isActive ? 'active' : ''}`}
                    style={{ paddingLeft: `${10 + entry.depth * 14}px` }}
                    onClick={() => setActiveFilePath(entry.fileDiff.change.filePath)}
                  >
                    <span className="icon">{entry.fileDiff.isNewFile ? '+' : '{}'}</span>
                    <span className="label">{entry.label}</span>
                    <span className="meta">
                      {entry.fileDiff.addedCount > 0 ? `+${entry.fileDiff.addedCount}` : ''}
                      {entry.fileDiff.removedCount > 0 ? ` −${entry.fileDiff.removedCount}` : ''}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
