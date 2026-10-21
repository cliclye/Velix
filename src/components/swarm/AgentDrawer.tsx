import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Agent } from '../../services/swarm/types';
import { agentElapsed, isLive } from './swarmUi';

interface AgentDrawerProps {
  agent: Agent;
  now: number;
  onClose: () => void;
  onStop: (agentId: string) => void;
}

type DrawerTab = 'activity' | 'result' | 'errors' | 'task';

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const AgentDrawer: React.FC<AgentDrawerProps> = ({ agent, now, onClose, onStop }) => {
  const live = isLive(agent);
  const [tab, setTab] = useState<DrawerTab>(live ? 'activity' : 'result');
  const feedRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  // Follow the tail unless the user scrolled up.
  useEffect(() => {
    const el = feedRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [agent.activity.length, agent.output.length, tab]);

  useEffect(() => {
    if (!live && tab === 'activity' && agent.activity.length === 0) setTab('result');
  }, [live, tab, agent.activity.length]);

  const activity = agent.activity.length > 0
    ? agent.activity
    : agent.output.trim().split('\n').filter(Boolean).slice(-80).map((text) => ({ at: 0, kind: 'text' as const, text }));

  return (
    <aside className="sw-drawer" aria-label={`${agent.label ?? agent.role.name} details`}>
      <header className="sw-drawer-head">
        <div>
          <p className="sw-eyebrow">{agent.role.name}{agent.attempt > 1 ? ` · attempt ${agent.attempt}` : ''}</p>
          <h3>{agent.label ?? agent.role.name}</h3>
        </div>
        <div className="sw-drawer-actions">
          {live && <button type="button" className="sw-btn danger sm" onClick={() => onStop(agent.id)}>Stop</button>}
          <button type="button" className="sw-icon-btn" onClick={onClose} aria-label="Close details">×</button>
        </div>
      </header>

      <dl className="sw-drawer-meta">
        <div><dt>Status</dt><dd className={`status-${agent.status}`}>{agent.status}</dd></div>
        <div><dt>Time</dt><dd>{agentElapsed(agent, now)}</dd></div>
        {agent.exitCode !== undefined && agent.exitCode !== null && <div><dt>Exit</dt><dd>{agent.exitCode}</dd></div>}
        {agent.costUsd !== undefined && <div><dt>Cost</dt><dd>${agent.costUsd.toFixed(2)}</dd></div>}
      </dl>

      {agent.failureReason && <p className="sw-drawer-fail">{agent.failureReason}</p>}

      {agent.filesTouched.length > 0 && (
        <div className="sw-drawer-files">
          <h4>Files touched</h4>
          <ul>{[...new Set(agent.filesTouched)].map((f) => <li key={f}><code>{f}</code></li>)}</ul>
        </div>
      )}

      <div className="sw-tabs sm" role="tablist">
        {(['activity', 'result', 'errors', 'task'] as DrawerTab[])
          .filter((t) => t !== 'errors' || agent.stderr.trim())
          .map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'errors' ? 'stderr' : t}
            </button>
          ))}
      </div>

      <div
        className="sw-drawer-body"
        ref={feedRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {tab === 'activity' && (
          activity.length === 0
            ? <p className="sw-muted">{live ? 'Waiting for output… some CLIs only print when they finish.' : 'No activity recorded.'}</p>
            : (
              <ol className="sw-activity">
                {activity.map((a, i) => (
                  <li key={i} className={`k-${a.kind}`}>
                    {a.at > 0 && <time>{timeOf(a.at)}</time>}
                    <span>{a.text}</span>
                  </li>
                ))}
              </ol>
            )
        )}
        {tab === 'result' && (
          agent.result?.trim()
            ? <div className="sw-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{agent.result}</ReactMarkdown></div>
            : <p className="sw-muted">{live ? 'The result appears when the worker finishes.' : 'The worker produced no readable result.'}</p>
        )}
        {tab === 'errors' && <pre className="sw-pre">{agent.stderr}</pre>}
        {tab === 'task' && <pre className="sw-pre wrap">{agent.assignedTask}</pre>}
      </div>
    </aside>
  );
};
