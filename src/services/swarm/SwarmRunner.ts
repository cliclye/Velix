/**
 * SwarmRunner — the swarm loop, rebuilt bottom-up as plain async/await.
 *
 * Pipeline:
 *   coordinator plan (API)
 *     → scout wave     (API research + one-shot CLI analysis, parallel)
 *     → builder wave   (one-shot CLI runs, parallel)
 *     → reviewer wave  (one-shot CLI runs, parallel)
 *     → coordinator verdict (API): APPROVED → done, REVISE → builders re-run
 *       with reviewer feedback (max N iterations)
 *
 * Every worker is a Promise from AgentManager.runTask() that resolves when the
 * headless CLI process exits. There are no event subscriptions, no stall
 * checkers, and no completion heuristics in this loop — a wave is just
 * `await Promise.all(...)`.
 */

import { AgentManager, AgentRunResult, DEFAULT_AGENT_TIMEOUT_MS, MAX_MODE_AGENT_TIMEOUT_MS } from './AgentManager';
import {
  claudeCoordinator,
  CoordinatorConfig,
  CoordinatorPlan,
  CoordinatorAssignment,
} from './ClaudeCoordinator';
import { getRole } from './roleDefinitions';

export type SwarmLogKind = 'plan' | 'sync' | 'dispatch' | 'review' | 'error';

export interface SwarmRunnerCallbacks {
  onLog?: (kind: SwarmLogKind, message: string) => void;
  onStatus?: (label: string) => void;
  onPlan?: (plan: CoordinatorPlan) => void;
  onAgentsChanged?: () => void;
}

export interface SwarmRunOptions {
  goal: string;
  workspacePath: string;
  plan: CoordinatorPlan;
  coordinatorConfig: CoordinatorConfig;
  maxMode: boolean;
  maxReviewIterations?: number;
  signal: AbortSignal;
}

export interface SwarmRunOutcome {
  approved: boolean;
  iterations: number;
  research: Map<string, string>;
  artifacts: Map<string, string>;
  reviews: Map<string, string>;
}

const SPAWN_STAGGER_MS = 150;

function abortError(): DOMException {
  return new DOMException('Swarm stopped by user', 'AbortError');
}

export class SwarmRunner {
  private manager: AgentManager;
  private callbacks: SwarmRunnerCallbacks;

  constructor(manager: AgentManager, callbacks: SwarmRunnerCallbacks = {}) {
    this.manager = manager;
    this.callbacks = callbacks;
  }

  private log(kind: SwarmLogKind, message: string): void {
    this.callbacks.onLog?.(kind, message);
  }

  private status(label: string): void {
    this.callbacks.onStatus?.(label);
  }

  private agentsChanged(): void {
    this.callbacks.onAgentsChanged?.();
  }

