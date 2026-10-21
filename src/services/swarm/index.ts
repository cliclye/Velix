/**
 * Swarm — multi-agent orchestration for headless worker CLIs.
 */

export * from './types';

export { AgentManager, DEFAULT_AGENT_TIMEOUT_MS, MAX_MODE_AGENT_TIMEOUT_MS, tauriAgentTransport } from './AgentManager';
export type { AgentRunResult, AgentTransport, AgentRunnerEvent, RunTaskOptions } from './AgentManager';

export {
  WORKER_CLI_OPTIONS,
  getWorkerCLIOptions,
  loadCustomCLIOptions,
  saveCustomCLIOptions,
  detectWorkerCLIAvailability,
  buildWorkerInvocation,
  createStreamParser,
  splitCommand,
} from './workerCli';
export type { WorkerCLIOption, WorkerCLIStatus, WorkerInvocation, ActivityEntry } from './workerCli';

export { SwarmRunner, mapWithConcurrency, isAbortError, DEFAULT_CONCURRENCY } from './SwarmRunner';
export type { SwarmRunnerCallbacks, SwarmRunOptions, SwarmRunOutcome, SwarmLogKind, SwarmPhase, SwarmFinalVerdict, WorkerPool } from './SwarmRunner';

export { SwarmSession, swarmSession, isRunActive } from './SwarmSession';
export type { SwarmSnapshot, SwarmStartConfig, SwarmLogEntry } from './SwarmSession';

export { AGENT_ROLES, getRole, getRolesByPriority, getRoleName, getRoleColor } from './roleDefinitions';
export { claudeCoordinator, SWARM_SPECIALIST_ROLE_ORDER } from './ClaudeCoordinator';
export type { CoordinatorConfig, CoordinatorPlan, CoordinatorAssignment } from './ClaudeCoordinator';

export { extractStructuredHandoff, formatCoordinatorHandoff, parseReviewVerdict } from './handoffOutput';
export { SWARM_PRESETS, getSwarmPreset } from './presets';
export type { SwarmPreset, SwarmRoleCounts } from './presets';
export { loadSwarmHistory, saveSwarmRun, clearSwarmHistory } from './history';
export type { SwarmHistoryEntry } from './history';
export { buildReportMarkdown, captureGitSnapshot, diffSnapshots, formatDuration } from './report';
export type { ChangedFile } from './report';
export { requestSwarmPreset, takePendingSwarmPreset, onSwarmPresetRequest } from './presetBus';
