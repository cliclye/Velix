/**
 * AgentCard - Display card for a single agent
 */

import React from 'react';
import { Agent } from '../../services/swarm/types';
import { getRoleColor } from '../../services/swarm/roleDefinitions';

interface AgentCardProps {
  agent: Agent;
  theme: 'light' | 'dark';
  onTerminate?: () => void;
  onSelect?: () => void;
}

export const AgentCard: React.FC<AgentCardProps> = ({
  agent,
  theme,
  onTerminate,
  onSelect,
}) => {
  const roleColor = getRoleColor(agent.role.type);

  const getStatusIcon = () => {
    switch (agent.status) {
      case 'running':
        return '▶';
      case 'waiting_for_input':
        return '…';
      case 'waiting_for_approval':
        return '!';
      case 'completed':
        return '✓';
      case 'failed':
        return '✗';
      case 'terminated':
        return '×';
      default:
        return '◯';
    }
  };

  const getStatusClass = () => {
    switch (agent.status) {
      case 'running':
        return 'running';
      case 'waiting_for_input':
      case 'waiting_for_approval':
        return 'waiting';
      case 'completed':
        return 'completed';
      case 'failed':
      case 'terminated':
        return 'failed';
      default:
        return 'initializing';
    }
  };

  const formatTime = (date: Date) => {
    const now = Date.now();
    const diff = now - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  const lastOutput = agent.outputBuffer.slice(-3).join('\n');

  return (
    <div
      className={`agent-card ${theme} ${getStatusClass()}`}
      onClick={onSelect}
      style={{ borderLeftColor: roleColor }}
    >
      <div className="agent-header">
        <div className="agent-role" style={{ backgroundColor: roleColor }}>
          {agent.role.name}
        </div>
        <span className="agent-status">
          {getStatusIcon()} {agent.status}
        </span>
      </div>

      <div className="agent-task">
        {agent.assignedTask.length > 100
          ? agent.assignedTask.slice(0, 100) + '...'
          : agent.assignedTask}
      </div>

      <div className="agent-metrics">
        <div className="metric">
          <span className="label">Prompts</span>
          <span className="value">{agent.metrics.promptsProcessed}</span>
        </div>
        <div className="metric">
          <span className="label">Files</span>
          <span className="value">{agent.metrics.filesModified.length}</span>
        </div>
        <div className="metric">
          <span className="label">Errors</span>
          <span className="value">{agent.metrics.errorsEncountered}</span>
        </div>
        <div className="metric">
          <span className="label">Runtime</span>
          <span className="value">{formatTime(agent.startedAt)}</span>
        </div>
      </div>

      {lastOutput && (
        <div className="agent-output">
          <pre>{lastOutput}</pre>
        </div>
      )}

      <div className="agent-actions">
        {onTerminate && agent.status !== 'completed' && agent.status !== 'terminated' && (
          <button
            className="terminate-btn"
            onClick={(e) => {
              e.stopPropagation();
              onTerminate();
            }}
          >
            Terminate
          </button>
        )}
      </div>
    </div>
  );
};
