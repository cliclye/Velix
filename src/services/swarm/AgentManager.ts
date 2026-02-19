/**
 * AgentManager - Manages Claude Code agent lifecycles and PTY sessions
 * Handles spawning, monitoring, and terminating agents
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import {
  Agent,
  AgentRole,
  AgentStatus,
  AgentMetrics,
  PatternMatch,
} from './types';
import { SwarmEventEmitter } from './SwarmEventEmitter';

interface PTYOutput {
  session_id: string;
  data: string;
}

interface PTYExit {
  session_id: string;
  exit_code: number | null;
}

const MAX_OUTPUT_BUFFER = 500; // Lines to keep in memory per agent

export class AgentManager {
  private agents: Map<string, Agent> = new Map();
  private eventEmitter: SwarmEventEmitter;
  private workspacePath: string;
  private outputListeners: Map<string, UnlistenFn> = new Map();
  private exitListeners: Map<string, UnlistenFn> = new Map();
  private globalOutputListener: UnlistenFn | null = null;
  private globalExitListener: UnlistenFn | null = null;
  private outputCallbacks: Array<(agentId: string, data: string) => void> = [];
  private exitCallbacks: Array<(agentId: string, exitCode: number | null) => void> = [];
  private patternDetector: ((output: string) => PatternMatch | null) | null = null;

  constructor(eventEmitter: SwarmEventEmitter, workspacePath: string) {
    this.eventEmitter = eventEmitter;
    this.workspacePath = workspacePath;
  }

  /**
   * Initialize global PTY event listeners
   */
  async initialize(): Promise<void> {
    // Listen for PTY output events
    this.globalOutputListener = await listen<PTYOutput>('pty-output', (event) => {
      const { session_id, data } = event.payload;
      const agent = this.findAgentBySessionId(session_id);
      if (agent) {
        this.handleAgentOutput(agent.id, data);
      }
    });

    // Listen for PTY exit events
    this.globalExitListener = await listen<PTYExit>('pty-exit', (event) => {
      const { session_id, exit_code } = event.payload;
      const agent = this.findAgentBySessionId(session_id);
      if (agent) {
        this.handleAgentExit(agent.id, exit_code);
      }
    });
  }

  /**
   * Cleanup listeners
   */
  async cleanup(): Promise<void> {
    if (this.globalOutputListener) {
      this.globalOutputListener();
      this.globalOutputListener = null;
    }
    if (this.globalExitListener) {
      this.globalExitListener();
      this.globalExitListener = null;
    }
    for (const unlisten of this.outputListeners.values()) {
      unlisten();
    }
    for (const unlisten of this.exitListeners.values()) {
      unlisten();
    }
    this.outputListeners.clear();
    this.exitListeners.clear();
  }

  /**
   * Set pattern detector for automation rules
   */
  setPatternDetector(detector: (output: string) => PatternMatch | null): void {
    this.patternDetector = detector;
  }

  /**
   * Find agent by PTY session ID
   */
  private findAgentBySessionId(sessionId: string): Agent | undefined {
    for (const agent of this.agents.values()) {
      if (agent.sessionId === sessionId) {
        return agent;
      }
    }
    return undefined;
  }

  /**
   * Handle output from an agent's PTY session
   */
  private handleAgentOutput(agentId: string, data: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Update last activity
    agent.lastActivityAt = new Date();

    // Add to output buffer
    const lines = data.split('\n');
    agent.outputBuffer.push(...lines);
    if (agent.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      agent.outputBuffer = agent.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }

    // Emit event
    this.eventEmitter.emitAgentEvent({
      type: 'output',
      agentId,
      data,
    });

    // Check for patterns
    if (this.patternDetector) {
      const match = this.patternDetector(data);
      if (match) {
        agent.metrics.promptsProcessed++;
        this.eventEmitter.emitAgentEvent({
          type: 'prompt_detected',
          agentId,
          match,
        });
      }
    }

    // Notify callbacks
    for (const callback of this.outputCallbacks) {
      try {
        callback(agentId, data);
      } catch (error) {
        console.error('AgentManager: Error in output callback:', error);
      }
    }
  }

  /**
   * Handle agent PTY session exit
   */
  private handleAgentExit(agentId: string, exitCode: number | null): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Update status
    agent.status = exitCode === 0 ? 'completed' : 'failed';

    // Emit event
    if (exitCode === 0) {
      this.eventEmitter.emitAgentEvent({
        type: 'completed',
        agentId,
        result: {
          id: `result_${agentId}`,
          agentId,
          role: agent.role.type,
          description: agent.assignedTask,
          status: 'completed',
          startedAt: agent.startedAt,
          completedAt: new Date(),
          output: agent.outputBuffer.join('\n'),
          filesModified: agent.metrics.filesModified,
        },
      });
    } else {
      this.eventEmitter.emitAgentEvent({
        type: 'failed',
        agentId,
        error: `Agent exited with code ${exitCode}`,
      });
    }

    // Notify callbacks
    for (const callback of this.exitCallbacks) {
      try {
        callback(agentId, exitCode);
      } catch (error) {
        console.error('AgentManager: Error in exit callback:', error);
      }
    }
  }

  /**
   * Spawn a new agent with a specific role and task
   */
  async spawnAgent(role: AgentRole, task: string): Promise<Agent> {
    const agentId = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sessionId = `swarm_${agentId}`;

    // Create PTY session
    await invoke('pty_create', {
      sessionId,
      rows: 24,
      cols: 80,
      cwd: this.workspacePath,
    });

    // Build the Claude CLI command with the prompt
    const prompt = this.buildPrompt(role, task);
    const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const command = `claude "${escapedPrompt}"\r`;

    // Create agent object
    const agent: Agent = {
      id: agentId,
      role,
      sessionId,
      status: 'initializing',
      assignedTask: task,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      outputBuffer: [],
      metrics: {
        promptsProcessed: 0,
        filesModified: [],
        testsRun: 0,
        errorsEncountered: 0,
        autoApprovals: 0,
        escalations: 0,
      },
    };

    this.agents.set(agentId, agent);

    // Send command to PTY
    await invoke('pty_write', {
      sessionId,
      data: command,
    });

    // Update status
    agent.status = 'running';

    // Emit spawned event
    this.eventEmitter.emitAgentEvent({
      type: 'spawned',
      agentId,
      role: role.type,
    });

    return agent;
  }

  /**
   * Build the complete prompt for an agent
   */
  private buildPrompt(role: AgentRole, task: string): string {
    // Combine role system prompt with the task
    const contextInfo = `
Working Directory: ${this.workspacePath}
Role: ${role.name}
Capabilities: ${role.capabilities.join(', ')}
Restrictions: ${role.restrictions.join(', ')}
`;

    return `${role.systemPrompt}

${contextInfo}

${role.initialPrompt}

Task: ${task}`;
  }

  /**
   * Send input to an agent's PTY session
   */
  async sendToAgent(agentId: string, data: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    await invoke('pty_write', {
      sessionId: agent.sessionId,
      data,
    });
  }

  /**
   * Send a response to a Claude prompt (e.g., "y" or "n")
   */
  async respondToAgent(agentId: string, response: string): Promise<void> {
    await this.sendToAgent(agentId, `${response}\r`);
  }

  /**
   * Terminate a specific agent
   */
  async terminateAgent(agentId: string, reason: string = 'User terminated'): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    try {
      // Send Ctrl+C first to gracefully stop
      await invoke('pty_write', {
        sessionId: agent.sessionId,
        data: '\x03', // Ctrl+C
      });

      // Wait a bit then kill
      await new Promise((resolve) => setTimeout(resolve, 500));

      await invoke('pty_kill', {
        sessionId: agent.sessionId,
      });
    } catch (error) {
      console.error(`Failed to terminate agent ${agentId}:`, error);
    }

    agent.status = 'terminated';

    this.eventEmitter.emitAgentEvent({
      type: 'terminated',
      agentId,
      reason,
    });

    this.agents.delete(agentId);
  }

  /**
   * Terminate all agents
   */
  async terminateAll(reason: string = 'Swarm stopped'): Promise<void> {
    const agentIds = Array.from(this.agents.keys());
    await Promise.all(agentIds.map((id) => this.terminateAgent(id, reason)));
  }

  /**
   * Get an agent by ID
   */
  getAgent(agentId: string): Agent | null {
    return this.agents.get(agentId) || null;
  }

  /**
   * Get all agents
   */
  getAllAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agents by role
   */
  getAgentsByRole(roleType: string): Agent[] {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.role.type === roleType
    );
  }

  /**
   * Get agent count
   */
  getAgentCount(): number {
    return this.agents.size;
  }

  /**
   * Get active (running) agent count
   */
  getActiveAgentCount(): number {
    return Array.from(this.agents.values()).filter(
      (agent) => agent.status === 'running' || agent.status === 'waiting_for_input'
    ).length;
  }

  /**
   * Get agent output buffer
   */
  getAgentOutput(agentId: string): string[] {
    const agent = this.agents.get(agentId);
    return agent ? [...agent.outputBuffer] : [];
  }

  /**
   * Subscribe to agent output
   */
  onAgentOutput(callback: (agentId: string, data: string) => void): () => void {
    this.outputCallbacks.push(callback);
    return () => {
      const index = this.outputCallbacks.indexOf(callback);
      if (index !== -1) {
        this.outputCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Subscribe to agent exit
   */
  onAgentExit(callback: (agentId: string, exitCode: number | null) => void): () => void {
    this.exitCallbacks.push(callback);
    return () => {
      const index = this.exitCallbacks.indexOf(callback);
      if (index !== -1) {
        this.exitCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Update agent metrics
   */
  updateAgentMetrics(agentId: string, updates: Partial<AgentMetrics>): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.metrics = { ...agent.metrics, ...updates };
    }
  }

  /**
   * Update agent status
   */
  updateAgentStatus(agentId: string, status: AgentStatus): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = status;
    }
  }

  /**
   * Check if any agents are stalled (no output for a while)
   */
  getStalledAgents(thresholdMs: number = 60000): Agent[] {
    const now = Date.now();
    return Array.from(this.agents.values()).filter((agent) => {
      if (agent.status !== 'running') return false;
      const timeSinceActivity = now - agent.lastActivityAt.getTime();
      return timeSinceActivity > thresholdMs;
    });
  }

  /**
   * Get agent health status
   */
  getAgentHealth(agentId: string): {
    status: 'healthy' | 'stalled' | 'erroring' | 'completed';
    lastActivity: Date;
    errorRate: number;
  } | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const timeSinceActivity = Date.now() - agent.lastActivityAt.getTime();
    const errorRate = agent.metrics.errorsEncountered / Math.max(agent.metrics.promptsProcessed, 1);

    let status: 'healthy' | 'stalled' | 'erroring' | 'completed' = 'healthy';
    if (agent.status === 'completed' || agent.status === 'failed') {
      status = 'completed';
    } else if (timeSinceActivity > 60000) {
      status = 'stalled';
    } else if (errorRate > 0.5) {
      status = 'erroring';
    }

    return {
      status,
      lastActivity: agent.lastActivityAt,
      errorRate,
    };
  }
}
