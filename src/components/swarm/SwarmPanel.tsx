import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  claudeCoordinator,
  detectWorkerCLIAvailability,
  getWorkerCLIOptions,
  isRunActive,
  getSwarmPreset,
  loadSwarmHistory,
  onSwarmPresetRequest,
  swarmSession,
  takePendingSwarmPreset,
  type SwarmHistoryEntry,
  type SwarmPreset,
  type WorkerCLIStatus,
} from '../../services/swarm';
import { useNow, useSwarmSession } from '../../hooks/useSwarmSession';
import { SwarmComposer } from './SwarmComposer';
import { SwarmRunView } from './SwarmRunView';
import { useSwarmSettings } from './swarmSettings';
import { isLive } from './swarmUi';
import './SwarmPanel.css';
import './SwarmMindMap.css';

interface SwarmPanelProps {
  workspacePath: string;
  theme: 'light' | 'dark';
  onOpenSettings?: () => void;
  onOpenGit?: () => void;
}

const workspaceNameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() || 'workspace';

/**
 * Swarm view. The run itself lives in `swarmSession` (outside React), so this panel can
 * unmount, remount, or change workspace without touching the workers.
 */
export const SwarmPanel: React.FC<SwarmPanelProps> = ({ workspacePath, theme, onOpenSettings, onOpenGit }) => {
  const snapshot = useSwarmSession();
  const [settings, updateSettings] = useSwarmSettings();
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cliStatus, setCliStatus] = useState<Record<string, WorkerCLIStatus>>({});
  const [isCheckingCLI, setIsCheckingCLI] = useState(true);
  const [hasKey, setHasKey] = useState(false);
  const [keyChecked, setKeyChecked] = useState(false);
  const [history, setHistory] = useState<SwarmHistoryEntry[]>(() => loadSwarmHistory());
  const [viewing, setViewing] = useState<SwarmHistoryEntry | null>(null);
  const [incomingPreset, setIncomingPreset] = useState<SwarmPreset | null>(null);

  const active = isRunActive(snapshot.phase);
  const now = useNow(active || snapshot.agents.some(isLive));

  const recheckCLI = useCallback(() => {
    setIsCheckingCLI(true);
    detectWorkerCLIAvailability()
      .then(setCliStatus)
      .catch(() => setCliStatus({}))
      .finally(() => setIsCheckingCLI(false));
  }, []);

  useEffect(() => { recheckCLI(); }, [recheckCLI]);

  useEffect(() => {
    let cancelled = false;
    setKeyChecked(false);
    claudeCoordinator.hasCoordinatorKey(settings.coordinatorProvider)
      .then((ok) => { if (!cancelled) { setHasKey(ok); setKeyChecked(true); } })
      .catch(() => { if (!cancelled) { setHasKey(false); setKeyChecked(true); } });
    return () => { cancelled = true; };
  }, [settings.coordinatorProvider]);

  // Presets requested from the command palette (possibly before this panel mounted).
  useEffect(() => {
    const consume = () => {
      const id = takePendingSwarmPreset();
      const preset = id ? getSwarmPreset(id) : undefined;
      if (preset) { setViewing(null); setIncomingPreset(preset); }
    };
    consume();
    return onSwarmPresetRequest(consume);
  }, []);

  // Refresh history when a run gets recorded.
  useEffect(() => { setHistory(loadSwarmHistory()); }, [snapshot.historyId]);

  const handleLaunch = useCallback(() => {
    const trimmed = goal.trim();
    if (!trimmed || !workspacePath) return;
    setError(null);
    setViewing(null);
    const cli = getWorkerCLIOptions().find((o) => o.id === settings.workerCLI);
    swarmSession
      .start({
        goal: trimmed,
        workspacePath,
        roleCounts: settings.roleCounts,
        workerCLI: settings.workerCLI,
        workerCLIName: cli?.name ?? settings.workerCLI,
        workerModel: settings.workerModel,
        coordinatorProvider: settings.coordinatorProvider,
        coordinatorModel: settings.coordinatorModel,
        maxMode: settings.maxMode,
        maxReviewIterations: settings.maxReviewIterations,
        concurrency: settings.concurrency,
        useSavedClaudeKey: settings.useSavedClaudeKey,
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [goal, workspacePath, settings]);

  const handleRerun = useCallback(() => {
    setGoal(snapshot.goal);
    swarmSession.reset();
  }, [snapshot.goal]);

  const handleNew = useCallback(() => {
    swarmSession.reset();
  }, []);

  const workspaceName = useMemo(() => workspaceNameOf(workspacePath), [workspacePath]);
  const otherWorkspace = snapshot.phase !== 'idle' && snapshot.workspacePath && snapshot.workspacePath !== workspacePath;

  let body: React.ReactNode;
  if (snapshot.phase !== 'idle') {
    body = (
      <SwarmRunView
        snapshot={snapshot}
        now={now}
        onStop={() => void swarmSession.stop()}
        onNewRun={handleNew}
        onRerun={handleRerun}
        onStopAgent={(id) => void swarmSession.terminateAgent(id)}
        onOpenGit={onOpenGit}
      />
    );
  } else if (viewing) {
    body = (
      <div className="sw-compose">
        <div className="sw-compose-inner sw-wide">
          <button type="button" className="sw-link back" onClick={() => setViewing(null)}>← Back</button>
          <p className="sw-eyebrow">{viewing.workspaceName} · {new Date(viewing.finishedAt).toLocaleString()}</p>
          <h1 className="sw-title sm">{viewing.goal}</h1>
          <div className="sw-report-actions">
            <button type="button" className="sw-btn sm primary" onClick={() => { setGoal(viewing.goal); setViewing(null); }}>Use this goal</button>
            <button type="button" className="sw-btn sm" onClick={() => void navigator.clipboard?.writeText(viewing.reportMarkdown)}>Copy Markdown</button>
          </div>
          <div className="sw-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{viewing.reportMarkdown}</ReactMarkdown></div>
        </div>
      </div>
    );
  } else {
    body = (
      <SwarmComposer
        goal={goal}
        onGoalChange={setGoal}
        settings={settings}
        onSettingsChange={updateSettings}
        cliStatus={cliStatus}
        isCheckingCLI={isCheckingCLI}
        onRecheckCLI={recheckCLI}
        hasCoordinatorKey={hasKey}
        keyChecked={keyChecked}
        onOpenSettings={onOpenSettings}
        history={history}
        onOpenHistory={setViewing}
        onLaunch={handleLaunch}
        workspaceName={workspaceName}
        error={error}
        onDismissError={() => setError(null)}
        incomingPreset={incomingPreset}
        onPresetConsumed={() => setIncomingPreset(null)}
      />
    );
  }

  return (
    <div className={`swarm-panel ${theme}`}>
      {otherWorkspace && (
        <div className="sw-banner muted slim" role="note">
          This run belongs to <strong>{snapshot.workspaceName}</strong>, not the project currently open.
        </div>
      )}
      {body}
    </div>
  );
};
