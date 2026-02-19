/**
 * SafetyLimiter - Safety constraints and kill switch functionality
 */

import {
  SafetyConfig,
  SafetyViolation,
  ResourceStatus,
  Agent,
  OrchestratorConfig,
} from './types';
import { AgentManager } from './AgentManager';

const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  maxRuntimePerAgent: 600000, // 10 minutes
  maxTotalRuntime: 1200000, // 20 minutes
  maxRetriesPerFailure: 3,
  maxFileModifications: 100,
  maxNewFiles: 50,
  forbiddenPaths: [
    'node_modules',
    '.env',
    '.git',
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var',
    '/tmp',
    '/root',
    'package-lock.json',
    'yarn.lock',
  ],
  forbiddenCommands: [
    'rm -rf /',
    'rm -rf /*',
    'sudo rm',
    'format',
    ':(){:|:&};:',
    'fork bomb',
    '> /dev/sda',
    'dd if=',
    'mkfs',
    'chmod -R 777 /',
    'chown -R',
  ],
  sandboxEnabled: true,
  dryRunMode: false,
};

export class SafetyLimiter {
  private config: SafetyConfig;
  private violations: SafetyViolation[] = [];
  private agentStartTimes: Map<string, number> = new Map();
  private fileModificationCount: number = 0;
  private newFileCount: number = 0;
  private taskStartTime: number = 0;
  private isEmergencyStopped: boolean = false;

  constructor(orchestratorConfig: OrchestratorConfig) {
    this.config = {
      ...DEFAULT_SAFETY_CONFIG,
      maxRuntimePerAgent: orchestratorConfig.maxRuntime,
      dryRunMode: orchestratorConfig.dryRunMode,
    };
  }

  /**
   * Configure safety settings
   */
  setConfig(config: Partial<SafetyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): SafetyConfig {
    return { ...this.config };
  }

  /**
   * Start tracking task runtime
   */
  startTask(): void {
    this.taskStartTime = Date.now();
    this.isEmergencyStopped = false;
    this.fileModificationCount = 0;
    this.newFileCount = 0;
  }

  /**
   * Register an agent for tracking
   */
  registerAgent(agentId: string): void {
    this.agentStartTimes.set(agentId, Date.now());
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId: string): void {
    this.agentStartTimes.delete(agentId);
  }

  /**
   * Check if agent has exceeded timeout
   */
  checkAgentTimeout(agent: Agent): boolean {
    const startTime = this.agentStartTimes.get(agent.id);
    if (!startTime) return false;

    const runtime = Date.now() - startTime;
    if (runtime > this.config.maxRuntimePerAgent) {
      this.logViolation({
        type: 'timeout',
        agentId: agent.id,
        details: `Agent runtime ${runtime}ms exceeded limit ${this.config.maxRuntimePerAgent}ms`,
        timestamp: new Date(),
        action: 'terminated',
      });
      return true;
    }

    return false;
  }

  /**
   * Check if total runtime exceeded
   */
  checkTotalTimeout(): boolean {
    if (this.taskStartTime === 0) return false;

    const runtime = Date.now() - this.taskStartTime;
    return runtime > this.config.maxTotalRuntime;
  }

