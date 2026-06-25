/**
 * Swarm launch orchestration — scout → builder ↔ reviewer loop.
 * Keeps React (SwarmPanel) thin: validation + plan creation stay in UI; waves run here.
 */
import { claudeCoordinator, type CoordinatorConfig } from "./ClaudeCoordinator";
import { getRole } from "./roleDefinitions";
import type { AgentManager } from "./AgentManager";
import type { AgentStatus } from "./types";

export type SwarmPlan = Awaited<ReturnType<typeof claudeCoordinator.createLaunchPlan>>;
export type SwarmAssignment = SwarmPlan["assignments"][number];

const FINISHED_STATUSES = new Set<AgentStatus>(["completed", "failed", "terminated"]);
const MAX_REVIEW_ITERATIONS = 3;
const AGENT_STALL_TIMEOUT_MS = 120_000;
const AGENT_STALL_CHECK_INTERVAL_MS = 10_000;

export type CoordinatorLogKind = "plan" | "sync" | "dispatch" | "review" | "error";

export interface RunSwarmLaunchParams {
  manager: AgentManager;
  plan: SwarmPlan;
  trimmedGoal: string;
  coordinatorConfig: CoordinatorConfig;
  selectedCliName: string;
  maxMode: boolean;
  signal: AbortSignal;
  appendLog: (kind: CoordinatorLogKind, message: string) => void;
  refreshAgents: () => void;
  /** Optional UI hook for phase labels (scout / builders / review). */
  setPhaseStatus?: (label: string) => void;
}

