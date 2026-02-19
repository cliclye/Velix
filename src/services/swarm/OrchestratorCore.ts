/**
 * OrchestratorCore - Main state machine controller for swarm orchestration
 * Manages the complete lifecycle of multi-agent task execution
 */

import {
  OrchestratorState,
  OrchestratorConfig,
  SwarmTask,
  Agent,
  PolicyDecision,
} from './types';
import { SwarmEventEmitter, swarmEvents } from './SwarmEventEmitter';
import { AgentManager } from './AgentManager';
import { RoleSystem } from './RoleSystem';
import { AutomationRulesEngine } from './AutomationRulesEngine';
import { SharedContextLayer } from './SharedContextLayer';
import { SupervisorValidator } from './SupervisorValidator';
import { SafetyLimiter } from './SafetyLimiter';
import { aiService } from '../ai/AIService';

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxAgents: 5,
  maxRuntime: 600000, // 10 minutes
  maxRetries: 3,
  dryRunMode: false,
  safeMode: false,
  workspacePath: '',
};

export class OrchestratorCore {
  private state: OrchestratorState = 'idle';
  private config: OrchestratorConfig;
  private eventEmitter: SwarmEventEmitter;
  private agentManager: AgentManager | null = null;
  private roleSystem: RoleSystem;
  private automationRules: AutomationRulesEngine;
  private sharedContext: SharedContextLayer;
  private supervisor: SupervisorValidator;
  private safetyLimiter: SafetyLimiter;

  private currentTask: SwarmTask | null = null;
  private retryCount: Map<string, number> = new Map();
  private taskStartTime: number = 0;
  private stateChangeCallbacks: Array<(state: OrchestratorState, task: SwarmTask | null) => void> = [];

  constructor(config: Partial<OrchestratorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.eventEmitter = swarmEvents;
    this.roleSystem = new RoleSystem();
    this.automationRules = new AutomationRulesEngine();
    this.sharedContext = new SharedContextLayer();
    this.supervisor = new SupervisorValidator(this.sharedContext);
    this.safetyLimiter = new SafetyLimiter(this.config);

    // Set up automation rules for safety limiter
    this.safetyLimiter.setConfig({
      maxRuntimePerAgent: this.config.maxRuntime,
      maxTotalRuntime: this.config.maxRuntime * 2,
      maxRetriesPerFailure: this.config.maxRetries,
      maxFileModifications: 100,
      maxNewFiles: 50,
      forbiddenPaths: ['node_modules', '.env', '.git', '/etc', '/usr', '/bin'],
      forbiddenCommands: ['rm -rf /', 'sudo rm', 'format', ':(){:|:&};:'],
      sandboxEnabled: true,
      dryRunMode: this.config.dryRunMode,
    });
  }

  /**
   * Initialize the orchestrator
   */
  async initialize(config: Partial<OrchestratorConfig> = {}): Promise<void> {
    this.config = { ...this.config, ...config };

    if (!this.config.workspacePath) {
      throw new Error('Workspace path is required');
    }

    // Create agent manager
    this.agentManager = new AgentManager(this.eventEmitter, this.config.workspacePath);
    await this.agentManager.initialize();

    // Set up pattern detector
    this.agentManager.setPatternDetector((output) =>
      this.automationRules.detectPrompt(output)
    );

    // Listen for agent events to handle automation
    this.eventEmitter.subscribeToAgentEvents((event) => {
      if (event.type === 'prompt_detected') {
        this.handlePromptDetected(event.agentId, event.match);
      }
    });

    // Set safe mode based on config
    this.automationRules.setSafeMode(this.config.safeMode);
  }

  /**
   * Handle detected prompts from agents
   */
  private async handlePromptDetected(agentId: string, match: import('./types').PatternMatch): Promise<void> {
    if (!this.agentManager) return;

    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;

    // Get policy decision
    const decision = this.automationRules.analyzeContext(match, agent);

    // Emit action taken event
    this.eventEmitter.emitAgentEvent({
      type: 'action_taken',
      agentId,
      decision,
    });

    // Execute action if not requiring user approval
    if (!decision.requiresUserApproval) {
      await this.automationRules.executeAction(decision, agentId, this.agentManager);

      // Update metrics
      if (decision.action === 'approve') {
        this.agentManager.updateAgentMetrics(agentId, {
          autoApprovals: (agent.metrics.autoApprovals || 0) + 1,
        });
      }
    } else {
      // Mark agent as waiting for approval
      this.agentManager.updateAgentStatus(agentId, 'waiting_for_approval');

      // Update metrics
      this.agentManager.updateAgentMetrics(agentId, {
        escalations: (agent.metrics.escalations || 0) + 1,
      });
    }
  }

