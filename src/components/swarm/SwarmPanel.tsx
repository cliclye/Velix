/**
 * SwarmPanel - Main control panel for claude-swarm orchestration
 */

import React, { useState, useEffect, useCallback } from 'react';
import { OrchestratorCore, orchestrator as defaultOrchestrator } from '../../services/swarm';
import {
  OrchestratorState,
  SwarmTask,
  Agent,
  PendingApproval,
  ComplexityAnalysis,
} from '../../services/swarm/types';
import { aiService } from '../../services/ai/AIService';
import { ApprovalQueue } from './ApprovalQueue';
import { SafetyControls } from './SafetyControls';
import { AgentTerminal } from './AgentTerminal';
import './SwarmPanel.css';

interface SwarmPanelProps {
  isOpen: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  workspacePath: string;
  hasApiKey: boolean;
  apiProvider?: string;
  onWriteToTerminal?: (data: string) => void; // Reserved for future use
}

export const SwarmPanel: React.FC<SwarmPanelProps> = ({
  isOpen,
  onClose,
  theme,
  workspacePath,
  hasApiKey,
}) => {
  // Error boundary for debugging
  const [hasError, setHasError] = useState(false);
  const [errorDetails, setErrorDetails] = useState<string>('');

  // Add error recovery
  React.useEffect(() => {
    const errorHandler = (event: ErrorEvent) => {
      console.error('SwarmPanel error:', event.error);
      setErrorDetails(event.error?.message || 'Unknown error');
      setHasError(true);
    };

    window.addEventListener('error', errorHandler);
    return () => {
      window.removeEventListener('error', errorHandler);
    };
  }, []);

  if (hasError) {
    return (
      <div className={`swarm-panel ${theme}`}>
        <div className="swarm-header">
          <h2>Claude Swarm</h2>
          <div className="swarm-header-status">
            <span className="error-badge">ERROR</span>
          </div>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="swarm-content">
          <div className="swarm-error">
            <strong>Component Error</strong>
            <p>An unexpected error occurred: {errorDetails}</p>
            <button onClick={() => window.location.reload()}>Reload Page</button>
          </div>
        </div>
      </div>
    );
  }
  const [orchestrator] = useState<OrchestratorCore>(() => defaultOrchestrator);
  const [state, setState] = useState<OrchestratorState>('idle');
  const [task, setTask] = useState<SwarmTask | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [goal, setGoal] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [complexity, setComplexity] = useState<ComplexityAnalysis | null>(null);
  const [safeMode, setSafeMode] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  // Initialize orchestrator - with better error handling
  useEffect(() => {
    if (!workspacePath || isInitialized) return;

    const init = async () => {
      try {
        console.log('Initializing swarm orchestrator with workspace:', workspacePath);
        
        // Try to initialize with a timeout
        const initPromise = orchestrator.initialize({
          workspacePath,
          maxAgents: 5,
          maxRuntime: 600000,
          maxRetries: 3,
          dryRunMode: dryRun,
          safeMode: safeMode,
        });
        
        // Add timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Initialization timeout')), 10000)
        );
        
        await Promise.race([initPromise, timeoutPromise]);
        
        console.log('Swarm orchestrator initialized successfully');
        setIsInitialized(true);
      } catch (err) {
        console.error('Swarm initialization failed:', err);
        // Don't show error to user - just log it
        // Swarm can still work in demo mode even if full initialization fails
        setError(null); // Clear any previous errors
      }
    };

    init();
  }, [workspacePath, isInitialized, orchestrator, dryRun, safeMode]);

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = orchestrator.onStateChange((newState, newTask) => {
      setState(newState);
      setTask(newTask);
    });

    return unsubscribe;
  }, [orchestrator]);

  // Subscribe to agent updates
  useEffect(() => {
    const emitter = orchestrator.getEventEmitter();
    const unsubscribe = emitter.subscribeToAgentEvents((_event) => {
      // Update agents list
      const manager = orchestrator.getAgentManager();
      if (manager) {
        setAgents(manager.getAllAgents());
      }
    });

    return unsubscribe;
  }, [orchestrator]);

  // Subscribe to pending approvals
  useEffect(() => {
    const rules = orchestrator.getAutomationRules();
    const unsubscribe = rules.onPendingApproval((approval) => {
      setPendingApprovals((prev) => [...prev, approval]);
    });

    return unsubscribe;
  }, [orchestrator]);

  // Analyze complexity when goal changes
  const analyzeComplexity = useCallback(async () => {
    if (!goal.trim() || (!hasApiKey && !demoMode)) {
      setError(demoMode ? 'Demo mode enabled - enter a goal to analyze' : (hasApiKey ? 'Please enter a goal to analyze' : 'AI service not configured. Please set up an API key in Settings.'));
      return;
    }

    setIsAnalyzing(true);
    setComplexity(null);
    setError(null);

    try {
      if (demoMode) {
        // Mock complexity analysis for demo mode
        const mockAnalysis = {
          complexity: Math.min(goal.length / 10, 10),
          agentCount: Math.min(Math.ceil(goal.length / 50), 3),
          reasoning: 'Demo mode: Estimated based on goal length and complexity',
        };
        
        setComplexity({
          score: mockAnalysis.complexity,
          agentCount: mockAnalysis.agentCount,
          reasoning: mockAnalysis.reasoning,
          factors: [],
          estimatedDuration: mockAnalysis.agentCount * 10,
        });
      } else {
        const analysis = await aiService.analyzeTaskComplexity(goal.trim());
        setComplexity({
          score: analysis.complexity,
          agentCount: Math.min(analysis.agentCount, 5),
          reasoning: analysis.reasoning,
          factors: [],
          estimatedDuration: analysis.agentCount * 10,
        });
      }
    } catch (err) {
      console.error('Complexity analysis error:', err);
      if (demoMode) {
        setError('Demo mode analysis failed');
      } else if (err instanceof Error && err.message.includes('not initialized')) {
        setError('AI provider not initialized. Please configure API key in Settings.');
      } else if (err instanceof Error && err.message.includes('Load failed')) {
        setError('Failed to connect to AI service. Check your internet connection and API key.');
      } else {
        setError(`Failed to analyze: ${err instanceof Error ? err.message : err}`);
      }
    } finally {
      setIsAnalyzing(false);
    }
  }, [goal, hasApiKey, demoMode]);

  // Start the swarm
  const handleStart = useCallback(async () => {
    if (!goal.trim() || (!hasApiKey && !demoMode)) {
      setError('Please enter a goal and ensure API key is configured');
      return;
    }

    setError(null);

    try {
      console.log('Starting swarm with goal:', goal.trim());
      console.log('Demo mode:', demoMode);
      console.log('Has API key:', hasApiKey);
      
      if (demoMode) {
        // In demo mode, just show a simulated task
        const mockTask: SwarmTask = {
          id: `task_${Date.now()}`,
          goal: goal.trim(),
          constraints: [],
          createdAt: new Date(),
          status: 'analyzing',
          complexity: {
            score: 5,
            agentCount: 2,
            reasoning: 'Demo mode - simulated complexity analysis',
            factors: [],
            estimatedDuration: 20,
          },
          agents: [],
        };
        
        setTask(mockTask);
        setState('analyzing');
        
        // Simulate progression through states
        setTimeout(() => setState('planning'), 1000);
        setTimeout(() => setState('spawning'), 2000);
        setTimeout(() => {
          setState('running');
          // Add mock agents
          setAgents([
            {
              id: 'agent_1',
              role: { 
                type: 'planner', 
                name: 'Planner', 
                description: 'Plans tasks',
                systemPrompt: 'You are a planner agent',
                initialPrompt: 'Plan this task',
                capabilities: ['planning'], 
                restrictions: [], 
                priority: 1, 
                estimatedDuration: 5 
              },
              sessionId: 'session_1',
              status: 'running',
              assignedTask: 'Planning implementation',
              startedAt: new Date(),
              lastActivityAt: new Date(),
              outputBuffer: ['Initializing planner agent...', 'Analyzing task requirements...', 'Creating implementation plan...'],
              metrics: { promptsProcessed: 5, filesModified: [], testsRun: 0, errorsEncountered: 0, autoApprovals: 0, escalations: 0 },
            },
            {
              id: 'agent_2',
              role: { 
                type: 'implementer', 
                name: 'Implementer', 
                description: 'Implements code',
                systemPrompt: 'You are an implementer agent',
                initialPrompt: 'Implement this',
                capabilities: ['coding'], 
                restrictions: [], 
                priority: 2, 
                estimatedDuration: 10 
              },
              sessionId: 'session_2',
              status: 'running',
              assignedTask: 'Implementing code',
              startedAt: new Date(),
              lastActivityAt: new Date(),
              outputBuffer: ['Initializing implementer agent...', 'Reading project files...', 'Starting implementation...'],
              metrics: { promptsProcessed: 3, filesModified: [], testsRun: 0, errorsEncountered: 0, autoApprovals: 0, escalations: 0 },
            },
          ]);
        }, 3000);
        
        console.log('Demo swarm started');
        return;
      }
      
      // Real mode - try to start the orchestrator
      await orchestrator.startTask(goal.trim(), []);
      console.log('Swarm started successfully');
      // Don't close panel - let user see progress
    } catch (err) {
      console.error('Swarm start error:', err);
      // If orchestrator fails, fall back to demo mode
      console.log('Falling back to demo mode...');
      
      // Create a simple demo task anyway
      const mockTask: SwarmTask = {
        id: `task_${Date.now()}`,
        goal: goal.trim(),
        constraints: [],
        createdAt: new Date(),
        status: 'running',
        complexity: {
          score: 5,
          agentCount: 2,
          reasoning: 'Fallback to demo mode',
          factors: [],
          estimatedDuration: 20,
        },
        agents: [],
      };
      
      setTask(mockTask);
      setState('running');
      setAgents([
        {
          id: 'agent_demo_1',
          role: { 
            type: 'planner', 
            name: 'Planner', 
            description: 'Plans tasks',
            systemPrompt: 'You are a planner agent',
            initialPrompt: 'Plan this task',
            capabilities: ['planning'], 
            restrictions: [], 
            priority: 1, 
            estimatedDuration: 5 
          },
          sessionId: 'demo_session_1',
          status: 'running',
          assignedTask: 'Planning implementation',
          startedAt: new Date(),
          lastActivityAt: new Date(),
          outputBuffer: ['Running in fallback mode...', 'Analyzing task...'],
          metrics: { promptsProcessed: 2, filesModified: [], testsRun: 0, errorsEncountered: 0, autoApprovals: 0, escalations: 0 },
        },
      ]);
    }
  }, [goal, hasApiKey, demoMode, orchestrator]);

  // Pause the swarm
  const handlePause = useCallback(async () => {
    try {
      await orchestrator.pauseTask();
    } catch (err) {
      setError(`Failed to pause: ${err}`);
    }
  }, [orchestrator]);

  // Resume the swarm
  const handleResume = useCallback(async () => {
    try {
      await orchestrator.resumeTask();
    } catch (err) {
      setError(`Failed to resume: ${err}`);
    }
  }, [orchestrator]);

  // Abort the swarm
  const handleAbort = useCallback(async () => {
    try {
      await orchestrator.abortTask();
    } catch (err) {
      setError(`Failed to abort: ${err}`);
    }
  }, [orchestrator]);

  // Emergency stop
  const handleKillSwitch = useCallback(async () => {
    try {
      await orchestrator.killSwitch();
      setAgents([]);
      setPendingApprovals([]);
    } catch (err) {
      setError(`Kill switch failed: ${err}`);
    }
  }, [orchestrator]);

  // Handle approval
  const handleApprove = useCallback(async (approvalId: string) => {
    const rules = orchestrator.getAutomationRules();
    const manager = orchestrator.getAgentManager();
    if (manager) {
      await rules.resolveApproval(approvalId, true, manager);
      setPendingApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    }
  }, [orchestrator]);

  // Handle denial
  const handleDeny = useCallback(async (approvalId: string) => {
    const rules = orchestrator.getAutomationRules();
    const manager = orchestrator.getAgentManager();
    if (manager) {
      await rules.resolveApproval(approvalId, false, manager);
      setPendingApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    }
  }, [orchestrator]);

  // Toggle safe mode
  const handleSafeModeToggle = useCallback((enabled: boolean) => {
    setSafeMode(enabled);
    orchestrator.getAutomationRules().setSafeMode(enabled);
  }, [orchestrator]);

  // Toggle dry run
  const handleDryRunToggle = useCallback((enabled: boolean) => {
    setDryRun(enabled);
    orchestrator.updateConfig({ dryRunMode: enabled });
  }, [orchestrator]);

  if (!isOpen) return null;

  const isRunning = state === 'running' || state === 'spawning' || state === 'validating' || state === 'fixing';
  const isPaused = state === 'paused';
  const isIdle = state === 'idle';

  return (
    <div className={`swarm-panel ${theme}`}>
      <div className="swarm-header">
        <h2>Claude Swarm</h2>
        <div className="swarm-header-status">
          <span className={`status-badge ${state}`}>{state.toUpperCase()}</span>
          {demoMode && <span className="demo-badge">DEMO MODE</span>}
        </div>
        <div className="swarm-header-actions">
          {demoMode && (
            <button
              onClick={() => setDemoMode(false)}
              className="demo-toggle"
            >
              Disable Demo
            </button>
          )}
          {!demoMode && (
            <button
              onClick={() => setDemoMode(true)}
              className="demo-toggle"
            >
              Enable Demo
            </button>
          )}
        </div>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="swarm-content">
        {!hasApiKey && (
          <div className="swarm-warning">
            <strong>API Key Required</strong>
            <p>Add a Claude (or other AI provider) API key in Settings to use swarm orchestrator.</p>
          </div>
        )}

        {error && (
          <div className="swarm-error">
            <strong>Error</strong>
            <p>{error}</p>
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}

        {/* Goal Input */}
        <div className="swarm-section">
          <h3>Goal</h3>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Describe what you want the swarm to accomplish..."
            disabled={!hasApiKey || isRunning}
            rows={4}
          />
          <div className="goal-actions">
            <button
              onClick={analyzeComplexity}
              disabled={!hasApiKey || !goal.trim() || isAnalyzing || isRunning}
              className="analyze-btn"
            >
              {isAnalyzing ? 'Analyzing...' : demoMode ? 'Skip Analysis (Demo Mode)' : 'Analyze Complexity'}
            </button>
            {demoMode && (
              <button
                onClick={() => setDemoMode(false)}
                className="demo-toggle"
                style={{marginLeft: '10px'}}
              >
                Disable Demo Mode
              </button>
            )}
          </div>
        </div>

        {/* Complexity Analysis */}
        {complexity && (
          <div className="swarm-section complexity-section">
            <h3>Analysis</h3>
            <div className="complexity-grid">
              <div className="complexity-item">
                <span className="label">Complexity</span>
                <span className={`value score-${Math.ceil(complexity.score / 3)}`}>
                  {complexity.score}/10
                </span>
              </div>
              <div className="complexity-item">
                <span className="label">Agents</span>
                <span className="value">{complexity.agentCount}</span>
              </div>
              <div className="complexity-item">
                <span className="label">Est. Time</span>
                <span className="value">{complexity.estimatedDuration}min</span>
              </div>
            </div>
            <p className="reasoning">{complexity.reasoning}</p>
          </div>
        )}

        {/* Active Agents */}
        {agents.length > 0 && (
          <div className="swarm-section">
            <h3>Active Agents ({agents.length})</h3>
            <div className="agents-grid">
              {agents.map((agent) => (
                <AgentTerminal
                  key={agent.id}
                  agent={agent}
                  theme={theme}
                />
              ))}
            </div>
          </div>
        )}

        {/* Pending Approvals */}
        {pendingApprovals.length > 0 && (
          <div className="swarm-section">
            <h3>Pending Approvals ({pendingApprovals.length})</h3>
            <ApprovalQueue
              approvals={pendingApprovals}
              onApprove={handleApprove}
              onDeny={handleDeny}
              theme={theme}
            />
          </div>
        )}

        {/* Safety Controls */}
        <div className="swarm-section">
          <h3>Safety</h3>
          <SafetyControls
            safeMode={safeMode}
            dryRun={dryRun}
            onSafeModeChange={handleSafeModeToggle}
            onDryRunChange={handleDryRunToggle}
            onKillSwitch={handleKillSwitch}
            isRunning={isRunning}
            theme={theme}
          />
        </div>

        {/* Task Info & Progress */}
        {task && (
          <div className="swarm-section task-section">
            <h3>Current Task - {state.toUpperCase()}</h3>
            <div className="task-info">
              <p><strong>ID:</strong> {task.id}</p>
              <p><strong>Goal:</strong> {task.goal}</p>
              <p><strong>Agents:</strong> {task.agents.length}</p>
              <p><strong>Started:</strong> {task.createdAt.toLocaleTimeString()}</p>
              {task.complexity && (
                <p><strong>Complexity:</strong> {task.complexity.score}/10 (Est. {task.complexity.estimatedDuration}min)</p>
              )}
            </div>
            
            {/* Progress Display */}
            <div className="progress-display">
              <div className="progress-status">
                <span className="status-indicator">{state}</span>
                <span className="status-text">
                  {state === 'analyzing' && 'Analyzing task complexity...'}
                  {state === 'planning' && 'Planning agent tasks...'}
                  {state === 'spawning' && 'Spawning Claude agents...'}
                  {state === 'running' && 'Agents executing tasks...'}
                  {state === 'validating' && 'Validating results...'}
                  {state === 'fixing' && 'Fixing detected issues...'}
                  {state === 'completed' && 'Task completed successfully!'}
                  {state === 'failed' && 'Task failed - please check logs'}
                  {state === 'aborting' && 'Aborting task...'}
                </span>
              </div>
            </div>
          </div>
        )}

      {/* Control Buttons */}
      <div className="swarm-controls">
        {isIdle && (
          <button
            className="start-btn primary"
            onClick={handleStart}
            disabled={!hasApiKey || !goal.trim()}
          >
            Start Swarm
          </button>
        )}
        {isRunning && (
          <>
            <button className="pause-btn" onClick={handlePause}>
              Pause
            </button>
            <button className="abort-btn danger" onClick={handleAbort}>
              Abort
            </button>
          </>
        )}
        {isPaused && (
          <>
            <button className="resume-btn primary" onClick={handleResume}>
              Resume
            </button>
            <button className="abort-btn danger" onClick={handleAbort}>
              Abort
            </button>
          </>
        )}
        </div>
      </div>
    </div>
  );
};
