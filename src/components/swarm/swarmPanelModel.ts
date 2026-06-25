/**
 * Swarm panel — shared constants and pure helpers (no React).
 */
import { getRole, getWorkerCLIOptions } from "../../services/swarm";
import type { SwarmAssignment } from "../../services/swarm/swarmLaunchPipeline";
import type { Agent, AgentRoleType, AgentStatus, WorkerCLI } from "../../services/swarm/types";
import type { MindMapConnection } from "./SwarmMindMap";

export type SwarmLaunchRole = Extract<AgentRoleType, "scout" | "builder" | "reviewer">;
export type RoleCounts = Record<SwarmLaunchRole, number>;
export type BoardStatusTone = "queued" | "mapping" | "building" | "review" | "done" | "blocked";
export type WorkerCLIAvailability = Record<WorkerCLI, { available: boolean; detail: string }>;

export interface CoordinatorLogEntry {
  id: string;
  kind: "plan" | "sync" | "dispatch" | "review" | "error";
  message: string;
  timestamp: number;
}

export const MIN_AGENTS = 2;
export const MAX_AGENTS = 25;
export const MAX_MODE_STORAGE_KEY = "velix-swarm-max-mode";
export const WORKER_CLI_STORAGE_KEY = "velix-swarm-worker-cli";
export const ROLE_ORDER: SwarmLaunchRole[] = ["scout", "builder", "reviewer"];
export const DEFAULT_ROLE_COUNTS: RoleCounts = {
  scout: 1,
  builder: 2,
  reviewer: 1,
};
export const ROLE_LIMITS: Record<SwarmLaunchRole, { min: number; max: number }> = {
  scout: { min: 0, max: 5 },
  builder: { min: 1, max: 20 },
  reviewer: { min: 0, max: 5 },
};
export const ROLE_COPY: Record<SwarmLaunchRole, { caption: string; hint: string }> = {
  scout: {
    caption: "Codebase intelligence specialist",
    hint: "Maps the repo, surfaces risks, and sets clean ownership before builders spread out.",
  },
  builder: {
    caption: "Senior software engineer",
    hint: "Owns one implementation slice end-to-end and ships inside assigned files.",
  },
  reviewer: {
    caption: "Principal engineer quality gate",
    hint: "Reviews completed slices, catches regressions, and blocks weak work from shipping.",
  },
};
export const PALETTE_ROLE_COLORS: Record<SwarmLaunchRole, string> = {
  scout: "var(--text-muted)",
  builder: "var(--text-primary)",
  reviewer: "var(--text-secondary)",
};
export const PALETTE_DRAG_KEY = "smm-role";
export const FINISHED_STATUSES = new Set<AgentStatus>(["completed", "failed", "terminated"]);
export const WORK_SUMMARY_FALLBACK: Record<SwarmLaunchRole, string> = {
  scout: "Map code paths",
  builder: "Ship owned slice",
  reviewer: "Review build output",
};
const WORK_SUMMARY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "before",
  "for",
  "from",
  "inside",
  "its",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "with",
  "your",
]);

export const buildDefaultWorkerCLIAvailability = (): WorkerCLIAvailability =>
  Object.fromEntries(
    getWorkerCLIOptions().map((option) => [
      option.id,
      { available: false, detail: "Checking availability…" },
    ]),
  ) as WorkerCLIAvailability;

export const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const trimCoordinatorLog = (entries: CoordinatorLogEntry[]) => entries.slice(-12);

export const buildRolesToLaunch = (roleCounts: RoleCounts): SwarmLaunchRole[] =>
  ROLE_ORDER.flatMap((role) => Array.from({ length: roleCounts[role] }, () => role));

export const buildAssignmentLabel = (
  role: SwarmLaunchRole,
  occurrence: number,
  totalForRole: number,
): string => {
  const baseLabel = getRole(role).name;
  return totalForRole > 1 ? `${baseLabel}-${occurrence}` : baseLabel;
};

