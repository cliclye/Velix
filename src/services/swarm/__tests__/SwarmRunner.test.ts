import { describe, expect, it } from 'vitest';
import { SwarmRunner, mapWithConcurrency, type WorkerPool } from '../SwarmRunner';
import type { CoordinatorAssignment, CoordinatorPlan } from '../ClaudeCoordinator';
import type { AgentRunResult, RunTaskOptions } from '../AgentManager';
import type { AgentRole } from '../types';
import { builderReport, reviewVerdict, scoutFindings } from './fakeTransport';

const assignment = (id: string, role: 'scout' | 'builder' | 'reviewer'): CoordinatorAssignment => ({
  id, label: id, role, task: `${role} task`, ownedFiles: [], deliverables: [], dependencies: [], successCriteria: [],
});

const plan = (scouts: number, builders: number, reviewers: number): CoordinatorPlan => ({
  summary: 's', strategy: 'st', coordinatorBrief: 'b',
  assignments: [
    ...Array.from({ length: scouts }, (_, i) => assignment(`scout-${i + 1}`, 'scout')),
    ...Array.from({ length: builders }, (_, i) => assignment(`builder-${i + 1}`, 'builder')),
    ...Array.from({ length: reviewers }, (_, i) => assignment(`reviewer-${i + 1}`, 'reviewer')),
  ],
});

type Handler = (role: AgentRole, task: string, opts: RunTaskOptions) => Partial<AgentRunResult> & { delay?: number };

class FakePool implements WorkerPool {
  calls: Array<{ role: string; label?: string; task: string; attempt?: number }> = [];
  active = 0;
  maxActive = 0;
  constructor(private handler: Handler) {}
  async runTask(role: AgentRole, task: string, opts: RunTaskOptions = {}): Promise<AgentRunResult> {
    this.calls.push({ role: role.type, label: opts.label, task, attempt: opts.attempt });
    this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    const r = this.handler(role, task, opts);
    await new Promise((res) => setTimeout(res, r.delay ?? 1));
    this.active--;
    return { agentId: `a-${this.calls.length}`, status: 'completed', exitCode: 0, output: '', ...r };
  }
}

const fakeCoordinator = (evaluate?: () => { verdict: 'APPROVED' | 'REVISE'; summary: string; revisionInstructions: string }) => ({
  scoutResearch: async () => 'api research',
  buildWorkerTask: (_g: string, _p: CoordinatorPlan, a: CoordinatorAssignment, deps?: Map<string, string>) =>
    `WORK ${a.label}${deps ? ` deps=${[...deps.keys()].join(',')}` : ''}`,
  buildRevisionTask: (_g: string, _p: CoordinatorPlan, a: CoordinatorAssignment, _prev: string, instr: string, n: number) =>
    `REVISE ${a.label} r${n}: ${instr}`,
  evaluateReview: async () => evaluate?.() ?? { verdict: 'APPROVED' as const, summary: 'ok', revisionInstructions: '' },
});

const baseOptions = (p: CoordinatorPlan, signal = new AbortController().signal) => ({
  goal: 'goal', plan: p, coordinatorConfig: { provider: 'claude' as const, model: 'm', apiKey: 'k' },
  maxMode: false, signal,
});

const byRole = (h: { scout?: string; builder?: string; reviewer?: string }): Handler => (role) =>
  ({ output: h[role.type as 'scout' | 'builder' | 'reviewer'] ?? '' });

