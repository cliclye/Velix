/**
 * Agent loop type definitions — autonomous coding loop for Velix ADE.
 */

import type { ProviderID } from '../ai/modelCatalog';
import type { WorkerCLI } from '../swarm/types';

export type CapabilitySlot = 'planning' | 'coding' | 'review' | 'reasoning';

export type AgentLoopMode = 'assist' | 'guided' | 'autonomous' | 'infinite';

export type LoopTransport = 'api' | 'cli';

export type LoopJsonShape = 'plan' | 'actions' | 'any';

export type CliPromptRunner = (
  system: string,
  userContent: string,
  options?: {
    signal?: AbortSignal;
    label?: string;
    expectJson?: boolean;
    jsonShape?: LoopJsonShape;
    validateResult?: (text: string) => boolean;
    onProgress?: (message: string) => void;
  },
) => Promise<string>;

export type LoopStopReason =
  | 'goal_completed'
  | 'user_stopped'
  | 'budget_limit'
  | 'max_iterations'
  | 'no_deliverables'
  | 'fatal_error';

export type TaskStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface ModelSlot {
  provider: ProviderID;
  model: string;
}

export interface SlotConfig {
  planning: ModelSlot;
  coding: ModelSlot;
  review: ModelSlot;
  reasoning: ModelSlot;
}

export interface AgentLoopConfig {
  mode: AgentLoopMode;
  transport: LoopTransport;
  slots: SlotConfig;
  maxIterations: number;
  maxRetries: number;
  budgetLimit?: number;
  /** Required when transport is `cli`. */
  workerCLI?: WorkerCLI;
  runCliPrompt?: CliPromptRunner;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  retries: number;
  dependencies: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanOutput {
  tasks: Array<{
    title: string;
    description: string;
    priority: number;
    dependencies: string[];
  }>;
  summary: string;
}

export interface VerificationResult {
  success: boolean;
  errors: string[];
  commands: Array<{ command: string; exitCode: number; output: string }>;
}

export interface ReflectionOutput {
  status: 'complete' | 'partial' | 'failed';
  reason: string;
  nextAction: string;
  newTasks?: Array<{
    title: string;
    description: string;
    priority: number;
    dependencies: string[];
  }>;
}

export type ApprovalKind =
  | 'delete_file'
  | 'migration'
  | 'large_refactor'
  | 'install_deps'
  | 'git_operation';

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  diffPreview?: string;
  createdAt: number;
  resolved?: boolean;
  approved?: boolean;
}

export type LoopActivityKind =
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'reflecting'
  | 'fixing'
  | 'retrying'
  | 'waiting_approval'
  | 'completed'
  | 'error';

export interface LoopActivity {
  id: string;
  kind: LoopActivityKind;
  message: string;
  timestamp: number;
  taskId?: string;
}

export interface GoalMemory {
  objective: string;
  constraints: string[];
  requirements: string[];
}

export interface SessionMemory {
  completedTasks: string[];
  failures: string[];
  decisions: string[];
}

export interface ProjectMemory {
  architecture: string[];
  techStack: string[];
  importantFiles: string[];
  conventions: string[];
}

export interface LoopMemory {
  goal: GoalMemory;
  session: SessionMemory;
  project: ProjectMemory;
}

export interface LoopProgress {
  iteration: number;
  maxIterations: number;
  percent: number;
  currentTaskId: string | null;
  stopReason: LoopStopReason | null;
  running: boolean;
}

export interface LoopCallbacks {
  onActivity: (activity: LoopActivity) => void;
  onTasksChanged: (tasks: Task[]) => void;
  onProgress: (progress: LoopProgress) => void;
  onMemoryChanged: (memory: LoopMemory) => void;
  onApprovalRequired: (request: ApprovalRequest) => Promise<boolean>;
  onFilesModified: (paths: string[]) => void;
  onCommandsExecuted: (commands: string[]) => void;
}

export interface ExecutionAction {
  type: 'read_file' | 'write_file' | 'edit_file' | 'search_files' | 'run_terminal' | 'noop';
  path?: string;
  content?: string;
  oldString?: string;
  newString?: string;
  search?: string;
  command?: string;
  summary?: string;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  action: ExecutionAction;
}
