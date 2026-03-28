import React, { useState, useEffect, useRef } from 'react';
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

interface GitRemoteInfo {
  remoteUrl: string | null;
  githubRepo: string | null;
  githubUrl: string | null;
  contributors: Array<{ name: string; email: string; commits: number }>;
  totalCommits: number;
  firstCommitDate: string | null;
  branches: string[];
}

interface GitBranchList {
  current: string;
  local: string[];
  remote: string[];
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

interface OperationStatus {
  type: 'success' | 'error' | 'loading';
  message: string;
}

interface GitPanelProps {
  currentDir: string;
  onFileClick?: (filePath: string) => void;
  onBranchChange?: () => void;
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

export const GitPanel: React.FC<GitPanelProps> = ({ currentDir, onFileClick, onBranchChange }) => {
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<GitFileStatus | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New state for GitHub/branch features
  const [repoInfo, setRepoInfo] = useState<GitRemoteInfo | null>(null);
  const [branchList, setBranchList] = useState<GitBranchList | null>(null);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [opStatus, setOpStatus] = useState<OperationStatus | null>(null);
  const [showInitRemote, setShowInitRemote] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState('');
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const remoteInputRef = useRef<HTMLInputElement>(null);

  // Auto-dismiss operation status
  useEffect(() => {
    if (opStatus && opStatus.type !== 'loading') {
      const timer = setTimeout(() => setOpStatus(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [opStatus]);

  // Close branch dropdown on outside click
  useEffect(() => {
    if (!showBranchDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showBranchDropdown]);

  // Focus new branch input when shown
  useEffect(() => {
    if (showNewBranch && newBranchInputRef.current) {
      newBranchInputRef.current.focus();
    }
  }, [showNewBranch]);

  // Focus remote input when shown
  useEffect(() => {
    if (showInitRemote && remoteInputRef.current) {
      remoteInputRef.current.focus();
    }
  }, [showInitRemote]);

  const currentDirRef = useRef(currentDir);
  currentDirRef.current = currentDir;

  const loadGitStatus = async () => {
    const dir = currentDirRef.current;
    if (!dir) return;

    setLoading(true);
    setError(null);

    try {
      const status = await invoke<GitStatusResult>('get_git_status', {
        repoPath: dir,
      });
      if (currentDirRef.current !== dir) return;
      setGitStatus(status);
    } catch (err) {
      if (currentDirRef.current !== dir) return;
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setGitStatus(null);
    } finally {
      if (currentDirRef.current === dir) setLoading(false);
    }
  };

  const loadRepoInfo = async () => {
    const dir = currentDirRef.current;
    if (!dir) return;
    try {
      const info = await invoke<GitRemoteInfo>('get_git_remote_info', {
        repoPath: dir,
      });
      if (currentDirRef.current !== dir) return;
      setRepoInfo(info);
    } catch {
      if (currentDirRef.current === dir) setRepoInfo(null);
    }
  };

  const loadBranches = async () => {
    const dir = currentDirRef.current;
    if (!dir) return;
    try {
      const branches = await invoke<GitBranchList>('git_list_branches', {
        repoPath: dir,
      });
      if (currentDirRef.current !== dir) return;
      setBranchList(branches);
    } catch {
      if (currentDirRef.current === dir) setBranchList(null);
    }
  };

  const loadDiff = async (file: GitFileStatus) => {
    const dir = currentDirRef.current;
    if (!dir) return;

    try {
      const diffContent = await invoke<string>('get_git_diff', {
        repoPath: dir,
        filePath: file.path,
        staged: file.staged,
      });
      if (currentDirRef.current !== dir) return;
      setDiff(diffContent);
      setSelectedFile(file);
    } catch (err) {
      console.error('Failed to load diff:', err);
      if (currentDirRef.current === dir) setDiff('');
    }
  };

  // Load everything when project changes
  useEffect(() => {
    loadGitStatus();
    loadRepoInfo();
    loadBranches();
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

  const refreshAll = async () => {
    await Promise.all([loadGitStatus(), loadRepoInfo(), loadBranches()]);
  };

  const handleCheckoutBranch = async (branch: string) => {
    if (!currentDir) return;
    setShowBranchDropdown(false);
    setOpStatus({ type: 'loading', message: `Switching to ${branch}...` });

    try {
      const msg = await invoke<string>('git_checkout_branch', {
        repoPath: currentDir,
        branch,
      });
      setOpStatus({ type: 'success', message: msg });
      await refreshAll();
      onBranchChange?.();
    } catch (err) {
      setOpStatus({ type: 'error', message: String(err) });
    }
  };

  const handleCreateBranch = async () => {
    if (!currentDir || !newBranchName.trim()) return;
    const name = newBranchName.trim();
    setShowNewBranch(false);
    setNewBranchName('');
    setOpStatus({ type: 'loading', message: `Creating branch ${name}...` });

    try {
      const msg = await invoke<string>('git_create_branch', {
        repoPath: currentDir,
        branch: name,
      });
      setOpStatus({ type: 'success', message: msg });
      await refreshAll();
      onBranchChange?.();
    } catch (err) {
      setOpStatus({ type: 'error', message: String(err) });
    }
  };

  const handlePull = async () => {
    if (!currentDir) return;
    setOpStatus({ type: 'loading', message: 'Pulling...' });

    try {
      const msg = await invoke<string>('git_pull', { repoPath: currentDir });
      setOpStatus({ type: 'success', message: msg || 'Pull complete' });
      await refreshAll();
      onBranchChange?.();
    } catch (err) {
      setOpStatus({ type: 'error', message: String(err) });
    }
  };

  const handlePush = async () => {
    if (!currentDir) return;
    setOpStatus({ type: 'loading', message: 'Pushing...' });

    try {
      const msg = await invoke<string>('git_push', { repoPath: currentDir });
      setOpStatus({ type: 'success', message: msg || 'Push complete' });
      await refreshAll();
    } catch (err) {
      setOpStatus({ type: 'error', message: String(err) });
    }
  };

  const handleFetch = async () => {
    if (!currentDir) return;
    setOpStatus({ type: 'loading', message: 'Fetching...' });

    try {
      const msg = await invoke<string>('git_fetch', { repoPath: currentDir });
      setOpStatus({ type: 'success', message: msg || 'Fetch complete' });
      await loadBranches();
    } catch (err) {
      setOpStatus({ type: 'error', message: String(err) });
    }
  };

  const handleInitRepo = async () => {
    if (!currentDir) return;
    setOpStatus({ type: 'loading', message: 'Initializing repository...' });

    try {
      const msg = await invoke<string>('git_init', { repoPath: currentDir });
      setOpStatus({ type: 'success', message: msg || 'Repository initialized' });
      setError(null);
      setShowInitRemote(true);
      await Promise.all([loadGitStatus(), loadBranches()]);
      onBranchChange?.();
    } catch (err) {
      setOpStatus({ type: 'error', message: String(err) });
    }
  };

  const handleAddRemote = async () => {
    if (!currentDir || !remoteUrl.trim()) return;
    const url = remoteUrl.trim();
    setOpStatus({ type: 'loading', message: 'Adding remote...' });

    try {
      const msg = await invoke<string>('git_add_remote', {
        repoPath: currentDir,
        name: 'origin',
        url,
      });
      setOpStatus({ type: 'success', message: msg });
      setRemoteUrl('');
      setShowInitRemote(false);
      await loadRepoInfo();
    } catch (err) {
      setOpStatus({ type: 'error', message: String(err) });
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'modified': return 'M';
      case 'added': return 'A';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'untracked': return '?';
      default: return '-';
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

  // Get all unique branches for the dropdown (merge local + remote, dedup)
  const getAllBranches = (): string[] => {
    if (!branchList) return [];
    const all = new Set<string>();
    branchList.local.forEach(b => all.add(b));
    branchList.remote.forEach(b => {
      if (!branchList.local.includes(b)) all.add(b);
    });
    return Array.from(all);
  };

  const currentBranch = branchList?.current || gitStatus?.branch || '';

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
          <h3>Git</h3>
          <button className="refresh-btn" onClick={() => { loadGitStatus(); loadRepoInfo(); loadBranches(); }}>
            R
          </button>
        </div>

        {/* Operation status shown during/after init */}
        {opStatus && (
          <div className={`git-op-status git-op-${opStatus.type}`}>
            {opStatus.type === 'loading' && <span className="git-op-spinner" />}
            <span className="git-op-message">{opStatus.message}</span>
          </div>
        )}

        <div className="git-init-section">
          <div className="git-init-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"/>
              <circle cx="18" cy="6" r="3"/>
              <circle cx="6" cy="18" r="3"/>
              <path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
          </div>
          <p className="git-init-title">No git repository</p>
          <p className="git-init-desc">Initialize a repository to start tracking changes</p>
          <button className="git-init-btn" onClick={handleInitRepo}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Initialize Repository
          </button>
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
      {/* Header */}
      <div className="git-header">
        <h3>Git</h3>
        <button className="refresh-btn" onClick={refreshAll} disabled={loading}>
          {loading ? '...' : 'R'}
        </button>
      </div>

      {/* Repo info - auto-detected */}
      {repoInfo?.githubRepo ? (
        <div className="git-repo-info">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="git-repo-icon">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          <a
            href={repoInfo.githubUrl || '#'}
            className="git-repo-link"
            onClick={(e) => {
              e.preventDefault();
              if (repoInfo.githubUrl) {
                window.open(repoInfo.githubUrl, '_blank');
              }
            }}
          >
            {repoInfo.githubRepo}
          </a>
        </div>
      ) : repoInfo && !repoInfo.remoteUrl ? (
        /* No remote configured — show add remote prompt */
        <div className="git-remote-setup">
          {!showInitRemote ? (
            <button className="git-add-remote-toggle" onClick={() => { setShowInitRemote(true); setTimeout(() => remoteInputRef.current?.focus(), 50); }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add Remote
            </button>
          ) : (
            <div className="git-remote-input-row">
              <input
                ref={remoteInputRef}
                className="git-remote-input"
                type="text"
                placeholder="https://github.com/user/repo.git"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddRemote();
                  if (e.key === 'Escape') { setShowInitRemote(false); setRemoteUrl(''); }
                }}
              />
              <button
                className="git-remote-confirm"
                onClick={handleAddRemote}
                disabled={!remoteUrl.trim()}
              >
                Add
              </button>
            </div>
          )}
        </div>
      ) : null}

      {/* Branch bar */}
      {gitStatus && (
        <div className="git-branch-bar">
          <div className="git-branch-selector" ref={branchDropdownRef}>
            <button
              className="git-branch-btn"
              onClick={() => setShowBranchDropdown(!showBranchDropdown)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="3" x2="6" y2="15"/>
                <circle cx="18" cy="6" r="3"/>
                <circle cx="6" cy="18" r="3"/>
                <path d="M18 9a9 9 0 0 1-9 9"/>
              </svg>
              <span className="git-branch-current">{currentBranch}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {showBranchDropdown && (
              <div className="git-branch-dropdown">
                <div className="git-branch-dropdown-header">Branches</div>
                {getAllBranches().map(branch => (
                  <button
                    key={branch}
                    className={`git-branch-option ${branch === currentBranch ? 'current' : ''}`}
                    onClick={() => {
                      if (branch !== currentBranch) {
                        handleCheckoutBranch(branch);
                      } else {
                        setShowBranchDropdown(false);
                      }
                    }}
                  >
                    <span className="git-branch-option-name">{branch}</span>
                    {branch === currentBranch && <span className="git-branch-option-badge">current</span>}
                    {!branchList?.local.includes(branch) && branch !== currentBranch && (
                      <span className="git-branch-option-remote">remote</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
            <div className="git-sync">
              {gitStatus.ahead > 0 && <span className="ahead">+{gitStatus.ahead}</span>}
              {gitStatus.behind > 0 && <span className="behind">-{gitStatus.behind}</span>}
            </div>
          )}
        </div>
      )}

      {/* Git actions */}
      {gitStatus && (
        <div className="git-actions">
          <button className="git-action-btn" onClick={handlePull} title="Pull">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="7 13 12 18 17 13"/>
              <line x1="12" y1="18" x2="12" y2="6"/>
            </svg>
            Pull
          </button>
          <button className="git-action-btn" onClick={handlePush} title="Push">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="17 11 12 6 7 11"/>
              <line x1="12" y1="6" x2="12" y2="18"/>
            </svg>
            Push
          </button>
          <button className="git-action-btn" onClick={handleFetch} title="Fetch">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Fetch
          </button>
          <button
            className="git-action-btn"
            onClick={() => { setShowNewBranch(!showNewBranch); setNewBranchName(''); }}
            title="New Branch"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            Branch
          </button>
        </div>
      )}

      {/* New branch input */}
      {showNewBranch && (
        <div className="git-new-branch">
          <input
            ref={newBranchInputRef}
            className="git-new-branch-input"
            type="text"
            placeholder="new-branch-name"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateBranch();
              if (e.key === 'Escape') { setShowNewBranch(false); setNewBranchName(''); }
            }}
          />
          <button
            className="git-new-branch-confirm"
            onClick={handleCreateBranch}
            disabled={!newBranchName.trim()}
          >
            Create
          </button>
        </div>
      )}

      {/* Operation status */}
      {opStatus && (
        <div className={`git-op-status git-op-${opStatus.type}`}>
          {opStatus.type === 'loading' && <span className="git-op-spinner" />}
          <span className="git-op-message">{opStatus.message}</span>
        </div>
      )}

      {/* Changes section */}
      {gitStatus && (
        <>
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
                    {onFileClick && (
                      <button
                        className="view-file-btn"
                        onClick={() => onFileClick(selectedFile.path)}
                      >
                        Open File
                      </button>
                    )}
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
