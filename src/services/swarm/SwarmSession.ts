/**
 * SwarmSession — the one live swarm run, kept OUTSIDE React.
 *
 * Previously the run lived in SwarmPanel's effects, so closing the panel, switching
 * workspace, or any dependency change tore down the AgentManager and killed every
 * worker mid-run. Here the session is a module-level store: the panel is just a view
 * (subscribe → render) and can unmount freely while the swarm keeps working.
 */

import { invoke, isPermissionGranted, sendNotification } from '../../platform/native';
import { PROVIDERS, type ProviderID } from '../ai/types';
import { AgentManager, type AgentTransport } from './AgentManager';
import { claudeCoordinator, type CoordinatorConfig, type CoordinatorPlan } from './ClaudeCoordinator';
import { saveSwarmRun, type SwarmHistoryEntry } from './history';
import {
  buildReportMarkdown,
  captureGitSnapshot,
  diffSnapshots,
  type ChangedFile,
  type GitSnapshot,
} from './report';
import { getRole } from './roleDefinitions';
import { SwarmRunner, isAbortError, type SwarmFinalVerdict, type SwarmLogKind, type SwarmPhase } from './SwarmRunner';
import type { Agent, AgentRoleType, WorkerCLI } from './types';
import type { SwarmRoleCounts } from './presets';

export interface SwarmLogEntry {
  id: string;
  kind: SwarmLogKind;
  message: string;
  timestamp: number;
}

export interface SwarmStartConfig {
  goal: string;
  workspacePath: string;
  roleCounts: SwarmRoleCounts;
  workerCLI: WorkerCLI;
  workerCLIName: string;
  workerModel: string;
  coordinatorProvider: ProviderID;
  coordinatorModel: string;
  maxMode: boolean;
  maxReviewIterations: number;
  concurrency: number;
  /** Also pass the saved Anthropic key to `claude` (otherwise it uses its own login). */
  useSavedClaudeKey: boolean;
}

export interface SwarmSnapshot {
  phase: SwarmPhase;
  label: string;
  iteration: number;
  goal: string;
  workspacePath: string;
  workspaceName: string;
  workerCLIName: string;
  plan: CoordinatorPlan | null;
  /** Every attempt of every worker, oldest first. */
  agents: Agent[];
  log: SwarmLogEntry[];
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  verdict: SwarmFinalVerdict | 'stopped' | 'error' | null;
  changes: ChangedFile[];
  reportMarkdown: string | null;
  /** Non-null once the run is finished and recorded. */
  historyId: string | null;
}

const EMPTY: SwarmSnapshot = {
  phase: 'idle',
  label: 'Idle',
  iteration: 0,
  goal: '',
  workspacePath: '',
  workspaceName: '',
  workerCLIName: '',
  plan: null,
  agents: [],
  log: [],
  error: null,
  startedAt: null,
  finishedAt: null,
  verdict: null,
  changes: [],
  reportMarkdown: null,
  historyId: null,
};

const MAX_LOG = 200;
const EMIT_THROTTLE_MS = 120;

export const isRunActive = (phase: SwarmPhase): boolean =>
  phase === 'planning' || phase === 'scouting' || phase === 'building' || phase === 'reviewing' || phase === 'evaluating';

const workspaceNameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() || 'workspace';

const buildRoles = (counts: SwarmRoleCounts): AgentRoleType[] =>
  (['scout', 'builder', 'reviewer'] as const).flatMap((role) => Array.from({ length: counts[role] }, () => role));

/** Env vars for a worker CLI, so its own auth works headlessly. */
async function workerEnvironment(cli: WorkerCLI, useSavedClaudeKey: boolean): Promise<Record<string, string>> {
  const fetchKey = async (provider: ProviderID): Promise<string> => {
    try { return (await invoke<string>('get_api_key', { provider })) || ''; } catch { return ''; }
  };
  const env: Record<string, string> = {};
  if (cli === 'gemini') {
    const key = await fetchKey('gemini');
    if (key) { env.GEMINI_API_KEY = key; env.GOOGLE_API_KEY = key; }
  } else if (cli === 'codex') {
    const key = await fetchKey('chatgpt');
    if (key) env.OPENAI_API_KEY = key;
  } else if (cli === 'claude' && useSavedClaudeKey) {
    const key = await fetchKey('claude');
    if (key) env.ANTHROPIC_API_KEY = key;
  }
  return env;
}

