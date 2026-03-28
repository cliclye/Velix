/**
 * AgentManager - Manages Claude Code agent lifecycles and PTY sessions
 * Handles spawning, monitoring, and terminating agents
 */

import { invoke, listen, type UnlistenFn } from '../../platform/native';
import {
  Agent,
  AgentRole,
  AgentStatus,
  AgentMetrics,
  PatternMatch,
  WorkerCLI,
} from './types';
import { SwarmEventEmitter } from './SwarmEventEmitter';
import { aiService } from '../ai/AIService';

interface PTYOutput {
  session_id: string;
  data: string;
}

interface PTYExit {
  session_id: string;
  exit_code: number | null;
}


const MAX_OUTPUT_BUFFER = 500; // Lines to keep in memory per agent

// Patterns that indicate a CLI is showing its input prompt and ready for a message
const CLI_READY_PATTERNS = [
  /^\s*>\s*$/m,          // Claude Code: bare ">"
  /^\s*>\s+$/m,          // Claude Code: "> " with trailing space
  /╭─+╮/,               // Claude Code welcome box top border
  /Type your message/i,  // Some versions show this hint
  /\$\s*$/m,             // Fallback: shell prompt (Claude wasn't found, shell is ready)
];

const ANSI_ESCAPE_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g;

const sanitizeTerminalOutput = (data: string): string =>
  data
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');

export interface WorkerCLIOption {
  id: WorkerCLI;
  name: string;
  command: string;
  description: string;
  builtin?: boolean;
}

const BUILTIN_CLI_OPTIONS: WorkerCLIOption[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    description: 'Anthropic Claude Code CLI',
    builtin: true,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    description: 'Google Gemini terminal agent',
    builtin: true,
  },
  {
    id: 'velix',
    name: 'Velix CLI',
    command: 'velix',
    description: 'Velix AI CLI',
    builtin: true,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    description: 'OpenAI Codex CLI',
    builtin: true,
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    command: 'copilot',
    description: 'GitHub Copilot CLI',
    builtin: true,
  },
];

const CUSTOM_CLI_STORAGE_KEY = 'velix-custom-cli-options';

export function loadCustomCLIOptions(): WorkerCLIOption[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_CLI_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as WorkerCLIOption[];
  } catch {
    return [];
  }
}

export function saveCustomCLIOptions(options: WorkerCLIOption[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CUSTOM_CLI_STORAGE_KEY, JSON.stringify(options));
}

export function getWorkerCLIOptions(): WorkerCLIOption[] {
  return [...BUILTIN_CLI_OPTIONS, ...loadCustomCLIOptions()];
}

/** @deprecated Use getWorkerCLIOptions() instead — kept for import compatibility */
export const WORKER_CLI_OPTIONS = BUILTIN_CLI_OPTIONS;

export interface WorkerCLIStatus {
  available: boolean;
  detail: string;
}

export async function detectWorkerCLIAvailability(
  _cwd: string,
): Promise<Record<WorkerCLI, WorkerCLIStatus>> {
  const allOptions = getWorkerCLIOptions();
  const entries = await Promise.all(
    allOptions.map(async (option) => {
      try {
        const path = await invoke<string>('check_cli_available', {
          command: option.command,
        });
        return [option.id, { available: true, detail: path }] as const;
      } catch {
        return [
          option.id,
          { available: false, detail: 'Not found in PATH' },
        ] as const;
      }
    }),
  );

  return Object.fromEntries(entries) as Record<WorkerCLI, WorkerCLIStatus>;
}

export class AgentManager {
  private agents: Map<string, Agent> = new Map();
  private eventEmitter: SwarmEventEmitter;
  private workspacePath: string;
  private workerCLI: WorkerCLI = 'claude';
  private outputListeners: Map<string, UnlistenFn> = new Map();
  private exitListeners: Map<string, UnlistenFn> = new Map();
  private globalOutputListener: UnlistenFn | null = null;
  private globalExitListener: UnlistenFn | null = null;
  private outputCallbacks: Array<(agentId: string, data: string) => void> = [];
  private exitCallbacks: Array<(agentId: string, exitCode: number | null) => void> = [];
  private patternDetector: ((output: string) => PatternMatch | null) | null = null;
  // Prompts waiting to be delivered once the CLI shows its ready indicator
  private pendingPrompts: Map<string, string> = new Map();
  private pendingPromptTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(eventEmitter: SwarmEventEmitter, workspacePath: string) {
    this.eventEmitter = eventEmitter;
    this.workspacePath = workspacePath;
  }

  setWorkerCLI(workerCLI: WorkerCLI): void {
    this.workerCLI = workerCLI;
  }

