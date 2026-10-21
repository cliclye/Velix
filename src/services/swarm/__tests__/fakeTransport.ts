import type { AgentRunnerEvent, AgentTransport } from '../AgentManager';

export interface FakeScript {
  /** stdout chunks, emitted in order. */
  stdout?: string[];
  stderr?: string;
  exitCode?: number;
  /** ms before exit (default 1). */
  durationMs?: number;
  /** Never exits on its own — only via kill(). */
  hang?: boolean;
  /** spawn() rejects with this message. */
  spawnError?: string;
  timedOut?: boolean;
}

export type ScriptPicker = (request: SpawnRequest) => FakeScript;
export type SpawnRequest = Parameters<AgentTransport['spawn']>[0];

/** Simulates the Rust agent runner: emits output then exactly one exit event per run. */
export class FakeTransport implements AgentTransport {
  requests: SpawnRequest[] = [];
  killed: string[] = [];
  maxConcurrent = 0;
  private live = new Map<string, ReturnType<typeof setTimeout> | null>();
  private handler: ((e: AgentRunnerEvent) => void) | null = null;

  constructor(private pick: ScriptPicker) {}

  async subscribe(handler: (e: AgentRunnerEvent) => void) {
    this.handler = handler;
    return () => { this.handler = null; };
  }

  async spawn(request: SpawnRequest): Promise<void> {
    const script = this.pick(request);
    if (script.spawnError) throw new Error(script.spawnError);
    this.requests.push(request);
    this.live.set(request.runId, null);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.live.size);

    const emit = (e: AgentRunnerEvent) => this.handler?.(e);
    setTimeout(() => {
      if (!this.live.has(request.runId)) return;
      for (const data of script.stdout ?? []) emit({ kind: 'output', run_id: request.runId, stream: 'stdout', data });
      if (script.stderr) emit({ kind: 'output', run_id: request.runId, stream: 'stderr', data: script.stderr });
      if (script.hang) return;
      const timer = setTimeout(() => this.finish(request.runId, {
        exit_code: script.exitCode ?? 0, signal: null, timed_out: script.timedOut ?? false, killed: false,
      }), script.durationMs ?? 1);
      this.live.set(request.runId, timer);
    }, 0);
  }

  private finish(runId: string, partial: { exit_code: number | null; signal: number | null; timed_out: boolean; killed: boolean }) {
    if (!this.live.has(runId)) return;
    const timer = this.live.get(runId);
    if (timer) clearTimeout(timer);
    this.live.delete(runId);
    this.handler?.({ kind: 'exit', run_id: runId, duration_ms: 1, error: null, ...partial });
  }

  async kill(runId: string): Promise<void> {
    this.killed.push(runId);
    setTimeout(() => this.finish(runId, { exit_code: null, signal: 15, timed_out: false, killed: true }), 0);
  }

  async killAll(): Promise<void> {
    for (const id of [...this.live.keys()]) await this.kill(id);
  }

  get liveCount(): number { return this.live.size; }
}

export const builderReport = (note = 'done') =>
  `---BUILDER-REPORT---\n## Task Completed\n${note}\n## Files Modified\n- src/a.ts\n---END-BUILDER-REPORT---`;

export const scoutFindings = () =>
  '---SCOUT-FINDINGS---\n## Relevant Files\n- src/a.ts\n---END-SCOUT-FINDINGS---';

export const reviewVerdict = (decision: 'APPROVED' | 'REVISE', feedback = '') =>
  `---REVIEW-VERDICT---\n## Decision: ${decision}\n\n## Findings\n${feedback || 'none'}\n\n## Revision Instructions\n${feedback || 'None'}\n---END-REVIEW-VERDICT---`;

/** Wrap text the way `claude --output-format stream-json` would. */
export const claudeStream = (finalText: string): string[] => [
  JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model' }) + '\n',
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] } }) + '\n',
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: finalText, total_cost_usd: 0.1 }) + '\n',
];
