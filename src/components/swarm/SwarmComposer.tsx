import React, { useEffect, useMemo, useRef } from 'react';
import { PROVIDERS, type ProviderID } from '../../services/ai/types';
import {
  SWARM_PRESETS,
  getWorkerCLIOptions,
  type SwarmPreset,
  type SwarmHistoryEntry,
  type WorkerCLIStatus,
} from '../../services/swarm';
import type { SwarmGoalImage } from '../../services/swarm/swarmAttachments';
import type { SwarmSettings } from './swarmSettings';
import { LAUNCH_ROLES, MAX_WORKERS, ROLE_COPY, ROLE_LIMITS, relativeTime, type LaunchRole } from './swarmUi';

interface SwarmComposerProps {
  goal: string;
  onGoalChange: (goal: string) => void;
  settings: SwarmSettings;
  onSettingsChange: (patch: Partial<SwarmSettings>) => void;
  cliStatus: Record<string, WorkerCLIStatus>;
  isCheckingCLI: boolean;
  onRecheckCLI: () => void;
  hasCoordinatorKey: boolean;
  keyChecked: boolean;
  onOpenSettings?: () => void;
  history: SwarmHistoryEntry[];
  onOpenHistory: (entry: SwarmHistoryEntry) => void;
  onLaunch: () => void;
  workspaceName: string;
  error: string | null;
  onDismissError: () => void;
  /** A preset requested from outside (command palette); applied once, then consumed. */
  incomingPreset: SwarmPreset | null;
  onPresetConsumed: () => void;
  /** Uncommitted files already in the working tree (workers will edit alongside them). */
  dirtyFileCount: number;
  onOpenGit?: () => void;
  /** Reference images attached to the goal (paste or pick). */
  images: SwarmGoalImage[];
  onAddImages: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
}

const VERDICT_LABEL: Record<SwarmHistoryEntry['verdict'], { text: string; tone: string }> = {
  approved: { text: 'Approved', tone: 'ok' },
  'max-iterations': { text: 'Concerns left', tone: 'warn' },
  unreviewed: { text: 'Unreviewed', tone: 'muted' },
  stopped: { text: 'Stopped', tone: 'muted' },
  error: { text: 'Failed', tone: 'bad' },
};

