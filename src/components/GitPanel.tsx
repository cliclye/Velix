import React, { useState, useEffect } from 'react';
import { invoke } from '../platform/native';
import '../styles/GitPanel.css';

interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

interface GitStatusResult {
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
}

interface SplitDiffRow {
  kind: 'context' | 'added' | 'removed' | 'modified';
  leftLineNum?: number;
  rightLineNum?: number;
  leftText: string;
  rightText: string;
}

interface SplitDiffHunk {
  header: string;
  rows: SplitDiffRow[];
}

interface GitPanelProps {
  currentDir: string;
  onFileClick: (filePath: string) => void;
}

const parseUnifiedDiffToSplit = (diffText: string): SplitDiffHunk[] => {
  const lines = diffText.split('\n');
  const hunks: SplitDiffHunk[] = [];

  let currentHunk: SplitDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  let removedBuffer: string[] = [];
  let addedBuffer: string[] = [];
  let removedStart = 0;
  let addedStart = 0;

  const flushBuffers = () => {
    if (!currentHunk) return;
    if (removedBuffer.length === 0 && addedBuffer.length === 0) return;

    const maxLen = Math.max(removedBuffer.length, addedBuffer.length);
    for (let i = 0; i < maxLen; i++) {
      const leftText = removedBuffer[i];
      const rightText = addedBuffer[i];

      if (leftText !== undefined && rightText !== undefined) {
        currentHunk.rows.push({
          kind: 'modified',
          leftLineNum: removedStart + i,
          rightLineNum: addedStart + i,
          leftText,
          rightText,
        });
      } else if (leftText !== undefined) {
        currentHunk.rows.push({
          kind: 'removed',
          leftLineNum: removedStart + i,
          leftText,
          rightText: '',
        });
      } else {
        currentHunk.rows.push({
          kind: 'added',
          rightLineNum: addedStart + i,
          leftText: '',
          rightText: rightText ?? '',
        });
      }
    }

    removedBuffer = [];
    addedBuffer = [];
  };

  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/);
    if (hunkMatch) {
      flushBuffers();
      if (currentHunk) hunks.push(currentHunk);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      currentHunk = { header: line, rows: [] };
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('-') && !line.startsWith('---')) {
      if (removedBuffer.length === 0) removedStart = oldLine;
      removedBuffer.push(line.slice(1));
      oldLine++;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (addedBuffer.length === 0) addedStart = newLine;
      addedBuffer.push(line.slice(1));
      newLine++;
      continue;
    }

    if (line.startsWith(' ')) {
      flushBuffers();
      currentHunk.rows.push({
        kind: 'context',
        leftLineNum: oldLine,
        rightLineNum: newLine,
        leftText: line.slice(1),
        rightText: line.slice(1),
      });
      oldLine++;
      newLine++;
      continue;
    }

    if (line.startsWith('\\')) {
      continue;
    }
  }

  flushBuffers();
  if (currentHunk) hunks.push(currentHunk);
  return hunks;
};

