/**
 * SharedContextLayer - JSON-based shared memory for inter-agent communication
 */

import {
  SharedContext,
  Decision,
  AgentMessage,
  Conflict,
  FileModification,
  DirectoryMap,
  SubtaskResult,
  TaskSummary,
  SwarmTask,
  AgentRoleType,
} from './types';

export class SharedContextLayer {
  private context: SharedContext | null = null;
  private messageCallbacks: Array<(message: AgentMessage) => void> = [];
  private maxDecisions: number = 100;
  private maxMessages: number = 500;

  /**
   * Initialize context for a new task
   */
  initialize(
    taskId: string,
    goal: string,
    constraints: string[],
    projectPath: string
  ): void {
    this.context = {
      taskId,
      goal,
      constraints,
      projectPath,
      projectStructure: null,
      keyFiles: [],
      dependencies: {},
      decisions: [],
      completedSubtasks: [],
      pendingSubtasks: [],
      agentMessages: [],
      conflicts: [],
      modifiedFiles: [],
      createdFiles: [],
      deletedFiles: [],
    };
  }

  /**
   * Get the current context
   */
  getContext(): SharedContext {
    if (!this.context) {
      throw new Error('Context not initialized');
    }
    return { ...this.context };
  }

  /**
   * Update context with partial updates
   */
  updateContext(updates: Partial<SharedContext>): void {
    if (!this.context) {
      throw new Error('Context not initialized');
    }
    this.context = { ...this.context, ...updates };
  }

  /**
   * Set project structure
   */
  setProjectStructure(structure: DirectoryMap): void {
    if (!this.context) return;
    this.context.projectStructure = structure;
  }

  /**
   * Add key files
   */
  addKeyFiles(files: string[]): void {
    if (!this.context) return;
    const existing = new Set(this.context.keyFiles);
    for (const file of files) {
      existing.add(file);
    }
    this.context.keyFiles = Array.from(existing);
  }

