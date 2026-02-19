import React, { useState, useCallback } from 'react';
import '../styles/AutomationPanel.css';
import { aiService } from '../services/ai/AIService';
import { PROVIDERS } from '../services/ai/types';

interface AutomationTask {
  id: string;
  name: string;
  prompt: string;
  status: 'idle' | 'running' | 'completed' | 'error';
}

interface AutomationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  hasApiKey: boolean;
  onGeneratePrompts?: (goal: string, count: number) => Promise<string[]>;
  onWriteToTerminal?: (data: string) => void;
}

const DEFAULT_PROMPTS = [
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
  onGeneratePrompts,
  onWriteToTerminal,
}) => {
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [newTaskName, setNewTaskName] = useState('');
  const [newTaskPrompt, setNewTaskPrompt] = useState('');
  const [isAutomationRunning, setIsAutomationRunning] = useState(false);
  const [globalPrompt, setGlobalPrompt] = useState('');
  const [numInstances, setNumInstances] = useState(1);
  const [isGeneratingPrompts, setIsGeneratingPrompts] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(aiService.getConfig().model);
  const [complexityAnalysis, setComplexityAnalysis] = useState<{ complexity: number; agentCount: number; reasoning: string } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    // Find provider for this model
    const provider = PROVIDERS.find(p => p.models.includes(model));
    if (provider) {
      aiService.setProvider(provider.id, model);
    }
  };

  // Start automation for a single task
  const startTask = useCallback(async (task: AutomationTask) => {
    if (!onWriteToTerminal) {
      console.error("Automation: No terminal connection available");
      return;
    }

    // Open Claude Code and pass the generated prompt
    // We wrap the prompt in quotes and escape existing quotes
    const escaped = task.prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const command = `claude "${escaped}"\r`;

    // Send directly to main terminal
    onWriteToTerminal(command);

    // Update status (optimistic, since we can't easily track completion from here anymore)
    setTasks(prev => prev.map(t =>
      t.id === task.id ? { ...t, status: 'completed' } : t
    ));
  }, [onWriteToTerminal]);

  // Start all automation tasks
  const startAllTasks = useCallback(async () => {
    if (!hasApiKey || !onWriteToTerminal) return;

    let tasksToRun = [...tasks];

    // If no tasks and we have generatePrompts: analyze complexity then generate N prompts
    if (tasksToRun.length === 0 && onGeneratePrompts && globalPrompt.trim()) {
      setIsAnalyzing(true);
      setComplexityAnalysis(null);

      let agentCount = numInstances;

      try {
        // 1. Analyze Complexity
        const analysis = await aiService.analyzeTaskComplexity(globalPrompt.trim());
        setComplexityAnalysis(analysis);
        agentCount = analysis.agentCount;
        setNumInstances(agentCount); // Update state to reflect analysis

        setIsAnalyzing(false);
        setIsGeneratingPrompts(true);

        // 2. Generate Prompts based on agent count
        const prompts = await onGeneratePrompts(globalPrompt.trim(), agentCount);
        const newTasks: AutomationTask[] = prompts.map((prompt, i) => ({
          id: `task-${Date.now()}-${i}`,
          name: `Claude ${i + 1}`,
          prompt,
          status: 'idle' as const,
        }));
        setTasks(newTasks);
        tasksToRun = newTasks;
      } catch (err) {
        console.error('Failed to generate prompts:', err);
        setIsAnalyzing(false);
        setIsGeneratingPrompts(false);
        return;
      }
      setIsGeneratingPrompts(false);
    }

    if (tasksToRun.length === 0) return;

    setIsAutomationRunning(true);

    // Close the panel so the user can see the main terminal
    onClose();

    // Run tasks sequentially to avoid overwhelming the single terminal
    for (const task of tasksToRun) {
      if (task.status === 'idle') {
        await startTask(task);
        // Add a small delay between tasks if we were running multiple (though ideally we just run one 'Agent' flow now)
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    setIsAutomationRunning(false);
    // Clear tasks after running so they don't re-run
    setTasks([]);
  }, [tasks, startTask, onGeneratePrompts, globalPrompt, numInstances, hasApiKey, onWriteToTerminal, onClose]);

  // Add a new task
  const addTask = useCallback(() => {
    if (!hasApiKey) return;
    if (!newTaskName.trim() || !newTaskPrompt.trim()) return;

    const newTask: AutomationTask = {
      id: `task-${Date.now()}`,
      name: newTaskName.trim(),
      prompt: newTaskPrompt.trim(),
      status: 'idle',
    };

    setTasks(prev => [...prev, newTask]);
    setNewTaskName('');
    setNewTaskPrompt('');
  }, [newTaskName, newTaskPrompt, hasApiKey]);

  // Quick add (simplified for single terminal focus)
  const quickAddTasks = useCallback(() => {
    if (!hasApiKey) return;
    if (!globalPrompt.trim()) return;

    // For single terminal, we usually just want one task effectively
    const newTask: AutomationTask = {
      id: `task-${Date.now()}`,
      name: 'Claude Agent',
      prompt: globalPrompt.trim(),
      status: 'idle',
    };

    setTasks(prev => [...prev, newTask]);
    setGlobalPrompt('');
  }, [globalPrompt, hasApiKey]);

  // Use template prompt
  const useTemplate = useCallback((prompt: string) => {
    if (!hasApiKey) return;
    setGlobalPrompt(prompt);
  }, [hasApiKey]);

  if (!isOpen) return null;

  return (
    <div className={`automation-panel ${theme}`}>
      <div className="automation-header">
        <h2>Automation Claude Code</h2>
        <button className="close-btn" onClick={onClose}>x</button>
      </div>

      <div className="automation-content">
        {!hasApiKey && (
          <div className="automation-api-key-required">
            <strong>API key required</strong>
            <p>Automation uses an AI to control Claude Code. Add an API key in Settings (Claude, ChatGPT, etc.) to use this feature. Claude Code itself uses your login — the API key is for the automation AI.</p>
          </div>
        )}

        {/* Model Selector */}
        <div className="automation-section">
          <div className="model-selector">
            <label>AI Model:</label>
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="model-select"
              disabled={isAutomationRunning || isAnalyzing}
            >
              {PROVIDERS.flatMap(p => p.models.map(m => (
                <option key={m} value={m}>{m} ({p.name})</option>
              )))}
            </select>
          </div>
        </div>

        {/* Complexity Analysis Result */}
        {complexityAnalysis && (
          <div className="complexity-analysis">
            <div className="complexity-header">
              <span>Task Complexity</span>
              <span className={`complexity-score ${complexityAnalysis.complexity >= 7 ? 'high' : complexityAnalysis.complexity >= 4 ? 'medium' : 'low'}`}>
                {complexityAnalysis.complexity}/10
              </span>
            </div>
            <div className="agent-count">
              Recommended Agents: <strong>{complexityAnalysis.agentCount}</strong>
            </div>
            <p className="complexity-reasoning">{complexityAnalysis.reasoning}</p>
          </div>
        )}

        {/* Quick Setup Section */}
        <div className="automation-section">
          <h3>Quick Setup</h3>
          <p className="hint-text">Commands will run in your main terminal.</p>
          <div className="quick-setup">
            <div className="input-row">
              <label>Goal:</label>
              <textarea
                value={globalPrompt}
                onChange={(e) => setGlobalPrompt(e.target.value)}
                placeholder="e.g. Review and improve the codebase. Fix bugs and add tests..."
                disabled={!hasApiKey || isAutomationRunning}
                rows={3}
              />
            </div>
            <button
              className="add-btn"
              onClick={quickAddTasks}
              disabled={!hasApiKey || !globalPrompt.trim() || isAutomationRunning}
            >
              Start Agent
            </button>
          </div>

          {/* Template Prompts */}
          <div className="templates">
            <h4>Quick Templates:</h4>
            <div className="template-list">
              {DEFAULT_PROMPTS.map((prompt, idx) => (
                <button
                  key={idx}
                  className="template-btn"
                  onClick={() => useTemplate(prompt)}
                  disabled={!hasApiKey || isAutomationRunning}
                >
                  {prompt.length > 50 ? prompt.substring(0, 50) + '...' : prompt}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Custom Task Section */}
        <div className="automation-section">
          <h3>Add Custom Task</h3>
          <div className="add-task-form">
            <input
              type="text"
              placeholder="Task name"
              value={newTaskName}
              onChange={(e) => setNewTaskName(e.target.value)}
              disabled={!hasApiKey || isAutomationRunning}
            />
            <textarea
              placeholder="Claude prompt..."
              value={newTaskPrompt}
              onChange={(e) => setNewTaskPrompt(e.target.value)}
              disabled={!hasApiKey || isAutomationRunning}
              rows={2}
            />
            <button
              className="add-btn"
              onClick={addTask}
              disabled={!hasApiKey || !newTaskName.trim() || !newTaskPrompt.trim() || isAutomationRunning}
            >
              Add Task
            </button>
          </div>
        </div>

        {/* Tasks List */}
        {tasks.length > 0 && (
          <div className="automation-section">
            <h3>Tasks Queue ({tasks.length})</h3>
            <div className="tasks-list">
              {tasks.map((task) => (
                <div key={task.id} className={`task-item ${task.status}`}>
                  <div className="task-header">
                    <span className={`status-indicator ${task.status}`} />
                    <span className="task-name">{task.name}</span>
                    <button
                      className="remove-btn"
                      onClick={(e) => { e.stopPropagation(); setTasks(prev => prev.filter(t => t.id !== task.id)); }}
                    >
                      x
                    </button>
                  </div>
                  <div className="task-prompt">{task.prompt}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Control Buttons */}
        <div className="automation-controls">
          <button
            className="start-btn"
            onClick={startAllTasks}
            disabled={!hasApiKey || (tasks.length === 0 && !globalPrompt.trim()) || isGeneratingPrompts || isAnalyzing}
          >
            {isAnalyzing ? 'Analyzing Complexity...' : isGeneratingPrompts ? 'Generating Agents...' : 'Start Automation'}
          </button>

          {tasks.length > 0 && (
            <button className="clear-btn" onClick={() => setTasks([])}>
              Clear Queue
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
