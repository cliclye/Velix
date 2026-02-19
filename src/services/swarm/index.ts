/**
 * Claude-Swarm - Multi-agent orchestration system
 * Barrel exports for the swarm module
 */

// Types
export * from './types';

// Core components
export { OrchestratorCore, orchestrator } from './OrchestratorCore';
export { AgentManager } from './AgentManager';
export { SwarmEventEmitter, swarmEvents } from './SwarmEventEmitter';

// Role system
export { RoleSystem } from './RoleSystem';
export { AGENT_ROLES, getRole, getRolesByPriority, getRoleName, getRoleColor } from './roleDefinitions';

// Automation
export { AutomationRulesEngine } from './AutomationRulesEngine';
export { DEFAULT_AUTOMATION_PATTERNS, DEFAULT_POLICIES, RESPONSE_TEMPLATES } from './automationPatterns';

// Context and coordination
export { SharedContextLayer } from './SharedContextLayer';
export { SupervisorValidator } from './SupervisorValidator';
export { SafetyLimiter } from './SafetyLimiter';
