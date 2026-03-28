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
  kind: 'plan' | 'sync' | 'dispatch' | 'error';
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

  if (
    agent.status === 'failed' ||
    agent.status === 'terminated' ||
    agent.status === 'waiting_for_input' ||
    agent.status === 'waiting_for_approval'
  ) {
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
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false);
  const [nodePositions, setNodePositions] = useState<Record<string, MindMapPosition>>({});
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
    if (!isOpen || !workspacePath) return;

    const manager = new AgentManager(new SwarmEventEmitter(), workspacePath);
    manager.setWorkerCLI(workerCLI);
    managerRef.current = manager;

    let disposed = false;

    manager.initialize()
      .then(() => {
        if (!disposed) {
          refreshAgents();
        }
      })
      .catch((err) => {
        if (!disposed) {
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

    return () => {
      disposed = true;
      stopAutoSync();
      void manager.terminateAll('Swarm panel closed').catch(() => {});
      void manager.cleanup();
      unsubscribeOutput();
      unsubscribeExit();
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

    setIsLaunching(true);
    setError(null);
    setStatusLabel('Coordinator Planning');
    setCoordinatorPlan(null);
    setLastSync(null);
    setActiveGoal(trimmedGoal);
    appendLog('plan', `Coordinator planning ${rolesToLaunch.length} owned work lanes with ${getWorkerCLIOptions().find((option) => option.id === workerCLI)?.name || workerCLI}.`);

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

      const rawPlan = await claudeCoordinator.createLaunchPlan(trimmedGoal, workspacePath, rolesToLaunch, coordinatorConfig);
      const plan = {
        ...rawPlan,
        assignments: applyManualConnectionsToAssignments(rawPlan.assignments, manualConnections),
      };
      setCoordinatorPlan(plan);
      appendLog('plan', plan.summary);
      setStatusLabel('Launching Workers');

      // Spawn all agents in parallel for faster launch
      await Promise.all(plan.assignments.map(async (assignment) => {
        const role = getRole(assignment.role);
        const workerTask = claudeCoordinator.buildWorkerTask(trimmedGoal, plan, assignment);
        await manager.spawnAgent(role, workerTask, {
          assignmentId: assignment.id,
          label: assignment.label,
          ownedFiles: assignment.ownedFiles,
        });
        appendLog('dispatch', `Launched ${assignment.label}.`);
      }));

      refreshAgents();
      setStatusLabel('Running');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to launch swarm: ${message}`);
      appendLog('error', `Launch failed: ${message}`);
      setStatusLabel('Launch Error');
    } finally {
      setIsLaunching(false);
    }
  }, [
    appendLog,
    coordinatorModel,
    coordinatorProvider,
    goal,
    hasCoordinatorKey,
    isLaunching,
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

  const handleSendInput = useCallback(async (agentId: string, data: string) => {
    const manager = managerRef.current;
    if (!manager) return;
    await manager.sendToAgent(agentId, data + '\r');
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
    !isLaunching,
  ), [goal, workspacePath, hasCoordinatorKey, rolesReady, isCheckingWorkerCLI, selectedWorkerCLIStatus, isLaunching]);
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
    const { label, tone } = getAssignmentState(assignment, agent);
    return {
      id: assignment.id,
      label: assignment.label,
      role: assignment.role,
      tone,
      statusLabel: label,
      workingOn: buildWorkSummary(agent?.assignedTask || assignment.task, assignment.role as SwarmLaunchRole),
      position: nodePositions[assignment.id],
    };
  }), [boardAssignments, agentsByAssignment, nodePositions]);

  const boardAssignmentIdsKey = useMemo(
    () => boardAssignmentsBase.map((assignment) => assignment.id).join('|'),
    [boardAssignmentsBase],
  );

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
            isActive={Boolean(coordinatorPlan) || agents.length > 0}
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
              <div className="smm-agent-chat">
                <div className="smm-agent-chat-header">
                  <div className="smm-agent-chat-info">
                    <strong>{node.label}</strong>
                    <span>{node.role} · {node.tone}</span>
                  </div>
                  <button
                    className="smm-agent-chat-close"
                    onClick={() => { setSelectedAgentId(null); setAgentChatMsg(''); }}
                    aria-label="Close"
                  >×</button>
                </div>
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

          <div className="swarm-actions">
            <button className="swarm-primary-btn" onClick={handleLaunch} disabled={!canLaunch}>
              {isLaunching ? 'Launching…' : `Launch ${workerCount}-Worker Swarm`}
            </button>
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
