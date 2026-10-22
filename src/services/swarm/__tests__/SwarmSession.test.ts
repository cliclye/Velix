// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({
  gitCalls: 0,
  gitBefore: [] as Array<{ path: string; status: string }>,
  gitAfter: [{ path: 'src/a.ts', status: 'modified' }, { path: 'src/new.ts', status: 'untracked' }],
}));

vi.mock('../../../platform/native', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'get_git_status') {
      nativeState.gitCalls++;
      // 1st call = before the run, later calls = after it.
      return { branch: 'main', files: nativeState.gitCalls === 1 ? nativeState.gitBefore : nativeState.gitAfter };
    }
    if (command === 'get_api_key') return 'test-key';
    throw new Error(`unexpected invoke ${command}`);
  }),
  listen: vi.fn(),
  isPermissionGranted: vi.fn(async () => false),
  sendNotification: vi.fn(),
}));

import { SwarmSession, type SwarmStartConfig } from '../SwarmSession';
import { claudeCoordinator, type CoordinatorPlan } from '../ClaudeCoordinator';
import { loadSwarmHistory } from '../history';
import { FakeTransport, builderReport, claudeStream, reviewVerdict, scoutFindings } from './fakeTransport';

const plan: CoordinatorPlan = {
  summary: 'plan summary',
  strategy: 'strategy',
  coordinatorBrief: 'brief',
  assignments: [
    { id: 'scout', label: 'Scout', role: 'scout', task: 'map', ownedFiles: [], deliverables: [], dependencies: [], successCriteria: [] },
    { id: 'builder-1', label: 'Builder-1', role: 'builder', task: 'build 1', ownedFiles: ['src/a.ts'], deliverables: [], dependencies: ['Scout'], successCriteria: [] },
    { id: 'builder-2', label: 'Builder-2', role: 'builder', task: 'build 2', ownedFiles: ['src/new.ts'], deliverables: [], dependencies: ['Scout'], successCriteria: [] },
    { id: 'reviewer', label: 'Reviewer', role: 'reviewer', task: 'review', ownedFiles: [], deliverables: [], dependencies: [], successCriteria: [] },
  ],
};

const config = (over: Partial<SwarmStartConfig> = {}): SwarmStartConfig => ({
  goal: 'ship it',
  workspacePath: '/tmp/proj',
  roleCounts: { scout: 1, builder: 2, reviewer: 1 },
  workerCLI: 'claude',
  workerCLIName: 'Claude Code',
  workerModel: '',
  coordinatorProvider: 'claude',
  coordinatorModel: '',
  maxMode: false,
  maxReviewIterations: 3,
  concurrency: 6,
  useSavedClaudeKey: false,
  ...over,
});

/** Script every role by inspecting the prompt that reached the "process". */
const scripted = (opts: { reviewRounds?: Array<'APPROVED' | 'REVISE'>; failBuilder?: string } = {}) => {
  let reviewCall = 0;
  return new FakeTransport((req) => {
    const prompt = req.stdin ?? '';
    if (prompt.includes('Role: Scout')) return { stdout: claudeStream(scoutFindings()) };
    if (prompt.includes('Role: Reviewer')) {
      const decision = (opts.reviewRounds ?? ['APPROVED'])[Math.min(reviewCall++, (opts.reviewRounds ?? ['APPROVED']).length - 1)];
      return { stdout: claudeStream(reviewVerdict(decision, decision === 'REVISE' ? 'handle the null case' : '')) };
    }
    if (opts.failBuilder && prompt.includes(opts.failBuilder)) return { stdout: [], stderr: 'boom', exitCode: 1 };
    return { stdout: claudeStream(builderReport()) };
  });
};

beforeEach(() => {
  nativeState.gitCalls = 0;
  window.localStorage.clear();
  vi.spyOn(claudeCoordinator, 'createLaunchPlan').mockResolvedValue(structuredClone(plan));
  vi.spyOn(claudeCoordinator, 'scoutResearch').mockResolvedValue('external research');
  vi.spyOn(claudeCoordinator, 'getCoordinatorApiKey').mockResolvedValue('k');
});

