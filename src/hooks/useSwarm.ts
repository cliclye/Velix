/**
 * useSwarm - Main React hook for swarm orchestration
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  OrchestratorCore,
  orchestrator as defaultOrchestrator,
  OrchestratorState,
  SwarmTask,
  Agent,
  PendingApproval,
  ComplexityAnalysis,
} from '../services/swarm';
import { aiService } from '../services/ai/AIService';

interface UseSwarmOptions {
  workspacePath: string;
  autoInitialize?: boolean;
}

interface UseSwarmReturn {
  // State
  state: OrchestratorState;
  task: SwarmTask | null;
  agents: Agent[];
  pendingApprovals: PendingApproval[];
  isInitialized: boolean;
  error: string | null;

  // Complexity analysis
  complexity: ComplexityAnalysis | null;
  isAnalyzing: boolean;

  // Actions
  initialize: () => Promise<void>;
  analyzeComplexity: (goal: string) => Promise<ComplexityAnalysis | null>;
  startTask: (goal: string, constraints?: string[]) => Promise<SwarmTask | null>;
  pauseTask: () => Promise<void>;
  resumeTask: () => Promise<void>;
  abortTask: () => Promise<void>;
  killSwitch: () => Promise<void>;

  // Approval handling
  approveAction: (approvalId: string) => Promise<void>;
  denyAction: (approvalId: string) => Promise<void>;

  // Configuration
  setSafeMode: (enabled: boolean) => void;
  setDryRunMode: (enabled: boolean) => void;

  // Agent management
  terminateAgent: (agentId: string) => Promise<void>;
}

export function useSwarm(options: UseSwarmOptions): UseSwarmReturn {
  const { workspacePath, autoInitialize = true } = options;

  const orchestratorRef = useRef<OrchestratorCore>(defaultOrchestrator);

  const [state, setState] = useState<OrchestratorState>('idle');
  const [task, setTask] = useState<SwarmTask | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complexity, setComplexity] = useState<ComplexityAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Initialize orchestrator
  const initialize = useCallback(async () => {
    if (!workspacePath) {
      setError('Workspace path is required');
      return;
    }

    try {
      await orchestratorRef.current.initialize({
        workspacePath,
        maxAgents: 8,
        maxRuntime: 600000,
        maxRetries: 3,
        dryRunMode: false,
        safeMode: false,
      });
      setIsInitialized(true);
      setError(null);
    } catch (err) {
      setError(`Failed to initialize: ${err}`);
      setIsInitialized(false);
    }
  }, [workspacePath]);

  // Auto-initialize when workspace is available. Avoid `!isInitialized` in deps — a failed init
  // would otherwise retrigger this effect every render and spam initialize().
  useEffect(() => {
    if (!autoInitialize || !workspacePath) {
      setIsInitialized(false);
      return;
    }

    let cancelled = false;
    setIsInitialized(false);

    void (async () => {
      try {
        await orchestratorRef.current.initialize({
          workspacePath,
          maxAgents: 8,
          maxRuntime: 600000,
          maxRetries: 3,
          dryRunMode: false,
          safeMode: false,
        });
        if (!cancelled) {
          setIsInitialized(true);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(`Failed to initialize: ${err}`);
          setIsInitialized(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [autoInitialize, workspacePath]);

  // Subscribe to state changes
  useEffect(() => {
    if (!isInitialized) return;

    const unsubscribe = orchestratorRef.current.onStateChange((newState, newTask) => {
      setState(newState);
      setTask(newTask);
    });

    return unsubscribe;
  }, [isInitialized]);

  // Subscribe to agent events
  useEffect(() => {
    if (!isInitialized) return;

    const emitter = orchestratorRef.current.getEventEmitter();
    const unsubscribe = emitter.subscribeToAgentEvents(() => {
      const manager = orchestratorRef.current.getAgentManager();
      if (manager) {
        setAgents(manager.getAllAgents());
      }
    });

    return unsubscribe;
  }, [isInitialized]);

  // Subscribe to pending approvals
  useEffect(() => {
    if (!isInitialized) return;

    const rules = orchestratorRef.current.getAutomationRules();
    const unsubscribe = rules.onPendingApproval((approval) => {
      setPendingApprovals((prev) => [...prev, approval]);
    });

    return unsubscribe;
  }, [isInitialized]);

  // Analyze complexity
  const analyzeComplexity = useCallback(async (goal: string): Promise<ComplexityAnalysis | null> => {
    if (!goal.trim()) return null;

    setIsAnalyzing(true);
    setError(null);

    try {
      const analysis = await aiService.analyzeTaskComplexity(goal.trim());
      const result: ComplexityAnalysis = {
        score: analysis.complexity,
        agentCount: Math.min(analysis.agentCount, 8),
        reasoning: analysis.reasoning,
        factors: [],
        estimatedDuration: analysis.agentCount * 10,
      };
      setComplexity(result);
      return result;
    } catch (err) {
      setError(`Failed to analyze: ${err}`);
      return null;
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  // Start task
  const startTask = useCallback(async (goal: string, constraints: string[] = []): Promise<SwarmTask | null> => {
    if (!isInitialized) {
      setError('Orchestrator not initialized');
      return null;
    }

    try {
      const newTask = await orchestratorRef.current.startTask(goal, constraints);
      setError(null);
      return newTask;
    } catch (err) {
      setError(`Failed to start: ${err}`);
      return null;
    }
  }, [isInitialized]);

  // Pause task
  const pauseTask = useCallback(async () => {
    try {
      await orchestratorRef.current.pauseTask();
      setError(null);
    } catch (err) {
      setError(`Failed to pause: ${err}`);
    }
  }, []);

  // Resume task
  const resumeTask = useCallback(async () => {
    try {
      await orchestratorRef.current.resumeTask();
      setError(null);
    } catch (err) {
      setError(`Failed to resume: ${err}`);
    }
  }, []);

  // Abort task
  const abortTask = useCallback(async () => {
    try {
      await orchestratorRef.current.abortTask();
      setError(null);
    } catch (err) {
      setError(`Failed to abort: ${err}`);
    }
  }, []);

  // Kill switch
  const killSwitch = useCallback(async () => {
    try {
      await orchestratorRef.current.killSwitch();
      setAgents([]);
      setPendingApprovals([]);
      setError(null);
    } catch (err) {
      setError(`Kill switch failed: ${err}`);
    }
  }, []);

  // Approve action
  const approveAction = useCallback(async (approvalId: string) => {
    const rules = orchestratorRef.current.getAutomationRules();
    const manager = orchestratorRef.current.getAgentManager();
    if (manager) {
      await rules.resolveApproval(approvalId, true, manager);
      setPendingApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    }
  }, []);

  // Deny action
  const denyAction = useCallback(async (approvalId: string) => {
    const rules = orchestratorRef.current.getAutomationRules();
    const manager = orchestratorRef.current.getAgentManager();
    if (manager) {
      await rules.resolveApproval(approvalId, false, manager);
      setPendingApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    }
  }, []);

  // Set safe mode
  const setSafeMode = useCallback((enabled: boolean) => {
    orchestratorRef.current.getAutomationRules().setSafeMode(enabled);
  }, []);

  // Set dry run mode
  const setDryRunMode = useCallback((enabled: boolean) => {
    orchestratorRef.current.updateConfig({ dryRunMode: enabled });
  }, []);

  // Terminate agent
  const terminateAgent = useCallback(async (agentId: string) => {
    const manager = orchestratorRef.current.getAgentManager();
    if (manager) {
      await manager.terminateAgent(agentId, 'User terminated');
      setAgents(manager.getAllAgents());
    }
  }, []);

  return {
    state,
    task,
    agents,
    pendingApprovals,
    isInitialized,
    error,
    complexity,
    isAnalyzing,
    initialize,
    analyzeComplexity,
    startTask,
    pauseTask,
    resumeTask,
    abortTask,
    killSwitch,
    approveAction,
    denyAction,
    setSafeMode,
    setDryRunMode,
    terminateAgent,
  };
}
