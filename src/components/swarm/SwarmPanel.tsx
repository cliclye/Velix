import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  AgentManager,
  SwarmEventEmitter,
  getRole,
  claudeCoordinator,
  getWorkerCLIOptions,
  detectWorkerCLIAvailability,
} from '../../services/swarm';
import { CoordinatorConfig } from '../../services/swarm/ClaudeCoordinator';
import { Agent, AgentRoleType, AgentStatus, WorkerCLI } from '../../services/swarm/types';
import { PROVIDERS, ProviderID } from '../../services/ai/types';
import { AgentTerminal } from './AgentTerminal';
import { SwarmPtyTerminal } from './SwarmPtyTerminal';
import {
  SwarmMindMap,
  MindMapConnection,
  MindMapNode,
  MindMapPosition,
  buildDefaultMindMapPosition,
} from './SwarmMindMap';
import './SwarmPanel.css';

interface SwarmPanelProps {
  isOpen: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  workspacePath: string;
  hasApiKey: boolean;
  apiProvider?: string;
  onWriteToTerminal?: (data: string) => void;
}

interface CoordinatorLogEntry {
  id: string;
  kind: 'plan' | 'sync' | 'dispatch' | 'review' | 'error';
  message: string;
  timestamp: number;
}

type SwarmPlan = Awaited<ReturnType<typeof claudeCoordinator.createLaunchPlan>>;
type SwarmAssignment = SwarmPlan['assignments'][number];
type SwarmLaunchRole = Extract<AgentRoleType, 'scout' | 'builder' | 'reviewer'>;
type RoleCounts = Record<SwarmLaunchRole, number>;
type BoardStatusTone = 'queued' | 'mapping' | 'building' | 'review' | 'done' | 'blocked';
type WorkerCLIAvailability = Record<WorkerCLI, { available: boolean; detail: string }>;

const MIN_AGENTS = 2;
const MAX_AGENTS = 25;
const MAX_REVIEW_ITERATIONS = 3;
const MAX_MODE_STORAGE_KEY = 'velix-swarm-max-mode';
const WORKER_CLI_STORAGE_KEY = 'velix-swarm-worker-cli';
const COORDINATOR_PROVIDER_STORAGE_KEY = 'velix-swarm-coordinator-provider';
const COORDINATOR_MODEL_STORAGE_KEY = 'velix-swarm-coordinator-model';
const ROLE_ORDER: SwarmLaunchRole[] = ['scout', 'builder', 'reviewer'];
const DEFAULT_ROLE_COUNTS: RoleCounts = {
  scout: 1,
  builder: 2,
  reviewer: 1,
};
const ROLE_LIMITS: Record<SwarmLaunchRole, { min: number; max: number }> = {
  scout: { min: 0, max: 5 },
  builder: { min: 1, max: 20 },
  reviewer: { min: 0, max: 5 },
};
const ROLE_COPY: Record<SwarmLaunchRole, { caption: string; hint: string }> = {
  scout: {
    caption: 'Codebase intelligence specialist',
    hint: 'Maps the repo, surfaces risks, and sets clean ownership before builders spread out.',
  },
  builder: {
    caption: 'Senior software engineer',
    hint: 'Owns one implementation slice end-to-end and ships inside assigned files.',
  },
  reviewer: {
    caption: 'Principal engineer quality gate',
    hint: 'Reviews completed slices, catches regressions, and blocks weak work from shipping.',
  },
};
const OPERATING_MODEL = [
  'Every worker starts with full context from the coordinator.',
  'Assignments carry explicit file ownership to avoid collisions.',
  'Status updates stay terse and operational.',
  'Review gates and escalation keep the swarm from drifting.',
];
const PALETTE_ROLE_COLORS: Record<SwarmLaunchRole, string> = {
  scout: 'var(--text-muted)',
  builder: 'var(--text-primary)',
  reviewer: 'var(--text-secondary)',
};
const PALETTE_DRAG_KEY = 'smm-role';
const FINISHED_STATUSES = new Set<AgentStatus>(['completed', 'failed', 'terminated']);
const WORK_SUMMARY_FALLBACK: Record<SwarmLaunchRole, string> = {
  scout: 'Map code paths',
  builder: 'Ship owned slice',
  reviewer: 'Review build output',
};
const WORK_SUMMARY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'before',
  'for',
  'from',
  'inside',
  'its',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'with',
  'your',
]);

const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const trimCoordinatorLog = (entries: CoordinatorLogEntry[]) => entries.slice(-12);

const buildDefaultWorkerCLIAvailability = (): WorkerCLIAvailability =>
  Object.fromEntries(
    getWorkerCLIOptions().map((option) => [
      option.id,
      { available: false, detail: 'Checking availability…' },
    ]),
  ) as WorkerCLIAvailability;

const buildRolesToLaunch = (roleCounts: RoleCounts): SwarmLaunchRole[] =>
  ROLE_ORDER.flatMap((role) => Array.from({ length: roleCounts[role] }, () => role));

const buildAssignmentLabel = (
  role: SwarmLaunchRole,
  occurrence: number,
  totalForRole: number,
): string => {
  const baseLabel = getRole(role).name;
  return totalForRole > 1 ? `${baseLabel}-${occurrence}` : baseLabel;
};

const buildPreviewAssignments = (roles: SwarmLaunchRole[]): SwarmAssignment[] => {
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
      role === 'scout'
        ? 'Map the relevant code paths, identify risks, and recommend ownership boundaries.'
        : role === 'reviewer'
          ? 'Review completed builder slices and gate release quality before the swarm marks work done.'
          : `Ship the ${label.toLowerCase()} slice inside its assigned ownership boundary.`;

    return {
      id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      label,
      role,
      task: previewTask,
      ownedFiles: [],
      deliverables: [],
      dependencies:
        role === 'builder'
          ? (totals.scout ? [buildAssignmentLabel('scout', 1, totals.scout || 1)] : [])
          : role === 'reviewer'
            ? roles
                .filter((candidate) => candidate === 'builder')
                .map((_candidate, index) => buildAssignmentLabel('builder', index + 1, totals.builder || 1))
            : [],
      successCriteria: [],
    };
  });
};

const getWorkspaceName = (workspacePath: string): string => {
  const parts = workspacePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
};

const getAssignmentState = (
  assignment: SwarmAssignment,
  agent: Agent | undefined,
): { label: string; tone: BoardStatusTone } => {
  if (!agent) {
    return { label: 'QUEUED', tone: 'queued' };
  }

  if (agent.status === 'initializing') {
    return { label: 'STARTING', tone: 'queued' };
  }

  if (agent.status === 'completed') {
    return { label: 'DONE', tone: 'done' };
  }

  if (agent.status === 'failed') {
    return { label: 'FAILED', tone: 'blocked' };
  }

  if (agent.status === 'terminated') {
    return { label: 'STOPPED', tone: 'blocked' };
  }

  if (agent.status === 'waiting_for_input' || agent.status === 'waiting_for_approval') {
    return { label: 'BLOCKED', tone: 'blocked' };
  }

  if (assignment.role === 'reviewer') {
    return { label: 'REVIEW', tone: 'review' };
  }

  if (assignment.role === 'scout') {
    return { label: 'MAPPING', tone: 'mapping' };
  }

  return { label: 'BUILDING', tone: 'building' };
};

const normalizeMindMapId = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const formatSummaryWord = (value: string): string =>
  value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

