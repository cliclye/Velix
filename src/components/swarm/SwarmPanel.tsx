/**
 * SwarmPanel - CLI Agent Manager
 * Manage multiple Claude CLI agent instances running in parallel PTY sessions.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AgentManager, SwarmEventEmitter } from '../../services/swarm';
import { Agent, AgentRole } from '../../services/swarm/types';
import { AgentTerminal } from './AgentTerminal';
import './SwarmPanel.css';

interface SwarmPanelProps {
  isOpen: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  workspacePath: string;
  hasApiKey: boolean;
  apiProvider?: string;
  onWriteToTerminal?: (data: string) => void;
}

export const SwarmPanel: React.FC<SwarmPanelProps> = ({
  isOpen,
  onClose,
  theme,
  workspacePath,
}) => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [spawnInput, setSpawnInput] = useState('');
  const [isSpawning, setIsSpawning] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agentCounterRef = useRef(0);

  const [agentManager] = useState(
    () => new AgentManager(new SwarmEventEmitter(), workspacePath)
  );

  useEffect(() => {
    agentManager.initialize().catch(console.error);

    const unsubscribeOutput = agentManager.onAgentOutput(() => {
      setAgents([...agentManager.getAllAgents()]);
    });

    const unsubscribeExit = agentManager.onAgentExit(() => {
      setAgents([...agentManager.getAllAgents()]);
    });

    return () => {
      unsubscribeOutput();
      unsubscribeExit();
      agentManager.cleanup();
    };
  }, [agentManager]);

  const handleSpawn = useCallback(async () => {
    const task = spawnInput.trim();
    if (!task || isSpawning) return;

    setIsSpawning(true);
    setError(null);
    agentCounterRef.current += 1;
    const agentName = `Agent #${agentCounterRef.current}`;

    const role: AgentRole = {
      type: 'implementer',
      name: agentName,
      description: task,
      systemPrompt: 'You are a helpful Claude agent. Complete the given task efficiently.',
      initialPrompt: task,
      capabilities: ['read_files', 'write_files', 'run_commands', 'search_code'],
      restrictions: [],
      priority: 1,
      estimatedDuration: 10,
    };

    try {
      await agentManager.spawnAgent(role, task);
      setAgents([...agentManager.getAllAgents()]);
      setSpawnInput('');
    } catch (err) {
      setError(`Failed to spawn agent: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSpawning(false);
    }
  }, [spawnInput, isSpawning, agentManager]);

  const handleKill = useCallback(async (agentId: string) => {
    await agentManager.terminateAgent(agentId, 'User terminated');
    setAgents([...agentManager.getAllAgents()]);
  }, [agentManager]);

  const handleKillAll = useCallback(async () => {
    await agentManager.terminateAll('User killed all');
    setAgents([]);
  }, [agentManager]);

  const handleSendInput = useCallback(async (agentId: string, data: string) => {
    try {
      await agentManager.sendToAgent(agentId, data + '\r');
    } catch (err) {
      console.error('Failed to send input to agent:', err);
    }
  }, [agentManager]);

  const handleToggleExpand = useCallback((agentId: string) => {
    setExpandedAgentId(prev => prev === agentId ? null : agentId);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSpawn();
    }
  }, [handleSpawn]);

  if (!isOpen) return null;

  const runningCount = agents.filter(
    a => a.status === 'running' || a.status === 'waiting_for_input'
  ).length;

  return (
    <div className={`swarm-panel ${theme}`}>
      <div className="swarm-header">
        <h2>Agent Manager</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="spawn-bar">
        <input
          type="text"
          value={spawnInput}
          onChange={e => setSpawnInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe a task and press Enter to spawn an agent..."
          disabled={isSpawning}
          className="spawn-input"
        />
        <button
          onClick={handleSpawn}
          disabled={!spawnInput.trim() || isSpawning}
          className="spawn-btn"
        >
          {isSpawning ? '...' : 'Run'}
        </button>
      </div>

      {error && (
        <div className="swarm-error-bar">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="agents-status-bar">
        <span className="agent-count">
          {agents.length === 0
            ? 'No agents running'
            : `${runningCount} running · ${agents.length} total`}
        </span>
        {agents.length > 0 && (
          <button className="kill-all-btn" onClick={handleKillAll}>
            Kill All
          </button>
        )}
      </div>

      <div className="agents-list">
        {agents.length === 0 ? (
          <div className="agents-empty">
            <div className="agents-empty-icon">⬡</div>
            <p>No agents running</p>
            <p className="agents-empty-sub">Enter a task above and press Enter to spawn a Claude agent.</p>
          </div>
        ) : (
          agents.map(agent => (
            <AgentTerminal
              key={agent.id}
              agent={agent}
              theme={theme}
              onKill={handleKill}
              onSendInput={handleSendInput}
              expanded={expandedAgentId === agent.id}
              onToggleExpand={handleToggleExpand}
            />
          ))
        )}
      </div>
    </div>
  );
};
