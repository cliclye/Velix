import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readTextFile } from '../../platform/native';
import {
  agentLoopEngine,
  DEFAULT_LOOP_CONFIG,
  getPresetSlots,
  LOOP_CLI_TRANSPORT_STORAGE_KEY,
  LOOP_PRESETS,
  SLOT_LABELS,
  type AgentLoopConfig,
  type AgentLoopMode,
  type ApprovalRequest,
  type LoopActivity,
  type LoopPresetId,
  type LoopProgress,
  type LoopMemory,
  type SlotConfig,
  type Task,
} from '../../services/agent-loop';
import { aiService } from '../../services/ai';
import { PROVIDER_CATALOG, type ProviderID } from '../../services/ai/modelCatalog';
import {
  AgentManager,
  SwarmEventEmitter,
  detectWorkerCLIAvailability,
  getWorkerCLIOptions,
} from '../../services/swarm';
import type { WorkerCLI } from '../../services/swarm/types';
import {
  WORKER_CLI_STORAGE_KEY,
  buildDefaultWorkerCLIAvailability,
  type WorkerCLIAvailability,
} from '../swarm/swarmPanelModel';
import './AgentLoopPanel.css';

interface AgentLoopPanelProps {
  isOpen: boolean;
  theme: 'light' | 'dark';
  workspacePath: string;
  hasApiKey: boolean;
}

type DetailTab = 'tasks' | 'activity' | 'details';

const MODE_OPTIONS: { id: AgentLoopMode; label: string; description: string }[] = [
  { id: 'assist', label: 'Assist', description: 'Plan only — no file edits' },
  { id: 'guided', label: 'Guided', description: 'Execute with approval before changes' },
  { id: 'autonomous', label: 'Autonomous', description: 'Execute and verify automatically' },
  { id: 'infinite', label: 'Infinite', description: 'Run until goal complete or stopped' },
];

const ACTIVITY_LABELS: Record<LoopActivity['kind'], string> = {
  planning: 'Planning',
  executing: 'Executing',
  verifying: 'Verifying',
  reflecting: 'Reflecting',
  fixing: 'Fixing',
  retrying: 'Retrying',
  waiting_approval: 'Approval',
  completed: 'Done',
  error: 'Error',
};

function parseSlotValue(value: string): { provider: ProviderID; model: string } {
  const sep = value.indexOf(':');
  if (sep <= 0) return { provider: 'claude', model: value };
  return {
    provider: value.slice(0, sep) as ProviderID,
    model: value.slice(sep + 1),
  };
}