const buildWorkSummary = (value: string | undefined, role: SwarmLaunchRole): string => {
  const tokens = (value || '')
    .replace(/your assigned task:/gi, ' ')
    .replace(/[^a-z0-9\s/-]/gi, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !/^\d+$/.test(token));

  const filtered = tokens.filter((token) => !WORK_SUMMARY_STOP_WORDS.has(token.toLowerCase()));
  const chosen = (filtered.length >= 3 ? filtered : tokens)
    .slice(0, 3)
    .map(formatSummaryWord);

  return chosen.length > 0 ? chosen.join(' ') : WORK_SUMMARY_FALLBACK[role];
};

const dedupeMindMapConnections = (connections: MindMapConnection[]): MindMapConnection[] => {
  const uniqueConnections = new Map<string, MindMapConnection>();

  for (const connection of connections) {
    if (!connection.from || !connection.to || connection.from === connection.to) continue;

    const key = `${connection.from}->${connection.to}`;
    const existing = uniqueConnections.get(key);
    if (!existing || connection.kind === 'manual') {
      uniqueConnections.set(key, connection);
    }
  }

  return Array.from(uniqueConnections.values());
};

const applyManualConnectionsToAssignments = (
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
        new Set([
          ...assignment.dependencies,
          ...manualDependencies,
        ]),
      ).filter((dependency) => normalizeMindMapId(dependency) !== normalizeMindMapId(assignment.label)),
    };
  });
};

const buildAutomaticMindMapConnections = (assignments: SwarmAssignment[]): MindMapConnection[] => {
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
          ? [{ from: sourceId, to: assignment.id, kind: 'automatic' as const }]
          : [];
      }),
    ),
  );
};

