/**
 * SwarmRunner — the swarm loop as plain async/await.
 *
 *   coordinator plan (API)
 *     → scout wave     (API research + headless CLI analysis, parallel)
 *     → builder wave   (headless CLI runs, parallel, bounded concurrency)
 *     → reviewer wave  (headless CLI runs, parallel)
 *     → verdict: parsed from the reviewers' ---REVIEW-VERDICT--- blocks
 *                (coordinator API only as a fallback when none is parseable)
 *       APPROVED → done, REVISE → builders re-run with reviewer feedback (max N rounds)
 *
 * Every worker is a Promise from `runTask()` that settles when its process exits.
 * A wave is just `await Promise.all(...)`; there are no event subscriptions, stall
 * checkers, or completion heuristics in this loop.
 */

import { DEFAULT_AGENT_TIMEOUT_MS, MAX_MODE_AGENT_TIMEOUT_MS } from './AgentManager';
import type { AgentRunResult, RunTaskOptions } from './AgentManager';
import {
  claudeCoordinator,
  CoordinatorConfig,
  CoordinatorPlan,
  CoordinatorAssignment,
} from './ClaudeCoordinator';
import { getRole } from './roleDefinitions';
import { parseReviewVerdict } from './handoffOutput';
import type { AgentRole } from './types';

export type SwarmLogKind = 'plan' | 'sync' | 'dispatch' | 'review' | 'error';

export type SwarmPhase =
  | 'idle'
  | 'planning'
  | 'scouting'
  | 'building'
  | 'reviewing'
  | 'evaluating'
  | 'complete'
  | 'stopped'
  | 'error';

/** The slice of AgentManager the runner needs — lets tests inject a fake pool. */
export interface WorkerPool {
  runTask(role: AgentRole, task: string, options?: RunTaskOptions): Promise<AgentRunResult>;
}

export interface SwarmRunnerCallbacks {
  onLog?: (kind: SwarmLogKind, message: string) => void;
  onPhase?: (phase: SwarmPhase, label: string, iteration: number) => void;
}

export interface SwarmRunOptions {
  goal: string;
  plan: CoordinatorPlan;
  coordinatorConfig: CoordinatorConfig;
  maxMode: boolean;
  maxReviewIterations?: number;
  /** Max worker processes alive at once. */
  concurrency?: number;
  /** Minimum gap between worker launches (default 120ms). */
  launchStaggerMs?: number;
  signal: AbortSignal;
}

export type SwarmFinalVerdict =
  | 'approved'            // every reviewer approved
  | 'max-iterations'      // reviewers still wanted changes after the last round
  | 'unreviewed';         // no reviewer verdict was available

export interface SwarmRunOutcome {
  verdict: SwarmFinalVerdict;
  approved: boolean;
  iterations: number;
  research: Map<string, string>;
  artifacts: Map<string, string>;
  reviews: Map<string, string>;
  failedLabels: string[];
}

/** Minimum gap between worker launches, so CLIs don't race on shared auth/config files. */
const DEFAULT_LAUNCH_STAGGER_MS = 120;
export const DEFAULT_CONCURRENCY = 6;

export const abortError = (): DOMException => new DOMException('Swarm stopped by user', 'AbortError');
export const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

