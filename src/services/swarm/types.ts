/**
 * Swarm type definitions — multi-agent orchestration for headless coding CLIs
 * (Claude Code, Gemini CLI, Codex, Copilot, Velix, custom commands, etc.).
 */

import type { ActivityEntry } from './workerCli';

export type AgentStatus =
  | 'initializing'
  | 'running'
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

// ============= Agent Definition =============

export interface Agent {
  id: string;
  role: AgentRole;
  /** Id of the OS process run in the Rust agent runner. */
  runId: string;
  assignmentId?: string;
  label?: string;
  ownedFiles: string[];
  status: AgentStatus;
  assignedTask: string;
  /** 1 for the first attempt; builders get a new attempt per revision round. */
  attempt: number;
  startedAt: Date;
  endedAt?: Date;
  lastActivityAt: Date;
  /** Everything the CLI printed on stdout (capped). */
  output: string;
  /** Everything the CLI printed on stderr (capped). */
  stderr: string;
  /** Parsed live activity (tool calls, narration) — populated for stream-json CLIs. */
  activity: ActivityEntry[];
  /** Files the agent reported editing via tool calls. */
  filesTouched: string[];
  exitCode?: number | null;
  failureReason?: string;
  costUsd?: number;
  /** Final handoff text (structured report block or denoised output), set when the run ends. */
  result?: string;
}