function workspaceLabel(path: string): string {
  if (!path) return 'No project';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function formatStopReason(reason: string): string {
  return reason.replace(/_/g, ' ');
}

function relativeFilePath(workspacePath: string, absolutePath: string): string {
  const base = workspacePath.replace(/\/$/, '');
  if (absolutePath.startsWith(base + '/')) {
    return absolutePath.slice(base.length + 1);
  }
  if (absolutePath.startsWith(base)) {
    return absolutePath.slice(base.length).replace(/^\//, '');
  }
  return absolutePath;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

const MAX_FILE_PREVIEW_CHARS = 80_000;
const MAX_ACTIVITY_ITEMS = 120;

function truncatePreview(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_FILE_PREVIEW_CHARS) {
    return { text: content, truncated: false };
  }
  return {
    text: `${content.slice(0, MAX_FILE_PREVIEW_CHARS)}\n\n… truncated (${content.length.toLocaleString()} chars total)`,
    truncated: true,
  };
}

export const AgentLoopPanel: React.FC<AgentLoopPanelProps> = ({
  isOpen,
  theme,
  workspacePath,
  hasApiKey,
}) => {
  const [goal, setGoal] = useState('');
  const [presetId, setPresetId] = useState<LoopPresetId>(DEFAULT_LOOP_CONFIG.presetId);
  const [slots, setSlots] = useState<SlotConfig>(() => getPresetSlots(DEFAULT_LOOP_CONFIG.presetId));
  const [mode, setMode] = useState<AgentLoopMode>(DEFAULT_LOOP_CONFIG.mode);
  const [maxIterations, setMaxIterations] = useState(DEFAULT_LOOP_CONFIG.maxIterations);
  const [detailTab, setDetailTab] = useState<DetailTab>('activity');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activities, setActivities] = useState<LoopActivity[]>([]);
  const [memory, setMemory] = useState<LoopMemory | null>(null);
  const [progress, setProgress] = useState<LoopProgress | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [modifiedFiles, setModifiedFiles] = useState<string[]>([]);
  const [executedCommands, setExecutedCommands] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [filePreviewTruncated, setFilePreviewTruncated] = useState(false);
  const approvalResolver = useRef<((approved: boolean) => void) | null>(null);
  const mountedRef = useRef(true);
  const previewRequestRef = useRef(0);
  const managerRef = useRef<AgentManager | null>(null);

  const [useCli, setUseCli] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(LOOP_CLI_TRANSPORT_STORAGE_KEY) === '1';
  });
  const [workerCLI, setWorkerCLI] = useState<WorkerCLI>(() => {
    if (typeof window === 'undefined') return 'claude';
    const stored = window.localStorage.getItem(WORKER_CLI_STORAGE_KEY);
    const options = getWorkerCLIOptions();
    if (stored && options.some((option) => option.id === stored)) {
      return stored as WorkerCLI;
    }
    return 'claude';
  });
  const [workerCLIAvailability, setWorkerCLIAvailability] = useState<WorkerCLIAvailability>(
    buildDefaultWorkerCLIAvailability,
  );
  const [isCheckingWorkerCLI, setIsCheckingWorkerCLI] = useState(false);
  const [loopPtyReady, setLoopPtyReady] = useState(false);

  const fileEntries = useMemo(
    () =>
      modifiedFiles.map((path) => ({
        absolute: path,
        relative: workspacePath ? relativeFilePath(workspacePath, path) : path,
      })),
    [modifiedFiles, workspacePath],
  );

  const activeMode = MODE_OPTIONS.find((m) => m.id === mode);
  const projectName = workspaceLabel(workspacePath);
  const selectedCliOption = useMemo(
    () => getWorkerCLIOptions().find((option) => option.id === workerCLI) || getWorkerCLIOptions()[0],
    [workerCLI],
  );
  const selectedCliAvailable = workerCLIAvailability[workerCLI]?.available ?? false;
  const canStartCli = useCli && loopPtyReady && selectedCliAvailable;

  const taskCounts = useMemo(() => {
    const counts = { pending: 0, running: 0, complete: 0, failed: 0 };
    for (const t of tasks) counts[t.status] += 1;
    return counts;
  }, [tasks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (approvalResolver.current) {
        approvalResolver.current(false);
        approvalResolver.current = null;
      }
      agentLoopEngine.stop();
    };
  }, []);

  useEffect(() => {
    if (!isOpen || !workspacePath) {
      setLoopPtyReady(false);
      return;
    }

    const manager = new AgentManager(new SwarmEventEmitter(), workspacePath);
    manager.setWorkerCLI(workerCLI);
    managerRef.current = manager;

    let disposed = false;
    setLoopPtyReady(false);

    manager
      .initialize()
      .then(() => {
        if (!disposed) setLoopPtyReady(true);
      })
      .catch((err) => {
        if (!disposed) {
          setLoopPtyReady(false);
          setError(`Failed to initialize loop CLI manager: ${err}`);
        }
      });

    return () => {
      disposed = true;
      setLoopPtyReady(false);
      void manager
        .terminateAll('Agent loop panel closed')
        .catch(() => {})
        .finally(() => {
          void manager.cleanup();
        });
      managerRef.current = null;
    };
  }, [isOpen, workspacePath]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(WORKER_CLI_STORAGE_KEY, workerCLI);
    }
    managerRef.current?.setWorkerCLI(workerCLI);
  }, [workerCLI]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(LOOP_CLI_TRANSPORT_STORAGE_KEY, useCli ? '1' : '0');
    }
  }, [useCli]);

  useEffect(() => {
    if (!isOpen || !workspacePath) return;

    let cancelled = false;
    setIsCheckingWorkerCLI(true);
    setWorkerCLIAvailability(buildDefaultWorkerCLIAvailability());

    detectWorkerCLIAvailability(workspacePath)
      .then((availability) => {
        if (!cancelled) setWorkerCLIAvailability(availability);
      })
      .catch(() => {
        if (!cancelled) setWorkerCLIAvailability(buildDefaultWorkerCLIAvailability());
      })
      .finally(() => {
        if (!cancelled) setIsCheckingWorkerCLI(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, workspacePath]);

  useEffect(() => {
    if (fileEntries.length === 0) {
      setSelectedFile(null);
      return;
    }
    setSelectedFile((current) => {
      if (current && fileEntries.some((f) => f.absolute === current)) return current;
      return fileEntries[fileEntries.length - 1].absolute;
    });
  }, [fileEntries]);

  useEffect(() => {
    if (!selectedFile) {
      setFilePreview(null);
      setFilePreviewError(null);
      setFilePreviewTruncated(false);
      return;
    }
    const requestId = ++previewRequestRef.current;
    setFilePreview(null);
    setFilePreviewError(null);
    setFilePreviewTruncated(false);

    const timer = window.setTimeout(() => {
      void readTextFile(selectedFile)
        .then((content) => {
          if (!mountedRef.current || previewRequestRef.current !== requestId) return;
          const { text, truncated } = truncatePreview(content);
          setFilePreview(text);
          setFilePreviewTruncated(truncated);
        })
        .catch((err) => {
          if (!mountedRef.current || previewRequestRef.current !== requestId) return;
          setFilePreviewError(err instanceof Error ? err.message : String(err));
        });
    }, 200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [selectedFile]);

  const handlePresetChange = (id: LoopPresetId) => {
    setPresetId(id);
    if (id !== 'custom') setSlots(getPresetSlots(id));
  };

  const updateSlot = (slot: keyof SlotConfig, provider: ProviderID, model: string) => {
    setPresetId('custom');
    setSlots((prev) => ({ ...prev, [slot]: { provider, model } }));
  };

  const handleApproval = (approved: boolean) => {
    setPendingApproval(null);
    approvalResolver.current?.(approved);
    approvalResolver.current = null;
  };

  const handleStart = useCallback(async () => {
    const trimmed = goal.trim();
    if (!trimmed) {
      setError('Enter a goal for the agent loop.');
      return;
    }
    if (!workspacePath) {
      setError('Open a project before starting the loop.');
      return;
    }

    if (useCli) {
      if (!loopPtyReady) {
        setError('CLI manager is still initializing. Wait a moment and try again.');
        return;
      }
      if (!selectedCliAvailable) {
        setError(
          `${selectedCliOption?.name || 'Selected CLI'} is not available on PATH. Install it or pick another CLI.`,
        );
        return;
      }
    } else {
      const slotList = Object.values(slots);
      const missing = await aiService.ensureSlotKeys(slotList);
      if (missing.length > 0) {
        setError(`Missing API keys for: ${missing.join(', ')}. Add them in Settings or enable local CLI mode.`);
        return;
      }
    }

    const manager = managerRef.current;
    if (useCli && !manager) {
      setError('CLI manager is not ready.');
      return;
    }

    if (agentLoopEngine.isRunning()) return;

    setError(null);
    setRunning(true);
    setActivities([]);
    setTasks([]);
    setModifiedFiles([]);
    setExecutedCommands([]);
    setSelectedFile(null);
    setFilePreview(null);
    setDetailTab('activity');

    const config: AgentLoopConfig = {
      mode,
      transport: useCli ? 'cli' : 'api',
      slots,
      maxIterations: mode === 'infinite' ? 9999 : maxIterations,
      maxRetries: DEFAULT_LOOP_CONFIG.maxRetries,
      workerCLI: useCli ? workerCLI : undefined,
      runCliPrompt: useCli
        ? (system, user, opts) =>
            manager!.runCoordinatorPrompt(`${system}\n\n---\n\n${user}`, {
              signal: opts?.signal,
              label: opts?.label,
              timeoutMs: 300_000,
              expectJson: opts?.expectJson ?? true,
              jsonShape: opts?.jsonShape,
              validateResult: opts?.validateResult,
              onProgress: opts?.onProgress,
            })
        : undefined,
    };

    const stopReason = await agentLoopEngine.run(trimmed, workspacePath, config, {
      onActivity: (a) => {
        if (!mountedRef.current) return;
        setActivities((prev) => [a, ...prev].slice(0, MAX_ACTIVITY_ITEMS));
        if (a.kind === 'waiting_approval') setDetailTab('activity');
      },
      onTasksChanged: (next) => {
        if (mountedRef.current) setTasks(next);
      },
      onProgress: (p) => {
        if (mountedRef.current) setProgress(p);
      },
      onMemoryChanged: (m) => {
        if (mountedRef.current) setMemory(m);
      },
      onFilesModified: (files) => {
        if (mountedRef.current) setModifiedFiles(files);
      },
      onCommandsExecuted: (commands) => {
        if (mountedRef.current) setExecutedCommands(commands);
      },
      onApprovalRequired: (request) =>
        new Promise<boolean>((resolve) => {
          if (!mountedRef.current) {
            resolve(false);
            return;
          }
          setPendingApproval(request);
          approvalResolver.current = resolve;
        }),
    });

    if (!mountedRef.current) return;

    setRunning(false);
    setProgress((p) => (p ? { ...p, running: false, stopReason } : { iteration: 0, maxIterations, percent: 0, currentTaskId: null, stopReason, running: false }));
    if (stopReason === 'fatal_error' || stopReason === 'no_deliverables' || stopReason === 'max_iterations') {
      const messages: Record<string, string> = {
        fatal_error: 'Agent loop stopped due to an error. Check the activity feed.',
        no_deliverables: 'Loop ended without changing files or running commands — the goal was not implemented.',
        max_iterations: 'Iteration limit reached before the goal was fully implemented.',
      };
      setError(messages[stopReason] ?? 'Agent loop stopped.');
    }
  }, [goal, workspacePath, mode, slots, maxIterations, useCli, loopPtyReady, selectedCliAvailable, selectedCliOption, workerCLI]);

  const handleStop = useCallback(() => {
    if (approvalResolver.current) {
      approvalResolver.current(false);
      approvalResolver.current = null;
    }
    setPendingApproval(null);
    agentLoopEngine.stop();
    setRunning(false);
    setProgress((p) =>
      p
        ? { ...p, running: false, stopReason: 'user_stopped' }
        : { iteration: 0, maxIterations, percent: 0, currentTaskId: null, stopReason: 'user_stopped', running: false },
    );
  }, [maxIterations]);

  const statusPill = useMemo(() => {
    if (running) return { label: 'Running', className: 'is-running' };
    if (progress?.stopReason === 'goal_completed') return { label: 'Complete', className: 'is-done' };
    if (
      progress?.stopReason === 'fatal_error' ||
      progress?.stopReason === 'no_deliverables' ||
      progress?.stopReason === 'max_iterations'
    ) {
      return { label: formatStopReason(progress.stopReason), className: 'is-error' };
    }
    if (progress?.stopReason === 'user_stopped') return { label: 'Stopped', className: '' };
    return { label: 'Ready', className: '' };
  }, [running, progress?.stopReason]);

  if (!isOpen) return null;

  return (
    <div className={`agent-loop-panel ${theme}`}>
      <header className="loop-topbar">
        <div className="loop-topbar-title">
          <h2>Loop</h2>
          <span className={`loop-status-pill ${statusPill.className}`}>{statusPill.label}</span>
        </div>
        <div className="loop-topbar-meta">
          <span className="loop-topbar-project">{projectName}</span>
          {(running || (progress?.percent ?? 0) > 0) && (
            <div className="loop-topbar-progress" aria-hidden>
              <div className="loop-topbar-progress-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
          )}
        </div>
        <div className="loop-topbar-actions">
          {running ? (
            <button type="button" className="loop-btn loop-btn-danger" onClick={handleStop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="loop-btn loop-btn-primary"
              onClick={() => void handleStart()}
              disabled={!workspacePath || (!useCli && !hasApiKey) || (useCli && !canStartCli)}
            >
              Run
            </button>
          )}
        </div>
      </header>

      {!useCli && !hasApiKey && (
        <div className="loop-inline-alert" role="status">
          Add API keys in Settings, or enable local CLI below.
        </div>
      )}

      {useCli && !selectedCliAvailable && !isCheckingWorkerCLI && (
        <div className="loop-inline-alert is-warn" role="status">
          {selectedCliOption?.name || 'CLI'} not found on PATH.
        </div>
      )}

      {error && (
        <div className="loop-inline-alert is-error" role="alert">
          <span>{error}</span>
          <button type="button" className="loop-alert-dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className="loop-body">
        <aside className="loop-rail">
          <section className="loop-section">
            <p className="loop-section-label">Goal</p>
            <textarea
              className="loop-goal-input"
              placeholder="What should the agent build or fix?"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              disabled={running}
            />
          </section>

          <section className="loop-section">
            <p className="loop-section-label">Mode</p>
            <div className="loop-segment-row">
              {MODE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`loop-segment${mode === opt.id ? ' active' : ''}`}
                  onClick={() => setMode(opt.id)}
                  disabled={running}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {activeMode && <p className="loop-hint">{activeMode.description}</p>}
            {mode !== 'infinite' && (
              <label className="loop-row" style={{ marginTop: 10 }}>
                <span>Max tasks</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(Number(e.target.value) || 25)}
                  disabled={running}
                />
              </label>
            )}
          </section>

          <section className="loop-section">
            <label className="loop-toggle-row">
              <input
                type="checkbox"
                checked={useCli}
                onChange={(e) => setUseCli(e.target.checked)}
                disabled={running}
              />
              <span>Local CLI (no API cost)</span>
            </label>
            {useCli && (
              <div className="loop-field">
                <span>CLI</span>
                <select
                  value={workerCLI}
                  onChange={(e) => setWorkerCLI(e.target.value as WorkerCLI)}
                  disabled={running}
                >
                  {getWorkerCLIOptions().map((option) => {
                    const status = workerCLIAvailability[option.id];
                    const suffix = isCheckingWorkerCLI ? '…' : status?.available ? '' : ' ✕';
                    return (
                      <option key={option.id} value={option.id}>
                        {option.name}{suffix}
                      </option>
                    );
                  })}
                </select>
                <p className="loop-hint">
                  {isCheckingWorkerCLI
                    ? 'Checking…'
                    : loopPtyReady && selectedCliAvailable
                      ? 'Ready'
                      : loopPtyReady
                        ? 'Not on PATH'
                        : 'Starting…'}
                </p>
              </div>
            )}
          </section>

          <section className="loop-section">
            <details className="loop-details-block" open={!useCli}>
              <summary>Models & presets</summary>
              <div className={`loop-details-body${useCli ? ' is-dimmed' : ''}`}>
                <div className="loop-chip-row">
                  {LOOP_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`loop-chip${presetId === preset.id ? ' active' : ''}`}
                      onClick={() => handlePresetChange(preset.id)}
                      disabled={running || useCli}
                      title={preset.description}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="loop-slot-grid">
                  {(Object.keys(SLOT_LABELS) as Array<keyof SlotConfig>).map((slotKey) => (
                    <label key={slotKey} className="loop-slot-row">
                      <span>{SLOT_LABELS[slotKey]}</span>
                      <select
                        value={`${slots[slotKey].provider}:${slots[slotKey].model}`}
                        onChange={(e) => {
                          const { provider, model } = parseSlotValue(e.target.value);
                          updateSlot(slotKey, provider, model);
                        }}
                        disabled={running || useCli}
                      >
                        {PROVIDER_CATALOG.map((provider) => (
                          <optgroup key={provider.id} label={provider.name}>
                            {provider.models
                              .filter((m) => !m.disabled)
                              .map((m) => (
                                <option key={`${slotKey}-${provider.id}-${m.id}`} value={`${provider.id}:${m.id}`}>
                                  {m.label}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              </div>
            </details>
          </section>

          <section className="loop-section">
            <div className="loop-stats-row">
              <span>{taskCounts.complete}/{tasks.length} done</span>
              {taskCounts.failed > 0 && <span className="stat-failed">{taskCounts.failed} failed</span>}
              {running && <span>task {progress?.iteration ?? 0}</span>}
            </div>
          </section>
        </aside>

        <main className="loop-feed">
          <nav className="loop-feed-tabs" aria-label="Loop views">
            {(['activity', 'tasks', 'details'] as DetailTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`loop-feed-tab${detailTab === tab ? ' active' : ''}`}
                onClick={() => setDetailTab(tab)}
              >
                {tab === 'activity' && 'Output'}
                {tab === 'tasks' && `Tasks${tasks.length ? ` · ${tasks.length}` : ''}`}
                {tab === 'details' && 'Debug'}
              </button>
            ))}
          </nav>

          <div className="loop-feed-panel">
            {detailTab === 'activity' && (
              <>
                {activities.length === 0 ? (
                  <p className="loop-feed-empty">Run output will stream here — planning, execution, and results.</p>
                ) : (
                  <ul className="loop-timeline">
                    {activities.map((a) => (
                      <li key={a.id} className={`loop-timeline-item kind-${a.kind}`}>
                        <span className="loop-timeline-dot" aria-hidden />
                        <div className="loop-timeline-body">
                          <div className="loop-timeline-meta">
                            {new Date(a.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                            {' · '}
                            {ACTIVITY_LABELS[a.kind]}
                          </div>
                          <div className="loop-timeline-msg">{a.message}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {detailTab === 'tasks' && (
              <>
                {tasks.length === 0 ? (
                  <p className="loop-feed-empty">Tasks appear after planning.</p>
                ) : (
                  <ul className="loop-task-list">
                    {tasks.map((task) => (
                      <li
                        key={task.id}
                        className={`loop-task-item${task.status === 'running' ? ' is-running' : ''}`}
                      >
                        <span className={`loop-task-dot status-${task.status}`} aria-hidden />
                        <div className="loop-task-content">
                          <div className="loop-task-head">
                            <strong>{task.title}</strong>
                            <span className="loop-task-status">{task.status}</span>
                          </div>
                          <p className="loop-task-desc">{task.description}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {detailTab === 'details' && (
              <div className="loop-meta-grid">
                <div className="loop-meta-block">
                  <h4>Files</h4>
                  <ul>
                    {modifiedFiles.length === 0 && <li>None</li>}
                    {modifiedFiles.map((f) => (
                      <li key={f}><code>{relativeFilePath(workspacePath, f)}</code></li>
                    ))}
                  </ul>
                </div>
                <div className="loop-meta-block">
                  <h4>Commands</h4>
                  <ul>
                    {executedCommands.length === 0 && <li>None</li>}
                    {executedCommands.map((c) => (
                      <li key={c}><code>{c}</code></li>
                    ))}
                  </ul>
                </div>
                {memory && (
                  <div className="loop-meta-block">
                    <h4>Memory</h4>
                    <dl className="loop-meta-dl">
                      <dt>Objective</dt>
                      <dd>{memory.goal.objective}</dd>
                      {memory.session.failures.length > 0 && (
                        <>
                          <dt>Failures</dt>
                          <dd className="is-failure">{memory.session.failures.join(' · ')}</dd>
                        </>
                      )}
                    </dl>
                  </div>
                )}
              </div>
            )}
          </div>
        </main>

        <aside className="loop-changes" aria-label="Changes">
          <div className="loop-changes-head">
            <h3>Changes{fileEntries.length > 0 ? ` · ${fileEntries.length}` : ''}</h3>
          </div>

          {fileEntries.length === 0 ? (
            <p className="loop-changes-empty">Edited files show here.</p>
          ) : (
            <ul className="loop-changes-list">
              {fileEntries.map((entry) => (
                <li key={entry.absolute}>
                  <button
                    type="button"
                    className={`loop-change-item${selectedFile === entry.absolute ? ' active' : ''}`}
                    onClick={() => setSelectedFile(entry.absolute)}
                    title={entry.absolute}
                  >
                    <span className="loop-change-name">{fileName(entry.relative)}</span>
                    <span className="loop-change-path">{entry.relative}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="loop-preview">
            {selectedFile ? (
              <>
                <div className="loop-preview-path">{relativeFilePath(workspacePath, selectedFile)}</div>
                {filePreviewError ? (
                  <p className="loop-preview-status is-error">{filePreviewError}</p>
                ) : filePreview === null ? (
                  <p className="loop-preview-status">Loading…</p>
                ) : (
                  <pre className="loop-preview-code">{filePreview}</pre>
                )}
              </>
            ) : (
              <p className="loop-changes-empty">Select a file to preview.</p>
            )}
          </div>
        </aside>
      </div>

      {pendingApproval && (
        <div className="loop-approval-overlay" role="dialog" aria-modal="true" aria-labelledby="loop-approval-title">
          <div className="loop-approval-card">
            <h3 id="loop-approval-title">Approval required</h3>
            <p className="loop-approval-kind">{pendingApproval.kind.replace(/_/g, ' ')}</p>
            <p className="loop-approval-title">{pendingApproval.title}</p>
            <p className="loop-approval-desc">{pendingApproval.description}</p>
            {pendingApproval.diffPreview && (
              <pre className="loop-approval-diff">{pendingApproval.diffPreview}</pre>
            )}
            <div className="loop-approval-actions">
              <button type="button" className="loop-btn" onClick={() => handleApproval(false)}>
                Deny
              </button>
              <button type="button" className="loop-btn loop-btn-primary" onClick={() => handleApproval(true)}>
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