  /**
   * Run one wave of assignments in parallel. Resolves with outputs keyed by
   * assignment label once every worker process has exited.
   * Failed/timed-out workers contribute whatever output they produced.
   */
  private async runWave(
    assignments: CoordinatorAssignment[],
    taskFor: (assignment: CoordinatorAssignment) => string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Map<string, string>> {
    if (signal.aborted) throw abortError();

    const results = await Promise.all(
      assignments.map(async (assignment, index) => {
        // Stagger PTY creation slightly to avoid login-shell races.
        if (index > 0) {
          await new Promise((r) => setTimeout(r, index * SPAWN_STAGGER_MS));
        }
        if (signal.aborted) throw abortError();

        const role = getRole(assignment.role);
        this.log('dispatch', `Launched ${assignment.label}.`);
        this.agentsChanged();

        const result: AgentRunResult = await this.manager.runTask(role, taskFor(assignment), {
          assignmentId: assignment.id,
          label: assignment.label,
          ownedFiles: assignment.ownedFiles,
          timeoutMs,
        });

        this.agentsChanged();

        if (result.status === 'completed') {
          this.log('dispatch', `${assignment.label} finished.`);
        } else if (result.status === 'failed') {
          this.log('error', `${assignment.label} failed: ${result.failureReason || 'unknown error'}`);
        }

        return { label: assignment.label, result };
      }),
    );

    if (signal.aborted) throw abortError();

    const outputs = new Map<string, string>();
    for (const { label, result } of results) {
      if (result.output.trim()) {
        outputs.set(label, result.output);
      } else if (result.status === 'completed') {
        this.log('error', `${label} finished with no readable output for coordinator handoff.`);
      }
    }
    return outputs;
  }

  async run(options: SwarmRunOptions): Promise<SwarmRunOutcome> {
    const {
      goal,
      plan,
      coordinatorConfig,
      maxMode,
      signal,
    } = options;
    const maxIterations = options.maxReviewIterations ?? 3;
    const timeoutMs = maxMode ? MAX_MODE_AGENT_TIMEOUT_MS : DEFAULT_AGENT_TIMEOUT_MS;

    const research = new Map<string, string>();
    const artifacts = new Map<string, string>();
    const reviews = new Map<string, string>();

    // ── Phase 1: Scouts (hybrid API research + CLI codebase analysis) ────
    const scoutAssignments = plan.assignments.filter((a) => a.role === 'scout');
    if (scoutAssignments.length > 0) {
      this.status('Scout Research (API)');
      const scoutApiResearch = new Map<string, string>();

      await Promise.all(scoutAssignments.map(async (assignment) => {
        try {
          this.log('dispatch', `Scout ${assignment.label}: running external research via API…`);
          const found = await claudeCoordinator.scoutResearch(goal, assignment.task, coordinatorConfig, maxMode);
          scoutApiResearch.set(assignment.label, found);
          this.log('dispatch', `Scout ${assignment.label}: external research complete.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log('error', `Scout ${assignment.label} API research failed: ${msg}`);
        }
      }));
      if (signal.aborted) throw abortError();

      this.status('Scouts Mapping Codebase');
      const scoutOutputs = await this.runWave(
        scoutAssignments,
        (assignment) => {
          const baseTask = claudeCoordinator.buildWorkerTask(goal, plan, assignment, undefined, maxMode);
          const apiResearch = scoutApiResearch.get(assignment.label);
          if (!apiResearch) return baseTask;
          return baseTask
            + '\n\n--- External Research Context (from API) ---\n'
            + apiResearch
            + '\n--- End External Research ---\n\n'
            + 'Use the above external research to inform your codebase analysis. '
            + 'Focus on internal code paths, file structure, and risks specific to this project.';
        },
        timeoutMs,
        signal,
      );

      for (const [label, cliOutput] of scoutOutputs) {
        const apiOutput = scoutApiResearch.get(label) || '';
        research.set(label, apiOutput ? `${apiOutput}\n\n---\n\n${cliOutput}` : cliOutput);
      }
      this.log('dispatch', `Scout wave complete: ${scoutAssignments.map((a) => a.label).join(', ')}`);
    } else {
      this.log('dispatch', 'No scouts configured — builders will work without pre-mapping.');
    }

    // ── Phase 2+3: Builder ⇄ Reviewer iteration loop ─────────────────────
    const builderAssignments = plan.assignments.filter((a) => a.role === 'builder');
    const reviewerAssignments = plan.assignments.filter((a) => a.role === 'reviewer');

    if (builderAssignments.length === 0) {
      throw new Error('Coordinator plan has no builder assignments. Cannot proceed.');
    }

    let iteration = 0;
    let approved = false;
    let lastRevisionInstructions = '';

    while (!approved && iteration < maxIterations) {
      if (signal.aborted) throw abortError();
      iteration++;
      const isRevision = iteration > 1;

      // ── Builders ──
      this.status(isRevision ? `Builder Revision ${iteration}` : 'Builders Working');
      if (isRevision) {
        this.log('review', `Revision round ${iteration} — sending builders back with reviewer feedback.`);
      }

      const builderOutputs = await this.runWave(
        builderAssignments,
        (assignment) => {
          if (isRevision && lastRevisionInstructions) {
            const prevOutput = artifacts.get(assignment.label) || '';
            return claudeCoordinator.buildRevisionTask(
              goal, plan, assignment, prevOutput, lastRevisionInstructions, iteration, maxMode,
            );
          }
          const deps = new Map<string, string>();
          for (const depLabel of assignment.dependencies) {
            const output = research.get(depLabel);
            if (output) deps.set(depLabel, output);
          }
          // Builders always get scout research even when dependencies were not
          // declared explicitly in the plan.
          if (deps.size === 0) {
            for (const [label, output] of research) deps.set(label, output);
          }
          return claudeCoordinator.buildWorkerTask(
            goal, plan, assignment, deps.size > 0 ? deps : undefined, maxMode,
          );
        },
        timeoutMs,
        signal,
      );

      for (const [label, output] of builderOutputs) artifacts.set(label, output);
      this.log('dispatch', `Builder wave complete: ${builderAssignments.map((a) => a.label).join(', ')}`);

      if (artifacts.size === 0) {
        throw new Error('All builders failed to produce output. Aborting swarm run.');
      }

      // ── Reviewers ──
      if (reviewerAssignments.length === 0) {
        this.log('review', 'No reviewers configured — marking work as complete.');
        approved = true;
        break;
      }

      if (signal.aborted) throw abortError();
      this.status('Reviewers Evaluating');

      const reviewerContext = new Map<string, string>([...research, ...artifacts]);
      const reviewerOutputs = await this.runWave(
        reviewerAssignments,
        (assignment) => claudeCoordinator.buildWorkerTask(goal, plan, assignment, reviewerContext, maxMode),
        timeoutMs,
        signal,
      );

      for (const [label, output] of reviewerOutputs) reviews.set(label, output);
      this.log('dispatch', `Reviewer wave complete: ${reviewerAssignments.map((a) => a.label).join(', ')}`);

      // ── Verdict ──
      if (signal.aborted) throw abortError();
      this.status('Coordinator Evaluating Review');

      const evaluation = await claudeCoordinator.evaluateReview(goal, reviews, artifacts, coordinatorConfig);
      if (signal.aborted) throw abortError();

      this.log('review', `Coordinator verdict: ${evaluation.verdict} — ${evaluation.summary}`);
      lastRevisionInstructions = evaluation.revisionInstructions;

      if (evaluation.verdict === 'APPROVED') {
        approved = true;
        this.log('review', 'All work approved by coordinator. Swarm complete.');
      } else if (iteration >= maxIterations) {
        this.log('review', `Max review iterations (${maxIterations}) reached. Accepting current state.`);
        approved = true;
      }
    }

    this.agentsChanged();
    return { approved, iterations: iteration, research, artifacts, reviews };
  }
}