export const GitPanel: React.FC<GitPanelProps> = ({ currentDir, onFileClick }) => {
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFileStatus | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadGitStatus = async () => {
    if (!currentDir) return;

    setLoading(true);
    setError(null);

    try {
      const status = await invoke<GitStatusResult>('get_git_status', {
        repoPath: currentDir,
      });
      setGitStatus(status);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setGitStatus(null);
    } finally {
      setLoading(false);
    }
  };

  const loadDiff = async (file: GitFileStatus) => {
    if (!currentDir) return;

    try {
      const diffContent = await invoke<string>('get_git_diff', {
        repoPath: currentDir,
        filePath: file.path,
        staged: file.staged,
      });
      setDiff(diffContent);
      setSelectedFile(file);
    } catch (err) {
      console.error('Failed to load diff:', err);
      setDiff('');
    }
  };

  useEffect(() => {
    loadGitStatus();
  }, [currentDir]);

  useEffect(() => {
    if (!gitStatus || gitStatus.files.length === 0) {
      setSelectedFile(null);
      setDiff('');
      return;
    }

    const stillSelected = selectedFile && gitStatus.files.some(
      (file) => file.path === selectedFile.path && file.staged === selectedFile.staged
    );
    if (!stillSelected) {
      loadDiff(gitStatus.files[0]);
    }
  }, [gitStatus]);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'modified': return 'M';
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'untracked': return '?';
      default: return '•';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'modified': return 'status-modified';
      case 'added': return 'status-added';
      case 'deleted': return 'status-deleted';
      case 'renamed': return 'status-renamed';
      case 'untracked': return 'status-untracked';
      default: return '';
    }
  };

  const renderSplitDiff = (diffText: string) => {
    const hunks = parseUnifiedDiffToSplit(diffText);
    if (hunks.length === 0) {
      return <div className="split-diff-empty">No line-level changes to display</div>;
    }

    return (
      <div className="split-diff-view">
        <div className="split-diff-head">
          <div className="split-diff-head-col">Before</div>
          <div className="split-diff-head-col">After</div>
        </div>
        {hunks.map((hunk, hunkIndex) => (
          <div key={`${hunk.header}-${hunkIndex}`} className="split-diff-hunk">
            <div className="split-diff-hunk-header">{hunk.header}</div>
            {hunk.rows.map((row, rowIndex) => (
              <div key={`${hunkIndex}-${rowIndex}`} className={`split-diff-row ${row.kind}`}>
                <div className={`split-diff-cell left ${row.kind}`}>
                  <span className="split-diff-line-num">{row.leftLineNum ?? ''}</span>
                  <span className="split-diff-line-text">{row.leftText || ' '}</span>
                </div>
                <div className={`split-diff-cell right ${row.kind}`}>
                  <span className="split-diff-line-num">{row.rightLineNum ?? ''}</span>
                  <span className="split-diff-line-text">{row.rightText || ' '}</span>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  };

  if (!currentDir) {
    return (
      <div className="git-panel">
        <div className="git-empty">
          <p>No project open</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-panel">
        <div className="git-header">
          <h3>Git Status</h3>
          <button className="refresh-btn" onClick={loadGitStatus}>
            ↻
          </button>
        </div>
        <div className="git-error">
          <p>Not a git repository</p>
          <p className="error-detail">{error}</p>
        </div>
      </div>
    );
  }

  if (loading && !gitStatus) {
    return (
      <div className="git-panel">
        <div className="git-loading">Loading git status...</div>
      </div>
    );
  }

  return (
    <div className="git-panel">
      <div className="git-header">
        <h3>Git Status</h3>
        <button className="refresh-btn" onClick={loadGitStatus} disabled={loading}>
          {loading ? '...' : 'R'}
        </button>
      </div>

      {gitStatus && (
        <>
          <div className="git-info">
            <div className="git-branch">
              <span className="branch-icon">*</span>
              <span className="branch-name">{gitStatus.branch}</span>
            </div>
            {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
              <div className="git-sync">
                {gitStatus.ahead > 0 && <span className="ahead">+{gitStatus.ahead}</span>}
                {gitStatus.behind > 0 && <span className="behind">-{gitStatus.behind}</span>}
              </div>
            )}
          </div>

          {gitStatus.files.length === 0 ? (
            <div className="git-clean">
              <p>Working tree clean</p>
            </div>
          ) : (
            <div className="git-files-container">
              <div className="git-files-list">
                <div className="files-header">
                  Changes ({gitStatus.files.length})
                </div>
                {gitStatus.files.map((file) => (
                  <div
                    key={file.path}
                    className={`git-file-item ${selectedFile?.path === file.path ? 'selected' : ''}`}
                    onClick={() => loadDiff(file)}
                  >
                    <span className={`file-status ${getStatusColor(file.status)}`}>
                      {getStatusIcon(file.status)}
                    </span>
                    <span className="file-path">{file.path}</span>
                    {file.staged && <span className="staged-badge">S</span>}
                  </div>
                ))}
              </div>

              {selectedFile && diff && (
                <div className="git-diff-viewer">
                  <div className="diff-header">
                    <span>{selectedFile.path}</span>
                    <button
                      className="view-file-btn"
                      onClick={() => onFileClick(selectedFile.path)}
                    >
                      Open File
                    </button>
                  </div>
                  <div className="diff-content">
                    {renderSplitDiff(diff)}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};
