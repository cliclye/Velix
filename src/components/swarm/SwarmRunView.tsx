import React, { useCallback, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getRole, isRunActive, type SwarmSnapshot } from '../../services/swarm';
import type { Agent } from '../../services/swarm/types';
import type { CoordinatorAssignment } from '../../services/swarm/ClaudeCoordinator';
import { SwarmMindMap, type MindMapNode, type MindMapPosition } from './SwarmMindMap';
import { AgentDrawer } from './AgentDrawer';
import {
  LAUNCH_ROLES, PHASE_STEPS, agentElapsed, assignmentState, buildConnections, formatElapsed, isLive, liveLine,
  phaseIndex, workSummary, type LaunchRole,
} from './swarmUi';

interface SwarmRunViewProps {
  snapshot: SwarmSnapshot;
  now: number;
  onStop: () => void;
  onNewRun: () => void;
  onRerun: () => void;
  onStopAgent: (agentId: string) => void;
  onOpenGit?: () => void;
}

type RunTab = 'board' | 'graph' | 'log' | 'report';

const VERDICT_BANNER: Record<NonNullable<SwarmSnapshot['verdict']>, { title: string; tone: string }> = {
  approved: { title: 'Approved by reviewers', tone: 'ok' },
  'max-iterations': { title: 'Finished — reviewers still had concerns', tone: 'warn' },
  unreviewed: { title: 'Finished without a reviewer verdict', tone: 'muted' },
  stopped: { title: 'Stopped', tone: 'muted' },
  error: { title: 'The run failed', tone: 'bad' },
};

/** Latest attempt per assignment. */
function latestByAssignment(agents: Agent[]): Map<string, Agent> {
  const map = new Map<string, Agent>();
  for (const a of agents) {
    const key = a.assignmentId ?? a.id;
    const prev = map.get(key);
    if (!prev || a.attempt >= prev.attempt) map.set(key, a);
  }
  return map;
}