describe('SwarmRunner', () => {
  it('happy path: scouts → builders → reviewers → approved in one round', async () => {
    const pool = new FakePool(byRole({ scout: scoutFindings(), builder: builderReport(), reviewer: reviewVerdict('APPROVED') }));
    const phases: string[] = [];
    const runner = new SwarmRunner(pool, { onPhase: (p) => phases.push(p) }, fakeCoordinator());
    const out = await runner.run(baseOptions(plan(1, 2, 1)));

    expect(out.verdict).toBe('approved');
    expect(out.approved).toBe(true);
    expect(out.iterations).toBe(1);
    expect(pool.calls.map((c) => c.role)).toEqual(['scout', 'builder', 'builder', 'reviewer']);
    expect(phases).toEqual(['scouting', 'scouting', 'building', 'reviewing', 'evaluating']);
    // Builders always receive scout research as dependencies.
    expect(pool.calls.find((c) => c.label === 'builder-1')!.task).toContain('deps=scout-1');
    expect(out.research.get('scout-1')).toContain('api research');
  });

  it('REVISE sends builders back with the reviewers\' feedback, then approves', async () => {
    let reviewRound = 0;
    const pool = new FakePool((role) => {
      if (role.type === 'reviewer') {
        reviewRound++;
        return { output: reviewRound === 1 ? reviewVerdict('REVISE', 'fix the off-by-one in a.ts') : reviewVerdict('APPROVED') };
      }
      return { output: builderReport() };
    });
    const out = await new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(0, 1, 1)));

    expect(out.verdict).toBe('approved');
    expect(out.iterations).toBe(2);
    const builderCalls = pool.calls.filter((c) => c.role === 'builder');
    expect(builderCalls).toHaveLength(2);
    expect(builderCalls[1].task).toContain('REVISE builder-1 r2');
    expect(builderCalls[1].task).toContain('off-by-one');
    expect(builderCalls.map((c) => c.attempt)).toEqual([1, 2]);
  });

  it('stops after max rounds with verdict max-iterations', async () => {
    const pool = new FakePool((role) => ({ output: role.type === 'reviewer' ? reviewVerdict('REVISE', 'still wrong') : builderReport() }));
    const out = await new SwarmRunner(pool, {}, fakeCoordinator()).run({ ...baseOptions(plan(0, 1, 1)), maxReviewIterations: 2 });
    expect(out.verdict).toBe('max-iterations');
    expect(out.approved).toBe(false);
    expect(out.iterations).toBe(2);
  });

  it('any single REVISE blocks approval even if another reviewer approves', async () => {
    let n = 0;
    const pool = new FakePool((role) => {
      if (role.type !== 'reviewer') return { output: builderReport() };
      return { output: n++ % 2 === 0 ? reviewVerdict('APPROVED') : reviewVerdict('REVISE', 'bad') };
    });
    const out = await new SwarmRunner(pool, {}, fakeCoordinator()).run({ ...baseOptions(plan(0, 1, 2)), maxReviewIterations: 1 });
    expect(out.verdict).toBe('max-iterations');
  });

  it('no reviewers → accepted as unreviewed after one builder wave', async () => {
    const pool = new FakePool(byRole({ builder: builderReport() }));
    const out = await new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(0, 2, 0)));
    expect(out.verdict).toBe('unreviewed');
    expect(out.iterations).toBe(1);
    expect(pool.calls).toHaveLength(2);
  });

  it('reviewers that print no verdict block fall back to the coordinator', async () => {
    const pool = new FakePool(byRole({ builder: builderReport(), reviewer: 'looks good to me' }));
    const out = await new SwarmRunner(pool, {}, fakeCoordinator(() => ({ verdict: 'APPROVED', summary: 'fine', revisionInstructions: '' })))
      .run(baseOptions(plan(0, 1, 1)));
    expect(out.verdict).toBe('approved');
  });

  it('reviewers that produce nothing do NOT trigger pointless rebuilds', async () => {
    const pool = new FakePool((role) => (role.type === 'reviewer' ? { status: 'failed', failureReason: 'crashed', output: '' } : { output: builderReport() }));
    const out = await new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(0, 1, 1)));
    expect(out.verdict).toBe('unreviewed');
    expect(out.iterations).toBe(1);
    expect(out.failedLabels).toContain('reviewer-1');
    expect(pool.calls.filter((c) => c.role === 'builder')).toHaveLength(1);
  });

  it('a failed scout is non-fatal; builders still run', async () => {
    const pool = new FakePool((role) => (role.type === 'scout' ? { status: 'failed', output: '' } : { output: builderReport() }));
    const out = await new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(1, 1, 0)));
    expect(out.verdict).toBe('unreviewed');
    expect(out.failedLabels).toEqual(['scout-1']);
  });

  it('one failed builder among several: continues and reports it', async () => {
    const pool = new FakePool((role, _t, opts) =>
      role.type === 'builder' && opts.label === 'builder-2' ? { status: 'failed', output: '' } : { output: builderReport() });
    const out = await new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(0, 2, 0)));
    expect(out.failedLabels).toEqual(['builder-2']);
    expect(out.artifacts.has('builder-1')).toBe(true);
  });

  it('every builder failing throws a readable error', async () => {
    const pool = new FakePool(() => ({ status: 'failed', output: '' }));
    await expect(new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(0, 2, 1)))).rejects.toThrow(/Every builder failed/);
  });

  it('plans without builders are rejected up front', async () => {
    const pool = new FakePool(() => ({}));
    await expect(new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(1, 0, 1)))).rejects.toThrow(/no builder/);
    expect(pool.calls).toHaveLength(0);
  });

  it('abort between waves throws AbortError and launches nothing further', async () => {
    const abort = new AbortController();
    const pool = new FakePool((role) => {
      if (role.type === 'builder') abort.abort();
      return { output: builderReport() };
    });
    const run = new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(0, 1, 1), abort.signal));
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.calls.some((c) => c.role === 'reviewer')).toBe(false);
  });

  it('already-aborted signal launches nothing', async () => {
    const abort = new AbortController();
    abort.abort();
    const pool = new FakePool(() => ({}));
    await expect(new SwarmRunner(pool, {}, fakeCoordinator()).run(baseOptions(plan(0, 2, 0), abort.signal)))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.calls).toHaveLength(0);
  });

  it('respects the concurrency limit', async () => {
    const pool = new FakePool(() => ({ output: builderReport(), delay: 15 }));
    await new SwarmRunner(pool, {}, fakeCoordinator()).run({ ...baseOptions(plan(0, 9, 0)), concurrency: 3, launchStaggerMs: 0 });
    expect(pool.maxActive).toBeLessThanOrEqual(3);
    expect(pool.maxActive).toBeGreaterThan(1);
    expect(pool.calls).toHaveLength(9);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and caps parallelism', async () => {
    let active = 0; let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5 * (7 - n)));
      active--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBe(2);
  });

  it('handles empty input and limit larger than items', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
    expect(await mapWithConcurrency([1], 10, async (x) => x + 1)).toEqual([2]);
  });
});
