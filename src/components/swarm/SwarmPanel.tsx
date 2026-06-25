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
import { Agent, WorkerCLI } from '../../services/swarm/types';
import { runSwarmLaunch, type SwarmPlan } from '../../services/swarm/swarmLaunchPipeline';
import { AgentTerminal } from './AgentTerminal';
import { SwarmPtyTerminal } from './SwarmPtyTerminal';
import {
  SwarmMindMap,
  MindMapConnection,
  MindMapNode,
  MindMapPosition,
  buildDefaultMindMapPosition,
} from './SwarmMindMap';
import {
  MIN_AGENTS,
  MAX_AGENTS,
  MAX_MODE_STORAGE_KEY,
  WORKER_CLI_STORAGE_KEY,
  ROLE_ORDER,
  DEFAULT_ROLE_COUNTS,
  ROLE_LIMITS,
  PALETTE_ROLE_COLORS,
  PALETTE_DRAG_KEY,
  FINISHED_STATUSES,
  type CoordinatorLogEntry,
  type SwarmLaunchRole,
  type RoleCounts,
  type WorkerCLIAvailability,
  formatTimestamp,
  trimCoordinatorLog,
  buildRolesToLaunch,
  buildPreviewAssignments,
  getWorkspaceName,
  getAssignmentState,
  buildWorkSummary,
  dedupeMindMapConnections,
  applyManualConnectionsToAssignments,
  buildAutomaticMindMapConnections,
  buildDefaultWorkerCLIAvailability,
} from './swarmPanelModel';
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

export const SwarmPanel: React.FC<SwarmPanelProps> = ({
  isOpen,
  onClose,
  theme,
  workspacePath,
  hasApiKey,
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
    const options = getWorkerCLIOptions();
    if (stored && options.some((option) => option.id === stored)) {
      return stored as WorkerCLI;
    }
    return 'claude';
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
      swarmAbortRef.current?.abort();
      setSwarmPtyReady(false);
      stopAutoSync();
      void manager
        .terminateAll('Swarm panel closed')
        .catch(() => {})
        .finally(() => {
          void manager.cleanup();
        });
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
      const coordinatorConfig: CoordinatorConfig = {
        cliLabel: getWorkerCLIOptions().find((option) => option.id === workerCLI)?.name || workerCLI,
        runPrompt: (prompt, options) => manager.runCoordinatorPrompt(prompt, options),
      };

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
  }, [activeGoal, appendLog, coordinatorPlan, manualConnections, refreshAgents, workerCLI, workspacePath]);

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

      const selectedCliName = getWorkerCLIOptions().find((option) => option.id === workerCLI)?.name || workerCLI;
      const coordinatorConfig: CoordinatorConfig = {
        cliLabel: selectedCliName,
        runPrompt: (prompt, options) => manager.runCoordinatorPrompt(prompt, {
          ...options,
          signal: abort.signal,
        }),
      };

      const rawPlan = await claudeCoordinator.createLaunchPlan(trimmedGoal, workspacePath, rolesToLaunch, coordinatorConfig, maxMode);
      const plan = {
        ...rawPlan,
        assignments: applyManualConnectionsToAssignments(rawPlan.assignments, manualConnections),
      };
      setCoordinatorPlan(plan);
      appendLog('plan', plan.summary);
      setStatusLabel('Launching Workers');

      const bailIfAborted = (): boolean => {
        if (!abort.signal.aborted) return false;
        appendLog('dispatch', 'Swarm stopped by user.');
        setStatusLabel('Stopped');
        return true;
      };

      if (bailIfAborted()) return;

      await runSwarmLaunch({
        manager,
        plan,
        trimmedGoal,
        coordinatorConfig,
        selectedCliName,
        maxMode,
        signal: abort.signal,
        appendLog,
        refreshAgents,
        setPhaseStatus: setStatusLabel,
      });

      refreshAgents();
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
    goal,
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
    swarmAbortRef.current?.abort();
    const manager = managerRef.current;
    if (!manager) return;
    await manager.terminateAll('User terminated all swarm agents');
    stopAutoSync();
    setIsLaunching(false);
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
    setStatusLabel('Stopped');
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
    hasApiKey &&
    goal.trim() &&
    workspacePath &&
    rolesReady &&
    !isCheckingWorkerCLI &&
    selectedWorkerCLIStatus?.available &&
    swarmPtyReady &&
    !isLaunching,
  ), [hasApiKey, goal, workspacePath, rolesReady, isCheckingWorkerCLI, selectedWorkerCLIStatus, swarmPtyReady, isLaunching]);
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
  }, [boardAssignmentIdsKey, boardAssignmentsBase, selectedAgentId]);

  if (!isOpen) return null;

  return (
    <div className={`swarm-panel ${theme}`}>
      <div className="swarm-header">
        <div className="swarm-header-copy">
          <h2>Agents</h2>
          <span>
            {workspaceName} · {statusLabel} · {runningCount}/{Math.max(agents.length, 1)} live
          </span>
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

      {!hasApiKey && (
        <div className="swarm-api-hint" role="status">
          Add an API key in Settings so the coordinator can plan and sync runs.
        </div>
      )}

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
              <label>Agent CLI</label>
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
              <span className="swarm-config-static">{selectedWorkerCLIOption.name}</span>
              <span className={`swarm-config-badge ${selectedWorkerCLIStatus?.available ? 'ok' : 'warn'}`}>
                Same CLI
              </span>
            </div>
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
                  <h3>Agent CLI</h3>
                  <span>workers and coordinators</span>
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
            </>
          )}

          {/* Warnings - only show actionable ones */}
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