describe('SwarmSession — full run against fake worker processes', () => {
  it('runs scout → builders → reviewer and records an approved run with a report', async () => {
    const transport = scripted();
    const session = new SwarmSession(transport);
    const phases: string[] = [];
    session.subscribe(() => {
      const p = session.getSnapshot().phase;
      if (phases[phases.length - 1] !== p) phases.push(p);
    });

    await session.start(config());
    const snap = session.getSnapshot();

    expect(phases).toEqual(['planning', 'scouting', 'building', 'reviewing', 'evaluating', 'complete']);
    expect(snap.phase).toBe('complete');
    expect(snap.verdict).toBe('approved');
    expect(snap.agents.map((a) => a.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(snap.plan?.summary).toBe('plan summary');
    expect(transport.requests).toHaveLength(4);
    // Everything that went to a worker was passed through stdin, never through a shell.
    expect(transport.requests.every((r) => r.program === 'claude' && typeof r.stdin === 'string')).toBe(true);
    // Scout findings reached the builders.
    const builderPrompt = transport.requests.find((r) => r.stdin!.includes('Role: Builder'))!.stdin!;
    expect(builderPrompt).toContain('external research');
    expect(builderPrompt).toContain('---SCOUT-FINDINGS---');

    // Only files that changed *during* the run are reported.
    expect(snap.changes.map((c) => c.path)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(snap.reportMarkdown).toContain('# Swarm report — proj');
    expect(snap.reportMarkdown).toContain('Approved by reviewers');

    const history = loadSwarmHistory();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(snap.historyId);
    expect(history[0].verdict).toBe('approved');
    expect(transport.liveCount).toBe(0);
  });

  it('REVISE round re-runs builders and the second attempt is marked as attempt 2', async () => {
    const transport = scripted({ reviewRounds: ['REVISE', 'APPROVED'] });
    const session = new SwarmSession(transport);
    await session.start(config());
    const snap = session.getSnapshot();

    expect(snap.verdict).toBe('approved');
    expect(snap.iteration).toBe(2);
    const builders = snap.agents.filter((a) => a.role.type === 'builder');
    expect(builders.map((a) => a.attempt).sort()).toEqual([1, 1, 2, 2]);
    const revision = transport.requests.filter((r) => r.stdin!.includes('REVISION ROUND 2'));
    expect(revision).toHaveLength(2);
    expect(revision[0].stdin).toContain('handle the null case');
  });

  it('a failing builder is surfaced but does not sink the run', async () => {
    const session = new SwarmSession(scripted({ failBuilder: 'Your assigned task: build 2' }));
    await session.start(config());
    const snap = session.getSnapshot();
    expect(snap.phase).toBe('complete');
    const failed = snap.agents.find((a) => a.status === 'failed');
    expect(failed?.label).toBe('Builder-2');
    expect(failed?.failureReason).toContain('boom');
    expect(snap.reportMarkdown).toContain('Builder-2 — failed');
  });

  it('coordinator failure → error phase with the message, nothing spawned', async () => {
    vi.spyOn(claudeCoordinator, 'createLaunchPlan').mockRejectedValue(new Error('401 invalid x-api-key'));
    const transport = scripted();
    const session = new SwarmSession(transport);
    await session.start(config());
    const snap = session.getSnapshot();
    expect(snap.phase).toBe('error');
    expect(snap.error).toContain('invalid x-api-key');
    expect(transport.requests).toHaveLength(0);
    expect(loadSwarmHistory()[0].verdict).toBe('error');
  });

  it('stop() kills live workers, ends as stopped, and leaves no process behind', async () => {
    const transport = new FakeTransport((req) =>
      req.stdin!.includes('Role: Scout') ? { stdout: claudeStream(scoutFindings()) } : { hang: true, stdout: ['working…'] });
    const session = new SwarmSession(transport);
    const run = session.start(config());

    // Wait until the builders are alive.
    await vi.waitFor(() => expect(transport.liveCount).toBe(2), { timeout: 3000 });
    expect(session.isActive()).toBe(true);

    await session.stop();
    await run;
    const snap = session.getSnapshot();
    expect(snap.phase).toBe('stopped');
    expect(snap.verdict).toBe('stopped');
    expect(transport.liveCount).toBe(0);
    expect(snap.agents.filter((a) => a.role.type === 'builder').every((a) => a.status === 'terminated')).toBe(true);
    expect(session.isActive()).toBe(false);
  });

  it('stop() during coordinator planning aborts before any worker starts', async () => {
    let release!: (p: CoordinatorPlan) => void;
    vi.spyOn(claudeCoordinator, 'createLaunchPlan').mockImplementation(() => new Promise((r) => { release = r; }));
    const transport = scripted();
    const session = new SwarmSession(transport);
    const run = session.start(config());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await session.stop();
    release(structuredClone(plan));
    await run;
    expect(session.getSnapshot().phase).toBe('stopped');
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses to start a second run while one is active', async () => {
    const transport = new FakeTransport(() => ({ hang: true }));
    const session = new SwarmSession(transport);
    const run = session.start(config({ roleCounts: { scout: 0, builder: 1, reviewer: 0 } }));
    await vi.waitFor(() => expect(session.isActive()).toBe(true));
    await expect(session.start(config())).rejects.toThrow(/already running/);
    await session.stop();
    await run;
  });

  it('the run survives subscribers coming and going (panel closed and reopened)', async () => {
    const transport = scripted();
    const session = new SwarmSession(transport);
    const unsubscribe = session.subscribe(() => {});
    const run = session.start(config());
    unsubscribe(); // "panel closed" mid-run
    await run;
    expect(session.getSnapshot().verdict).toBe('approved');
  });

  it('reset() clears a finished run but not an active one', async () => {
    const session = new SwarmSession(scripted());
    await session.start(config());
    expect(session.getSnapshot().phase).toBe('complete');
    session.reset();
    expect(session.getSnapshot().phase).toBe('idle');
    expect(session.getSnapshot().agents).toEqual([]);
  });

  it('passes the worker model through to the CLI', async () => {
    const transport = scripted();
    const session = new SwarmSession(transport);
    await session.start(config({ workerModel: 'claude-sonnet-5-5' }));
    expect(transport.requests[0].args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5-5']));
  });

  it('only injects the saved Anthropic key into claude when asked', async () => {
    const off = scripted();
    await new SwarmSession(off).start(config());
    expect(off.requests[0].env).toEqual({});

    const on = scripted();
    await new SwarmSession(on).start(config({ useSavedClaudeKey: true }));
    expect(on.requests[0].env).toEqual({ ANTHROPIC_API_KEY: 'test-key' });
  });
});