export const SwarmRunView: React.FC<SwarmRunViewProps> = ({
  snapshot, now, onStop, onNewRun, onRerun, onStopAgent, onOpenGit,
}) => {
  const [tab, setTab] = useState<RunTab>('board');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, MindMapPosition>>({});
  const [copied, setCopied] = useState(false);

  const active = isRunActive(snapshot.phase);
  const latest = useMemo(() => latestByAssignment(snapshot.agents), [snapshot.agents]);
  const assignments: CoordinatorAssignment[] = snapshot.plan?.assignments ?? [];
  const finished = !active && snapshot.verdict !== null;
  const step = phaseIndex(snapshot.phase);

  const runningCount = [...latest.values()].filter(isLive).length;
  const doneCount = [...latest.values()].filter((a) => a.status === 'completed').length;
  const startedAt = snapshot.startedAt ?? now;
  const elapsed = formatElapsed((snapshot.finishedAt ?? now) - startedAt);
  const totalCost = snapshot.agents.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
  const costText = totalCost > 0 ? ` · $${totalCost.toFixed(2)}` : '';
  const openAgent = openKey ? latest.get(openKey) : undefined;

  const nodes = useMemo<MindMapNode[]>(() => assignments.map((a) => {
    const state = assignmentState(a, latest.get(a.id));
    return {
      id: a.id,
      label: a.label,
      role: a.role,
      tone: state.tone,
      statusLabel: state.label.toUpperCase(),
      workingOn: workSummary(a.task, getRole(a.role).name),
      position: positions[a.id],
    };
  }), [assignments, latest, positions]);
  const connections = useMemo(() => buildConnections(assignments), [assignments]);

  const copyReport = useCallback(async () => {
    if (!snapshot.reportMarkdown) return;
    try {
      await navigator.clipboard.writeText(snapshot.reportMarkdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  }, [snapshot.reportMarkdown]);

  const downloadReport = useCallback(() => {
    if (!snapshot.reportMarkdown) return;
    const blob = new Blob([snapshot.reportMarkdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `swarm-report-${snapshot.workspaceName || 'run'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [snapshot.reportMarkdown, snapshot.workspaceName]);

  const failedCount = [...latest.values()].filter((a) => a.status === 'failed').length;
  const baseBanner = finished && snapshot.verdict ? VERDICT_BANNER[snapshot.verdict] : null;
  // "Approved" must not hide that some workers crashed.
  const banner = baseBanner && snapshot.verdict === 'approved' && failedCount > 0
    ? { title: `Approved — but ${failedCount} worker${failedCount === 1 ? '' : 's'} failed`, tone: 'warn' }
    : baseBanner;
  const tabs: RunTab[] = finished ? ['board', 'graph', 'log', 'report'] : ['board', 'graph', 'log'];

  return (
    <div className="sw-run">
      <div className="sw-run-main">
        <header className="sw-run-head">
          <div className="sw-run-goal">
            <p className="sw-eyebrow">{snapshot.workspaceName} · {snapshot.workerCLIName}</p>
            <h2 title={snapshot.goal}>{snapshot.goal}</h2>
          </div>
          <div className="sw-run-actions">
            {active
              ? <button type="button" className="sw-btn danger" onClick={onStop}>Stop swarm</button>
              : (
                <>
                  <button type="button" className="sw-btn" onClick={onRerun}>Run again</button>
                  <button type="button" className="sw-btn primary" onClick={onNewRun}>New swarm</button>
                </>
              )}
          </div>
        </header>

        <ol className="sw-steps" aria-label="Progress">
          {PHASE_STEPS.map((label, i) => {
            const state = step === -1 ? (snapshot.phase === 'error' ? 'bad' : 'idle') : i < step ? 'done' : i === step ? 'now' : 'todo';
            return (
              <li key={label} className={`sw-step ${state}`}>
                <span className="sw-step-bullet">{state === 'done' ? '✓' : i + 1}</span>
                <span>{label}</span>
              </li>
            );
          })}
          <li className="sw-steps-meta">
            {active
              ? <>{snapshot.label}{snapshot.iteration > 1 ? ` · round ${snapshot.iteration}` : ''} · {runningCount} active · {elapsed}{costText}</>
              : <>{doneCount}/{latest.size} workers done · {elapsed}{costText}</>}
          </li>
        </ol>

        {banner && (
          <div className={`sw-banner ${banner.tone}`} role="status">
            <div>
              <strong>{banner.title}</strong>
              <span>
                {snapshot.iteration > 0 && <>{snapshot.iteration} review round{snapshot.iteration === 1 ? '' : 's'} · </>}
                {snapshot.changes.length} file{snapshot.changes.length === 1 ? '' : 's'} changed
              </span>
              {snapshot.error && <span className="sw-banner-error">{snapshot.error}</span>}
            </div>
            <div className="sw-banner-actions">
              {snapshot.changes.length > 0 && onOpenGit && <button type="button" className="sw-btn sm" onClick={onOpenGit}>Review in Git</button>}
              {snapshot.reportMarkdown && <button type="button" className="sw-btn sm" onClick={() => setTab('report')}>View report</button>}
            </div>
          </div>
        )}

        <div className="sw-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t}{t === 'log' && snapshot.log.length > 0 ? <span className="sw-count">{snapshot.log.length}</span> : null}
            </button>
          ))}
        </div>

        <div className="sw-run-body">
          {tab === 'board' && (
            <div className="sw-board">
              {snapshot.plan?.summary && <p className="sw-plan-summary">{snapshot.plan.summary}</p>}
              {assignments.length === 0 && (
                <div className="sw-empty">
                  <span className="sw-spinner" aria-hidden />
                  <p>{snapshot.phase === 'error' ? 'The coordinator could not produce a plan.' : 'The coordinator is planning the lanes…'}</p>
                </div>
              )}
              {LAUNCH_ROLES.map((role: LaunchRole) => {
                const list = assignments.filter((a) => a.role === role);
                if (list.length === 0) return null;
                return (
                  <section key={role} className="sw-lane">
                    <h3><span className={`sw-role-dot role-${role}`} />{role}s</h3>
                    <div className="sw-cards">
                      {list.map((a) => {
                        const agent = latest.get(a.id);
                        const state = assignmentState(a, agent);
                        return (
                          <button
                            key={a.id}
                            type="button"
                            className={`sw-card tone-${state.tone}${openKey === a.id ? ' selected' : ''}`}
                            onClick={() => setOpenKey((k) => (k === a.id ? null : a.id))}
                            disabled={!agent}
                          >
                            <span className="sw-card-top">
                              <strong>{a.label}</strong>
                              <span className={`sw-pill tone-${state.tone}`}>
                                {isLive(agent) && <span className="sw-pulse" aria-hidden />}
                                {state.label}
                              </span>
                            </span>
                            <span className="sw-card-task">{a.task}</span>
                            <span className="sw-card-live" title={liveLine(agent)}>{liveLine(agent)}</span>
                            <span className="sw-card-foot">
                              <span>{agent ? agentElapsed(agent, now) : '—'}</span>
                              {agent && agent.attempt > 1 && <span>attempt {agent.attempt}</span>}
                              {agent && agent.filesTouched.length > 0 && <span>{new Set(agent.filesTouched).size} file{new Set(agent.filesTouched).size === 1 ? '' : 's'}</span>}
                              {a.ownedFiles.length > 0 && <span className="sw-card-owned" title={a.ownedFiles.join('\n')}>owns {a.ownedFiles[0]}{a.ownedFiles.length > 1 ? ` +${a.ownedFiles.length - 1}` : ''}</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
              {snapshot.plan?.strategy && (
                <details className="sw-strategy">
                  <summary>Coordinator strategy</summary>
                  <p>{snapshot.plan.strategy}</p>
                </details>
              )}
            </div>
          )}

          {tab === 'graph' && (
            <div className="sw-graph">
              <SwarmMindMap
                nodes={nodes}
                connections={connections}
                coordinatorStatus={snapshot.label}
                isActive={active}
                onAgentClick={(id) => setOpenKey((k) => (k === id ? null : id))}
                selectedNodeId={openKey}
                onNodeMove={(id, pos) => setPositions((p) => ({ ...p, [id]: pos }))}
              />
            </div>
          )}

          {tab === 'log' && (
            <ol className="sw-log">
              {snapshot.log.length === 0 && <li className="sw-muted">Nothing yet.</li>}
              {snapshot.log.map((entry) => (
                <li key={entry.id} className={`k-${entry.kind}`}>
                  <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                  <span className="sw-log-kind">{entry.kind}</span>
                  <span>{entry.message}</span>
                </li>
              ))}
            </ol>
          )}

          {tab === 'report' && snapshot.reportMarkdown && (
            <div className="sw-report">
              <div className="sw-report-actions">
                <button type="button" className="sw-btn sm" onClick={() => void copyReport()}>{copied ? 'Copied' : 'Copy Markdown'}</button>
                <button type="button" className="sw-btn sm" onClick={downloadReport}>Download .md</button>
              </div>
              <div className="sw-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{snapshot.reportMarkdown}</ReactMarkdown></div>
            </div>
          )}
        </div>
      </div>

      {openAgent && (
        <AgentDrawer key={openAgent.id} agent={openAgent} now={now} onClose={() => setOpenKey(null)} onStop={onStopAgent} />
      )}
    </div>
  );
};