export const buildPreviewAssignments = (roles: SwarmLaunchRole[]): SwarmAssignment[] => {
  const totals = roles.reduce<Record<string, number>>((acc, role) => {
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  const seen = new Map<SwarmLaunchRole, number>();

  return roles.map((role) => {
    const occurrence = (seen.get(role) || 0) + 1;
    seen.set(role, occurrence);
    const label = buildAssignmentLabel(role, occurrence, totals[role] || 1);
    const previewTask =
      role === "scout"
        ? "Map the relevant code paths, identify risks, and recommend ownership boundaries."
        : role === "reviewer"
          ? "Review completed builder slices and gate release quality before the swarm marks work done."
          : `Ship the ${label.toLowerCase()} slice inside its assigned ownership boundary.`;

    return {
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      label,
      role,
      task: previewTask,
      ownedFiles: [],
      deliverables: [],
      dependencies:
        role === "builder"
          ? (totals.scout ? [buildAssignmentLabel("scout", 1, totals.scout || 1)] : [])
          : role === "reviewer"
            ? roles
                .filter((candidate) => candidate === "builder")
                .map((_candidate, index) => buildAssignmentLabel("builder", index + 1, totals.builder || 1))
            : [],
      successCriteria: [],
    };
  });
};

export const getWorkspaceName = (workspacePath: string): string => {
  const parts = workspacePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || "workspace";
};

export const getAssignmentState = (
  assignment: SwarmAssignment,
  agent: Agent | undefined,
): { label: string; tone: BoardStatusTone } => {
  if (!agent) {
    return { label: "QUEUED", tone: "queued" };
  }

  if (agent.status === "initializing") {
    return { label: "STARTING", tone: "queued" };
  }

  if (agent.status === "completed") {
    return { label: "DONE", tone: "done" };
  }

  if (agent.status === "failed") {
    return { label: "FAILED", tone: "blocked" };
  }

  if (agent.status === "terminated") {
    return { label: "STOPPED", tone: "blocked" };
  }

  if (agent.status === "waiting_for_input" || agent.status === "waiting_for_approval") {
    return { label: "BLOCKED", tone: "blocked" };
  }

  if (assignment.role === "reviewer") {
    return { label: "REVIEW", tone: "review" };
  }

  if (assignment.role === "scout") {
    return { label: "MAPPING", tone: "mapping" };
  }

  return { label: "BUILDING", tone: "building" };
};

const normalizeMindMapId = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const formatSummaryWord = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

export const buildWorkSummary = (value: string | undefined, role: SwarmLaunchRole): string => {
  const tokens = (value || "")
    .replace(/your assigned task:/gi, " ")
    .replace(/[^a-z0-9\s/-]/gi, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));

  const filtered = tokens.filter((token) => !WORK_SUMMARY_STOP_WORDS.has(token.toLowerCase()));
  const chosen = (filtered.length >= 3 ? filtered : tokens).slice(0, 3).map(formatSummaryWord);

  return chosen.length > 0 ? chosen.join(" ") : WORK_SUMMARY_FALLBACK[role];
};

export const dedupeMindMapConnections = (connections: MindMapConnection[]): MindMapConnection[] => {
  const uniqueConnections = new Map<string, MindMapConnection>();

  for (const connection of connections) {
    if (!connection.from || !connection.to || connection.from === connection.to) continue;

    const key = `${connection.from}->${connection.to}`;
    const existing = uniqueConnections.get(key);
    if (!existing || connection.kind === "manual") {
      uniqueConnections.set(key, connection);
    }
  }

  return Array.from(uniqueConnections.values());
};

export const applyManualConnectionsToAssignments = (
  assignments: SwarmAssignment[],
  manualConnections: MindMapConnection[],
): SwarmAssignment[] => {
  if (manualConnections.length === 0) return assignments;

  const labelById = new Map(assignments.map((assignment) => [assignment.id, assignment.label]));
  const additionsByTarget = new Map<string, string[]>();

  for (const connection of manualConnections) {
    const sourceLabel = labelById.get(connection.from);
    if (!sourceLabel) continue;

    const current = additionsByTarget.get(connection.to) || [];
    current.push(sourceLabel);
    additionsByTarget.set(connection.to, current);
  }

  return assignments.map((assignment) => {
    const manualDependencies = additionsByTarget.get(assignment.id);
    if (!manualDependencies || manualDependencies.length === 0) return assignment;

    return {
      ...assignment,
      dependencies: Array.from(
        new Set([...assignment.dependencies, ...manualDependencies]),
      ).filter((dependency) => normalizeMindMapId(dependency) !== normalizeMindMapId(assignment.label)),
    };
  });
};

export const buildAutomaticMindMapConnections = (assignments: SwarmAssignment[]): MindMapConnection[] => {
  const idsByNormalizedLabel = new Map(
    assignments.map((assignment) => [normalizeMindMapId(assignment.label), assignment.id]),
  );
  const idsByAssignmentId = new Map(
    assignments.map((assignment) => [normalizeMindMapId(assignment.id), assignment.id]),
  );

  return dedupeMindMapConnections(
    assignments.flatMap((assignment) =>
      assignment.dependencies.flatMap((dependency) => {
        const normalizedDependency = normalizeMindMapId(dependency);
        const sourceId = idsByAssignmentId.get(normalizedDependency) || idsByNormalizedLabel.get(normalizedDependency);
        return sourceId && sourceId !== assignment.id
          ? [{ from: sourceId, to: assignment.id, kind: "automatic" as const }]
          : [];
      }),
    ),
  );
};
