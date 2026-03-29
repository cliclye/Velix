import React, { useState, useCallback } from 'react';
import '../styles/AutomationPanel.css';
import { aiService } from '../services/ai/AIService';
import { PROVIDERS } from '../services/ai/types';
import { getWorkerCLIOptions } from '../services/swarm';
import { TerminalRef } from './TerminalBlock';

/** Same key as Swarm — whichever worker CLI is selected there is used for automation dispatch. */
const WORKER_CLI_STORAGE_KEY = 'velix-swarm-worker-cli';

function resolveAutomationCliCommand(): string {
  if (typeof window === 'undefined') return 'claude';
  const stored = window.localStorage.getItem(WORKER_CLI_STORAGE_KEY);
  const options = getWorkerCLIOptions();
  const byId = stored ? options.find((o) => o.id === stored) : undefined;
  const fallback = options.find((o) => o.id === 'claude') ?? options[0];
  return (byId ?? fallback)?.command ?? 'claude';
}

interface TerminalTab {
  id: string;
  title: string;
}

interface SubTask {
  id: string;
  prompt: string;
  assignedTabId: string | null;
}

interface AutomationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  hasApiKey: boolean;
  configuredProviders: Array<{ id: string; name: string }>;
  terminalTabs: TerminalTab[];
  terminalRefs: React.MutableRefObject<Map<string, TerminalRef>>;
  onAddTerminal: () => void;
  onGeneratePrompts?: (goal: string, count: number) => Promise<string[]>;
  onStartAutomation?: (prompts: string[]) => void;
}

const TEMPLATES = [
  'Review the codebase and identify potential bugs or issues',
  'Add comprehensive error handling to all async functions',
  'Write unit tests for the main components',
  'Optimize performance and reduce bundle size',
];

