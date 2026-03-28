/**
 * Claude-Swarm Type Definitions
 * Multi-agent orchestration system for automating Claude Code sessions
 */

// ============= Orchestrator States =============

export type OrchestratorState =
  | 'idle'
  | 'analyzing'
  | 'planning'
  | 'spawning'
  | 'running'
  | 'validating'
  | 'fixing'
  | 'paused'
  | 'aborting'
  | 'completed'
  | 'failed';

export type AgentStatus =
  | 'initializing'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'terminated';

export type WorkerCLI = string;

// ============= Agent Roles =============

export type AgentRoleType =
  | 'scout'
  | 'planner'
  | 'architect'
  | 'frontend'
  | 'backend'
  | 'builder'
  | 'security'
  | 'qa'
  | 'implementer'
  | 'tester'
  | 'refactorer'
  | 'reviewer'
  | 'docwriter';

export interface AgentRole {
  type: AgentRoleType;
  name: string;
  description: string;
  systemPrompt: string;
  initialPrompt: string;
  capabilities: string[];
  restrictions: string[];
  priority: number;
  estimatedDuration: number; // minutes
}

// ============= Complexity Analysis =============

export interface ComplexityFactor {
  name: string;
  weight: number;
  value: number;
  description: string;
}

export interface ComplexityAnalysis {
  score: number; // 1-10
  agentCount: number; // 1-5
  reasoning: string;
  factors: ComplexityFactor[];
  estimatedDuration: number; // minutes
}

// ============= Agent Definition =============

export interface AgentMetrics {
  promptsProcessed: number;
  filesModified: string[];
  testsRun: number;
  errorsEncountered: number;
  autoApprovals: number;
  escalations: number;
}

export interface Agent {
  id: string;
  role: AgentRole;
  sessionId: string; // PTY session ID
  assignmentId?: string;
  label?: string;
  ownedFiles?: string[];
  status: AgentStatus;
  assignedTask: string;
  startedAt: Date;
  lastActivityAt: Date;
  outputBuffer: string[]; // Rolling buffer of last N lines
  terminalOutput: string; // Raw PTY stream used for terminal replay
  metrics: AgentMetrics;
  promptFilePath?: string; // Temp file containing the full prompt for this agent
}

export interface AgentAssignment {
  agentId: string;
  role: AgentRoleType;
  subtask: string;
  priority: number;
  dependencies: string[]; // Other agent IDs this depends on
  estimatedDuration: number;
}

// ============= Swarm Task =============

export interface SwarmTask {
  id: string;
  goal: string;
  constraints: string[];
  createdAt: Date;
  status: OrchestratorState;
  complexity: ComplexityAnalysis;
  agents: AgentAssignment[];
}

// ============= Automation Patterns =============

export interface AutomationPattern {
  id: string;
  name: string;
  pattern: RegExp;
  category: 'confirmation' | 'file_operation' | 'dependency' | 'test' | 'custom';
  examples: string[];
}

export interface PolicyCondition {
  type: 'file_path' | 'file_type' | 'keyword' | 'context';
  operator: 'contains' | 'matches' | 'starts_with' | 'ends_with' | 'not_contains';
  value: string;
}

export interface AutomationPolicy {
  patternId: string;
  action: 'auto_approve' | 'auto_deny' | 'escalate' | 'ask_user';
  conditions?: PolicyCondition[];
  confidence: number; // 0-1
}

export interface PatternMatch {
  patternId: string;
  matchedText: string;
  confidence: number;
  suggestedAction: 'approve' | 'deny' | 'escalate';
  context: string;
}

export interface PolicyDecision {
  patternMatch: PatternMatch;
  policy: AutomationPolicy;
  action: 'approve' | 'deny' | 'escalate';
  response: string;
  reasoning: string;
  requiresUserApproval: boolean;
}

// ============= Shared Context =============

export interface Decision {
  id: string;
  agentId: string;
  agentRole: AgentRoleType;
  timestamp: Date;
  type: 'architecture' | 'implementation' | 'dependency' | 'test' | 'other';
  description: string;
  rationale: string;
  affectedFiles: string[];
}

export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string | null; // null = broadcast
  timestamp: Date;
  type: 'info' | 'request' | 'response' | 'warning' | 'completion';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface Conflict {
  id: string;
  type: 'file_conflict' | 'decision_conflict' | 'resource_conflict';
  agents: string[];
  description: string;
  detectedAt: Date;
  resolvedAt?: Date;
  resolution?: string;
}

export interface FileModification {
  path: string;
  agentId: string;
  timestamp: Date;
  type: 'create' | 'modify' | 'delete' | 'rename';
  oldContent?: string;
  newContent?: string;
  diff?: string;
}

export interface DirectoryMap {
  path: string;
  type: 'file' | 'directory';
  children?: DirectoryMap[];
  metadata?: {
    size: number;
    lastModified: Date;
    language?: string;
  };
}

export interface SharedContext {
  taskId: string;
  goal: string;
  constraints: string[];
  projectPath: string;