  /**
   * Check if a path is allowed
   */
  checkPathAllowed(path: string): boolean {
    const normalizedPath = path.toLowerCase();

    for (const forbidden of this.config.forbiddenPaths) {
      if (normalizedPath.includes(forbidden.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validate a file operation
   */
  validateFileOperation(
    agentId: string,
    path: string,
    operation: 'create' | 'modify' | 'delete'
  ): { allowed: boolean; reason?: string } {
    // Check forbidden paths
    if (!this.checkPathAllowed(path)) {
      this.logViolation({
        type: 'forbidden_path',
        agentId,
        details: `Attempted to ${operation} forbidden path: ${path}`,
        timestamp: new Date(),
        action: 'blocked',
      });
      return { allowed: false, reason: `Path "${path}" is forbidden` };
    }

    // Check modification limits
    if (operation === 'modify' || operation === 'create') {
      if (this.fileModificationCount >= this.config.maxFileModifications) {
        this.logViolation({
          type: 'resource_limit',
          agentId,
          details: `Exceeded max file modifications: ${this.config.maxFileModifications}`,
          timestamp: new Date(),
          action: 'blocked',
        });
        return { allowed: false, reason: 'Maximum file modifications exceeded' };
      }
    }

    // Check new file limits
    if (operation === 'create') {
      if (this.newFileCount >= this.config.maxNewFiles) {
        this.logViolation({
          type: 'resource_limit',
          agentId,
          details: `Exceeded max new files: ${this.config.maxNewFiles}`,
          timestamp: new Date(),
          action: 'blocked',
        });
        return { allowed: false, reason: 'Maximum new files exceeded' };
      }
    }

    // Track the operation
    if (operation === 'modify' || operation === 'create') {
      this.fileModificationCount++;
    }
    if (operation === 'create') {
      this.newFileCount++;
    }

    return { allowed: true };
  }

  /**
   * Check if a command is allowed
   */
  checkCommandAllowed(command: string): boolean {
    const normalizedCommand = command.toLowerCase();

    for (const forbidden of this.config.forbiddenCommands) {
      if (normalizedCommand.includes(forbidden.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Validate a command before execution
   */
  validateCommand(agentId: string, command: string): { allowed: boolean; reason?: string } {
    if (!this.checkCommandAllowed(command)) {
      this.logViolation({
        type: 'forbidden_command',
        agentId,
        details: `Attempted to run forbidden command: ${command}`,
        timestamp: new Date(),
        action: 'blocked',
      });
      return { allowed: false, reason: 'Command is forbidden' };
    }

    return { allowed: true };
  }

  /**
   * Get resource status
   */
  checkResourceLimits(): ResourceStatus {
    const runtime = this.taskStartTime > 0 ? Date.now() - this.taskStartTime : 0;

    return {
      activeAgents: this.agentStartTimes.size,
      maxAgents: 5, // From orchestrator config
      totalRuntime: runtime,
      maxRuntime: this.config.maxTotalRuntime,
      filesModified: this.fileModificationCount,
      maxFiles: this.config.maxFileModifications,
      memoryUsage: 0, // Would need to track this
    };
  }

  /**
   * Kill a specific agent
   */
  async killAgent(
    agentId: string,
    reason: string,
    agentManager?: AgentManager
  ): Promise<void> {
    this.logViolation({
      type: 'timeout', // or could be different type
      agentId,
      details: `Agent killed: ${reason}`,
      timestamp: new Date(),
      action: 'terminated',
    });

    this.unregisterAgent(agentId);

    if (agentManager) {
      await agentManager.terminateAgent(agentId, reason);
    }
  }

  /**
   * Kill all agents
   */
  async killAllAgents(reason: string, agentManager?: AgentManager): Promise<void> {
    const agentIds = Array.from(this.agentStartTimes.keys());

    for (const agentId of agentIds) {
      await this.killAgent(agentId, reason, agentManager);
    }
  }

  /**
   * Emergency stop - immediately terminates everything
   */
  async emergencyStop(agentManager?: AgentManager | null): Promise<void> {
    this.isEmergencyStopped = true;

    console.warn('EMERGENCY STOP ACTIVATED');

    if (agentManager) {
      await agentManager.terminateAll('Emergency stop activated');
    }

    // Clear all tracking
    this.agentStartTimes.clear();
    this.fileModificationCount = 0;
    this.newFileCount = 0;
  }

  /**
   * Check if emergency stopped
   */
  isEmergencyStopActive(): boolean {
    return this.isEmergencyStopped;
  }

  /**
   * Reset emergency stop
   */
  resetEmergencyStop(): void {
    this.isEmergencyStopped = false;
  }

  /**
   * Log a safety violation
   */
  logViolation(violation: SafetyViolation): void {
    this.violations.push(violation);
    console.warn('Safety violation:', violation);
  }

  /**
   * Get all violations
   */
  getViolations(): SafetyViolation[] {
    return [...this.violations];
  }

  /**
   * Get violations for a specific agent
   */
  getAgentViolations(agentId: string): SafetyViolation[] {
    return this.violations.filter((v) => v.agentId === agentId);
  }

  /**
   * Clear violations
   */
  clearViolations(): void {
    this.violations = [];
  }

  /**
   * Set dry run mode
   */
  setDryRunMode(enabled: boolean): void {
    this.config.dryRunMode = enabled;
  }

  /**
   * Check if dry run mode is enabled
   */
  isDryRunMode(): boolean {
    return this.config.dryRunMode;
  }

  /**
   * Add a forbidden path
   */
  addForbiddenPath(path: string): void {
    if (!this.config.forbiddenPaths.includes(path)) {
      this.config.forbiddenPaths.push(path);
    }
  }

  /**
   * Remove a forbidden path
   */
  removeForbiddenPath(path: string): void {
    const index = this.config.forbiddenPaths.indexOf(path);
    if (index !== -1) {
      this.config.forbiddenPaths.splice(index, 1);
    }
  }

  /**
   * Add a forbidden command
   */
  addForbiddenCommand(command: string): void {
    if (!this.config.forbiddenCommands.includes(command)) {
      this.config.forbiddenCommands.push(command);
    }
  }

  /**
   * Remove a forbidden command
   */
  removeForbiddenCommand(command: string): void {
    const index = this.config.forbiddenCommands.indexOf(command);
    if (index !== -1) {
      this.config.forbiddenCommands.splice(index, 1);
    }
  }

  /**
   * Get summary of safety status
   */
  getSafetyStatus(): {
    isActive: boolean;
    violationCount: number;
    resourceStatus: ResourceStatus;
    isEmergencyStopped: boolean;
  } {
    return {
      isActive: this.taskStartTime > 0,
      violationCount: this.violations.length,
      resourceStatus: this.checkResourceLimits(),
      isEmergencyStopped: this.isEmergencyStopped,
    };
  }
}