  /**
   * Approve a pending decision
   */
  async approveDecision(agentId: string, decision: PolicyDecision): Promise<void> {
    if (!this.agentManager) return;

    await this.agentManager.respondToAgent(agentId, decision.response);
    this.agentManager.updateAgentStatus(agentId, 'running');
  }

  /**
   * Deny a pending decision
   */
  async denyDecision(agentId: string): Promise<void> {
    if (!this.agentManager) return;

    await this.agentManager.respondToAgent(agentId, 'n');
    this.agentManager.updateAgentStatus(agentId, 'running');
  }

  /**
   * Start a new task
   */
  async startTask(goal: string, constraints: string[] = []): Promise<SwarmTask> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start task in state: ${this.state}`);
    }

    if (!this.agentManager) {
      throw new Error('Orchestrator not initialized');
    }

    this.taskStartTime = Date.now();

    // Create task
    const task: SwarmTask = {
      id: `task_${Date.now()}`,
      goal,
      constraints,
      createdAt: new Date(),
      status: 'analyzing',
      complexity: {
        score: 0,
        agentCount: 1,
        reasoning: '',
        factors: [],
        estimatedDuration: 0,
      },
      agents: [],
    };

    this.currentTask = task;
    this.retryCount.clear();

    // Initialize shared context
    this.sharedContext.initialize(task.id, goal, constraints, this.config.workspacePath);

    // Emit task started
    this.eventEmitter.emit({ type: 'task_started', task });

    // Start the state machine
    await this.transitionTo('analyzing');

    return task;
  }

  /**
   * Transition to a new state
   */
  private async transitionTo(newState: OrchestratorState): Promise<void> {
    const oldState = this.state;
    this.state = newState;

    if (this.currentTask) {
      this.currentTask.status = newState;
    }

    this.eventEmitter.emitStateChange(oldState, newState);

    // Notify callbacks
    for (const callback of this.stateChangeCallbacks) {
      try {
        callback(newState, this.currentTask);
      } catch (error) {
        console.error('OrchestratorCore: Error in state change callback:', error);
      }
    }

    // Execute state-specific logic
    await this.executeState(newState);
  }

  /**
   * Execute logic for the current state
   */
  private async executeState(state: OrchestratorState): Promise<void> {
    switch (state) {
      case 'analyzing':
        await this.doAnalyzing();
        break;
      case 'planning':
        await this.doPlanning();
        break;
      case 'spawning':
        await this.doSpawning();
        break;
      case 'running':
        await this.doRunning();
        break;
      case 'validating':
        await this.doValidating();
        break;
      case 'fixing':
        await this.doFixing();
        break;
      case 'completed':
        await this.doCompleted();
        break;
      case 'failed':
        await this.doFailed();
        break;
      case 'aborting':
        await this.doAborting();
        break;
    }
  }

  /**
   * ANALYZING state: Analyze task complexity
   */
  private async doAnalyzing(): Promise<void> {
    if (!this.currentTask) return;

    try {
      // Use AI service to analyze complexity
      const analysis = await aiService.analyzeTaskComplexity(this.currentTask.goal);

      this.currentTask.complexity = {
        score: analysis.complexity,
        agentCount: Math.min(analysis.agentCount, this.config.maxAgents),
        reasoning: analysis.reasoning,
        factors: [],
        estimatedDuration: analysis.agentCount * 10, // rough estimate
      };

      await this.transitionTo('planning');
    } catch (error) {
      console.error('Error in analyzing state:', error);
      
      // Fallback to default complexity if AI analysis fails
      if (this.currentTask) {
        this.currentTask.complexity = {
          score: 5, // Medium complexity
          agentCount: 2, // Default to 2 agents
          reasoning: error instanceof Error ? error.message : 'Failed to analyze complexity, using defaults',
          factors: [],
          estimatedDuration: 20, // Default 20 minutes
        };
      }
      
      await this.transitionTo('planning');
    }
  }

  /**
   * PLANNING state: Generate subtasks and assign roles
   */
  private async doPlanning(): Promise<void> {
    if (!this.currentTask) return;

    try {
      const agentCount = this.currentTask.complexity.agentCount;

      // Generate prompts for each agent
      const prompts = await aiService.generateAutomationPrompts(
        this.currentTask.goal,
        agentCount
      );

      // Select roles for the task
      const roles = this.roleSystem.selectRoles({
        taskType: 'mixed',
        complexity: this.currentTask.complexity.score,
        filesInvolved: 0, // We don't know yet
        hasTests: this.currentTask.goal.toLowerCase().includes('test'),
        needsArchitecture: this.currentTask.complexity.score > 5,
      });

      // Create agent assignments
      this.currentTask.agents = prompts.map((prompt, index) => {
        const role = roles[index % roles.length];
        return {
          agentId: '', // Will be filled when spawned
          role: role.type,
          subtask: prompt,
          priority: role.priority,
          dependencies: [],
          estimatedDuration: role.estimatedDuration,
        };
      });

      // Update shared context
      this.sharedContext.updateContext({
        pendingSubtasks: prompts,
      });

      await this.transitionTo('spawning');
    } catch (error) {
      console.error('Error in planning state:', error);
      
      // Fallback: create simple assignment without AI
      if (this.currentTask) {
        const fallbackRole = this.roleSystem.getRole('planner');
        this.currentTask.agents = [{
          agentId: '',
          role: fallbackRole.type,
          subtask: this.currentTask.goal,
          priority: fallbackRole.priority,
          dependencies: [],
          estimatedDuration: fallbackRole.estimatedDuration,
        }];
      }
      
      await this.transitionTo('spawning');
    }
  }

  /**
   * SPAWNING state: Create agent PTY sessions
   */
  private async doSpawning(): Promise<void> {
    if (!this.currentTask || !this.agentManager) return;

    try {
      for (const assignment of this.currentTask.agents) {
        // Check safety limits
        if (this.agentManager.getAgentCount() >= this.config.maxAgents) {
          break;
        }

        const role = this.roleSystem.getRole(assignment.role);
        const agent = await this.agentManager.spawnAgent(role, assignment.subtask);
        assignment.agentId = agent.id;
      }

      await this.transitionTo('running');
    } catch (error) {
      console.error('Error in spawning state:', error);
      await this.transitionTo('failed');
    }
  }

  /**
   * RUNNING state: Monitor agents
   */
  private async doRunning(): Promise<void> {
    // Set up periodic monitoring
    const checkInterval = setInterval(async () => {
      if (this.state !== 'running') {
        clearInterval(checkInterval);
        return;
      }

      // Check for stalled agents
      const stalledAgents = this.agentManager?.getStalledAgents() || [];
      for (const agent of stalledAgents) {
        console.warn(`Agent ${agent.id} appears stalled`);
        // Could send a nudge or terminate
      }

      // Check runtime limits
      const runtime = Date.now() - this.taskStartTime;
      if (runtime > this.config.maxRuntime) {
        console.warn('Task exceeded maximum runtime');
        clearInterval(checkInterval);
        await this.transitionTo('validating');
      }

      // Check if all agents completed
      const agents = this.agentManager?.getAllAgents() || [];
      const allComplete = agents.every(
        (a) => a.status === 'completed' || a.status === 'failed' || a.status === 'terminated'
      );

      if (allComplete && agents.length > 0) {
        clearInterval(checkInterval);
        await this.transitionTo('validating');
      }
    }, 5000);
  }

  /**
   * VALIDATING state: Run validation checks
   */
  private async doValidating(): Promise<void> {
    try {
      this.eventEmitter.emit({
        type: 'validation_started',
        checks: ['build', 'test', 'lint']
      });

      const results = await this.supervisor.runAllValidations();

      this.eventEmitter.emit({
        type: 'validation_completed',
        results
      });

      const hasErrors = results.some((r) => !r.success && r.checkType !== 'lint');

      if (hasErrors) {
        // Check retry limit
        const retryKey = 'validation';
        const currentRetries = this.retryCount.get(retryKey) || 0;

        if (currentRetries < this.config.maxRetries) {
          this.retryCount.set(retryKey, currentRetries + 1);
          await this.transitionTo('fixing');
        } else {
          await this.transitionTo('failed');
        }
      } else {
        await this.transitionTo('completed');
      }
    } catch (error) {
      console.error('Error in validating state:', error);
      await this.transitionTo('failed');
    }
  }

  /**
   * FIXING state: Assign fixes to agents
   */
  private async doFixing(): Promise<void> {
    // Get validation errors
    const conflicts = this.supervisor.detectConflicts();

    if (conflicts.length > 0) {
      this.eventEmitter.emit({
        type: 'conflict_detected',
        conflict: conflicts[0],
      });
    }

    // For now, spawn a new implementer agent to fix issues
    if (this.agentManager && this.agentManager.getAgentCount() < this.config.maxAgents) {
      const role = this.roleSystem.getRole('implementer');
      const fixTask = 'Review the build/test errors and fix them. Run the tests again after fixing.';
      await this.agentManager.spawnAgent(role, fixTask);
    }

    await this.transitionTo('running');
  }

  /**
   * COMPLETED state: Task finished successfully
   */
  private async doCompleted(): Promise<void> {
    if (!this.currentTask) return;

    const summary = this.sharedContext.generateSummary(this.currentTask);

    this.eventEmitter.emit({
      type: 'task_completed',
      task: this.currentTask,
      summary,
    });

    // Clean up
    await this.cleanup();
  }

  /**
   * FAILED state: Task failed
   */
  private async doFailed(): Promise<void> {
    if (!this.currentTask) return;

    this.eventEmitter.emit({
      type: 'task_failed',
      task: this.currentTask,
      reason: 'Task failed after exhausting retries',
    });

    // Clean up
    await this.cleanup();
  }

  /**
   * ABORTING state: User requested abort
   */
  private async doAborting(): Promise<void> {
    await this.agentManager?.terminateAll('User aborted');
    await this.transitionTo('failed');
  }

  /**
   * Pause the current task
   */
  async pauseTask(): Promise<void> {
    if (this.state !== 'running') {
      throw new Error(`Cannot pause in state: ${this.state}`);
    }
    await this.transitionTo('paused');
  }

  /**
   * Resume a paused task
   */
  async resumeTask(): Promise<void> {
    if (this.state !== 'paused') {
      throw new Error(`Cannot resume in state: ${this.state}`);
    }
    await this.transitionTo('running');
  }

  /**
   * Abort the current task
   */
  async abortTask(): Promise<void> {
    if (this.state === 'idle' || this.state === 'completed' || this.state === 'failed') {
      return;
    }
    await this.transitionTo('aborting');
  }

  /**
   * Emergency stop - kills all agents immediately
   */
  async killSwitch(): Promise<void> {
    await this.safetyLimiter.emergencyStop(this.agentManager);
    this.state = 'failed';
    await this.cleanup();
  }

  /**
   * Clean up resources
   */
  private async cleanup(): Promise<void> {
    await this.agentManager?.cleanup();
    this.currentTask = null;
    this.retryCount.clear();
    this.state = 'idle';
  }

  /**
   * Get current state
   */
  getState(): OrchestratorState {
    return this.state;
  }

  /**
   * Get current task
   */
  getTask(): SwarmTask | null {
    return this.currentTask;
  }

  /**
   * Get all active agents
   */
  getActiveAgents(): Agent[] {
    return this.agentManager?.getAllAgents() || [];
  }

  /**
   * Subscribe to state changes
   */
  onStateChange(callback: (state: OrchestratorState, task: SwarmTask | null) => void): () => void {
    this.stateChangeCallbacks.push(callback);
    return () => {
      const index = this.stateChangeCallbacks.indexOf(callback);
      if (index !== -1) {
        this.stateChangeCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Get configuration
   */
  getConfig(): OrchestratorConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get event emitter for external subscriptions
   */
  getEventEmitter(): SwarmEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Get shared context for external access
   */
  getSharedContext(): SharedContextLayer {
    return this.sharedContext;
  }

  /**
   * Get automation rules engine
   */
  getAutomationRules(): AutomationRulesEngine {
    return this.automationRules;
  }

  /**
   * Get agent manager
   */
  getAgentManager(): AgentManager | null {
    return this.agentManager;
  }
}

// Singleton instance
export const orchestrator = new OrchestratorCore();
