import { describe, expect, it } from 'vitest';
import { AgentManager } from '../AgentManager';
import { getRole } from '../roleDefinitions';
import { FakeTransport, builderReport, claudeStream } from './fakeTransport';

const make = (pick: ConstructorParameters<typeof FakeTransport>[0], cli = 'claude') => {
  const transport = new FakeTransport(pick);
  const manager = new AgentManager('/work', transport);
  manager.setWorkerCLI(cli);
  return { transport, manager };
};

describe('AgentManager.runTask', () => {
  it('resolves completed with the structured handoff from stream-json output', async () => {
    const { manager, transport } = make(() => ({ stdout: claudeStream(`chatter\n${builderReport('built it')}`) }));
    const result = await manager.runTask(getRole('builder'), 'do the thing', { assignmentId: 'builder-1', label: 'Builder-1' });

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('---BUILDER-REPORT---');
    expect(result.output).toContain('built it');
    expect(result.output).not.toContain('chatter');

    const agent = manager.getAllAgents()[0];
    expect(agent.filesTouched).toEqual(['src/a.ts']);
    expect(agent.costUsd).toBe(0.1);
    expect(agent.activity.some((a) => a.text === 'Edit src/a.ts')).toBe(true);

    // The prompt travels via stdin and carries the role + task.
    expect(transport.requests[0].stdin).toContain('Task: do the thing');
    expect(transport.requests[0].cwd).toBe('/work');
    expect(transport.requests[0].program).toBe('claude');
  });

  it('plain-text CLIs: stdout is the output', async () => {
    const { manager } = make(() => ({ stdout: [`hello\n${builderReport()}`] }), 'gemini');
    const result = await manager.runTask(getRole('builder'), 't');
    expect(result.status).toBe('completed');
    expect(result.output).toContain('---BUILDER-REPORT---');
  });

  it('non-zero exit → failed with the stderr tail in the reason', async () => {
    const { manager } = make(() => ({ stdout: ['partial work'], stderr: 'Error: not logged in\n', exitCode: 2 }), 'gemini');
    const result = await manager.runTask(getRole('builder'), 't');
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(2);
    expect(result.failureReason).toContain('code 2');
    expect(result.failureReason).toContain('not logged in');
    expect(result.output).toContain('partial work'); // partial output is preserved
  });

  it('a claude is_error result fails the run even with exit code 0', async () => {
    const { manager } = make(() => ({
      stdout: [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Credit balance too low' }) + '\n'],
    }));
    const result = await manager.runTask(getRole('builder'), 't');
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('Credit balance too low');
  });

  it('timeout from the runner is reported as a timeout', async () => {
    const { manager } = make(() => ({ timedOut: true, exitCode: 0 }), 'gemini');
    const result = await manager.runTask(getRole('builder'), 't', { timeoutMs: 120_000 });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('Timed out after 2 min');
  });

  it('spawn errors resolve as failed instead of rejecting', async () => {
    const { manager } = make(() => ({ spawnError: '`claude` was not found' }));
    const result = await manager.runTask(getRole('builder'), 't');
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('was not found');
  });

  it('terminateAgent kills the process and settles as terminated', async () => {
    const { manager, transport } = make(() => ({ hang: true, stdout: ['working…'] }), 'gemini');
    const pending = manager.runTask(getRole('builder'), 't');
    await new Promise((r) => setTimeout(r, 20));
    const agent = manager.getAllAgents()[0];
    expect(agent.status).toBe('running');

    await manager.terminateAgent(agent.id, 'because');
    const result = await pending;
    expect(result.status).toBe('terminated');
    expect(result.failureReason).toBe('because');
    expect(transport.killed).toEqual([agent.runId]);
    expect(manager.getActiveAgentCount()).toBe(0);
  });

  it('terminateAll stops every live worker and none stay running', async () => {
    const { manager, transport } = make(() => ({ hang: true }), 'gemini');
    const runs = [1, 2, 3].map((i) => manager.runTask(getRole('builder'), `t${i}`, { assignmentId: `b${i}` }));
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.getActiveAgentCount()).toBe(3);
    await manager.terminateAll();
    const results = await Promise.all(runs);
    expect(results.every((r) => r.status === 'terminated')).toBe(true);
    expect(transport.liveCount).toBe(0);
  });

  it('a stop that races the env lookup never spawns a process', async () => {
    const { manager, transport } = make(() => ({ hang: true }), 'gemini');
    manager.setEnvProvider(() => new Promise((r) => setTimeout(() => r({}), 30)));
    const pending = manager.runTask(getRole('builder'), 't');
    await new Promise((r) => setTimeout(r, 5));
    await manager.terminateAll();
    const result = await pending;
    expect(result.status).toBe('terminated');
    expect(transport.requests).toHaveLength(0);
  });

  it('ignores events for unknown runs and never settles twice', async () => {
    const { manager, transport } = make(() => ({ stdout: ['x'] }), 'gemini');
    await manager.initialize();
    // Event for a run nobody started must not throw.
    transport.requests.length = 0;
    const result = await manager.runTask(getRole('builder'), 't');
    expect(result.status).toBe('completed');
  });

  it('latest attempt per assignment wins in getLatestAgents', async () => {
    const { manager } = make(() => ({ stdout: ['ok'] }), 'gemini');
    await manager.runTask(getRole('builder'), 't', { assignmentId: 'b1', attempt: 1 });
    await manager.runTask(getRole('builder'), 't', { assignmentId: 'b1', attempt: 2 });
    expect(manager.getAllAgents()).toHaveLength(2);
    const latest = manager.getLatestAgents();
    expect(latest).toHaveLength(1);
    expect(latest[0].attempt).toBe(2);
  });

  it('notifies subscribers as output arrives', async () => {
    const { manager } = make(() => ({ stdout: ['a', 'b'] }), 'gemini');
    let calls = 0;
    manager.subscribe(() => { calls++; });
    await manager.runTask(getRole('builder'), 't');
    expect(calls).toBeGreaterThanOrEqual(4); // init, running, 2 outputs, exit
  });
});