/** Run async jobs with at most `limit` in flight, preserving result order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}

export class SwarmRunner {
  constructor(
    private pool: WorkerPool,
    private callbacks: SwarmRunnerCallbacks = {},
    private coordinator: Pick<typeof claudeCoordinator, 'scoutResearch' | 'buildWorkerTask' | 'buildRevisionTask' | 'evaluateReview'> = claudeCoordinator,
  ) {}

  private log(kind: SwarmLogKind, message: string): void {
    this.callbacks.onLog?.(kind, message);
  }

  private phase(phase: SwarmPhase, label: string, iteration: number): void {
    this.callbacks.onPhase?.(phase, label, iteration);
  }

  /**
   * Run one wave. Resolves with outputs keyed by assignment label once every worker
   * process has exited. A failed worker contributes whatever output it produced.
   */
  private async runWave(
    assignments: CoordinatorAssignment[],
    taskFor: (assignment: CoordinatorAssignment) => string,
    opts: { timeoutMs: number; concurrency: number; staggerMs: number; signal: AbortSignal; attempt: number },
  ): Promise<{ outputs: Map<string, string>; failed: string[] }> {
    if (opts.signal.aborted) throw abortError();

    // Shared launch gate: successive launches are at least SPAWN_STAGGER_MS apart, without
    // holding a concurrency lane idle (a per-lane sleep would let one lane drain the queue).
    let nextLaunchAt = Date.now();
    const launchGate = async () => {
      const wait = nextLaunchAt - Date.now();
      nextLaunchAt = Math.max(nextLaunchAt, Date.now()) + opts.staggerMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    };

    const results = await mapWithConcurrency(assignments, opts.concurrency, async (assignment) => {
      await launchGate();
      if (opts.signal.aborted) throw abortError();

      this.log('dispatch', `Launched ${assignment.label}.`);
      const result = await this.pool.runTask(getRole(assignment.role), taskFor(assignment), {
        assignmentId: assignment.id,
        label: assignment.label,
        ownedFiles: assignment.ownedFiles,
        timeoutMs: opts.timeoutMs,
        attempt: opts.attempt,
      });

      if (result.status === 'completed') {
        this.log('dispatch', `${assignment.label} finished.`);
      } else if (result.status === 'failed') {
        this.log('error', `${assignment.label} failed: ${result.failureReason || 'unknown error'}`);
      }
      return { label: assignment.label, result };
    });

    if (opts.signal.aborted) throw abortError();

    const outputs = new Map<string, string>();
    const failed: string[] = [];
    for (const { label, result } of results) {
      if (result.status !== 'completed') failed.push(label);
      if (result.output.trim()) {
        outputs.set(label, result.output);
      } else if (result.status === 'completed') {
        this.log('error', `${label} finished without readable output for the handoff.`);
      }
    }
    return { outputs, failed };
  }

  async run(options: SwarmRunOptions): Promise<SwarmRunOutcome> {
    const { goal, plan, coordinatorConfig, maxMode, signal } = options;
    const maxIterations = Math.max(1, options.maxReviewIterations ?? 3);
    const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    const timeoutMs = maxMode ? MAX_MODE_AGENT_TIMEOUT_MS : DEFAULT_AGENT_TIMEOUT_MS;
    const staggerMs = options.launchStaggerMs ?? DEFAULT_LAUNCH_STAGGER_MS;

    const research = new Map<string, string>();
    const artifacts = new Map<string, string>();
    const reviews = new Map<string, string>();
    const failedLabels = new Set<string>();

    const scoutAssignments = plan.assignments.filter((a) => a.role === 'scout');
    const builderAssignments = plan.assignments.filter((a) => a.role === 'builder');
    const reviewerAssignments = plan.assignments.filter((a) => a.role === 'reviewer');

    if (builderAssignments.length === 0) {
      throw new Error('The plan has no builder assignments, so there is nothing to run.');
    }

    // ── Phase 1: Scouts (API research + CLI codebase analysis) ───────────
    if (scoutAssignments.length > 0) {
      this.phase('scouting', 'Scouts researching', 0);
      const apiResearch = new Map<string, string>();

      await Promise.all(scoutAssignments.map(async (assignment) => {
        try {
          this.log('dispatch', `${assignment.label}: external research via API…`);
          const found = await this.coordinator.scoutResearch(goal, assignment.task, coordinatorConfig, maxMode);
          apiResearch.set(assignment.label, found);
        } catch (err) {
          // Non-fatal: the CLI scout still maps the codebase.
          this.log('error', `${assignment.label} API research skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
      if (signal.aborted) throw abortError();

      this.phase('scouting', 'Scouts mapping the codebase', 0);
      const { outputs, failed } = await this.runWave(
        scoutAssignments,
        (assignment) => {
          const base = this.coordinator.buildWorkerTask(goal, plan, assignment, undefined, maxMode);
          const external = apiResearch.get(assignment.label);
          return external
            ? `${base}\n\n--- External Research Context (from API) ---\n${external}\n--- End External Research ---\n\n`
              + 'Use the external research above to inform your codebase analysis. Focus on internal code paths, file structure, and risks specific to this project.'
            : base;
        },
        { timeoutMs, concurrency, staggerMs, signal, attempt: 1 },
      );
      failed.forEach((l) => failedLabels.add(l));

      for (const assignment of scoutAssignments) {
        const cli = outputs.get(assignment.label) ?? '';
        const api = apiResearch.get(assignment.label) ?? '';
        const merged = [api, cli].filter(Boolean).join('\n\n---\n\n');
        if (merged) research.set(assignment.label, merged);
      }
    } else {
      this.log('dispatch', 'No scouts configured — builders will work without pre-mapping.');
    }

    // ── Phase 2+3: Builder ⇄ Reviewer loop ───────────────────────────────
    let iteration = 0;
    let verdict: SwarmFinalVerdict = 'unreviewed';
    let revisionInstructions = '';

    while (iteration < maxIterations) {
      if (signal.aborted) throw abortError();
      iteration++;
      const isRevision = iteration > 1;

      this.phase('building', isRevision ? `Builders revising (round ${iteration})` : 'Builders working', iteration);
      if (isRevision) {
        this.log('review', `Revision round ${iteration}: builders get the reviewers' feedback.`);
      }

      const { outputs: builderOutputs, failed: failedBuilders } = await this.runWave(
        builderAssignments,
        (assignment) => {
          if (isRevision && revisionInstructions) {
            return this.coordinator.buildRevisionTask(
              goal, plan, assignment, artifacts.get(assignment.label) ?? '', revisionInstructions, iteration, maxMode,
            );
          }
          const deps = new Map<string, string>();
          for (const depLabel of assignment.dependencies) {
            const out = research.get(depLabel);
            if (out) deps.set(depLabel, out);
          }
          // Builders always get scout research even if the plan didn't declare it.
          if (deps.size === 0) for (const [label, out] of research) deps.set(label, out);
          return this.coordinator.buildWorkerTask(goal, plan, assignment, deps.size > 0 ? deps : undefined, maxMode);
        },
        { timeoutMs, concurrency, staggerMs, signal, attempt: iteration },
      );

      failedBuilders.forEach((l) => failedLabels.add(l));
      for (const [label, out] of builderOutputs) artifacts.set(label, out);
      for (const l of builderAssignments.map((a) => a.label)) {
        if (!failedBuilders.includes(l)) failedLabels.delete(l); // recovered on retry
      }

      if (failedBuilders.length === builderAssignments.length) {
        throw new Error(`Every builder failed. First error is in the log — ${failedBuilders.join(', ')}.`);
      }
      this.log('dispatch', `Builder wave ${iteration} complete.`);

      if (reviewerAssignments.length === 0) {
        this.log('review', 'No reviewers configured — accepting builder work as-is.');
        verdict = 'unreviewed';
        break;
      }

      // ── Reviewers ──
      if (signal.aborted) throw abortError();
      this.phase('reviewing', 'Reviewers inspecting the changes', iteration);
      reviews.clear();

      const reviewerContext = new Map<string, string>([...research, ...artifacts]);
      const { outputs: reviewerOutputs, failed: failedReviewers } = await this.runWave(
        reviewerAssignments,
        (assignment) => this.coordinator.buildWorkerTask(goal, plan, assignment, reviewerContext, maxMode),
        { timeoutMs, concurrency, staggerMs, signal, attempt: iteration },
      );
      failedReviewers.forEach((l) => failedLabels.add(l));
      for (const [label, out] of reviewerOutputs) reviews.set(label, out);

      // ── Verdict ──
      if (signal.aborted) throw abortError();
      this.phase('evaluating', 'Evaluating review', iteration);

      const parsed = [...reviews.entries()].map(([label, out]) => ({ label, ...parseReviewVerdict(out) }));
      const decided = parsed.filter((p) => p.decision !== null);

      let approved: boolean | null = null;
      let feedback = '';

      if (decided.length > 0) {
        approved = decided.every((p) => p.decision === 'APPROVED');
        feedback = decided
          .filter((p) => p.decision === 'REVISE')
          .map((p) => `## ${p.label}\n${p.feedback}`)
          .join('\n\n');
        this.log('review', approved
          ? `All ${decided.length} reviewer(s) approved.`
          : `${decided.filter((p) => p.decision === 'REVISE').length} of ${decided.length} reviewer(s) requested changes.`);
      } else if (reviews.size > 0) {
        // Reviewers answered but without a parseable verdict: ask the coordinator.
        try {
          const evaluation = await this.coordinator.evaluateReview(goal, reviews, artifacts, coordinatorConfig);
          approved = evaluation.verdict === 'APPROVED';
          feedback = evaluation.revisionInstructions;
          this.log('review', `Coordinator verdict: ${evaluation.verdict} — ${evaluation.summary}`);
        } catch (err) {
          this.log('error', `Could not evaluate the review: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        this.log('error', 'Reviewers produced no output — accepting builder work unreviewed.');
      }
      if (signal.aborted) throw abortError();

      if (approved === null) { verdict = 'unreviewed'; break; }
      if (approved) { verdict = 'approved'; break; }

      verdict = 'max-iterations';
      revisionInstructions = feedback || 'Reviewers requested changes but gave no details. Re-check the work against the goal.';
      if (iteration >= maxIterations) {
        this.log('review', `Reached the ${maxIterations}-round limit. Keeping the current state.`);
      }
    }

    return {
      verdict,
      approved: verdict === 'approved',
      iterations: iteration,
      research,
      artifacts,
      reviews,
      failedLabels: [...failedLabels],
    };
  }
}
