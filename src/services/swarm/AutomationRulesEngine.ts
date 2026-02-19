/**
 * AutomationRulesEngine - Pattern detection and policy execution for Claude Code prompts
 */

import {
  AutomationPattern,
  AutomationPolicy,
  PolicyCondition,
  PatternMatch,
  PolicyDecision,
  Agent,
  PendingApproval,
} from './types';
import { DEFAULT_AUTOMATION_PATTERNS, DEFAULT_POLICIES, RESPONSE_TEMPLATES } from './automationPatterns';
import { AgentManager } from './AgentManager';

export class AutomationRulesEngine {
  private patterns: Map<string, AutomationPattern> = new Map();
  private policies: Map<string, AutomationPolicy> = new Map();
  private safeMode: boolean = false;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private approvalCallbacks: Array<(approval: PendingApproval) => void> = [];

  constructor() {
    // Initialize with default patterns and policies
    for (const pattern of DEFAULT_AUTOMATION_PATTERNS) {
      this.patterns.set(pattern.id, pattern);
    }
    for (const policy of DEFAULT_POLICIES) {
      this.policies.set(policy.patternId, policy);
    }
  }

  /**
   * Get all patterns
   */
  getPatterns(): AutomationPattern[] {
    return Array.from(this.patterns.values());
  }

  /**
   * Add a new pattern
   */
  addPattern(pattern: AutomationPattern): void {
    this.patterns.set(pattern.id, pattern);
  }

  /**
   * Remove a pattern
   */
  removePattern(patternId: string): void {
    this.patterns.delete(patternId);
  }

  /**
   * Get all policies
   */
  getPolicies(): AutomationPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Set or update a policy
   */
  setPolicy(policy: AutomationPolicy): void {
    this.policies.set(policy.patternId, policy);
  }

  /**
   * Remove a policy
   */
  removePolicy(patternId: string): void {
    this.policies.delete(patternId);
  }

  /**
   * Detect a prompt in output text
   */
  detectPrompt(output: string): PatternMatch | null {
    // Check each pattern
    for (const pattern of this.patterns.values()) {
      const match = pattern.pattern.exec(output);
      if (match) {
        const policy = this.policies.get(pattern.id);
        const suggestedAction = this.getSuggestedAction(pattern.id);

        return {
          patternId: pattern.id,
          matchedText: match[0],
          confidence: policy?.confidence || 0.5,
          suggestedAction,
          context: this.extractContext(output, match.index),
        };
      }
    }

    return null;
  }

  /**
   * Extract context around a match
   */
  private extractContext(output: string, matchIndex: number): string {
    const contextSize = 200;
    const start = Math.max(0, matchIndex - contextSize);
    const end = Math.min(output.length, matchIndex + contextSize);
    return output.substring(start, end);
  }

  /**
   * Get suggested action for a pattern
   */
  private getSuggestedAction(patternId: string): 'approve' | 'deny' | 'escalate' {
    if (this.safeMode) {
      return 'escalate';
    }

    const policy = this.policies.get(patternId);
    if (!policy) {
      return 'escalate';
    }

    switch (policy.action) {
      case 'auto_approve':
        return 'approve';
      case 'auto_deny':
        return 'deny';
      default:
        return 'escalate';
    }
  }

  /**
   * Analyze context and determine policy decision
   */
  analyzeContext(match: PatternMatch, agent: Agent): PolicyDecision {
    const policy = this.policies.get(match.patternId);

    if (!policy || this.safeMode) {
      return {
        patternMatch: match,
        policy: policy || {
          patternId: match.patternId,
          action: 'escalate',
          confidence: 0.5,
        },
        action: 'escalate',
        response: '',
        reasoning: this.safeMode ? 'Safe mode is enabled - all actions require approval' : 'No policy defined for this pattern',
        requiresUserApproval: true,
      };
    }

    // Check conditions
    if (policy.conditions) {
      const conditionsMet = this.evaluateConditions(policy.conditions, match, agent);
      if (!conditionsMet) {
        return {
          patternMatch: match,
          policy,
          action: 'escalate',
          response: '',
          reasoning: 'Policy conditions not met',
          requiresUserApproval: true,
        };
      }
    }

    // Check confidence threshold
    if (match.confidence < policy.confidence) {
      return {
        patternMatch: match,
        policy,
        action: 'escalate',
        response: '',
        reasoning: `Confidence (${match.confidence.toFixed(2)}) below threshold (${policy.confidence.toFixed(2)})`,
        requiresUserApproval: true,
      };
    }

    // Determine action
    const action = policy.action === 'auto_approve' ? 'approve' :
                   policy.action === 'auto_deny' ? 'deny' : 'escalate';

    const response = this.getResponse(match.patternId, action);
    const requiresUserApproval = policy.action === 'escalate' || policy.action === 'ask_user';

    return {
      patternMatch: match,
      policy,
      action,
      response,
      reasoning: this.generateReasoning(policy, match),
      requiresUserApproval,
    };
  }

