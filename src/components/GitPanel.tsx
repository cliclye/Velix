import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
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

interface GitPanelProps {
  currentDir: string;
  onFileClick: (filePath: string) => void;
}

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

  const renderDiff = (diffText: string) => {
    const lines = diffText.split('\n');
    return lines.map((line, idx) => {
      let className = 'diff-line';
      if (line.startsWith('+') && !line.startsWith('+++')) {
        className += ' diff-added';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        className += ' diff-removed';
      } else if (line.startsWith('@@')) {
        className += ' diff-hunk';
      } else if (line.startsWith('diff') || line.startsWith('index') || line.startsWith('+++') || line.startsWith('---')) {
        className += ' diff-header';
      }

      return (
        <div key={idx} className={className}>
          {line || ' '}
        </div>
      );
    });
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
                    {renderDiff(diff)}
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