export class SwarmSession {
  private snapshot: SwarmSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private manager: AgentManager | null = null;
  private abort: AbortController | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private runCounter = 0;

  constructor(private transport?: AgentTransport) {}

  // ---- store API (useSyncExternalStore) ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): SwarmSnapshot => this.snapshot;

  isActive(): boolean {
    return isRunActive(this.snapshot.phase);
  }

  private set(patch: Partial<SwarmSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.flush();
  }

  private flush(): void {
    for (const l of this.listeners) {
      try { l(); } catch (err) { console.error('SwarmSession listener error:', err); }
    }
  }

  /** Coalesce bursts of worker output into at most one UI update per throttle window. */
  private scheduleAgentSync(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (this.manager) {
        this.snapshot = { ...this.snapshot, agents: this.manager.getAllAgents().map((a) => ({ ...a })) };
        this.flush();
      }
    }, EMIT_THROTTLE_MS);
  }

  private appendLog(kind: SwarmLogKind, message: string): void {
    const entry: SwarmLogEntry = {
      id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      message,
      timestamp: Date.now(),
    };
    this.set({ log: [...this.snapshot.log, entry].slice(-MAX_LOG) });
  }

  // ---- control ----

  /** Forget a finished run (no-op while one is active). */
  reset(): void {
    if (this.isActive()) return;
    this.manager?.dispose().catch(() => {});
    this.manager = null;
    this.snapshot = EMPTY;
    this.flush();
  }

  /** Stop the current run: abort the loop, then kill every live worker. */
  async stop(): Promise<void> {
    if (!this.isActive()) return;
    this.abort?.abort();
    await this.manager?.terminateAll('Stopped by user');
  }

  async terminateAgent(agentId: string): Promise<void> {
    await this.manager?.terminateAgent(agentId, 'Stopped by user');
  }

  async start(config: SwarmStartConfig): Promise<void> {
    if (this.isActive()) throw new Error('A swarm is already running.');

    const roles = buildRoles(config.roleCounts);
    const runId = `run-${Date.now().toString(36)}-${(this.runCounter++).toString(36)}`;
    const startedAt = Date.now();
    const workspaceName = workspaceNameOf(config.workspacePath);

    // Fresh manager per run so a previous run's listeners/agents can't leak in.
    await this.manager?.dispose().catch(() => {});
    const manager = new AgentManager(config.workspacePath, this.transport);
    manager.setWorkerCLI(config.workerCLI);
    manager.setWorkerModel(config.workerModel);
    manager.setEnvProvider(() => workerEnvironment(config.workerCLI, config.useSavedClaudeKey));
    manager.subscribe(() => this.scheduleAgentSync());
    this.manager = manager;
    const abort = new AbortController();
    this.abort = abort;

    this.snapshot = {
      ...EMPTY,
      phase: 'planning',
      label: 'Coordinator planning',
      goal: config.goal,
      workspacePath: config.workspacePath,
      workspaceName,
      workerCLIName: config.workerCLIName,
      startedAt,
    };
    this.flush();
    this.appendLog('plan', `Planning ${roles.length} work lanes with ${config.workerCLIName}${config.maxMode ? ' · MAX MODE' : ''}.`);

    let plan: CoordinatorPlan | null = null;
    let gitBefore: GitSnapshot | null = null;
    let verdict: SwarmSnapshot['verdict'] = null;
    let iterations = 0;
    let error: string | null = null;

    try {
      await manager.initialize();
      gitBefore = await captureGitSnapshot(config.workspacePath);

      const providerConfig = PROVIDERS.find((p) => p.id === config.coordinatorProvider);
      const coordinatorConfig: CoordinatorConfig = {
        provider: config.coordinatorProvider,
        model: config.coordinatorModel || providerConfig?.models[0] || '',
        apiKey: await claudeCoordinator.getCoordinatorApiKey(config.coordinatorProvider),
      };

      const rawPlan = await claudeCoordinator.createLaunchPlan(
        config.goal, config.workspacePath, roles, coordinatorConfig, config.maxMode,
      );
      if (abort.signal.aborted) throw new DOMException('Swarm stopped by user', 'AbortError');
      plan = rawPlan;
      this.set({ plan });
      this.appendLog('plan', plan.summary);
      if (plan.usedFallback) {
        this.appendLog('error', 'The coordinator reply could not be parsed, so a generic plan is being used.');
      }

      const runner = new SwarmRunner(manager, {
        onLog: (kind, message) => this.appendLog(kind, message),
        onPhase: (phase, label, iteration) => this.set({ phase, label, iteration }),
      });

      const outcome = await runner.run({
        goal: config.goal,
        plan,
        coordinatorConfig,
        maxMode: config.maxMode,
        maxReviewIterations: config.maxReviewIterations,
        concurrency: config.concurrency,
        signal: abort.signal,
      });
      verdict = outcome.verdict;
      iterations = outcome.iterations;
    } catch (err) {
      if (isAbortError(err) || abort.signal.aborted) {
        verdict = 'stopped';
        this.appendLog('dispatch', 'Swarm stopped by user.');
      } else {
        verdict = 'error';
        error = err instanceof Error ? err.message : String(err);
        this.appendLog('error', error);
        // Don't leave workers running after a failed run.
        await manager.terminateAll('Run failed').catch(() => {});
      }
    }

    // ---- finalize ----
    const finishedAt = Date.now();
    const agents = manager.getAllAgents().map((a) => ({ ...a }));
    const changes = diffSnapshots(gitBefore, await captureGitSnapshot(config.workspacePath));
    const reportMarkdown = buildReportMarkdown({
      goal: config.goal,
      workspaceName,
      cli: config.workerCLIName,
      startedAt,
      finishedAt,
      verdict,
      iterations,
      plan,
      agents,
      changes,
      error: error ?? undefined,
    });

    const entry: SwarmHistoryEntry = {
      id: runId,
      goal: config.goal,
      workspacePath: config.workspacePath,
      workspaceName,
      startedAt,
      finishedAt,
      verdict,
      iterations,
      workerCount: new Set(agents.map((a) => a.assignmentId ?? a.id)).size,
      cli: config.workerCLIName,
      changes,
      reportMarkdown,
    };
    saveSwarmRun(entry);

    const label = verdict === 'approved' ? 'Complete'
      : verdict === 'stopped' ? 'Stopped'
      : verdict === 'error' ? 'Failed'
      : verdict === 'max-iterations' ? 'Done — review concerns remain'
      : 'Complete (unreviewed)';

    this.set({
      phase: verdict === 'stopped' ? 'stopped' : verdict === 'error' ? 'error' : 'complete',
      label,
      agents,
      error,
      finishedAt,
      verdict,
      iteration: iterations,
      changes,
      reportMarkdown,
      historyId: runId,
    });
    this.abort = null;

    void this.notifyDone(verdict, workspaceName, changes.length);
  }

  private async notifyDone(verdict: SwarmSnapshot['verdict'], workspaceName: string, changed: number): Promise<void> {
    if (verdict === 'stopped') return;
    try {
      if (typeof document !== 'undefined' && document.hasFocus()) return;
      if (!(await isPermissionGranted())) return;
      await sendNotification({
        title: verdict === 'error' ? 'Swarm failed' : 'Swarm finished',
        body: verdict === 'error'
          ? `${workspaceName}: the run hit an error.`
          : `${workspaceName}: ${changed} file${changed === 1 ? '' : 's'} changed.`,
      });
    } catch {
      /* notifications are best-effort */
    }
  }

  /** Role display helper for views. */
  static roleName(role: AgentRoleType): string {
    return getRole(role).name;
  }
}

export const swarmSession = new SwarmSession();
