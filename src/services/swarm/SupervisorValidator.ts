/**
 * SupervisorValidator - Validation checks and conflict detection
 */

import { invoke } from '../../platform/native';
import {
  ValidationCheck,
  ValidationResult,
  ValidationError,
  ConflictDetection,
  AgentHealth,
  StopCondition,
  AgentAssignment,
  AgentRoleType,
} from './types';
import { SharedContextLayer } from './SharedContextLayer';

interface ShellResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  cwd: string;
}

export class SupervisorValidator {
  private sharedContext: SharedContextLayer;
  private checks: Map<string, ValidationCheck> = new Map();
  private lastValidationResults: ValidationResult[] = [];
  private stopConditions: Map<string, { type: string; threshold: number }> = new Map();

  constructor(sharedContext: SharedContextLayer) {
    this.sharedContext = sharedContext;

    // Set up default validation checks
    this.setupDefaultChecks();
    this.setupDefaultStopConditions();
  }

  /**
   * Set up default validation checks
   */
  private setupDefaultChecks(): void {
    this.checks.set('build', {
      type: 'build',
      command: 'npm run build 2>&1 || yarn build 2>&1 || echo "No build script"',
      timeout: 120000,
      required: true,
    });

    this.checks.set('test', {
      type: 'test',
      command: 'npm test 2>&1 || yarn test 2>&1 || echo "No test script"',
      timeout: 180000,
      required: false,
    });

    this.checks.set('lint', {
      type: 'lint',
      command: 'npm run lint 2>&1 || yarn lint 2>&1 || echo "No lint script"',
      timeout: 60000,
      required: false,
    });

    this.checks.set('typecheck', {
      type: 'typecheck',
      command: 'npx tsc --noEmit 2>&1 || echo "No TypeScript"',
      timeout: 60000,
      required: false,
    });
  }

  /**
   * Set up default stop conditions
   */
  private setupDefaultStopConditions(): void {
    this.stopConditions.set('retry_limit', { type: 'retry_limit', threshold: 3 });
    this.stopConditions.set('timeout', { type: 'timeout', threshold: 600000 });
    this.stopConditions.set('error_rate', { type: 'error_rate', threshold: 0.5 });
  }

  /**
   * Add a validation check
   */
  addCheck(check: ValidationCheck): void {
    this.checks.set(check.type, check);
  }

  /**
   * Remove a validation check
   */
  removeCheck(type: string): void {
    this.checks.delete(type);
  }