  // Project understanding
  projectStructure: DirectoryMap | null;
  keyFiles: string[];
  dependencies: Record<string, string[]>;

  // Progress tracking
  decisions: Decision[];
  completedSubtasks: SubtaskResult[];
  pendingSubtasks: string[];

  // Agent communication
  agentMessages: AgentMessage[];
  conflicts: Conflict[];

  // Resource tracking
  modifiedFiles: FileModification[];
  createdFiles: string[];
  deletedFiles: string[];
}

// ============= Subtask Results =============

export interface SubtaskResult {
  id: string;
  agentId: string;
  role: AgentRoleType;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  output?: string;
  filesModified: string[];
  errors?: string[];
}

// ============= Validation =============

export interface ValidationCheck {
  type: 'build' | 'test' | 'lint' | 'typecheck' | 'custom';
  command: string;
  timeout: number;
  required: boolean;
}

export interface ValidationError {
  file: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  rule?: string;
}

export interface ValidationResult {
  checkType: string;
  success: boolean;
  output: string;
  errors: ValidationError[];
  duration: number;
  timestamp: Date;
}

export interface ConflictDetection {
  type: 'simultaneous_edit' | 'contradictory_decision' | 'circular_dependency';
  agents: string[];
  details: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  suggestedResolution: string;
}

export interface AgentHealth {
  agentId: string;
  status: 'healthy' | 'stalled' | 'erroring' | 'completed';
  lastActivity: Date;
  errorRate: number;
  outputRate: number; // Lines per minute
}

export interface StopCondition {
  type: 'success' | 'retry_limit' | 'timeout' | 'critical_error' | 'user_abort';
  reason: string;
  details?: unknown;
}

// ============= Safety =============

export interface SafetyConfig {
  maxRuntimePerAgent: number; // ms
  maxTotalRuntime: number; // ms
  maxRetriesPerFailure: number;
  maxFileModifications: number;
  maxNewFiles: number;
  forbiddenPaths: string[];
  forbiddenCommands: string[];
  sandboxEnabled: boolean;
  dryRunMode: boolean;
}

export interface SafetyViolation {
  type: 'timeout' | 'forbidden_path' | 'forbidden_command' | 'resource_limit';
  agentId: string;
  details: string;
  timestamp: Date;
  action: 'blocked' | 'terminated' | 'warned';
}

export interface ResourceStatus {
  activeAgents: number;
  maxAgents: number;
  totalRuntime: number;
  maxRuntime: number;
  filesModified: number;
  maxFiles: number;
  memoryUsage: number;
}

// ============= Events =============

export type AgentEvent =
  | { type: 'spawned'; agentId: string; role: AgentRoleType }
  | { type: 'output'; agentId: string; data: string }
  | { type: 'prompt_detected'; agentId: string; match: PatternMatch }
  | { type: 'action_taken'; agentId: string; decision: PolicyDecision }
  | { type: 'completed'; agentId: string; result: SubtaskResult }
  | { type: 'failed'; agentId: string; error: string }
  | { type: 'terminated'; agentId: string; reason: string };

export type SwarmEvent =
  | { type: 'state_changed'; from: OrchestratorState; to: OrchestratorState }
  | { type: 'task_started'; task: SwarmTask }
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'validation_started'; checks: string[] }
  | { type: 'validation_completed'; results: ValidationResult[] }
  | { type: 'conflict_detected'; conflict: ConflictDetection }
  | { type: 'task_completed'; task: SwarmTask; summary: TaskSummary }
  | { type: 'task_failed'; task: SwarmTask; reason: string };

export interface TaskSummary {
  taskId: string;
  goal: string;
  duration: number; // ms
  agentsUsed: number;
  rolesUsed: AgentRoleType[];
  filesCreated: string[];
  filesModified: string[];
  testsRun: number;
  testsPassed: number;
  validationResults: ValidationResult[];
  decisions: Decision[];
}

// ============= Configuration =============

export interface OrchestratorConfig {
  maxAgents: number;
  maxRuntime: number;
  maxRetries: number;
  dryRunMode: boolean;
  safeMode: boolean;
  workspacePath: string;
}

export interface RoleSelectionCriteria {
  taskType: 'new_feature' | 'bug_fix' | 'refactor' | 'documentation' | 'testing' | 'mixed';
  complexity: number;
  filesInvolved: number;
  hasTests: boolean;
  needsArchitecture: boolean;
}

export interface RoleDecisionMatrix {
  taskAnalysis: {
    primaryType: string;
    complexity: number;
    estimatedEffort: string;
  };
  recommendedRoles: Array<{
    role: AgentRoleType;
    confidence: number;
    reasoning: string;
  }>;
  sequencing: Array<{
    phase: number;
    roles: AgentRoleType[];
    dependencies: string[];
  }>;
}

// ============= Approval Queue =============

export interface PendingApproval {
  id: string;
  agentId: string;
  patternMatch: PatternMatch;
  timestamp: Date;
  context: string;
}
