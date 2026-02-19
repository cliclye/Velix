/**
 * RoleSystem - Role selection and prompt generation for agents
 */

import {
  AgentRole,
  AgentRoleType,
  RoleSelectionCriteria,
  RoleDecisionMatrix,
  SharedContext,
} from './types';
import { AGENT_ROLES } from './roleDefinitions';

export class RoleSystem {
  /**
   * Get all available roles
   */
  getRoles(): AgentRole[] {
    return Object.values(AGENT_ROLES);
  }

  /**
   * Get a specific role by type
   */
  getRole(type: AgentRoleType): AgentRole {
    const role = AGENT_ROLES[type];
    if (!role) {
      throw new Error(`Unknown role type: ${type}`);
    }
    return role;
  }

  /**
   * Select roles based on task criteria
   */
  selectRoles(criteria: RoleSelectionCriteria): AgentRole[] {
    const selectedRoles: AgentRole[] = [];

    // Always include planner for complex tasks
    if (criteria.complexity >= 5) {
      selectedRoles.push(AGENT_ROLES.planner);
    }

    // Include architect for complex or architecture-needing tasks
    if (criteria.needsArchitecture || criteria.complexity >= 7) {
      selectedRoles.push(AGENT_ROLES.architect);
    }

    // Always include implementer for most tasks
    if (criteria.taskType !== 'documentation') {
      selectedRoles.push(AGENT_ROLES.implementer);
    }

    // Include tester if tests are involved
    if (criteria.hasTests || criteria.taskType === 'testing') {
      selectedRoles.push(AGENT_ROLES.tester);
    }

    // Include refactorer for refactoring tasks
    if (criteria.taskType === 'refactor') {
      selectedRoles.push(AGENT_ROLES.refactorer);
    }

    // Include reviewer for high complexity
    if (criteria.complexity >= 6) {
      selectedRoles.push(AGENT_ROLES.reviewer);
    }

    // Include docwriter for documentation tasks
    if (criteria.taskType === 'documentation' || criteria.complexity >= 8) {
      selectedRoles.push(AGENT_ROLES.docwriter);
    }

    // Ensure at least implementer is selected
    if (selectedRoles.length === 0) {
      selectedRoles.push(AGENT_ROLES.implementer);
    }

    // Sort by priority
    return selectedRoles.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Build a decision matrix for role selection
   */
  buildDecisionMatrix(criteria: RoleSelectionCriteria): RoleDecisionMatrix {
    const roles = this.selectRoles(criteria);

    const recommendedRoles = roles.map((role) => ({
      role: role.type,
      confidence: this.calculateRoleConfidence(role, criteria),
      reasoning: this.generateRoleReasoning(role, criteria),
    }));

    const sequencing = this.generateSequencing(roles);

    return {
      taskAnalysis: {
        primaryType: criteria.taskType,
        complexity: criteria.complexity,
        estimatedEffort: this.estimateEffort(criteria),
      },
      recommendedRoles,
      sequencing,
    };
  }

  /**
   * Calculate confidence score for a role
   */
  private calculateRoleConfidence(role: AgentRole, criteria: RoleSelectionCriteria): number {
    let confidence = 0.5; // Base confidence

    switch (role.type) {
      case 'planner':
        confidence += criteria.complexity >= 5 ? 0.3 : 0;
        confidence += criteria.filesInvolved > 5 ? 0.1 : 0;
        break;
      case 'architect':
        confidence += criteria.needsArchitecture ? 0.4 : 0;
        confidence += criteria.complexity >= 7 ? 0.1 : 0;
        break;
      case 'implementer':
        confidence += 0.4; // Always high for implementer
        break;
      case 'tester':
        confidence += criteria.hasTests ? 0.4 : 0;
        confidence += criteria.taskType === 'testing' ? 0.2 : 0;
        break;
      case 'refactorer':
        confidence += criteria.taskType === 'refactor' ? 0.5 : 0;
        break;
      case 'reviewer':
        confidence += criteria.complexity >= 6 ? 0.3 : 0;
        break;
      case 'docwriter':
        confidence += criteria.taskType === 'documentation' ? 0.5 : 0;
        confidence += criteria.complexity >= 8 ? 0.1 : 0;
        break;
    }

    return Math.min(confidence, 1);
  }

  /**
   * Generate reasoning for role selection
   */
  private generateRoleReasoning(role: AgentRole, criteria: RoleSelectionCriteria): string {
    const reasons: string[] = [];

    switch (role.type) {
      case 'planner':
        if (criteria.complexity >= 5) {
          reasons.push('Task complexity requires structured planning');
        }
        if (criteria.filesInvolved > 5) {
          reasons.push('Multiple files involved require coordination');
        }
        break;
      case 'architect':
        if (criteria.needsArchitecture) {
          reasons.push('Task requires architectural decisions');
        }
        if (criteria.complexity >= 7) {
          reasons.push('High complexity benefits from design phase');
        }
        break;
      case 'implementer':
        reasons.push('Core implementation required');
        break;
      case 'tester':
        if (criteria.hasTests) {
          reasons.push('Tests need to be written or updated');
        }
        if (criteria.taskType === 'testing') {
          reasons.push('Testing is the primary focus');
        }
        break;
      case 'refactorer':
        if (criteria.taskType === 'refactor') {
          reasons.push('Refactoring is the primary goal');
        }
        break;
      case 'reviewer':
        if (criteria.complexity >= 6) {
          reasons.push('Complex changes benefit from review');
        }
        break;
      case 'docwriter':
        if (criteria.taskType === 'documentation') {
          reasons.push('Documentation is the primary goal');
        }
        if (criteria.complexity >= 8) {
          reasons.push('Complex feature needs documentation');
        }
        break;
    }

    return reasons.length > 0 ? reasons.join('; ') : 'Default role for task type';
  }

  /**
   * Generate execution sequencing for roles
   */
  private generateSequencing(roles: AgentRole[]): Array<{
    phase: number;
    roles: AgentRoleType[];
    dependencies: string[];
  }> {
    const phases: Array<{
      phase: number;
      roles: AgentRoleType[];
      dependencies: string[];
    }> = [];

    // Phase 1: Planning (if planner is selected)
    const plannerRoles = roles.filter((r) => r.type === 'planner');
    if (plannerRoles.length > 0) {
      phases.push({
        phase: 1,
        roles: plannerRoles.map((r) => r.type),
        dependencies: [],
      });
    }

    // Phase 2: Architecture (if architect is selected)
    const architectRoles = roles.filter((r) => r.type === 'architect');
    if (architectRoles.length > 0) {
      phases.push({
        phase: phases.length + 1,
        roles: architectRoles.map((r) => r.type),
        dependencies: plannerRoles.length > 0 ? ['planner'] : [],
      });
    }

    // Phase 3: Implementation (parallel with testing prep)
    const implRoles = roles.filter((r) => r.type === 'implementer');
    if (implRoles.length > 0) {
      phases.push({
        phase: phases.length + 1,
        roles: implRoles.map((r) => r.type),
        dependencies: architectRoles.length > 0 ? ['architect'] : plannerRoles.length > 0 ? ['planner'] : [],
      });
    }

    // Phase 4: Testing & Refactoring
    const testRefactorRoles = roles.filter((r) => r.type === 'tester' || r.type === 'refactorer');
    if (testRefactorRoles.length > 0) {
      phases.push({
        phase: phases.length + 1,
        roles: testRefactorRoles.map((r) => r.type),
        dependencies: implRoles.length > 0 ? ['implementer'] : [],
      });
    }

    // Phase 5: Review & Documentation
    const reviewDocRoles = roles.filter((r) => r.type === 'reviewer' || r.type === 'docwriter');
    if (reviewDocRoles.length > 0) {
      phases.push({
        phase: phases.length + 1,
        roles: reviewDocRoles.map((r) => r.type),
        dependencies: implRoles.length > 0 ? ['implementer'] : [],
      });
    }

    return phases;
  }

  /**
   * Estimate effort level
   */
  private estimateEffort(criteria: RoleSelectionCriteria): string {
    if (criteria.complexity <= 3) return 'low';
    if (criteria.complexity <= 6) return 'medium';
    return 'high';
  }

  /**
   * Generate initial prompt for a role with context
   */
  generateInitialPrompt(role: AgentRole, context: SharedContext): string {
    const contextSection = `
## Context
- Project: ${context.projectPath}
- Goal: ${context.goal}
- Constraints: ${context.constraints.join(', ') || 'None specified'}
- Key Files: ${context.keyFiles.slice(0, 10).join(', ') || 'Explore the codebase'}

## Previous Decisions
${context.decisions.slice(-5).map((d) => `- [${d.agentRole}]: ${d.description}`).join('\n') || 'None yet'}
`;

    return `${role.systemPrompt}

${contextSection}

${role.initialPrompt}`;
  }

  /**
   * Generate follow-up prompt for an agent
   */
  generateFollowUpPrompt(
    role: AgentRole,
    context: SharedContext,
    previousOutput: string,
    issue?: string
  ): string {
    let prompt = `Continue your work as ${role.name}.

## Previous Context
${previousOutput.slice(-2000)}

## Current State
- Completed subtasks: ${context.completedSubtasks.length}
- Pending subtasks: ${context.pendingSubtasks.length}
- Files modified: ${context.modifiedFiles.length}
`;

    if (issue) {
      prompt += `
## Issue to Address
${issue}

Please address this issue and continue with the task.`;
    } else {
      prompt += `
Please continue with the next steps of your assigned task.`;
    }

    return prompt;
  }

  /**
   * Get role for a specific task type
   */
  suggestPrimaryRole(taskDescription: string): AgentRoleType {
    const lower = taskDescription.toLowerCase();

    if (lower.includes('plan') || lower.includes('break down') || lower.includes('analyze')) {
      return 'planner';
    }
    if (lower.includes('design') || lower.includes('architect') || lower.includes('structure')) {
      return 'architect';
    }
    if (lower.includes('test') || lower.includes('spec') || lower.includes('coverage')) {
      return 'tester';
    }
    if (lower.includes('refactor') || lower.includes('optimize') || lower.includes('clean')) {
      return 'refactorer';
    }
    if (lower.includes('review') || lower.includes('check') || lower.includes('audit')) {
      return 'reviewer';
    }
    if (lower.includes('document') || lower.includes('readme') || lower.includes('doc')) {
      return 'docwriter';
    }

    // Default to implementer
    return 'implementer';
  }
}