export const AutomationPanel: React.FC<AutomationPanelProps> = ({
  isOpen,
  onClose,
  theme,
  hasApiKey,
  configuredProviders,
  terminalTabs,
  terminalRefs,
  onAddTerminal,
  onGeneratePrompts,
}) => {
  const [goal, setGoal] = useState('');
  const [subtasks, setSubtasks] = useState<SubTask[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [complexityAnalysis, setComplexityAnalysis] = useState<{
    complexity: number;
    agentCount: number;
    reasoning: string;
  } | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchStatus, setDispatchStatus] = useState<Record<string, 'dispatched' | 'error'>>({});
  const [selectedModel, setSelectedModel] = useState<string>(aiService.getConfig().model);

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    const provider = PROVIDERS.find(p => p.models.includes(model));
    if (provider) {
      aiService.setProvider(provider.id, model);
    }
  };

  const handleAnalyze = useCallback(async () => {
    if (!goal.trim() || !hasApiKey) return;

    setIsAnalyzing(true);
    setComplexityAnalysis(null);
    setSubtasks([]);
    setDispatchStatus({});

    try {
      const analysis = await aiService.analyzeTaskComplexity(goal.trim());
      setComplexityAnalysis(analysis);
    } catch (err) {
      console.error('Failed to analyze task:', err);
    } finally {
      setIsAnalyzing(false);
    }
  }, [goal, hasApiKey]);

  const handleGenerateSubtasks = useCallback(async () => {
    if (!goal.trim() || !hasApiKey || !onGeneratePrompts) return;

    const count = complexityAnalysis?.agentCount ?? Math.max(terminalTabs.length, 1);

    setIsGenerating(true);
    try {
      const prompts = await onGeneratePrompts(goal.trim(), count);
      const newSubtasks: SubTask[] = prompts.map((prompt, i) => ({
        id: `subtask-${Date.now()}-${i}`,
        prompt,
        // Auto-assign round-robin to available terminals
        assignedTabId: terminalTabs[i % terminalTabs.length]?.id ?? null,
      }));
      setSubtasks(newSubtasks);
      setDispatchStatus({});
    } catch (err) {
      console.error('Failed to generate subtasks:', err);
    } finally {
      setIsGenerating(false);
    }
  }, [goal, hasApiKey, onGeneratePrompts, complexityAnalysis, terminalTabs]);

  const handleDispatch = useCallback(async () => {
    if (!hasApiKey || subtasks.length === 0) return;

    setDispatching(true);
    const newStatus: Record<string, 'dispatched' | 'error'> = {};

    for (const subtask of subtasks) {
      if (!subtask.assignedTabId) {
        newStatus[subtask.id] = 'error';
        continue;
      }

      const terminalRef = terminalRefs.current.get(subtask.assignedTabId);
      if (!terminalRef) {
        newStatus[subtask.id] = 'error';
        continue;
      }

      try {
        const escaped = subtask.prompt.replace(/'/g, "'\\''");
        const cmd = resolveAutomationCliCommand();
        terminalRef.write(`${cmd} '${escaped}'\r`);
        newStatus[subtask.id] = 'dispatched';
      } catch {
        newStatus[subtask.id] = 'error';
      }

      // Small delay between dispatches
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    setDispatchStatus(newStatus);
    setDispatching(false);

    // Close after a moment so user can see the confirmation
    setTimeout(() => onClose(), 1200);
  }, [hasApiKey, subtasks, terminalRefs, onClose]);

  // Broadcast the same goal to every open session
  const handleBroadcast = useCallback(async () => {
    if (!goal.trim() || !hasApiKey || terminalTabs.length === 0) return;

    for (const tab of terminalTabs) {
      const ref = terminalRefs.current.get(tab.id);
      if (ref) {
        const escaped = goal.trim().replace(/'/g, "'\\''");
        const cmd = resolveAutomationCliCommand();
        ref.write(`${cmd} '${escaped}'\r`);
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    onClose();
  }, [goal, hasApiKey, terminalTabs, terminalRefs, onClose]);

  const handleAssign = (subtaskId: string, tabId: string | null) => {
    setSubtasks(prev => prev.map(st =>
      st.id === subtaskId ? { ...st, assignedTabId: tabId } : st
    ));
  };

  if (!isOpen) return null;

  const allDispatched = subtasks.length > 0 && subtasks.every(st => dispatchStatus[st.id] === 'dispatched');
  const canDispatch = subtasks.some(st => st.assignedTabId);

  return (
    <div className={`automation-panel ${theme}`}>
      <div className="automation-header">
        <h2>Terminal automation</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="automation-content">
        {!hasApiKey && (
          <div className="automation-api-key-required">
            <strong>API Key Required</strong>
            <p>Add an API key in Settings to use the automation controller.</p>
          </div>
        )}

        {/* Model Selector */}
        <div className="automation-section">
          <div className="model-row">
            <label className="model-label">AI Model</label>
            <select
              value={selectedModel}
              onChange={e => handleModelChange(e.target.value)}
              className="model-select"
              disabled={isAnalyzing || isGenerating || dispatching}
            >
              {PROVIDERS.flatMap(p => {
                const isConfigured = configuredProviders.some(cp => cp.id === p.id);
                return p.models.map(m => (
                  <option key={m} value={m} disabled={!isConfigured}>
                    {m} ({p.name}){isConfigured ? '' : ' — Setup Required'}
                  </option>
                ));
              })}
            </select>
          </div>
        </div>

        {/* Active Sessions */}
        <div className="automation-section">
          <div className="section-header-row">
            <h3>Active Sessions ({terminalTabs.length})</h3>
            <button className="add-session-btn" onClick={onAddTerminal}>+ New</button>
          </div>
          <div className="sessions-grid">
            {terminalTabs.map(tab => (
              <div key={tab.id} className="session-card">
                <span className="session-dot" />
                <span className="session-name">{tab.title}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Goal Input */}
        <div className="automation-section">
          <h3>Goal</h3>
          <textarea
            value={goal}
            onChange={e => setGoal(e.target.value)}
            placeholder="Describe what you want to build or fix across your sessions..."
            disabled={!hasApiKey || isAnalyzing || isGenerating || dispatching}
            rows={4}
            className="goal-textarea"
          />
          <div className="templates">
            <span className="hint-text">Templates:</span>
            <div className="template-list">
              {TEMPLATES.map((t, i) => (
                <button
                  key={i}
                  className="template-btn"
                  onClick={() => setGoal(t)}
                  disabled={!hasApiKey || isAnalyzing || dispatching}
                >
                  {t.length > 48 ? t.slice(0, 48) + '…' : t}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Complexity Analysis */}
        {complexityAnalysis && (
          <div className="automation-section complexity-section">
            <div className="complexity-row">
              <span className="complexity-label">Complexity</span>
              <span className={`complexity-badge ${complexityAnalysis.complexity >= 7 ? 'high' : complexityAnalysis.complexity >= 4 ? 'medium' : 'low'}`}>
                {complexityAnalysis.complexity}/10
              </span>
              <span className="agent-count-badge">{complexityAnalysis.agentCount} agents recommended</span>
            </div>
            <p className="complexity-reasoning">{complexityAnalysis.reasoning}</p>
            <button
              className="generate-btn"
              onClick={handleGenerateSubtasks}
              disabled={isGenerating || !onGeneratePrompts}
            >
              {isGenerating ? 'Generating Subtasks…' : `Split into ${complexityAnalysis.agentCount} Subtasks`}
            </button>
          </div>
        )}

        {/* Subtask Assignments */}
        {subtasks.length > 0 && (
          <div className="automation-section">
            <h3>Task Distribution</h3>
            <div className="subtasks-list">
              {subtasks.map((st, i) => (
                <div key={st.id} className={`subtask-card ${dispatchStatus[st.id] ?? ''}`}>
                  <div className="subtask-header">
                    <span className="subtask-index">#{i + 1}</span>
                    <select
                      className="terminal-assign-select"
                      value={st.assignedTabId ?? ''}
                      onChange={e => handleAssign(st.id, e.target.value || null)}
                    >
                      <option value="">— Unassigned —</option>
                      {terminalTabs.map(tab => (
                        <option key={tab.id} value={tab.id}>{tab.title}</option>
                      ))}
                    </select>
                    {dispatchStatus[st.id] === 'dispatched' && <span className="dispatch-badge dispatched">✓ Sent</span>}
                    {dispatchStatus[st.id] === 'error' && <span className="dispatch-badge error-badge">✗ Failed</span>}
                  </div>
                  <p className="subtask-prompt">{st.prompt}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer Controls */}
      <div className="automation-footer">
        {subtasks.length > 0 ? (
          <button
            className="dispatch-btn"
            onClick={handleDispatch}
            disabled={dispatching || allDispatched || !canDispatch}
          >
            {dispatching ? 'Dispatching…' : allDispatched ? '✓ Dispatched' : 'Dispatch to Sessions'}
          </button>
        ) : (
          <button
            className="start-btn"
            onClick={handleAnalyze}
            disabled={!hasApiKey || !goal.trim() || isAnalyzing || isGenerating}
          >
            {isAnalyzing ? 'Analyzing…' : 'Analyze & Split Tasks'}
          </button>
        )}
        <button
          className="broadcast-btn"
          onClick={handleBroadcast}
          disabled={!hasApiKey || !goal.trim() || dispatching}
          title="Send the same goal to every open session at once"
        >
          Broadcast to All
        </button>
      </div>
    </div>
  );
};