export const SwarmComposer: React.FC<SwarmComposerProps> = ({
  goal, onGoalChange, settings, onSettingsChange, cliStatus, isCheckingCLI, onRecheckCLI,
  hasCoordinatorKey, keyChecked, onOpenSettings, history, onOpenHistory, onLaunch, workspaceName,
  error, onDismissError, incomingPreset, onPresetConsumed, dirtyFileCount, onOpenGit,
  images, onAddImages, onRemoveImage,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const cliOptions = getWorkerCLIOptions();
  const selectedCLI = cliOptions.find((o) => o.id === settings.workerCLI) ?? cliOptions[0];
  const cliReady = cliStatus[selectedCLI.id]?.available === true;
  const provider = PROVIDERS.find((p) => p.id === settings.coordinatorProvider) ?? PROVIDERS[0];
  const workerCount = LAUNCH_ROLES.reduce((n, r) => n + settings.roleCounts[r], 0);

  const blocker = useMemo((): { text: string; action?: { label: string; run: () => void } } | null => {
    if (!goal.trim()) return { text: 'Describe the goal to launch.' };
    if (keyChecked && !hasCoordinatorKey) {
      return {
        text: `The coordinator needs a ${provider.name} API key.`,
        action: onOpenSettings ? { label: 'Open Settings', run: onOpenSettings } : undefined,
      };
    }
    if (!isCheckingCLI && !cliReady) {
      return {
        text: `${selectedCLI.name} isn't installed (looked for \`${selectedCLI.command}\`).`,
        action: { label: 'Check again', run: onRecheckCLI },
      };
    }
    return null;
  }, [goal, keyChecked, hasCoordinatorKey, provider.name, onOpenSettings, isCheckingCLI, cliReady, selectedCLI, onRecheckCLI]);

  const applyPreset = (preset: SwarmPreset) => {
    onGoalChange(preset.goal);
    onSettingsChange({ roleCounts: preset.roles, ...(preset.maxMode !== undefined ? { maxMode: preset.maxMode } : {}) });
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      // Select the [bracketed placeholder] so typing replaces it.
      const start = preset.goal.indexOf('[');
      const end = preset.goal.lastIndexOf(']');
      if (start !== -1 && end > start) el.setSelectionRange(start, end + 1);
    });
  };

  useEffect(() => {
    if (!incomingPreset) return;
    applyPreset(incomingPreset);
    onPresetConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingPreset]);

  const stepRole = (role: LaunchRole, delta: number) => {
    const next = settings.roleCounts[role] + delta;
    const limits = ROLE_LIMITS[role];
    if (next < limits.min || next > limits.max) return;
    if (delta > 0 && workerCount >= MAX_WORKERS) return;
    onSettingsChange({ roleCounts: { ...settings.roleCounts, [role]: next } });
  };

  const canLaunch = blocker === null;

  return (
    <div className="sw-compose">
      <div className="sw-compose-inner">
        <p className="sw-eyebrow">Swarm · {workspaceName}</p>
        <h1 className="sw-title">What should the swarm work on?</h1>
        <p className="sw-lede">
          A coordinator splits the goal into lanes. Scouts map the code, builders ship in parallel, reviewers check the real changes.
        </p>

        <div className="sw-presets" role="list" aria-label="Presets">
          {SWARM_PRESETS.map((preset) => (
            <button key={preset.id} type="button" role="listitem" className="sw-preset" onClick={() => applyPreset(preset)} title={preset.blurb}>
              {preset.name}
            </button>
          ))}
        </div>

        <div className="sw-goal-card">
          <textarea
            ref={textareaRef}
            className="sw-goal"
            value={goal}
            placeholder="Describe what you want built, fixed, or refactored…"
            rows={5}
            onChange={(e) => onGoalChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canLaunch) {
                e.preventDefault();
                onLaunch();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.items)
                .filter((item) => item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((f): f is File => !!f);
              if (files.length === 0) return;
              e.preventDefault();
              onAddImages(files);
            }}
            aria-label="Swarm goal"
          />
          {images.length > 0 && (
            <div className="sw-images" aria-label="Reference images">
              {images.map((image) => (
                <div className="sw-image-chip" key={image.id} title={image.name}>
                  <img src={image.dataUrl} alt={image.name} />
                  <button type="button" className="sw-image-remove" onClick={() => onRemoveImage(image.id)} aria-label={`Remove ${image.name}`}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="sw-goal-bar">
            <div className="sw-roster" aria-label="Roster">
              {LAUNCH_ROLES.map((role) => (
                <div className="sw-stepper" key={role} title={ROLE_COPY[role].hint}>
                  <span className={`sw-role-dot role-${role}`} />
                  <span className="sw-stepper-name">{ROLE_COPY[role].title}</span>
                  <button type="button" className="sw-step-btn" onClick={() => stepRole(role, -1)}
                    disabled={settings.roleCounts[role] <= ROLE_LIMITS[role].min} aria-label={`Fewer ${role}s`}>−</button>
                  <span className="sw-step-value">{settings.roleCounts[role]}</span>
                  <button type="button" className="sw-step-btn" onClick={() => stepRole(role, 1)}
                    disabled={settings.roleCounts[role] >= ROLE_LIMITS[role].max || workerCount >= MAX_WORKERS} aria-label={`More ${role}s`}>+</button>
                </div>
              ))}
              <button type="button" className="sw-stepper sw-attach" onClick={() => imageInputRef.current?.click()}
                title="Attach reference images (or paste them into the goal)">
                Attach image
              </button>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) onAddImages(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
            </div>
            <button type="button" className="sw-launch" onClick={onLaunch} disabled={!canLaunch}
              title={blocker?.text ?? 'Launch (⌘/Ctrl + Enter)'}>
              Launch {workerCount} worker{workerCount === 1 ? '' : 's'}
            </button>
          </div>
        </div>

        {blocker && goal.trim() && (
          <div className="sw-notice warn" role="status">
            <span>{blocker.text}</span>
            {blocker.action && <button type="button" className="sw-link" onClick={blocker.action.run}>{blocker.action.label}</button>}
          </div>
        )}
        {dirtyFileCount > 0 && (
          <div className="sw-notice" role="note">
            <span>
              {dirtyFileCount} uncommitted file{dirtyFileCount === 1 ? '' : 's'} in this project. Workers edit the same working tree, so consider committing or stashing first.
            </span>
            {onOpenGit && <button type="button" className="sw-link" onClick={onOpenGit}>Open Git</button>}
          </div>
        )}
        {error && (
          <div className="sw-notice bad" role="alert">
            <span>{error}</span>
            <button type="button" className="sw-link" onClick={onDismissError}>Dismiss</button>
          </div>
        )}

        <details className="sw-options">
          <summary>Options</summary>
          <div className="sw-options-grid">
            <label className="sw-field">
              <span>Worker CLI</span>
              <div className="sw-field-row">
                <select value={settings.workerCLI} onChange={(e) => onSettingsChange({ workerCLI: e.target.value })}>
                  {cliOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}{cliStatus[o.id]?.available ? '' : ' (not found)'}</option>
                  ))}
                </select>
                <span className={`sw-dot ${isCheckingCLI ? 'pending' : cliReady ? 'ok' : 'bad'}`} aria-label={cliReady ? 'Installed' : 'Missing'} />
              </div>
            </label>

            <label className="sw-field">
              <span>Worker model <em>optional</em></span>
              <input type="text" value={settings.workerModel} placeholder="CLI default"
                onChange={(e) => onSettingsChange({ workerModel: e.target.value })} spellCheck={false} />
            </label>

            <label className="sw-field">
              <span>Coordinator</span>
              <div className="sw-field-row">
                <select value={settings.coordinatorProvider}
                  onChange={(e) => onSettingsChange({ coordinatorProvider: e.target.value as ProviderID, coordinatorModel: '' })}>
                  {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <span className={`sw-dot ${!keyChecked ? 'pending' : hasCoordinatorKey ? 'ok' : 'bad'}`} aria-label={hasCoordinatorKey ? 'Key set' : 'No key'} />
              </div>
            </label>

            <label className="sw-field">
              <span>Coordinator model</span>
              <select value={settings.coordinatorModel || provider.models[0]}
                onChange={(e) => onSettingsChange({ coordinatorModel: e.target.value })}>
                {provider.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>

            <label className="sw-field">
              <span>Review rounds <em>max</em></span>
              <input type="number" min={1} max={6} value={settings.maxReviewIterations}
                onChange={(e) => onSettingsChange({ maxReviewIterations: Number(e.target.value) })} />
            </label>

            <label className="sw-field">
              <span>Parallel workers <em>max</em></span>
              <input type="number" min={1} max={12} value={settings.concurrency}
                onChange={(e) => onSettingsChange({ concurrency: Number(e.target.value) })} />
            </label>

            <label className="sw-check">
              <input type="checkbox" checked={settings.maxMode} onChange={(e) => onSettingsChange({ maxMode: e.target.checked })} />
              <span><strong>Max mode</strong> — no shortcuts, deeper self-review, longer time limits.</span>
            </label>

            {settings.workerCLI === 'claude' && (
              <label className="sw-check">
                <input type="checkbox" checked={settings.useSavedClaudeKey}
                  onChange={(e) => onSettingsChange({ useSavedClaudeKey: e.target.checked })} />
                <span><strong>Use my saved Anthropic key for Claude Code</strong> — otherwise it uses its own login.</span>
              </label>
            )}
          </div>
        </details>

        {history.length > 0 && (
          <section className="sw-history" aria-label="Recent runs">
            <h2>Recent runs</h2>
            <ul>
              {history.slice(0, 5).map((entry) => {
                const v = VERDICT_LABEL[entry.verdict];
                return (
                  <li key={entry.id}>
                    <button type="button" className="sw-history-row" onClick={() => onOpenHistory(entry)}>
                      <span className="sw-history-goal">{entry.goal}</span>
                      <span className="sw-history-meta">
                        <span className={`sw-chip ${v.tone}`}>{v.text}</span>
                        <span>{entry.changes.length} file{entry.changes.length === 1 ? '' : 's'}</span>
                        <span>{relativeTime(entry.finishedAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
};