export const SwarmPanel: React.FC<SwarmPanelProps> = ({
  isOpen,
  onClose,
  theme,
  workspacePath,
}) => {
  const managerRef = useRef<AgentManager | null>(null);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Prevents overlapping coordinator syncs when the 45s interval fires with a stale `isSyncing` closure. */
  const coordinatorSyncInFlightRef = useRef(false);
  /** Abort controller for the current swarm run — allows mid-flight cancellation. */
  const swarmAbortRef = useRef<AbortController | null>(null);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [goal, setGoal] = useState('');
  const [activeGoal, setActiveGoal] = useState('');
  const [roleCounts, setRoleCounts] = useState<RoleCounts>(DEFAULT_ROLE_COUNTS);
  const [workerCLI, setWorkerCLI] = useState<WorkerCLI>(() => {
    if (typeof window === 'undefined') return 'claude';
    const stored = window.localStorage.getItem(WORKER_CLI_STORAGE_KEY);
    return getWorkerCLIOptions().some((option) => option.id === stored)
      ? (stored as WorkerCLI)
      : 'claude';
  });
  const [coordinatorProvider, setCoordinatorProvider] = useState<ProviderID>(() => {
    if (typeof window === 'undefined') return 'claude';
    const stored = window.localStorage.getItem(COORDINATOR_PROVIDER_STORAGE_KEY);
    return PROVIDERS.some((p) => p.id === stored) ? (stored as ProviderID) : 'claude';
  });
  const [coordinatorModel, setCoordinatorModel] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(COORDINATOR_MODEL_STORAGE_KEY) || '';
  });
  const [workerCLIAvailability, setWorkerCLIAvailability] = useState<WorkerCLIAvailability>(
    buildDefaultWorkerCLIAvailability,
  );
  const [isCheckingWorkerCLI, setIsCheckingWorkerCLI] = useState(false);
  /** PTY event listeners registered — avoids launching before AgentManager can receive output. */
  const [swarmPtyReady, setSwarmPtyReady] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [hasCoordinatorKey, setHasCoordinatorKey] = useState(false);
  const [requirementsLoaded, setRequirementsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState('Idle');
  const [coordinatorPlan, setCoordinatorPlan] = useState<SwarmPlan | null>(null);
  const [lastSync, setLastSync] = useState<Awaited<ReturnType<typeof claudeCoordinator.createSyncResult>> | null>(null);
  const [coordinatorLog, setCoordinatorLog] = useState<CoordinatorLogEntry[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentChatMsg, setAgentChatMsg] = useState('');
  const [showAgentTerminal, setShowAgentTerminal] = useState(false);
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [nodePositions, setNodePositions] = useState<Record<string, MindMapPosition>>({});
  const [maxMode, setMaxMode] = useState(() => {
    try { return window.localStorage.getItem(MAX_MODE_STORAGE_KEY) === 'true'; } catch { return false; }
  });
  const [manualConnections, setManualConnections] = useState<MindMapConnection[]>([]);
  const pendingDroppedNodesRef = useRef<Array<{ role: SwarmLaunchRole; position: MindMapPosition }>>([]);
  const previousBoardAssignmentIdsRef = useRef<string[]>([]);

  const appendLog = useCallback((kind: CoordinatorLogEntry['kind'], message: string) => {
    setCoordinatorLog((prev) =>
      trimCoordinatorLog([
        ...prev,
        {
          id: `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind,
          message,
          timestamp: Date.now(),
        },
      ]),
    );
  }, []);

  const refreshAgents = useCallback(() => {
    const manager = managerRef.current;
    if (!manager) return;
    setAgents([...manager.getAllAgents()]);
  }, []);

  const stopAutoSync = useCallback(() => {
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    setRequirementsLoaded(false);

    claudeCoordinator.hasCoordinatorKey(coordinatorProvider)
      .then((ready) => {
        if (!isMounted) return;
        setHasCoordinatorKey(ready);
        setRequirementsLoaded(true);
      })
      .catch(() => {
        if (!isMounted) return;
        setHasCoordinatorKey(false);
        setRequirementsLoaded(true);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, coordinatorProvider]);

  // Persist coordinator provider/model to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(COORDINATOR_PROVIDER_STORAGE_KEY, coordinatorProvider);
    }
  }, [coordinatorProvider]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(COORDINATOR_MODEL_STORAGE_KEY, coordinatorModel);
    }
  }, [coordinatorModel]);

  useEffect(() => {
    if (!isOpen || !workspacePath) {
      setSwarmPtyReady(false);
      return;
    }

    const manager = new AgentManager(new SwarmEventEmitter(), workspacePath);
    manager.setWorkerCLI(workerCLI);
    managerRef.current = manager;

    let disposed = false;
    setSwarmPtyReady(false);

    manager.initialize()
      .then(() => {
        if (!disposed) {
          setSwarmPtyReady(true);
          refreshAgents();
        }
      })
      .catch((err) => {
        if (!disposed) {
          setSwarmPtyReady(false);
          setError(`Failed to initialize swarm worker manager: ${err}`);
        }
      });

    const unsubscribeOutput = manager.onAgentOutput(() => {
      if (!disposed) {
        refreshAgents();
      }
    });

    const unsubscribeExit = manager.onAgentExit(() => {
      if (!disposed) {
        refreshAgents();
      }
    });

    const unsubscribeSpawn = manager.onAgentSpawned(() => {
      if (!disposed) {
        refreshAgents();
      }
    });

    return () => {
      disposed = true;
      setSwarmPtyReady(false);
      stopAutoSync();
      void manager.terminateAll('Swarm panel closed').catch(() => {});
      void manager.cleanup();
      unsubscribeOutput();
      unsubscribeExit();
      unsubscribeSpawn();
      managerRef.current = null;
    };
  }, [isOpen, refreshAgents, stopAutoSync, workspacePath]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(WORKER_CLI_STORAGE_KEY, workerCLI);
    }
    managerRef.current?.setWorkerCLI(workerCLI);
  }, [workerCLI]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MAX_MODE_STORAGE_KEY, String(maxMode));
    }
  }, [maxMode]);

  useEffect(() => {
    if (!isOpen || !workspacePath) return;

    let cancelled = false;
    setIsCheckingWorkerCLI(true);
    setWorkerCLIAvailability(buildDefaultWorkerCLIAvailability());

    detectWorkerCLIAvailability(workspacePath)
      .then((availability) => {
        if (!cancelled) {
          setWorkerCLIAvailability(availability);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkerCLIAvailability(buildDefaultWorkerCLIAvailability());
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsCheckingWorkerCLI(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, workspacePath]);

  const handleCoordinatorSync = useCallback(async (reason: 'manual' | 'automatic' = 'manual') => {
    const manager = managerRef.current;
    if (!manager || !activeGoal || !coordinatorPlan || coordinatorSyncInFlightRef.current) return;

    const snapshot = manager.getAllAgents();
    if (snapshot.length === 0) return;

    coordinatorSyncInFlightRef.current = true;

    const syncPlan = {
      ...coordinatorPlan,
      assignments: applyManualConnectionsToAssignments(coordinatorPlan.assignments, manualConnections),
    };

    setIsSyncing(true);
    setStatusLabel(reason === 'manual' ? 'Coordinator Syncing' : 'Coordinator Monitoring');
    appendLog(
      'sync',
      reason === 'manual'
        ? 'Coordinator running a manual sync round.'
        : 'Coordinator running an automatic sync round.',
    );

    try {
      const selectedProviderConfig = PROVIDERS.find((p) => p.id === coordinatorProvider);
      const effectiveModel = coordinatorModel || selectedProviderConfig?.models[0] || '';
      const apiKey = await claudeCoordinator.getCoordinatorApiKey(coordinatorProvider);
      const coordinatorConfig: CoordinatorConfig = { provider: coordinatorProvider, model: effectiveModel, apiKey };

      const syncResult = await claudeCoordinator.createSyncResult(
        activeGoal,
        workspacePath,
        syncPlan,
        snapshot,
        coordinatorConfig,
      );

      setLastSync(syncResult);
      appendLog('sync', syncResult.summary);

      for (const action of syncResult.actions) {
        const target = snapshot.find(
          (agent) =>
            agent.assignmentId === action.assignmentId && !FINISHED_STATUSES.has(agent.status),
        );
        if (!target) continue;

        await manager.sendToAgent(
          target.id,
          `\nCoordinator update:\n${action.message}\r`,
        );
        appendLog('dispatch', `Sent coordinator follow-up to ${target.label || target.role.name}.`);
      }

      refreshAgents();
      setStatusLabel(syncResult.overallStatus === 'blocked' ? 'Blocked' : 'Running');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Coordinator sync failed: ${message}`);
      appendLog('error', `Coordinator sync failed: ${message}`);
      setStatusLabel('Sync Error');
    } finally {
      coordinatorSyncInFlightRef.current = false;
      setIsSyncing(false);
    }
  }, [activeGoal, appendLog, coordinatorModel, coordinatorPlan, coordinatorProvider, manualConnections, refreshAgents, workspacePath]);

  useEffect(() => {
    stopAutoSync();

    if (!activeGoal || !coordinatorPlan) return;

    syncIntervalRef.current = setInterval(() => {
      const manager = managerRef.current;
      if (!manager || isLaunching || coordinatorSyncInFlightRef.current) return;

      const hasLiveAgents = manager.getAllAgents().some((agent) => !FINISHED_STATUSES.has(agent.status));
      if (!hasLiveAgents) return;

      void handleCoordinatorSync('automatic');
    }, 45000);

    return stopAutoSync;
  }, [activeGoal, coordinatorPlan, handleCoordinatorSync, isLaunching, stopAutoSync]);

  const handleCoordinatorProviderChange = useCallback((provider: ProviderID) => {
    setCoordinatorProvider(provider);
    // Reset model to first available for new provider
    const firstModel = PROVIDERS.find((p) => p.id === provider)?.models[0] ?? '';
    setCoordinatorModel(firstModel);
  }, []);

  const adjustRoleCount = useCallback((role: SwarmLaunchRole, delta: number) => {
    setRoleCounts((prev) => {
      const limits = ROLE_LIMITS[role];
      const nextValue = Math.max(limits.min, Math.min(limits.max, prev[role] + delta));
      if (nextValue === prev[role]) return prev;

      const proposed = { ...prev, [role]: nextValue };
      const totalWorkers = buildRolesToLaunch(proposed).length;
      if (totalWorkers > MAX_AGENTS) {
        return prev;
      }

      return proposed;
    });
  }, []);

  const handleLaunch = useCallback(async () => {
    const manager = managerRef.current;
    const trimmedGoal = goal.trim();
    const rolesToLaunch = buildRolesToLaunch(roleCounts);

    if (!manager || isLaunching) return;
    if (!workspacePath) {
      setError('Open a project before launching a swarm.');
      return;
    }

    try {
      await manager.initialize();
    } catch (initErr) {
      const msg = initErr instanceof Error ? initErr.message : String(initErr);
      setError(`Swarm PTY layer is not ready: ${msg}`);
      return;
    }
    if (!hasCoordinatorKey) {
      const providerName = PROVIDERS.find((p) => p.id === coordinatorProvider)?.name || coordinatorProvider;
      setError(`Swarm coordinator requires a ${providerName} API key in Settings.`);
      return;
    }
    if (!trimmedGoal) {
      setError('Describe the goal for the coordinator first.');
      return;
    }
    if (rolesToLaunch.length < MIN_AGENTS) {
      setError(`Launch at least ${MIN_AGENTS} workers so the coordinator can split work meaningfully.`);
      return;
    }
    if (!workerCLIAvailability[workerCLI]?.available) {
      setError(`${getWorkerCLIOptions().find((option) => option.id === workerCLI)?.name || 'Selected CLI'} is not available on PATH.`);
      return;
    }

    // Abort any previous run and create a new controller for this one
    swarmAbortRef.current?.abort();
    const abort = new AbortController();
    swarmAbortRef.current = abort;

    setIsLaunching(true);
    setError(null);
    setStatusLabel('Coordinator Planning');
    setCoordinatorPlan(null);
    setLastSync(null);
    setActiveGoal(trimmedGoal);
    appendLog('plan', `Coordinator planning ${rolesToLaunch.length} owned work lanes with ${getWorkerCLIOptions().find((option) => option.id === workerCLI)?.name || workerCLI}.${maxMode ? ' MAX MODE enabled.' : ''}`);

    try {
      if (manager.getAgentCount() > 0) {
        await manager.terminateAll('Restarting swarm');
        refreshAgents();
      }

      manager.setWorkerCLI(workerCLI);

      const selectedProviderConfig = PROVIDERS.find((p) => p.id === coordinatorProvider);
      const effectiveModel = coordinatorModel || selectedProviderConfig?.models[0] || '';
      const apiKey = await claudeCoordinator.getCoordinatorApiKey(coordinatorProvider);
      const coordinatorConfig: CoordinatorConfig = { provider: coordinatorProvider, model: effectiveModel, apiKey };

      const rawPlan = await claudeCoordinator.createLaunchPlan(trimmedGoal, workspacePath, rolesToLaunch, coordinatorConfig, maxMode);
      const plan = {
        ...rawPlan,
        assignments: applyManualConnectionsToAssignments(rawPlan.assignments, manualConnections),
      };
      setCoordinatorPlan(plan);
      appendLog('plan', plan.summary);
      setStatusLabel('Launching Workers');

      // --- Shared swarm state ---
      const swarmState = {
        research: new Map<string, string>(),   // Scout findings keyed by label
        artifacts: new Map<string, string>(),   // Builder outputs keyed by label
        reviews: new Map<string, string>(),     // Reviewer outputs keyed by label
      };

      // Helper: wait for a set of agent IDs to finish, return their outputs by assignment label.
      // Includes a per-agent stall timeout: if an agent has no output activity for this long,
      // it is forcibly terminated so the swarm can proceed.
      const AGENT_STALL_TIMEOUT_MS = 120_000; // 2 minutes of no activity
      const AGENT_STALL_CHECK_INTERVAL_MS = 10_000; // check every 10 seconds

      const waitForAgents = (agentIds: string[]): Promise<Map<string, string>> =>
        new Promise<Map<string, string>>((resolve, reject) => {
          if (agentIds.length === 0) {
            resolve(new Map());
            return;
          }

          const outputs = new Map<string, string>();
          const pending = new Set(agentIds);
          let resolved = false;

          const finish = () => {
            if (resolved) return;
            resolved = true;
            unsubscribe();
            clearInterval(stallChecker);
            abort.signal.removeEventListener('abort', onAbort);
            resolve(outputs);
          };

          const onAbort = () => {
            if (resolved) return;
            resolved = true;
            unsubscribe();
            clearInterval(stallChecker);
            reject(new DOMException('Swarm stopped by user', 'AbortError'));
          };
          abort.signal.addEventListener('abort', onAbort);

          const collectAgent = (agentId: string) => {
            const agent = manager.getAgent(agentId);
            if (agent) {
              const assignment = plan.assignments.find((a) => a.id === agent.assignmentId);
              if (assignment) {
                outputs.set(assignment.label, manager.getAgentHandoffOutput(agentId));
              }
            }
          };

          const unsubscribe = manager.onAgentExit((agentId) => {
            if (resolved || !pending.delete(agentId)) return;
            collectAgent(agentId);
            if (pending.size === 0) finish();
          });

          // Periodically check for stalled agents and terminate them
          const stallChecker = setInterval(() => {
            if (resolved) { clearInterval(stallChecker); return; }
            const now = Date.now();
            for (const id of pending) {
              const agent = manager.getAgent(id);
              if (!agent) { pending.delete(id); continue; }
              // Also pick up agents that finished without us noticing
              if (FINISHED_STATUSES.has(agent.status)) {
                pending.delete(id);
                collectAgent(id);
                continue;
              }
              const timeSinceActivity = now - agent.lastActivityAt.getTime();
              if (timeSinceActivity > AGENT_STALL_TIMEOUT_MS) {
                appendLog('error', `Agent ${agent.label || id} stalled (no activity for ${Math.round(timeSinceActivity / 1000)}s) — terminating.`);
                void manager.terminateAgent(id, 'Stall timeout');
              }
            }
            if (pending.size === 0) finish();
          }, AGENT_STALL_CHECK_INTERVAL_MS);

          // Check agents that already exited before subscription
          for (const id of agentIds) {
            const agent = manager.getAgent(id);
            if (agent && FINISHED_STATUSES.has(agent.status)) {
              if (pending.delete(id)) collectAgent(id);
            }
          }
          if (!resolved && pending.size === 0) finish();
        });

      // Helper: spawn a wave of assignments, return their agent IDs.
      // When passAllContext is true, all depOutputs are injected regardless of the assignment's dependency list.
      const spawnWave = async (
        assignments: SwarmAssignment[],
        taskOverrides?: Map<string, string>,
        depOutputs?: Map<string, string>,
        passAllContext?: boolean,
      ): Promise<string[]> => {
        const agentIds: string[] = [];
        await Promise.all(assignments.map(async (assignment, index) => {
          // Stagger PTY spawns slightly to avoid macOS/login-shell races when many agents start at once.
          await new Promise((r) => setTimeout(r, index * 150));
          const role = getRole(assignment.role);

          // Use task override (revision) or build normal worker task with dependency context
          let workerTask: string;
          if (taskOverrides?.has(assignment.label)) {
            workerTask = taskOverrides.get(assignment.label)!;
          } else {
            let deps: Map<string, string>;
            if (passAllContext && depOutputs) {
              // Pass all available context (used for reviewers who need full picture)
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
              trimmedGoal, plan, assignment, deps.size > 0 ? deps : undefined, maxMode,
            );
          }

          const agent = await manager.spawnAgent(role, workerTask, {
            assignmentId: assignment.id,
            label: assignment.label,
            ownedFiles: assignment.ownedFiles,
          });
          agentIds.push(agent.id);
          appendLog('dispatch', `Launched ${assignment.label}.`);
        }));
        refreshAgents();
        return agentIds;
      };

      // --- Phase 1: Scout wave (hybrid: API research + CLI analysis) ---
      const scoutAssignments = plan.assignments.filter((a) => a.role === 'scout');
      if (scoutAssignments.length > 0) {
        // Phase 1a: External research via API (parallel for all scouts)
        setStatusLabel('Scout Research (API)');
        const scoutApiResearch = new Map<string, string>();
        await Promise.all(scoutAssignments.map(async (assignment) => {
          try {
            appendLog('dispatch', `Scout ${assignment.label}: running external research via API…`);
            const research = await claudeCoordinator.scoutResearch(
              trimmedGoal, assignment.task, coordinatorConfig, maxMode,
            );
            scoutApiResearch.set(assignment.label, research);
            appendLog('dispatch', `Scout ${assignment.label}: external research complete.`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendLog('error', `Scout ${assignment.label} API research failed: ${msg}`);
          }
        }));
        if (abort.signal.aborted) return;

        // Phase 1b: Internal analysis via CLI — inject API research as context
        setStatusLabel('Scout Mapping (CLI)');
        const scoutTaskOverrides = new Map<string, string>();
        for (const assignment of scoutAssignments) {
          const apiResearch = scoutApiResearch.get(assignment.label);
          if (apiResearch) {
            const baseTask = claudeCoordinator.buildWorkerTask(
              trimmedGoal, plan, assignment, undefined, maxMode,
            );
            scoutTaskOverrides.set(
              assignment.label,
              baseTask
                + '\n\n--- External Research Context (from API) ---\n'
                + apiResearch
                + '\n--- End External Research ---\n\n'
                + 'Use the above external research to inform your codebase analysis. '
                + 'Focus on internal code paths, file structure, and risks specific to this project.',
            );
          }
        }

        const scoutIds = await spawnWave(
          scoutAssignments,
          scoutTaskOverrides.size > 0 ? scoutTaskOverrides : undefined,
        );
        const scoutOutputs = await waitForAgents(scoutIds);
        if (abort.signal.aborted) return;

        for (const [label, cliOutput] of scoutOutputs) {
          const apiOutput = scoutApiResearch.get(label) || '';
          swarmState.research.set(label, apiOutput ? `${apiOutput}\n\n---\n\n${cliOutput}` : cliOutput);
        }
        appendLog('dispatch', `Scout wave complete: ${scoutAssignments.map((a) => a.label).join(', ')}`);
        refreshAgents();
      } else {
        appendLog('dispatch', 'No scouts configured — builders will work without pre-mapping.');
      }

      // Combine all scout research for builder context
      const allResearch = new Map<string, string>([...swarmState.research]);

      // --- Phase 2+3: Builder → Reviewer iteration loop ---
      const builderAssignments = plan.assignments.filter((a) => a.role === 'builder');
      const reviewerAssignments = plan.assignments.filter((a) => a.role === 'reviewer');

      if (builderAssignments.length === 0) {
        appendLog('error', 'Coordinator plan has no builder assignments. Cannot proceed.');
        setError('Launch failed: no builder assignments in coordinator plan.');
        refreshAgents();
        setStatusLabel('Launch Error');
        setIsLaunching(false);
        return;
      }

      let iteration = 0;
      let approved = false;
      let lastRevisionInstructions = '';

      while (!approved && iteration < MAX_REVIEW_ITERATIONS && !abort.signal.aborted) {
        iteration++;
        const isRevision = iteration > 1;

        // --- Phase 2: Builder wave ---
        setStatusLabel(isRevision ? `Launching Builder Revision ${iteration}` : 'Launching Builders');

        let builderTaskOverrides: Map<string, string> | undefined;
        if (isRevision && lastRevisionInstructions) {
          builderTaskOverrides = new Map();
          for (const assignment of builderAssignments) {
            const prevOutput = swarmState.artifacts.get(assignment.label) || '';
            const revisionTask = claudeCoordinator.buildRevisionTask(
              trimmedGoal, plan, assignment, prevOutput, lastRevisionInstructions, iteration, maxMode,
            );
            builderTaskOverrides.set(assignment.label, revisionTask);
          }
          appendLog('review', `Revision round ${iteration} — sending builders back with reviewer feedback.`);
        }

        const builderIds = await spawnWave(builderAssignments, builderTaskOverrides, allResearch, false);
        setStatusLabel(isRevision ? `Builder Revision ${iteration}` : 'Builders Working');
        const builderOutputs = await waitForAgents(builderIds);
        for (const [label, output] of builderOutputs) swarmState.artifacts.set(label, output);
        appendLog('dispatch', `Builder wave complete: ${builderAssignments.map((a) => a.label).join(', ')}`);
        refreshAgents();

        // --- Phase 3: Reviewer wave ---
        if (reviewerAssignments.length === 0) {
          appendLog('review', 'No reviewers configured — marking work as complete.');
          approved = true;
          break;
        }

        setStatusLabel('Launching Reviewers');

        const reviewerContext = new Map<string, string>([...allResearch, ...swarmState.artifacts]);
        const reviewerIds = await spawnWave(reviewerAssignments, undefined, reviewerContext, true);
        setStatusLabel('Reviewers Evaluating');
        const reviewerOutputs = await waitForAgents(reviewerIds);
        for (const [label, output] of reviewerOutputs) swarmState.reviews.set(label, output);
        appendLog('dispatch', `Reviewer wave complete: ${reviewerAssignments.map((a) => a.label).join(', ')}`);
        refreshAgents();

        // --- Phase 4: Coordinator evaluates review verdict ---
        setStatusLabel('Coordinator Evaluating Review');

        const evaluation = await claudeCoordinator.evaluateReview(
          trimmedGoal, swarmState.reviews, swarmState.artifacts, coordinatorConfig,
        );

        appendLog('review', `Coordinator verdict: ${evaluation.verdict} — ${evaluation.summary}`);
        lastRevisionInstructions = evaluation.revisionInstructions;

        if (evaluation.verdict === 'APPROVED') {
          approved = true;
          appendLog('review', 'All work approved by coordinator. Swarm complete.');
        } else if (iteration >= MAX_REVIEW_ITERATIONS) {
          appendLog('review', `Max review iterations (${MAX_REVIEW_ITERATIONS}) reached. Accepting current state.`);
          approved = true;
        }
        // Otherwise loop continues — builders will be re-spawned with revision feedback
      }

      refreshAgents();
      setStatusLabel(approved ? 'Complete' : 'Running');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User stopped the swarm — agents already terminated by handleStopSwarm
        appendLog('dispatch', 'Swarm stopped by user.');
        setStatusLabel('Stopped');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to launch swarm: ${message}`);
        appendLog('error', `Launch failed: ${message}`);
        setStatusLabel('Launch Error');
        // Clean up any spawned agents on failure
        const manager = managerRef.current;
        if (manager) {
          await manager.terminateAll();
          refreshAgents();
        }
      }
    } finally {
      swarmAbortRef.current = null;
      setIsLaunching(false);
    }
  }, [
    appendLog,
    coordinatorModel,
    coordinatorProvider,
    goal,
    hasCoordinatorKey,
    isLaunching,
    maxMode,
    refreshAgents,
    roleCounts,
    workerCLI,
    workerCLIAvailability,
    workspacePath,
    manualConnections,
  ]);

  const handleKill = useCallback(async (agentId: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.terminateAgent(agentId, 'User terminated');
    refreshAgents();
  }, [refreshAgents]);

  const handleKillAll = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.terminateAll('User terminated all swarm agents');
    stopAutoSync();
    setAgents([]);
    setActiveGoal('');
    setCoordinatorPlan(null);
    setLastSync(null);
    setStatusLabel('Idle');
    setSelectedAgentId(null);
    setAgentChatMsg('');
    appendLog('dispatch', 'Terminated all swarm agents.');
  }, [appendLog, stopAutoSync]);

  const handleStopSwarm = useCallback(async () => {
    // Signal the running launch loop to abort
    swarmAbortRef.current?.abort();
    // Terminate all live agents immediately
    const manager = managerRef.current;
    if (manager) {
      await manager.terminateAll('Swarm stopped by user');
    }
    stopAutoSync();
    refreshAgents();
  }, [refreshAgents, stopAutoSync]);

  const handleSendInput = useCallback(async (agentId: string, data: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.sendToAgent(agentId, data + '\r');
  }, []);

  const handleWriteInput = useCallback(async (agentId: string, data: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.sendToAgent(agentId, data);
  }, []);

  const handleMindMapNodeMove = useCallback((nodeId: string, position: MindMapPosition) => {
    setNodePositions((prev) => ({
      ...prev,
      [nodeId]: position,
    }));
  }, []);

  const handleMindMapConnect = useCallback((fromNodeId: string, toNodeId: string) => {
    setManualConnections((prev) =>
      dedupeMindMapConnections([
        ...prev,
        { from: fromNodeId, to: toNodeId, kind: 'manual' },
      ]),
    );
  }, []);

  const handleMindMapDisconnect = useCallback((fromNodeId: string, toNodeId: string) => {
    setManualConnections((prev) =>
      prev.filter((connection) => !(connection.from === fromNodeId && connection.to === toNodeId)),
    );
  }, []);

  const rolesToLaunch = useMemo(() => buildRolesToLaunch(roleCounts), [roleCounts]);
  const workerCount = useMemo(() => rolesToLaunch.length, [rolesToLaunch]);
  const rolesReady = useMemo(() => workerCount >= MIN_AGENTS && workerCount <= MAX_AGENTS, [workerCount]);
  const selectedWorkerCLIOption = useMemo(
    () => getWorkerCLIOptions().find((option) => option.id === workerCLI) || getWorkerCLIOptions()[0],
    [workerCLI],
  );
  const selectedWorkerCLIStatus = useMemo(() => workerCLIAvailability[workerCLI], [workerCLIAvailability, workerCLI]);
  const runningCount = useMemo(
    () => agents.filter((agent) => !FINISHED_STATUSES.has(agent.status)).length,
    [agents],
  );
  const canLaunch = useMemo(() => Boolean(
    goal.trim() &&
    workspacePath &&
    hasCoordinatorKey &&
    rolesReady &&
    !isCheckingWorkerCLI &&
    selectedWorkerCLIStatus?.available &&
    swarmPtyReady &&
    !isLaunching,
  ), [goal, workspacePath, hasCoordinatorKey, rolesReady, isCheckingWorkerCLI, selectedWorkerCLIStatus, swarmPtyReady, isLaunching]);
  const workspaceName = useMemo(() => workspacePath ? getWorkspaceName(workspacePath) : 'workspace', [workspacePath]);
  const previewAssignments = useMemo(() => buildPreviewAssignments(rolesToLaunch), [rolesToLaunch]);
  const boardAssignmentsBase = useMemo(
    () => coordinatorPlan?.assignments || previewAssignments,
    [coordinatorPlan, previewAssignments],
  );
  const boardAssignments = useMemo(
    () => applyManualConnectionsToAssignments(boardAssignmentsBase, manualConnections),
    [boardAssignmentsBase, manualConnections],
  );
  const mindMapConnections = useMemo(() => dedupeMindMapConnections([
    ...buildAutomaticMindMapConnections(boardAssignmentsBase),
    ...manualConnections,
  ]), [boardAssignmentsBase, manualConnections]);
  const agentsByAssignment = useMemo(
    () => new Map(agents.map((agent) => [agent.assignmentId || agent.id, agent])),
    [agents],
  );

  const mindMapNodes = useMemo<MindMapNode[]>(() => boardAssignments.map((assignment) => {
    const agent = agentsByAssignment.get(assignment.id);
    const { label: statusLabel_, tone } = getAssignmentState(assignment, agent);
    return {
      id: assignment.id,
      label: assignment.label,
      role: assignment.role,
      tone,
      statusLabel: statusLabel_,
      workingOn: agent?.failureReason && (agent.status === 'failed' || agent.status === 'terminated')
        ? agent.failureReason
        : buildWorkSummary(agent?.assignedTask || assignment.task, assignment.role as SwarmLaunchRole),
      position: nodePositions[assignment.id],
    };
  }), [boardAssignments, agentsByAssignment, nodePositions]);

  const boardAssignmentIdsKey = useMemo(
    () => boardAssignmentsBase.map((assignment) => assignment.id).join('|'),
    [boardAssignmentsBase],
  );

  const selectedAgent = selectedAgentId ? agentsByAssignment.get(selectedAgentId) : undefined;

  const handleMindMapRoleDrop = useCallback((roleValue: string, position: MindMapPosition) => {
    const role = ROLE_ORDER.find((candidate) => candidate === roleValue);
    if (!role) return;

    const currentWorkerCount = buildRolesToLaunch(roleCounts).length;
    const atRoleLimit = roleCounts[role] >= ROLE_LIMITS[role].max;
    const atTotalLimit = currentWorkerCount >= MAX_AGENTS;

    if (atRoleLimit || atTotalLimit) {
      const existingAssignment = [...boardAssignmentsBase]
        .reverse()
        .find((assignment) => assignment.role === role);

      if (existingAssignment) {
        setNodePositions((prev) => ({
          ...prev,
          [existingAssignment.id]: position,
        }));
      }
      return;
    }

    pendingDroppedNodesRef.current.push({ role, position });
    adjustRoleCount(role, 1);
  }, [adjustRoleCount, boardAssignmentsBase, roleCounts]);

  useEffect(() => {
    const activeIds = new Set(boardAssignmentsBase.map((assignment) => assignment.id));
    const previousIds = new Set(previousBoardAssignmentIdsRef.current);
    const newlyAddedAssignments = boardAssignmentsBase.filter((assignment) => !previousIds.has(assignment.id));

    setNodePositions((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([nodeId]) => activeIds.has(nodeId)),
      );
      const pendingDrops = [...pendingDroppedNodesRef.current];

      for (const assignment of newlyAddedAssignments) {
        if (next[assignment.id]) continue;
        const pendingIndex = pendingDrops.findIndex((entry) => entry.role === assignment.role);
        if (pendingIndex === -1) continue;

        next[assignment.id] = pendingDrops.splice(pendingIndex, 1)[0].position;
      }

      for (const assignment of boardAssignmentsBase) {
        if (next[assignment.id]) continue;
        const pendingIndex = pendingDrops.findIndex((entry) => entry.role === assignment.role);
        if (pendingIndex !== -1) {
          next[assignment.id] = pendingDrops.splice(pendingIndex, 1)[0].position;
          continue;
        }

        next[assignment.id] = buildDefaultMindMapPosition(
          boardAssignmentsBase.findIndex((candidate) => candidate.id === assignment.id),
          boardAssignmentsBase.length,
        );
      }

      pendingDroppedNodesRef.current = pendingDrops;
      return next;
    });

    setManualConnections((prev) =>
      dedupeMindMapConnections(
        prev.filter((connection) => activeIds.has(connection.from) && activeIds.has(connection.to)),
      ),
    );

    previousBoardAssignmentIdsRef.current = boardAssignmentsBase.map((assignment) => assignment.id);
  }, [boardAssignmentIdsKey]);

  useEffect(() => {
    if (!selectedAgentId) return;

    const activeIds = new Set(boardAssignmentsBase.map((assignment) => assignment.id));
    if (!activeIds.has(selectedAgentId)) {
      setSelectedAgentId(null);
      setAgentChatMsg('');
    }
  }, [boardAssignmentIdsKey, selectedAgentId]);

  const coordinatorProviderName = useMemo(
    () => PROVIDERS.find((p) => p.id === coordinatorProvider)?.name || coordinatorProvider,
    [coordinatorProvider],
  );
  const coordinatorModels = useMemo(
    () => PROVIDERS.find((p) => p.id === coordinatorProvider)?.models ?? [],
    [coordinatorProvider],
  );
  const effectiveCoordinatorModel = coordinatorModel || coordinatorModels[0] || '';

  if (!isOpen) return null;

  return (
    <div className={`swarm-panel ${theme}`}>
      <div className="swarm-header">
        <div className="swarm-header-copy">
          <h2>Swarm Mode</h2>
          <span>{workspaceName} &middot; {statusLabel} &middot; {runningCount}/{agents.length} active</span>
        </div>
        <div className="swarm-header-actions">
          <button
            className="swarm-secondary-btn swarm-header-btn"
            onClick={() => void handleCoordinatorSync('manual')}
            disabled={!coordinatorPlan || agents.length === 0 || isSyncing}
          >
            {isSyncing ? 'Syncing…' : 'Sync'}
          </button>
          {agents.length > 0 && (
            <button className="swarm-danger-btn swarm-header-btn" onClick={handleKillAll}>
              Kill All
            </button>
          )}
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
      </div>

      <div className="swarm-split-body">
        <div className="swarm-mindmap-pane">
          <div className="smm-palette">
            <span className="smm-palette-label">Agents</span>
            {ROLE_ORDER.map((role) => {
              const count = roleCounts[role];
              const limits = ROLE_LIMITS[role];
              const swarmActive = agents.some((a) => !FINISHED_STATUSES.has(a.status));
              const canAddMore = count < limits.max && workerCount < MAX_AGENTS;
              const canPlace = !swarmActive && (canAddMore || count > 0);
              return (
                <div
                  key={role}
                  className={`smm-palette-chip${canPlace ? '' : ' disabled'}`}
                  draggable={canPlace}
                  onDragStart={(e) => {
                    if (!canPlace) { e.preventDefault(); return; }
                    e.dataTransfer.setData(PALETTE_DRAG_KEY, role);
                    e.dataTransfer.setData('text/plain', role);
                    e.dataTransfer.setData('text', role);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={
                    swarmActive ? 'Stop swarm before adjusting roster'
                    : canAddMore ? `Drag to add a ${role}`
                    : `Drag to reposition ${role}`
                  }
                >
                  <span className="smm-palette-dot" style={{ background: PALETTE_ROLE_COLORS[role] }} />
                  <span className="smm-palette-name">{role}</span>
                  <span className="smm-palette-count">×{count}</span>
                </div>
              );
            })}
          </div>

          <SwarmMindMap
            nodes={mindMapNodes}
            connections={mindMapConnections}
            coordinatorStatus={statusLabel}
            isActive={isLaunching || isSyncing}
            onAgentClick={(nodeId) => setSelectedAgentId((prev) => prev === nodeId ? null : nodeId)}
            selectedNodeId={selectedAgentId}
            onNodeMove={handleMindMapNodeMove}
            onConnect={handleMindMapConnect}
            onDisconnect={handleMindMapDisconnect}
            onDropRole={handleMindMapRoleDrop}
            dragDataKey={PALETTE_DRAG_KEY}
          />

          {selectedAgentId && (() => {
            const node = mindMapNodes.find((n) => n.id === selectedAgentId);
            const agent = node ? agentsByAssignment.get(node.id) : undefined;
            if (!node) return null;
            return (
              <div className={`smm-agent-chat${showAgentTerminal ? ' smm-agent-chat-expanded' : ''}`}>
                <div className="smm-agent-chat-header">
                  <div className="smm-agent-chat-info">
                    <strong>{node.label}</strong>
                    <span>{node.role} · {node.tone}</span>
                  </div>
                  <div className="smm-agent-chat-actions">
                    {agent && (
                      <button
                        className={`smm-agent-terminal-toggle${showAgentTerminal ? ' active' : ''}`}
                        onClick={() => setShowAgentTerminal((prev) => !prev)}
                        title={showAgentTerminal ? 'Hide terminal' : 'Show terminal output'}
                      >
                        {showAgentTerminal ? '⌃ Hide Terminal' : '⌄ Show Terminal'}
                      </button>
                    )}
                    <button
                      className="smm-agent-chat-close"
                      onClick={() => { setSelectedAgentId(null); setAgentChatMsg(''); setShowAgentTerminal(false); }}
                      aria-label="Close"
                    >×</button>
                  </div>
                </div>

                {showAgentTerminal && agent && (
                  <SwarmPtyTerminal
                    key={agent.id}
                    agent={agent}
                    theme={theme}
                    className="smm-agent-terminal"
                    emptyText={`${selectedWorkerCLIOption.name} — waiting for output…`}
                    interactive={!FINISHED_STATUSES.has(agent.status)}
                    resizeSession
                    autoFocus
                    onWriteInput={handleWriteInput}
                  />
                )}

                {agent && (
                  <div className="smm-agent-checklist">
                    <div className="smm-check-item done">
                      <span className="smm-check-icon">✓</span>
                      <span>Task prepared</span>
                    </div>
                    <div className={`smm-check-item${agent.cliLaunched ? ' done' : ''}`}>
                      <span className="smm-check-icon">{agent.cliLaunched ? '✓' : '○'}</span>
                      <span>CLI opened</span>
                    </div>
                    <div className={`smm-check-item${agent.promptDelivered ? ' done' : ''}`}>
                      <span className="smm-check-icon">{agent.promptDelivered ? '✓' : '○'}</span>
                      <span>Prompt sent</span>
                    </div>
                    {FINISHED_STATUSES.has(agent.status) && !agent.failureReason && (
                      <div className="smm-check-item done">
                        <span className="smm-check-icon">✓</span>
                        <span>Work complete</span>
                      </div>
                    )}
                    {agent.failureReason && (
                      <div className="smm-check-item fail">
                        <span className="smm-check-icon">✗</span>
                        <span>{agent.failureReason}</span>
                      </div>
                    )}
                  </div>
                )}

                {!agent ? (
                  <p className="smm-agent-chat-notice">Agent will accept input once launched.</p>
                ) : FINISHED_STATUSES.has(agent.status) ? (
                  <p className="smm-agent-chat-notice">Agent is {agent.status}.</p>
                ) : (
                  <form
                    className="smm-agent-chat-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const msg = agentChatMsg.trim();
                      if (!msg || !agent) return;
                      void handleSendInput(agent.id, msg);
                      setAgentChatMsg('');
                    }}
                  >
                    <input
                      className="smm-agent-chat-input"
                      value={agentChatMsg}
                      onChange={(e) => setAgentChatMsg(e.target.value)}
                      placeholder={`Message ${node.label}…`}
                      autoFocus
                    />
                    <button type="submit" className="smm-agent-chat-send" disabled={!agentChatMsg.trim()}>Send</button>
                  </form>
                )}
              </div>
            );
          })()}
        </div>

        <div className="swarm-control-pane">
        <div className="swarm-scroll">
        <div className="swarm-planner">
          {/* Goal input */}
          <div className="swarm-section">
            <textarea
              className="swarm-goal-input"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Describe what you want the swarm to build, fix, or refactor…"
            />
          </div>

          {/* Compact role steppers */}
          <div className="swarm-section">
            <div className="swarm-role-row">
              {ROLE_ORDER.map((role) => {
                const count = roleCounts[role];
                const limits = ROLE_LIMITS[role];
                const canDecrease = count > limits.min;
                const canIncrease = count < limits.max && workerCount < MAX_AGENTS;

                return (
                  <div key={role} className="swarm-role-compact">
                    <div className="swarm-role-compact-info">
                      <span className="smm-palette-dot" style={{ background: PALETTE_ROLE_COLORS[role] }} />
                      <span className="swarm-role-compact-name">{role}</span>
                    </div>
                    <div className="swarm-role-stepper">
                      <button
                        type="button"
                        className="swarm-stepper-btn"
                        onClick={() => adjustRoleCount(role, -1)}
                        disabled={!canDecrease}
                      >−</button>
                      <span className="swarm-stepper-value">{count}</span>
                      <button
                        type="button"
                        className="swarm-stepper-btn"
                        onClick={() => adjustRoleCount(role, 1)}
                        disabled={!canIncrease}
                      >+</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Compact config selectors */}
          <div className="swarm-compact-config">
            <div className="swarm-config-select-group">
              <label>Worker CLI</label>
              <select
                className="swarm-config-select"
                value={workerCLI}
                onChange={(e) => setWorkerCLI(e.target.value as WorkerCLI)}
              >
                {getWorkerCLIOptions().map((option) => {
                  const status = workerCLIAvailability[option.id];
                  return (
                    <option key={option.id} value={option.id}>
                      {option.name}{status?.available ? '' : ' (not installed)'}
                    </option>
                  );
                })}
              </select>
              <span className={`swarm-config-badge ${selectedWorkerCLIStatus?.available ? 'ok' : 'warn'}`}>
                {isCheckingWorkerCLI ? '…' : selectedWorkerCLIStatus?.available ? 'Ready' : 'Missing'}
              </span>
            </div>
            <div className="swarm-config-select-group">
              <label>Coordinator</label>
              <select
                className="swarm-config-select"
                value={coordinatorProvider}
                onChange={(e) => handleCoordinatorProviderChange(e.target.value as ProviderID)}
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}</option>
                ))}
              </select>
              <span className={`swarm-config-badge ${hasCoordinatorKey ? 'ok' : 'warn'}`}>
                {!requirementsLoaded ? '…' : hasCoordinatorKey ? 'Key set' : 'No key'}
              </span>
            </div>
            {coordinatorModels.length > 1 && (
              <div className="swarm-config-select-group">
                <label>Model</label>
                <select
                  className="swarm-config-select"
                  value={effectiveCoordinatorModel}
                  onChange={(e) => setCoordinatorModel(e.target.value)}
                >
                  {coordinatorModels.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Advanced config toggle */}
          <button
            type="button"
            className="swarm-advanced-toggle"
            onClick={() => setShowAdvancedConfig((v) => !v)}
          >
            {showAdvancedConfig ? 'Hide details' : 'Show details'}
            <svg
              xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: showAdvancedConfig ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {showAdvancedConfig && (
            <>
              <div className="swarm-section">
                <div className="swarm-section-head">
                  <h3>Worker CLI</h3>
                </div>
                <div className="swarm-cli-grid">
                  {getWorkerCLIOptions().map((option) => {
                    const status = workerCLIAvailability[option.id];
                    const selected = workerCLI === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={`swarm-cli-card ${selected ? 'selected' : ''}`}
                        onClick={() => setWorkerCLI(option.id)}
                      >
                        <div className="swarm-cli-head">
                          <span className="swarm-cli-name">{option.name}</span>
                          <span className={`swarm-cli-badge ${status?.available ? 'available' : 'unavailable'}`}>
                            {status?.available ? 'Installed' : 'Missing'}
                          </span>
                        </div>
                        <span className="swarm-cli-command">{option.command}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="swarm-section">
                <div className="swarm-section-head">
                  <h3>Coordinator AI</h3>
                </div>
                <div className="swarm-cli-grid">
                  {PROVIDERS.map((provider) => {
                    const selected = coordinatorProvider === provider.id;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        className={`swarm-cli-card ${selected ? 'selected' : ''}`}
                        onClick={() => handleCoordinatorProviderChange(provider.id)}
                      >
                        <div className="swarm-cli-head">
                          <span className="swarm-cli-name">{provider.name}</span>
                          {selected && (
                            <span className={`swarm-cli-badge ${hasCoordinatorKey ? 'available' : 'unavailable'}`}>
                              {hasCoordinatorKey ? 'Key set' : 'No key'}
                            </span>
                          )}
                        </div>
                        <span className="swarm-cli-desc">{provider.models[0]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Warnings - only show actionable ones */}
          {requirementsLoaded && !hasCoordinatorKey && (
            <div className="swarm-requirement warning">
              Add a {coordinatorProviderName} API key in Settings to enable the coordinator.
            </div>
          )}

          {!isCheckingWorkerCLI && selectedWorkerCLIStatus && !selectedWorkerCLIStatus.available && (
            <div className="swarm-requirement warning">
              {selectedWorkerCLIOption.name} is not installed. Install <code>{selectedWorkerCLIOption.command}</code> or choose another CLI.
            </div>
          )}

          {error && (
            <div className="swarm-error-bar">
              <span>{error}</span>
              <button onClick={() => setError(null)}>×</button>
            </div>
          )}

          {workspacePath && !swarmPtyReady && !isLaunching && (
            <div className="swarm-requirement">Preparing worker terminals…</div>
          )}

          <div className="swarm-max-mode-row">
            <label className="swarm-max-mode-toggle">
              <input
                type="checkbox"
                checked={maxMode}
                onChange={(e) => setMaxMode(e.target.checked)}
                disabled={isLaunching}
              />
              <span className={`swarm-max-mode-switch${maxMode ? ' active' : ''}`} />
              <span className="swarm-max-mode-label">MAX MODE</span>
            </label>
            {maxMode && (
              <span className="swarm-max-mode-hint">
                Maximum effort — no shortcuts, production quality, thorough self-review
              </span>
            )}
          </div>

          <div className="swarm-actions">
            {isLaunching ? (
              <button className="swarm-danger-btn" onClick={handleStopSwarm}>
                Stop Swarm
              </button>
            ) : (
              <button className="swarm-primary-btn" onClick={handleLaunch} disabled={!canLaunch}>
                {`Launch ${workerCount}-Worker Swarm${maxMode ? ' (MAX)' : ''}`}
              </button>
            )}
          </div>
        </div>

        {/* Coordination Board - visible after plan exists or as preview */}
        {(coordinatorPlan || agents.length > 0) && (
          <>
            <div className="swarm-status-strip">
              <span>{statusLabel}</span>
              <span>{runningCount} active · {agents.length} workers</span>
            </div>

            <div className="swarm-coordinator-board">
              <div className="swarm-coordinator-card swarm-board-card">
                <div className="swarm-section-head">
                  <h3>Board</h3>
                  <span>{coordinatorPlan ? 'live' : 'template'}</span>
                </div>
                <div className="swarm-board-list">
                  {boardAssignments.map((assignment) => {
                    const agent = agentsByAssignment.get(assignment.id);
                    const state = getAssignmentState(assignment, agent);
                    return (
                      <div key={assignment.id} className="swarm-board-row">
                        <span className={`swarm-task-status ${state.tone}`}>{state.label}</span>
                        <div className="swarm-task-main">
                          <div className="swarm-task-head">
                            <strong>{assignment.label}</strong>
                            <span>{getRole(assignment.role).name}</span>
                          </div>
                          <p>{assignment.task}</p>
                          {assignment.ownedFiles.length > 0 && (
                            <div className="swarm-task-meta">
                              <span>{assignment.ownedFiles.length} file{assignment.ownedFiles.length === 1 ? '' : 's'}</span>
                              <span>{assignment.ownedFiles.slice(0, 2).join(', ')}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="swarm-coordinator-stack">
                {coordinatorPlan && (
                  <div className="swarm-coordinator-card">
                    <div className="swarm-section-head">
                      <h3>Strategy</h3>
                    </div>
                    <p className="swarm-coordinator-summary">{coordinatorPlan.strategy}</p>
                    {lastSync && (
                      <div className="swarm-plan-snippet">
                        <strong>Next</strong>
                        <p>{lastSync.nextMilestone}</p>
                      </div>
                    )}
                  </div>
                )}

                {coordinatorLog.length > 0 && (
                  <div className="swarm-coordinator-card swarm-coordinator-log">
                    <div className="swarm-section-head">
                      <h3>Log</h3>
                      <span>{coordinatorLog.length}</span>
                    </div>
                    <div className="swarm-log-list">
                      {coordinatorLog.map((entry) => (
                        <div key={entry.id} className={`swarm-log-entry ${entry.kind}`}>
                          <span className="swarm-log-time">{formatTimestamp(entry.timestamp)}</span>
                          <div className="swarm-log-copy">
                            <strong>{entry.kind}</strong>
                            <span>{entry.message}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <div className="agents-list">
          {agents.length === 0 ? (
            <div className="agents-empty">
              <div className="agents-empty-icon">⬡</div>
              <p>No swarm running</p>
              <p className="agents-empty-sub">
                Describe a goal above and launch. The coordinator will split work across scouts, builders, and reviewers with file ownership.
              </p>
            </div>
          ) : (
            agents.map((agent) => (
              <AgentTerminal
                key={agent.id}
                agent={agent}
                theme={theme}
                workerCliLabel={selectedWorkerCLIOption.name}
                onKill={handleKill}
                onSendInput={handleSendInput}
                expanded={expandedAgentId === agent.id}
                onToggleExpand={(agentId) => setExpandedAgentId((prev) => prev === agentId ? null : agentId)}
              />
            ))
          )}
        </div>
        </div>{/* /swarm-scroll */}
        </div>{/* /swarm-control-pane */}
      </div>{/* /swarm-split-body */}
    </div>
  );
};