  /**
   * Evaluate policy conditions
   */
  private evaluateConditions(
    conditions: PolicyCondition[],
    match: PatternMatch,
    _agent: Agent
  ): boolean {
    for (const condition of conditions) {
      let value: string;

      switch (condition.type) {
        case 'file_path':
        case 'context':
          value = match.context;
          break;
        case 'file_type':
          value = match.context;
          break;
        case 'keyword':
          value = match.matchedText;
          break;
        default:
          value = match.context;
      }

      const result = this.evaluateCondition(condition, value);
      if (!result) {
        return false;
      }
    }

    return true;
  }

  /**
   * Evaluate a single condition
   */
  private evaluateCondition(condition: PolicyCondition, value: string): boolean {
    const lowerValue = value.toLowerCase();
    const lowerCondition = condition.value.toLowerCase();

    switch (condition.operator) {
      case 'contains':
        return lowerValue.includes(lowerCondition);
      case 'not_contains':
        return !lowerValue.includes(lowerCondition);
      case 'starts_with':
        return lowerValue.startsWith(lowerCondition);
      case 'ends_with':
        return lowerValue.endsWith(lowerCondition);
      case 'matches':
        try {
          return new RegExp(condition.value, 'i').test(value);
        } catch {
          return false;
        }
      default:
        return false;
    }
  }

  /**
   * Get response for an action
   */
  private getResponse(patternId: string, action: 'approve' | 'deny' | 'escalate'): string {
    const templates = RESPONSE_TEMPLATES[patternId] || { approve: 'y', deny: 'n' };

    if (action === 'approve') {
      return templates.approve;
    } else if (action === 'deny') {
      return templates.deny;
    }

    return '';
  }

  /**
   * Generate reasoning for a decision
   */
  private generateReasoning(policy: AutomationPolicy, match: PatternMatch): string {
    const pattern = this.patterns.get(match.patternId);
    const patternName = pattern?.name || match.patternId;

    if (policy.action === 'auto_approve') {
      return `Auto-approved: ${patternName} matches policy (confidence: ${match.confidence.toFixed(2)})`;
    } else if (policy.action === 'auto_deny') {
      return `Auto-denied: ${patternName} matches deny policy`;
    } else {
      return `Escalated: ${patternName} requires user approval`;
    }
  }

  /**
   * Execute an action (send response to agent)
   */
  async executeAction(
    decision: PolicyDecision,
    agentId: string,
    agentManager: AgentManager
  ): Promise<void> {
    if (decision.requiresUserApproval) {
      // Add to pending approvals
      const approval: PendingApproval = {
        id: `approval_${Date.now()}`,
        agentId,
        patternMatch: decision.patternMatch,
        timestamp: new Date(),
        context: decision.patternMatch.context,
      };

      this.pendingApprovals.set(approval.id, approval);

      // Notify callbacks
      for (const callback of this.approvalCallbacks) {
        try {
          callback(approval);
        } catch (error) {
          console.error('Error in approval callback:', error);
        }
      }

      return;
    }

    // Execute the action
    if (decision.response) {
      await agentManager.respondToAgent(agentId, decision.response);
    }
  }

  /**
   * Set safe mode
   */
  setSafeMode(enabled: boolean): void {
    this.safeMode = enabled;
  }

  /**
   * Check if safe mode is enabled
   */
  isSafeMode(): boolean {
    return this.safeMode;
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals(): PendingApproval[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * Get pending approval by ID
   */
  getPendingApproval(id: string): PendingApproval | undefined {
    return this.pendingApprovals.get(id);
  }

  /**
   * Resolve a pending approval
   */
  async resolveApproval(
    approvalId: string,
    approve: boolean,
    agentManager: AgentManager
  ): Promise<void> {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) return;

    const response = approve ? 'y' : 'n';
    await agentManager.respondToAgent(approval.agentId, response);

    this.pendingApprovals.delete(approvalId);
  }

  /**
   * Subscribe to pending approvals
   */
  onPendingApproval(callback: (approval: PendingApproval) => void): () => void {
    this.approvalCallbacks.push(callback);
    return () => {
      const index = this.approvalCallbacks.indexOf(callback);
      if (index !== -1) {
        this.approvalCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Clear all pending approvals
   */
  clearPendingApprovals(): void {
    this.pendingApprovals.clear();
  }

  /**
   * Get pattern by ID
   */
  getPattern(patternId: string): AutomationPattern | undefined {
    return this.patterns.get(patternId);
  }

  /**
   * Get policy by pattern ID
   */
  getPolicy(patternId: string): AutomationPolicy | undefined {
    return this.policies.get(patternId);
  }

  /**
   * Reset to defaults
   */
  resetToDefaults(): void {
    this.patterns.clear();
    this.policies.clear();

    for (const pattern of DEFAULT_AUTOMATION_PATTERNS) {
      this.patterns.set(pattern.id, pattern);
    }
    for (const policy of DEFAULT_POLICIES) {
      this.policies.set(policy.patternId, policy);
    }
  }
}