  /**
   * Run a specific validation check
   */
  async runValidation(types?: string[]): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];
    const checksToRun = types
      ? Array.from(this.checks.values()).filter((c) => types.includes(c.type))
      : Array.from(this.checks.values());

    const context = this.sharedContext.isInitialized()
      ? this.sharedContext.getContext()
      : null;
    const cwd = context?.projectPath || undefined;

    for (const check of checksToRun) {
      const startTime = Date.now();

      try {
        const shellPromise = invoke<ShellResult>('execute_shell_command', {
          command: check.command,
          cwd,
        });

        const timeoutMs = check.timeout || 120000;
        const result = await Promise.race([
          shellPromise,
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`Validation '${check.type}' timed out after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);

        const errors = this.parseErrors(result.stdout + result.stderr, check.type);

        results.push({
          checkType: check.type,
          success: result.exit_code === 0,
          output: result.stdout + result.stderr,
          errors,
          duration: Date.now() - startTime,
          timestamp: new Date(),
        });
      } catch (error) {
        results.push({
          checkType: check.type,
          success: false,
          output: String(error),
          errors: [{
            file: '',
            message: String(error),
            severity: 'error',
          }],
          duration: Date.now() - startTime,
          timestamp: new Date(),
        });
      }
    }

    this.lastValidationResults = results;
    return results;
  }

  /**
   * Run all validation checks
   */
  async runAllValidations(): Promise<ValidationResult[]> {
    return this.runValidation();
  }

  /**
   * Parse errors from command output
   */
  private parseErrors(output: string, _checkType: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // TypeScript/ESLint style: file.ts(10,5): error TS1234: message
      const tsMatch = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)$/);
      if (tsMatch) {
        errors.push({
          file: tsMatch[1],
          line: parseInt(tsMatch[2]),
          column: parseInt(tsMatch[3]),
          message: tsMatch[6],
          severity: tsMatch[4] as 'error' | 'warning',
          rule: tsMatch[5],
        });
        continue;
      }

      // ESLint style: file.ts:10:5: error message (rule)
      const eslintMatch = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning)\s+(.+?)(?:\s+\((.+)\))?$/);
      if (eslintMatch) {
        errors.push({
          file: eslintMatch[1],
          line: parseInt(eslintMatch[2]),
          column: parseInt(eslintMatch[3]),
          message: eslintMatch[5],
          severity: eslintMatch[4] as 'error' | 'warning',
          rule: eslintMatch[6],
        });
        continue;
      }

      // Generic error detection
      if (line.toLowerCase().includes('error') && !line.includes('0 error')) {
        errors.push({
          file: '',
          message: line.trim(),
          severity: 'error',
        });
      }
    }

    return errors;
  }

  /**
   * Detect conflicts between agents
   */
  detectConflicts(): ConflictDetection[] {
    const conflicts: ConflictDetection[] = [];

    if (!this.sharedContext.isInitialized()) {
      return conflicts;
    }

    const context = this.sharedContext.getContext();

    // Check for file conflicts
    const fileAgents: Record<string, Set<string>> = {};
    for (const mod of context.modifiedFiles) {
      if (!fileAgents[mod.path]) {
        fileAgents[mod.path] = new Set();
      }
      fileAgents[mod.path].add(mod.agentId);
    }

    for (const [path, agents] of Object.entries(fileAgents)) {
      if (agents.size > 1) {
        conflicts.push({
          type: 'simultaneous_edit',
          agents: Array.from(agents),
          details: `Multiple agents modified ${path}`,
          severity: 'high',
          suggestedResolution: 'Pause later agents and let first complete',
        });
      }
    }

    // Check for contradictory decisions
    const decisionGroups = new Map<string, typeof context.decisions>();
    for (const decision of context.decisions) {
      for (const file of decision.affectedFiles) {
        if (!decisionGroups.has(file)) {
          decisionGroups.set(file, []);
        }
        decisionGroups.get(file)!.push(decision);
      }
    }

    for (const [file, decisions] of decisionGroups) {
      if (decisions.length > 1) {
        const agents = new Set(decisions.map((d) => d.agentId));
        if (agents.size > 1) {
          conflicts.push({
            type: 'contradictory_decision',
            agents: Array.from(agents),
            details: `Multiple agents made decisions affecting ${file}`,
            severity: 'medium',
            suggestedResolution: 'Review decisions and choose one approach',
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Resolve a conflict
   */
  async resolveConflict(conflictId: string, resolution: string): Promise<void> {
    this.sharedContext.resolveConflict(conflictId, resolution);
  }

  /**
   * Monitor agent output for issues
   */
  monitorAgentOutput(agentId: string, output: string): void {
    // Check for error patterns
    const errorPatterns = [
      /error:/i,
      /failed:/i,
      /exception:/i,
      /traceback/i,
      /npm err!/i,
      /syntax error/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(output)) {
        this.sharedContext.sendMessage({
          fromAgentId: 'supervisor',
          toAgentId: null, // broadcast
          type: 'warning',
          content: `Agent ${agentId} encountered an error: ${output.slice(0, 200)}`,
        });
        break;
      }
    }
  }

  /**
   * Get agent health status
   */
  getAgentHealth(
    agentId: string,
    lastActivity: Date,
    errorCount: number,
    totalActions: number
  ): AgentHealth {
    const timeSinceActivity = Date.now() - lastActivity.getTime();
    const errorRate = totalActions > 0 ? errorCount / totalActions : 0;
    const outputRate = 0; // Would need to track this

    let status: 'healthy' | 'stalled' | 'erroring' | 'completed' = 'healthy';
    if (timeSinceActivity > 60000) {
      status = 'stalled';
    } else if (errorRate > 0.5) {
      status = 'erroring';
    }

    return {
      agentId,
      status,
      lastActivity,
      errorRate,
      outputRate,
    };
  }

  /**
   * Assign a fix to an agent
   */
  assignFix(error: ValidationError): AgentAssignment {
    // Determine which role should fix this error
    let role: AgentRoleType = 'implementer';

    if (error.rule?.startsWith('TS')) {
      role = 'implementer'; // TypeScript errors
    } else if (error.rule?.includes('lint') || error.rule?.includes('eslint')) {
      role = 'refactorer'; // Linting issues
    } else if (error.message.toLowerCase().includes('test')) {
      role = 'tester'; // Test failures
    }

    return {
      agentId: '', // To be assigned
      role,
      subtask: `Fix error in ${error.file}${error.line ? `:${error.line}` : ''}: ${error.message}`,
      priority: error.severity === 'error' ? 10 : 5,
      dependencies: [],
      estimatedDuration: 5,
    };
  }

  /**
   * Check stop conditions
   */
  checkStopConditions(
    retryCount: number,
    runtime: number,
    errorRate: number
  ): StopCondition | null {
    const retryLimit = this.stopConditions.get('retry_limit');
    if (retryLimit && retryCount >= retryLimit.threshold) {
      return {
        type: 'retry_limit',
        reason: `Exceeded retry limit of ${retryLimit.threshold}`,
      };
    }

    const timeout = this.stopConditions.get('timeout');
    if (timeout && runtime >= timeout.threshold) {
      return {
        type: 'timeout',
        reason: `Exceeded timeout of ${timeout.threshold}ms`,
      };
    }

    const errorRateLimit = this.stopConditions.get('error_rate');
    if (errorRateLimit && errorRate >= errorRateLimit.threshold) {
      return {
        type: 'critical_error',
        reason: `Error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold`,
      };
    }

    return null;
  }

  /**
   * Set a stop condition
   */
  setStopCondition(type: string, threshold: number): void {
    this.stopConditions.set(type, { type, threshold });
  }

  /**
   * Get last validation results
   */
  getLastResults(): ValidationResult[] {
    return [...this.lastValidationResults];
  }

  /**
   * Check if validation passed
   */
  didValidationPass(): boolean {
    return this.lastValidationResults.every((r) => r.success);
  }

  /**
   * Get failed checks
   */
  getFailedChecks(): ValidationResult[] {
    return this.lastValidationResults.filter((r) => !r.success);
  }

  /**
   * Get all errors from last validation
   */
  getAllErrors(): ValidationError[] {
    return this.lastValidationResults.flatMap((r) => r.errors);
  }
}
