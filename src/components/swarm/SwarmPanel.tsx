import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AgentManager,
  SwarmEventEmitter,
  getRole,
  claudeCoordinator,
  WORKER_CLI_OPTIONS,
  detectWorkerCLIAvailability,
} from '../../services/swarm';
import { Agent, AgentRoleType, AgentStatus, WorkerCLI } from '../../services/swarm/types';
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
    WORKER_CLI_OPTIONS.map((option) => [
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

  const [agents, setAgents] = useState<Agent[]>([]);
  const [goal, setGoal] = useState('');
  const [activeGoal, setActiveGoal] = useState('');
  const [roleCounts, setRoleCounts] = useState<RoleCounts>(DEFAULT_ROLE_COUNTS);
  const [workerCLI, setWorkerCLI] = useState<WorkerCLI>(() => {
    if (typeof window === 'undefined') return 'claude';
    const stored = window.localStorage.getItem(WORKER_CLI_STORAGE_KEY);
    return WORKER_CLI_OPTIONS.some((option) => option.id === stored)
      ? (stored as WorkerCLI)
      : 'claude';
  });
  const [workerCLIAvailability, setWorkerCLIAvailability] = useState<WorkerCLIAvailability>(
    buildDefaultWorkerCLIAvailability,
  );
  const [isCheckingWorkerCLI, setIsCheckingWorkerCLI] = useState(false);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [hasClaudeKey, setHasClaudeKey] = useState(false);
  const [requirementsLoaded, setRequirementsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLabel, setStatusLabel] = useState('Idle');
  const [coordinatorPlan, setCoordinatorPlan] = useState<SwarmPlan | null>(null);
  const [lastSync, setLastSync] = useState<Awaited<ReturnType<typeof claudeCoordinator.createSyncResult>> | null>(null);
  const [coordinatorLog, setCoordinatorLog] = useState<CoordinatorLogEntry[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentChatMsg, setAgentChatMsg] = useState('');
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

    claudeCoordinator.hasClaudeKey()
      .then((ready) => {
        if (!isMounted) return;
        setHasClaudeKey(ready);
        setRequirementsLoaded(true);
      })
      .catch(() => {
        if (!isMounted) return;
        setHasClaudeKey(false);
        setRequirementsLoaded(true);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

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
    if (!manager || !activeGoal || !coordinatorPlan || isSyncing) return;

    const snapshot = manager.getAllAgents();
    if (snapshot.length === 0) return;
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
      const syncResult = await claudeCoordinator.createSyncResult(
        activeGoal,
        workspacePath,
        syncPlan,
        snapshot,
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
      setIsSyncing(false);
    }
  }, [activeGoal, appendLog, coordinatorPlan, isSyncing, manualConnections, refreshAgents, workspacePath]);

  useEffect(() => {
    stopAutoSync();

    if (!activeGoal || !coordinatorPlan) return;

    syncIntervalRef.current = setInterval(() => {
      const manager = managerRef.current;
      if (!manager || isLaunching || isSyncing) return;

      const hasLiveAgents = manager.getAllAgents().some((agent) => !FINISHED_STATUSES.has(agent.status));
      if (!hasLiveAgents) return;

      void handleCoordinatorSync('automatic');
    }, 45000);

    return stopAutoSync;
  }, [activeGoal, coordinatorPlan, handleCoordinatorSync, isLaunching, isSyncing, stopAutoSync]);

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
    if (!hasClaudeKey) {
      setError('Swarm coordinator requires a Claude API key in Settings.');
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
      setError(`${WORKER_CLI_OPTIONS.find((option) => option.id === workerCLI)?.name || 'Selected CLI'} is not available on PATH.`);
      return;
    }

    setIsLaunching(true);
    setError(null);
    setStatusLabel('Coordinator Planning');
    setCoordinatorPlan(null);
    setLastSync(null);
    setActiveGoal(trimmedGoal);
    appendLog('plan', `Coordinator planning ${rolesToLaunch.length} owned work lanes with ${WORKER_CLI_OPTIONS.find((option) => option.id === workerCLI)?.name || workerCLI}.`);

    try {
      if (manager.getAgentCount() > 0) {
        await manager.terminateAll('Restarting swarm');
        refreshAgents();
      }

      manager.setWorkerCLI(workerCLI);

      const rawPlan = await claudeCoordinator.createLaunchPlan(trimmedGoal, workspacePath, rolesToLaunch);
      const plan = {
        ...rawPlan,
        assignments: applyManualConnectionsToAssignments(rawPlan.assignments, manualConnections),
      };
      setCoordinatorPlan(plan);
      appendLog('plan', plan.summary);
      setStatusLabel('Launching Workers');

      for (const assignment of plan.assignments) {
        const role = getRole(assignment.role);
        const workerTask = claudeCoordinator.buildWorkerTask(trimmedGoal, plan, assignment);
        await manager.spawnAgent(role, workerTask, {
          assignmentId: assignment.id,
          label: assignment.label,
          ownedFiles: assignment.ownedFiles,
        });
        appendLog('dispatch', `Launched ${assignment.label}.`);
      }

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
    goal,
    hasClaudeKey,
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

  const rolesToLaunch = buildRolesToLaunch(roleCounts);
  const workerCount = rolesToLaunch.length;
  const rolesReady = workerCount >= MIN_AGENTS && workerCount <= MAX_AGENTS;
  const selectedWorkerCLIOption = WORKER_CLI_OPTIONS.find((option) => option.id === workerCLI) || WORKER_CLI_OPTIONS[0];
  const selectedWorkerCLIStatus = workerCLIAvailability[workerCLI];
  const runningCount = agents.filter((agent) => !FINISHED_STATUSES.has(agent.status)).length;
  const canLaunch = Boolean(
    goal.trim() &&
    workspacePath &&
    hasClaudeKey &&
    rolesReady &&
    !isCheckingWorkerCLI &&
    selectedWorkerCLIStatus?.available &&
    !isLaunching,
  );
  const workspaceName = workspacePath ? getWorkspaceName(workspacePath) : 'workspace';
  const previewAssignments = buildPreviewAssignments(rolesToLaunch);
  const boardAssignmentsBase = coordinatorPlan?.assignments || previewAssignments;
  const boardAssignments = applyManualConnectionsToAssignments(boardAssignmentsBase, manualConnections);
  const mindMapConnections = dedupeMindMapConnections([
    ...buildAutomaticMindMapConnections(boardAssignmentsBase),
    ...manualConnections,
  ]);
  const agentsByAssignment = new Map(
    agents.map((agent) => [agent.assignmentId || agent.id, agent]),
  );

  const mindMapNodes: MindMapNode[] = boardAssignments.map((assignment) => {
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
  });

  const boardAssignmentIdsKey = boardAssignmentsBase.map((assignment) => assignment.id).join('|');

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

  if (!isOpen) return null;

  return (
    <div className={`swarm-panel ${theme}`}>
      <div className="swarm-header">
        <div className="swarm-header-copy">
          <h2>Swarm Mode</h2>
          <span>Coordinator-led agents with ownership, sync, and review gates</span>
        </div>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="swarm-split-body">
        <div className="swarm-mindmap-pane">
          {/* Role palette — drag chips onto the canvas to add agents */}
          <div className="smm-palette">
            <span className="smm-palette-label">Add agent</span>
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
                    swarmActive ? 'Swarm is running — stop it before adjusting the roster'
                    : canAddMore ? `Drag to add a ${role} agent`
                    : `Drag to reposition the ${role} node`
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

          {/* Agent message popover */}
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
                  <p className="smm-agent-chat-notice">Agent hasn't launched yet — it will accept input once running.</p>
                ) : FINISHED_STATUSES.has(agent.status) ? (
                  <p className="smm-agent-chat-notice">Agent is {agent.status} and no longer accepting input.</p>
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
                    <button
                      type="submit"
                      className="smm-agent-chat-send"
                      disabled={!agentChatMsg.trim()}
                    >Send</button>
                  </form>
                )}
              </div>
            );
          })()}
        </div>

        <div className="swarm-control-pane">
        <div className="swarm-scroll">
        <div className="swarm-planner">
          <div className="swarm-section">
            <div className="swarm-section-head">
              <h3>Mission</h3>
              <span>{workerCount} workers + coordinator</span>
            </div>
            <textarea
              className="swarm-goal-input"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Describe the product goal, bug, or feature. The coordinator will map the work, assign file ownership, launch workers, and drive review."
            />
            <div className="swarm-config-row">
              <div className="swarm-runtime-hint">
                Coordinator uses Claude API. Workers launch with {selectedWorkerCLIOption.name} in this workspace with explicit ownership boundaries.
              </div>
              <div className="swarm-runtime-hint">
                Recommended shape: 1 scout, 2 builders, 1 reviewer. Add more builders only when the work cleanly splits by files or modules.
              </div>
            </div>
          </div>

          <div className="swarm-section">
            <div className="swarm-section-head">
              <h3>Worker Mix</h3>
              <span>{workerCount}/{MAX_AGENTS} workers</span>
            </div>
            <div className="swarm-role-grid">
              {ROLE_ORDER.map((role) => {
                const roleDef = getRole(role);
                const count = roleCounts[role];
                const limits = ROLE_LIMITS[role];
                const canDecrease = count > limits.min;
                const canIncrease = count < limits.max && workerCount < MAX_AGENTS;

                return (
                  <div key={role} className="swarm-role-card selected">
                    <div className="swarm-role-card-head">
                      <div className="swarm-role-copy">
                        <span className="swarm-role-name">{roleDef.name}</span>
                        <span className="swarm-role-caption">{ROLE_COPY[role].caption}</span>
                      </div>
                      <div className="swarm-role-stepper">
                        <button
                          type="button"
                          className="swarm-stepper-btn"
                          onClick={() => adjustRoleCount(role, -1)}
                          disabled={!canDecrease}
                        >
                          −
                        </button>
                        <span className="swarm-stepper-value">{count}</span>
                        <button
                          type="button"
                          className="swarm-stepper-btn"
                          onClick={() => adjustRoleCount(role, 1)}
                          disabled={!canIncrease}
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <span className="swarm-role-desc">{roleDef.description}</span>
                    <span className="swarm-role-rule">{ROLE_COPY[role].hint}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="swarm-section">
            <div className="swarm-section-head">
              <h3>Worker CLI</h3>
              <span>{isCheckingWorkerCLI ? 'checking' : selectedWorkerCLIStatus?.available ? 'ready' : 'unavailable'}</span>
            </div>
            <div className="swarm-cli-grid">
              {WORKER_CLI_OPTIONS.map((option) => {
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
                    <span className="swarm-cli-desc">{option.description}</span>
                    <span className="swarm-cli-detail">{status?.detail || 'Checking availability…'}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="swarm-section">
            <div className="swarm-section-head">
              <h3>Operating Model</h3>
              <span>Coordinator-enforced rules</span>
            </div>
            <div className="swarm-principles-grid">
              {OPERATING_MODEL.map((principle, index) => (
                <div key={principle} className="swarm-principle-card">
                  <strong>{String(index + 1).padStart(2, '0')}</strong>
                  <span>{principle}</span>
                </div>
              ))}
            </div>
          </div>

          {!workspacePath && (
            <div className="swarm-requirement warning">
              Open a project first. The coordinator needs a workspace to assign ownership correctly.
            </div>
          )}

          {!rolesReady && (
            <div className="swarm-requirement warning">
              Use at least {MIN_AGENTS} workers. A single worker is just a terminal session, not a swarm.
            </div>
          )}

          {roleCounts.scout === 0 && (
            <div className="swarm-requirement warning">
              No scout selected. Builders will start without a dedicated discovery pass or ownership recommendations.
            </div>
          )}

          {roleCounts.reviewer === 0 && (
            <div className="swarm-requirement warning">
              No reviewer selected. Completed work will have no dedicated quality gate before you ship it.
            </div>
          )}

          {requirementsLoaded && !hasClaudeKey && (
            <div className="swarm-requirement warning">
              Add a Claude API key in Settings. The coordinator still depends on Claude API even if your terminal AI provider is different.
            </div>
          )}

          {!isCheckingWorkerCLI && selectedWorkerCLIStatus && !selectedWorkerCLIStatus.available && (
            <div className="swarm-requirement warning">
              {selectedWorkerCLIOption.name} is not available for worker sessions. Install `{selectedWorkerCLIOption.command}` or choose another CLI.
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
            <button
              className="swarm-secondary-btn"
              onClick={() => void handleCoordinatorSync('manual')}
              disabled={!coordinatorPlan || agents.length === 0 || isSyncing}
            >
              {isSyncing ? 'Syncing…' : 'Coordinator Sync'}
            </button>
            <button
              className="swarm-danger-btn"
              onClick={handleKillAll}
              disabled={agents.length === 0}
            >
              Kill All
            </button>
          </div>
        </div>

        <div className="swarm-status-strip">
          <span>{statusLabel}</span>
          <span>{runningCount} active · {agents.length} workers</span>
        </div>

        <div className="swarm-coordinator-board">
          <div className="swarm-coordinator-card swarm-board-card">
            <div className="swarm-section-head">
              <h3>Coordination Board</h3>
              <span>{coordinatorPlan ? 'live' : 'template'}</span>
            </div>
            <div className="swarm-board-summary">
              <strong>{coordinatorPlan ? `Active Swarm — ${workspaceName}` : `Swarm Template — ${workspaceName}`}</strong>
              <p>
                {activeGoal || 'Define a goal and launch the coordinator. This board previews how the swarm will split work across scout, builders, and reviewer.'}
              </p>
            </div>
            <div className="swarm-board-list">
              {boardAssignments.map((assignment) => {
                const agent = agentsByAssignment.get(assignment.id);
                const state = getAssignmentState(assignment, agent);
                const ownershipSummary = assignment.ownedFiles.length > 0
                  ? `${assignment.ownedFiles.length} ownership item${assignment.ownedFiles.length === 1 ? '' : 's'}`
                  : 'Ownership pending';
                const dependencySummary = assignment.dependencies.length > 0
                  ? `${assignment.dependencies.length} dep${assignment.dependencies.length === 1 ? '' : 's'}`
                  : 'No deps';
                const ownershipPreview = assignment.ownedFiles.length > 0
                  ? assignment.ownedFiles.slice(0, 2).join(', ')
                  : 'Coordinator will assign files or modules at launch';

                return (
                  <div key={assignment.id} className="swarm-board-row">
                    <span className={`swarm-task-status ${state.tone}`}>{state.label}</span>
                    <div className="swarm-task-main">
                      <div className="swarm-task-head">
                        <strong>{assignment.label}</strong>
                        <span>{getRole(assignment.role).name}</span>
                      </div>
                      <p>{assignment.task}</p>
                      <div className="swarm-task-meta">
                        <span>{ownershipSummary}</span>
                        <span>{dependencySummary}</span>
                      </div>
                      <div className="swarm-task-ownership">{ownershipPreview}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="swarm-coordinator-stack">
            <div className="swarm-coordinator-card">
              <div className="swarm-section-head">
                <h3>Coordinator</h3>
                <span>{lastSync?.overallStatus || (coordinatorPlan ? 'active' : 'ready')}</span>
              </div>
              <p className="swarm-coordinator-summary">
                {lastSync?.summary || coordinatorPlan?.summary || 'The coordinator will split the mission into owned work lanes, monitor progress, and push completed slices through review.'}
              </p>
              {coordinatorPlan && (
                <div className="swarm-plan-snippet">
                  <strong>Strategy</strong>
                  <p>{coordinatorPlan.strategy}</p>
                </div>
              )}
              {coordinatorPlan && (
                <div className="swarm-plan-snippet">
                  <strong>Watch</strong>
                  <p>{coordinatorPlan.coordinatorBrief}</p>
                </div>
              )}
              {lastSync && (
                <div className="swarm-plan-snippet">
                  <strong>Next Milestone</strong>
                  <p>{lastSync.nextMilestone}</p>
                </div>
              )}
            </div>

            <div className="swarm-coordinator-card swarm-coordinator-log">
              <div className="swarm-section-head">
                <h3>Coordinator Log</h3>
                <span>{coordinatorLog.length} events</span>
              </div>
              {coordinatorLog.length === 0 ? (
                <p className="swarm-coordinator-summary">No coordinator activity yet.</p>
              ) : (
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
              )}
            </div>
          </div>
        </div>

        <div className="agents-list">
          {agents.length === 0 ? (
            <div className="agents-empty">
              <div className="agents-empty-icon">⬡</div>
              <p>No swarm running</p>
              <p className="agents-empty-sub">
                Launch the coordinator with scouts, builders, and a reviewer to get owned work lanes instead of one monolithic agent session.
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
