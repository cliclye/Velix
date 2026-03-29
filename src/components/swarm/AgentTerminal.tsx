/**
 * AgentTerminal — interactive terminal card for one swarm worker (any configured CLI).
 */

import React, { useState } from 'react';
import { Agent } from '../../services/swarm/types';
import { SwarmPtyTerminal } from './SwarmPtyTerminal';
import './AgentTerminal.css';

interface AgentTerminalProps {
  agent: Agent;
  theme: 'light' | 'dark';
  /** Display name of the worker CLI (e.g. "Gemini CLI") — shown while waiting for PTY output */
  workerCliLabel?: string;
  onKill: (agentId: string) => void;
  onSendInput: (agentId: string, data: string) => void;
  expanded: boolean;
  onToggleExpand: (agentId: string) => void;
}

export const AgentTerminal: React.FC<AgentTerminalProps> = ({
  agent,
  theme,
  workerCliLabel = 'Worker CLI',
  onKill,
  onSendInput,
  expanded,
  onToggleExpand,
}) => {
  const [inputValue, setInputValue] = useState('');
  const displayName = agent.label || agent.role.name;
  const taskSummary = (() => {
    const lines = agent.assignedTask
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const assignedLine = lines.find((line) => line.startsWith('Your assigned task:'));
    if (assignedLine) {
      return assignedLine.replace(/^Your assigned task:\s*/, '');
    }
    return lines[0] || agent.assignedTask;
  })();
  const ownershipSummary = agent.ownedFiles && agent.ownedFiles.length > 0
    ? `Owns ${agent.ownedFiles.slice(0, 3).join(', ')}${agent.ownedFiles.length > 3 ? '…' : ''}`
    : null;

  const getStatusColor = () => {
    switch (agent.status) {
      case 'running': return '#22c55e';
      case 'waiting_for_input':
      case 'waiting_for_approval': return '#eab308';
      case 'completed': return '#16a34a';
      case 'failed': return '#ef4444';
      case 'terminated': return '#f97316';
      default: return '#a3a3a3';
    }
  };

  const getStatusText = () => {
    switch (agent.status) {
      case 'running': return 'RUNNING';
      case 'waiting_for_input': return 'WAITING';
      case 'waiting_for_approval': return 'APPROVAL';
      case 'completed': return 'DONE';
      case 'failed': return 'FAILED';
      case 'terminated': return 'KILLED';
      default: return 'INIT';
    }
  };

  const handleSend = () => {
    const val = inputValue.trim();
    if (!val) return;
    onSendInput(agent.id, val);
    setInputValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  const isFinished =
    agent.status === 'completed' ||
    agent.status === 'failed' ||
    agent.status === 'terminated';

  return (
    <div
      className={`agent-terminal ${theme} ${expanded ? 'expanded' : ''} ${isFinished ? 'finished' : ''}`}
      style={{ borderColor: getStatusColor(), borderLeftWidth: 3 }}
    >
      <div className="terminal-header">
        <div className="terminal-title">
          <div className="status-dot" style={{ backgroundColor: getStatusColor() }} />
          <span className="agent-name">{displayName}</span>
          <span className="status-label" style={{ color: getStatusColor() }}>
            {getStatusText()}
          </span>
        </div>
        <div className="terminal-actions">
          <button
            className="terminal-icon-btn expand-btn"
            onClick={() => onToggleExpand(agent.id)}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '⊖' : '⊕'}
          </button>
          <button
            className="terminal-icon-btn kill-btn"
            onClick={() => onKill(agent.id)}
            title="Kill agent"
          >
            ×
          </button>
        </div>
      </div>

      <div className="agent-work-block">
        <span className="agent-work-title">Working on</span>
        <div className="agent-work-copy" title={agent.assignedTask}>
          {taskSummary}
        </div>
      </div>
      {ownershipSummary && (
        <div className="agent-ownership-label" title={agent.ownedFiles?.join(', ')}>
          {ownershipSummary}
        </div>
      )}
      {agent.failureReason && (agent.status === 'failed' || agent.status === 'terminated') && (
        <div className="agent-failure-reason" title={agent.failureReason}>
          {agent.failureReason}
        </div>
      )}

      {expanded && (
        <SwarmPtyTerminal
          agent={agent}
          theme={theme}
          className="terminal-window"
          emptyText={`Starting ${workerCliLabel} for ${displayName}…`}
        />
      )}

      {!isFinished && expanded && (
        <div className="terminal-input-row">
          <input
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send input to agent..."
            className="terminal-input"
          />
          <button
            className="terminal-send-btn"
            onClick={handleSend}
            disabled={!inputValue.trim()}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
};