  getWorkerCLI(): WorkerCLI {
    return this.workerCLI;
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
  private async handleAgentOutput(agentId: string, data: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const sanitizedData = sanitizeTerminalOutput(data);

    // If the CLI hasn't received its first prompt yet, check whether it's ready
    if (this.pendingPrompts.has(agentId)) {
      const isReady = CLI_READY_PATTERNS.some((pattern) => pattern.test(sanitizedData));
      if (isReady) {
        await this.deliverPendingPrompt(agent);
      }
    }

    // Update last activity
    agent.lastActivityAt = new Date();

    // Add to output buffer
    const lines = sanitizedData
      .split('\n')
      .map((line) => line.trimEnd());
    agent.outputBuffer.push(...lines);
    if (agent.outputBuffer.length > MAX_OUTPUT_BUFFER) {
      agent.outputBuffer = agent.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
    }

    // Emit event
    this.eventEmitter.emitAgentEvent({
      type: 'output',
      agentId,
      data: sanitizedData,
    });

    // Check for patterns
    if (this.patternDetector) {
      const match = this.patternDetector(sanitizedData);
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
        callback(agentId, sanitizedData);
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
  async spawnAgent(
    role: AgentRole,
    task: string,
    options?: {
      assignmentId?: string;
      label?: string;
      ownedFiles?: string[];
    },
  ): Promise<Agent> {
    const agentId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const sessionId = `swarm_${agentId}`;

    // Create PTY session — shell starts in the workspace directory automatically
    await invoke('pty_create', {
      sessionId,
      rows: 50,
      cols: 220,
      cwd: this.workspacePath,
    });

    // Build the prompt text (to be typed AFTER the CLI starts)
    const prompt = this.buildPrompt(role, task);
    // Step 1: just open the CLI interactively
    const startCommand = this.buildWorkerStartCommand();

    // Create agent object
    const agent: Agent = {
      id: agentId,
      role,
      sessionId,
      assignmentId: options?.assignmentId,
      label: options?.label,
      ownedFiles: options?.ownedFiles || [],
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

    // Step 1: open the CLI (e.g. `claude --dangerously-skip-permissions`)
    await invoke('pty_write', {
      sessionId,
      data: startCommand,
    });

    // Step 2: store the prompt — it will be sent once the CLI shows its ready indicator.
    // A fallback timer fires after 6 s in case the ready pattern isn't detected.
    this.pendingPrompts.set(agentId, prompt);
    const fallbackTimer = setTimeout(() => {
      const a = this.agents.get(agentId);
      if (a) this.deliverPendingPrompt(a);
    }, 6000);
    this.pendingPromptTimers.set(agentId, fallbackTimer);

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
   * Build the command that opens the CLI in interactive mode.
   * The task prompt is NOT passed here — it is typed in after the CLI starts.
   */
  private buildWorkerStartCommand(): string {
    const config = aiService.getConfig();
    const parts: string[] = [];
    const allOptions = getWorkerCLIOptions();
    const cliOption = allOptions.find((o) => o.id === this.workerCLI);

    switch (this.workerCLI) {
      case 'claude':
        parts.push('claude', '--dangerously-skip-permissions');
        if (config.provider === 'claude' && config.model) {
          parts.push('-m', config.model);
        }
        break;
      case 'gemini':
        parts.push('gemini');
        if (config.provider === 'gemini' && config.model) {
          parts.push('-m', config.model);
        }
        break;
      case 'codex':
        parts.push('codex');
        if (config.provider === 'chatgpt' && config.model) {
          parts.push('-m', config.model);
        }
        break;
      case 'velix':
        parts.push('velix');
        break;
      case 'copilot':
        parts.push('copilot');
        break;
      default:
        // Custom CLI — use the command from the option entry
        if (cliOption) {
          parts.push(cliOption.command);
        } else {
          parts.push('claude', '--dangerously-skip-permissions');
        }
        break;
    }

    return parts.join(' ') + '\r';
  }

  /**
   * Deliver a pending prompt to an agent whose CLI is now ready for input.
   */
  private async deliverPendingPrompt(agent: Agent): Promise<void> {
    const prompt = this.pendingPrompts.get(agent.id);
    if (!prompt) return;

    this.pendingPrompts.delete(agent.id);

    const timer = this.pendingPromptTimers.get(agent.id);
    if (timer) {
      clearTimeout(timer);
      this.pendingPromptTimers.delete(agent.id);
    }

    try {
      await invoke('pty_write', {
        sessionId: agent.sessionId,
        data: `${prompt}\r`,
      });
    } catch (error) {
      console.error(`AgentManager: failed to deliver prompt to agent ${agent.id}:`, error);
    }
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

    // Cancel any pending prompt delivery
    this.pendingPrompts.delete(agentId);
    const timer = this.pendingPromptTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.pendingPromptTimers.delete(agentId);
    }

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