export async function runSwarmLaunch(p: RunSwarmLaunchParams): Promise<void> {
  const {
    manager,
    plan,
    trimmedGoal,
    coordinatorConfig,
    selectedCliName,
    maxMode,
    signal,
    appendLog,
    refreshAgents,
  } = p;
  const setPhase = p.setPhaseStatus ?? (() => {});

  const swarmState = {
    research: new Map<string, string>(),
    artifacts: new Map<string, string>(),
    reviews: new Map<string, string>(),
  };

  const bailIfAborted = (): boolean => {
    if (!signal.aborted) return false;
    appendLog("dispatch", "Swarm stopped by user.");
    return true;
  };

  const waitForAgents = (agentIds: string[]): Promise<Map<string, string>> =>
    new Promise<Map<string, string>>((resolve, reject) => {
      if (agentIds.length === 0) {
        resolve(new Map());
        return;
      }

      if (signal.aborted) {
        reject(new DOMException("Swarm stopped by user", "AbortError"));
        return;
      }

      const outputs = new Map<string, string>();
      const pending = new Set(agentIds);
      let resolved = false;
      let stallChecker: ReturnType<typeof setInterval> | undefined;
      let statusPoll: ReturnType<typeof setInterval> | undefined;

      const clearStallChecker = () => {
        if (stallChecker !== undefined) {
          clearInterval(stallChecker);
          stallChecker = undefined;
        }
      };

      const clearStatusPoll = () => {
        if (statusPoll !== undefined) {
          clearInterval(statusPoll);
          statusPoll = undefined;
        }
      };

      const finish = () => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        clearStatusPoll();
        clearStallChecker();
        signal.removeEventListener("abort", onAbort);
        resolve(outputs);
      };

      const onAbort = () => {
        if (resolved) return;
        resolved = true;
        unsubscribe();
        clearStatusPoll();
        clearStallChecker();
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Swarm stopped by user", "AbortError"));
      };
      signal.addEventListener("abort", onAbort);

      const collectAgent = (agentId: string) => {
        const agent = manager.getAgent(agentId);
        if (!agent) return;
        const assignment = plan.assignments.find((a) => a.id === agent.assignmentId);
        const key = assignment?.label ?? agent.label ?? agentId;
        outputs.set(key, manager.getAgentHandoffOutput(agentId));
        if (!assignment) {
          appendLog('error', `Agent ${agent.label || agentId} has no matching assignment — output keyed as "${key}".`);
        }
      };

      const unsubscribe = manager.onAgentExit((agentId) => {
        if (resolved || !pending.delete(agentId)) return;
        collectAgent(agentId);
        if (pending.size === 0) finish();
      });

      // Also poll for agents that reached a terminal status without a PTY exit
      // event (e.g. forced completion or race between status update and exit).
      statusPoll = setInterval(() => {
        if (resolved) {
          clearStatusPoll();
          return;
        }
        for (const id of [...pending]) {
          const agent = manager.getAgent(id);
          if (!agent) {
            pending.delete(id);
            continue;
          }
          if (FINISHED_STATUSES.has(agent.status)) {
            pending.delete(id);
            collectAgent(id);
          }
        }
        if (pending.size === 0) finish();
      }, 2_000);

      stallChecker = setInterval(() => {
        if (resolved) {
          clearStallChecker();
          return;
        }
        const now = Date.now();
        for (const id of pending) {
          const agent = manager.getAgent(id);
          if (!agent) {
            pending.delete(id);
            continue;
          }
          if (FINISHED_STATUSES.has(agent.status)) {
            pending.delete(id);
            collectAgent(id);
            continue;
          }
          const timeSinceActivity = now - agent.lastActivityAt.getTime();
          if (timeSinceActivity > AGENT_STALL_TIMEOUT_MS) {
            appendLog(
              "error",
              `Agent ${agent.label || id} stalled (no activity for ${Math.round(timeSinceActivity / 1000)}s) — terminating.`,
            );
            void manager.terminateAgent(id, "Stall timeout");
          }
        }
        if (pending.size === 0) finish();
      }, AGENT_STALL_CHECK_INTERVAL_MS);

      for (const id of agentIds) {
        const agent = manager.getAgent(id);
        if (agent && FINISHED_STATUSES.has(agent.status)) {
          if (pending.delete(id)) collectAgent(id);
        }
      }
      if (!resolved && pending.size === 0) finish();
    });

  const spawnWave = async (
    assignments: SwarmAssignment[],
    taskOverrides?: Map<string, string>,
    depOutputs?: Map<string, string>,
    passAllContext?: boolean,
  ): Promise<string[]> => {
    const agentIds: string[] = [];
    await Promise.all(
      assignments.map(async (assignment, index) => {
        await new Promise((r) => setTimeout(r, index * 150));
        if (signal.aborted) {
          throw new DOMException("Swarm stopped by user", "AbortError");
        }
        const role = getRole(assignment.role);

        let workerTask: string;
        if (taskOverrides?.has(assignment.label)) {
          workerTask = taskOverrides.get(assignment.label)!;
        } else {
          let deps: Map<string, string>;
          if (passAllContext && depOutputs) {
            deps = depOutputs;
          } else {
            deps = new Map<string, string>();
            if (depOutputs) {
              for (const depLabel of assignment.dependencies) {
                const output = depOutputs.get(depLabel);
                if (output) deps.set(depLabel, output);
              }
            }
          }
          workerTask = claudeCoordinator.buildWorkerTask(
            trimmedGoal,
            plan,
            assignment,
            deps.size > 0 ? deps : undefined,
            maxMode,
          );
        }

        const agent = await manager.spawnAgent(role, workerTask, {
          assignmentId: assignment.id,
          label: assignment.label,
          ownedFiles: assignment.ownedFiles,
        });
        agentIds.push(agent.id);
        appendLog("dispatch", `Launched ${assignment.label}.`);
      }),
    );
    refreshAgents();
    return agentIds;
  };

  const scoutAssignments = plan.assignments.filter((a) => a.role === "scout");
  if (scoutAssignments.length > 0) {
    setPhase("Scout Research (CLI)");
    const scoutApiResearch = new Map<string, string>();
    await Promise.all(
      scoutAssignments.map(async (assignment) => {
        try {
          appendLog(
            "dispatch",
            `Scout ${assignment.label}: running external research with ${selectedCliName}…`,
          );
          const research = await claudeCoordinator.scoutResearch(
            trimmedGoal,
            assignment.task,
            coordinatorConfig,
            maxMode,
          );
          scoutApiResearch.set(assignment.label, research);
          appendLog("dispatch", `Scout ${assignment.label}: external research complete.`);
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          const msg = err instanceof Error ? err.message : String(err);
          appendLog("error", `Scout ${assignment.label} coordinator research failed: ${msg}`);
        }
      }),
    );
    if (bailIfAborted()) return;

    setPhase("Scout Mapping (CLI)");
    const scoutTaskOverrides = new Map<string, string>();
    for (const assignment of scoutAssignments) {
      const apiResearch = scoutApiResearch.get(assignment.label);
      if (apiResearch) {
        const baseTask = claudeCoordinator.buildWorkerTask(trimmedGoal, plan, assignment, undefined, maxMode);
        scoutTaskOverrides.set(
          assignment.label,
          `${baseTask}\n\n--- External Research Context (from ${selectedCliName}) ---\n${apiResearch}\n--- End External Research ---\n\nUse the above external research to inform your codebase analysis. Focus on internal code paths, file structure, and risks specific to this project.`,
        );
      }
    }

    const scoutIds = await spawnWave(
      scoutAssignments,
      scoutTaskOverrides.size > 0 ? scoutTaskOverrides : undefined,
    );
    const scoutOutputs = await waitForAgents(scoutIds);
    if (bailIfAborted()) return;

    for (const [label, cliOutput] of scoutOutputs) {
      const apiOutput = scoutApiResearch.get(label) || "";
      swarmState.research.set(label, apiOutput ? `${apiOutput}\n\n---\n\n${cliOutput}` : cliOutput);
    }
    appendLog("dispatch", `Scout wave complete: ${scoutAssignments.map((a) => a.label).join(", ")}`);
    refreshAgents();
  } else {
    appendLog("dispatch", "No scouts configured — builders will work without pre-mapping.");
  }

  const allResearch = new Map<string, string>([...swarmState.research]);
  const builderAssignments = plan.assignments.filter((a) => a.role === "builder");
  const reviewerAssignments = plan.assignments.filter((a) => a.role === "reviewer");

  if (builderAssignments.length === 0) {
    appendLog("error", "Coordinator plan has no builder assignments. Cannot proceed.");
    throw new Error("Launch failed: no builder assignments in coordinator plan.");
  }

  let iteration = 0;
  let approved = false;
  let lastRevisionInstructions = "";

  while (!approved && iteration < MAX_REVIEW_ITERATIONS && !signal.aborted) {
    iteration++;
    const isRevision = iteration > 1;

    let builderTaskOverrides: Map<string, string> | undefined;
    if (isRevision) {
      const instructions =
        lastRevisionInstructions.trim() ||
        "Address reviewer feedback and fix issues from the previous build.";
      builderTaskOverrides = new Map();
      for (const assignment of builderAssignments) {
        const prevOutput = swarmState.artifacts.get(assignment.label) || "";
        const revisionTask = claudeCoordinator.buildRevisionTask(
          trimmedGoal,
          plan,
          assignment,
          prevOutput,
          instructions,
          iteration,
          maxMode,
        );
        builderTaskOverrides.set(assignment.label, revisionTask);
      }
      appendLog("review", `Revision round ${iteration} — sending builders back with reviewer feedback.`);
    }

    setPhase(isRevision ? `Launching Builder Revision ${iteration}` : "Launching Builders");
    const builderIds = await spawnWave(builderAssignments, builderTaskOverrides, allResearch, false);
    setPhase(isRevision ? `Builder Revision ${iteration}` : "Builders Working");
    const builderOutputs = await waitForAgents(builderIds);
    if (bailIfAborted()) return;
    for (const [label, output] of builderOutputs) swarmState.artifacts.set(label, output);
    appendLog("dispatch", `Builder wave complete: ${builderAssignments.map((a) => a.label).join(", ")}`);
    refreshAgents();

    if (reviewerAssignments.length === 0) {
      appendLog("review", "No reviewers configured — marking work as complete.");
      approved = true;
      break;
    }

    if (bailIfAborted()) return;

    setPhase("Launching Reviewers");
    const reviewerContext = new Map<string, string>([...allResearch, ...swarmState.artifacts]);
    const reviewerIds = await spawnWave(reviewerAssignments, undefined, reviewerContext, true);
    setPhase("Reviewers Evaluating");
    const reviewerOutputs = await waitForAgents(reviewerIds);
    if (bailIfAborted()) return;
    for (const [label, output] of reviewerOutputs) swarmState.reviews.set(label, output);
    appendLog("dispatch", `Reviewer wave complete: ${reviewerAssignments.map((a) => a.label).join(", ")}`);
    refreshAgents();

    if (bailIfAborted()) return;

    setPhase("Coordinator Evaluating Review");
    const evaluation = await claudeCoordinator.evaluateReview(
      trimmedGoal,
      swarmState.reviews,
      swarmState.artifacts,
      coordinatorConfig,
    );

    if (bailIfAborted()) return;

    appendLog("review", `Coordinator verdict: ${evaluation.verdict} — ${evaluation.summary}`);
    lastRevisionInstructions = evaluation.revisionInstructions;

    if (evaluation.verdict === "APPROVED") {
      approved = true;
      appendLog("review", "All work approved by coordinator. Swarm complete.");
    } else if (iteration >= MAX_REVIEW_ITERATIONS) {
      appendLog("review", `Max review iterations (${MAX_REVIEW_ITERATIONS}) reached. Accepting current state.`);
      approved = true;
    }
  }

  refreshAgents();
  if (!signal.aborted) {
    setPhase(approved ? "Complete" : "Running");
  }
}