  /**
   * Log a decision made by an agent
   */
  logDecision(decision: Omit<Decision, 'id' | 'timestamp'>): void {
    if (!this.context) return;

    const fullDecision: Decision = {
      ...decision,
      id: `decision_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    };

    this.context.decisions.push(fullDecision);

    // Prune if needed
    if (this.context.decisions.length > this.maxDecisions) {
      this.context.decisions = this.context.decisions.slice(-this.maxDecisions);
    }
  }

  /**
   * Get decisions with optional filtering
   */
  getDecisions(filter?: { agentId?: string; type?: string }): Decision[] {
    if (!this.context) return [];

    let decisions = [...this.context.decisions];

    if (filter?.agentId) {
      decisions = decisions.filter((d) => d.agentId === filter.agentId);
    }
    if (filter?.type) {
      decisions = decisions.filter((d) => d.type === filter.type);
    }

    return decisions;
  }

  /**
   * Send a message between agents
   */
  sendMessage(message: Omit<AgentMessage, 'id' | 'timestamp'>): void {
    if (!this.context) return;

    const fullMessage: AgentMessage = {
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    };

    this.context.agentMessages.push(fullMessage);

    // Prune if needed
    if (this.context.agentMessages.length > this.maxMessages) {
      this.context.agentMessages = this.context.agentMessages.slice(-this.maxMessages);
    }

    // Notify subscribers
    for (const callback of this.messageCallbacks) {
      try {
        callback(fullMessage);
      } catch (error) {
        console.error('Error in message callback:', error);
      }
    }
  }

  /**
   * Get messages for a specific agent or all messages
   */
  getMessages(agentId?: string): AgentMessage[] {
    if (!this.context) return [];

    if (!agentId) {
      return [...this.context.agentMessages];
    }

    return this.context.agentMessages.filter(
      (m) => m.toAgentId === agentId || m.toAgentId === null || m.fromAgentId === agentId
    );
  }

  /**
   * Subscribe to messages
   */
  subscribeToMessages(callback: (message: AgentMessage) => void): () => void {
    this.messageCallbacks.push(callback);
    return () => {
      const index = this.messageCallbacks.indexOf(callback);
      if (index !== -1) {
        this.messageCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Track a file modification
   */
  trackFileModification(mod: Omit<FileModification, 'timestamp'>): void {
    if (!this.context) return;

    const fullMod: FileModification = {
      ...mod,
      timestamp: new Date(),
    };

    this.context.modifiedFiles.push(fullMod);

    // Track created/deleted files
    if (mod.type === 'create' && !this.context.createdFiles.includes(mod.path)) {
      this.context.createdFiles.push(mod.path);
    } else if (mod.type === 'delete' && !this.context.deletedFiles.includes(mod.path)) {
      this.context.deletedFiles.push(mod.path);
    }
  }

  /**
   * Get file modifications
   */
  getFileModifications(path?: string): FileModification[] {
    if (!this.context) return [];

    if (path) {
      return this.context.modifiedFiles.filter((m) => m.path === path);
    }

    return [...this.context.modifiedFiles];
  }

  /**
   * Check if there's a file conflict
   */
  hasFileConflict(path: string): boolean {
    if (!this.context) return false;

    const mods = this.context.modifiedFiles.filter((m) => m.path === path);
    const agents = new Set(mods.map((m) => m.agentId));

    return agents.size > 1;
  }

  /**
   * Log a conflict
   */
  logConflict(conflict: Omit<Conflict, 'id' | 'detectedAt'>): void {
    if (!this.context) return;

    const fullConflict: Conflict = {
      ...conflict,
      id: `conflict_${Date.now()}`,
      detectedAt: new Date(),
    };

    this.context.conflicts.push(fullConflict);
  }

  /**
   * Resolve a conflict
   */
  resolveConflict(conflictId: string, resolution: string): void {
    if (!this.context) return;

    const conflict = this.context.conflicts.find((c) => c.id === conflictId);
    if (conflict) {
      conflict.resolvedAt = new Date();
      conflict.resolution = resolution;
    }
  }

  /**
   * Get unresolved conflicts
   */
  getUnresolvedConflicts(): Conflict[] {
    if (!this.context) return [];
    return this.context.conflicts.filter((c) => !c.resolvedAt);
  }

  /**
   * Add a completed subtask
   */
  addCompletedSubtask(result: SubtaskResult): void {
    if (!this.context) return;
    this.context.completedSubtasks.push(result);

    // Remove from pending if present
    const index = this.context.pendingSubtasks.indexOf(result.description);
    if (index !== -1) {
      this.context.pendingSubtasks.splice(index, 1);
    }
  }

  /**
   * Add pending subtasks
   */
  addPendingSubtasks(subtasks: string[]): void {
    if (!this.context) return;
    this.context.pendingSubtasks.push(...subtasks);
  }

  /**
   * Prune old decisions
   */
  pruneOldDecisions(maxAge: number): void {
    if (!this.context) return;

    const cutoff = Date.now() - maxAge;
    this.context.decisions = this.context.decisions.filter(
      (d) => d.timestamp.getTime() > cutoff
    );
  }

  /**
   * Prune messages
   */
  pruneMessages(maxCount: number): void {
    if (!this.context) return;

    if (this.context.agentMessages.length > maxCount) {
      this.context.agentMessages = this.context.agentMessages.slice(-maxCount);
    }
  }

  /**
   * Get memory usage stats
   */
  getMemoryUsage(): { decisions: number; messages: number; files: number } {
    if (!this.context) {
      return { decisions: 0, messages: 0, files: 0 };
    }

    return {
      decisions: this.context.decisions.length,
      messages: this.context.agentMessages.length,
      files: this.context.modifiedFiles.length,
    };
  }

  /**
   * Generate a summary for task completion
   */
  generateSummary(task: SwarmTask): TaskSummary {
    if (!this.context) {
      return {
        taskId: task.id,
        goal: task.goal,
        duration: 0,
        agentsUsed: 0,
        rolesUsed: [],
        filesCreated: [],
        filesModified: [],
        testsRun: 0,
        testsPassed: 0,
        validationResults: [],
        decisions: [],
      };
    }

    const rolesUsed = new Set<AgentRoleType>();
    for (const result of this.context.completedSubtasks) {
      rolesUsed.add(result.role);
    }

    const filesModified = new Set<string>();
    for (const mod of this.context.modifiedFiles) {
      if (mod.type === 'modify') {
        filesModified.add(mod.path);
      }
    }

    return {
      taskId: task.id,
      goal: task.goal,
      duration: Date.now() - task.createdAt.getTime(),
      agentsUsed: task.agents.length,
      rolesUsed: Array.from(rolesUsed),
      filesCreated: [...this.context.createdFiles],
      filesModified: Array.from(filesModified),
      testsRun: 0, // Would be tracked by supervisor
      testsPassed: 0,
      validationResults: [],
      decisions: this.context.decisions,
    };
  }

  /**
   * Export context to JSON
   */
  exportToJSON(): string {
    return JSON.stringify(this.context, null, 2);
  }

  /**
   * Import context from JSON
   */
  importFromJSON(json: string): void {
    try {
      const parsed = JSON.parse(json);
      // Convert date strings back to Date objects
      if (parsed.decisions) {
        parsed.decisions = parsed.decisions.map((d: Decision & { timestamp: string }) => ({
          ...d,
          timestamp: new Date(d.timestamp),
        }));
      }
      if (parsed.agentMessages) {
        parsed.agentMessages = parsed.agentMessages.map((m: AgentMessage & { timestamp: string }) => ({
          ...m,
          timestamp: new Date(m.timestamp),
        }));
      }
      if (parsed.conflicts) {
        parsed.conflicts = parsed.conflicts.map((c: Conflict & { detectedAt: string; resolvedAt?: string }) => ({
          ...c,
          detectedAt: new Date(c.detectedAt),
          resolvedAt: c.resolvedAt ? new Date(c.resolvedAt) : undefined,
        }));
      }
      if (parsed.modifiedFiles) {
        parsed.modifiedFiles = parsed.modifiedFiles.map((f: FileModification & { timestamp: string }) => ({
          ...f,
          timestamp: new Date(f.timestamp),
        }));
      }
      this.context = parsed;
    } catch (error) {
      console.error('Failed to import context from JSON:', error);
      throw error;
    }
  }

  /**
   * Clear the context
   */
  clear(): void {
    this.context = null;
    this.messageCallbacks = [];
  }

  /**
   * Check if context is initialized
   */
  isInitialized(): boolean {
    return this.context !== null;
  }
}
