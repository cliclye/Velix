/**
 * AgentLoopEngine — autonomous goal-driven coding loop.
 *
 * Core cycle:
 *   analyzeGoal → generatePlan → executeNextTask → verifyChanges → reflect → updatePlan
 */
import { aiService } from '../ai/AIService';
import { TaskQueue } from './TaskQueue';
import { MemoryStore } from './MemoryStore';
import { executeAction, parseActionsFromResponse, actionsAreResearchOnly, actionsProduceDeliverables } from './AgentTools';
import { runVerification } from './Verifier';
import {
  canClaimGoalReached,
  isResearchTask,
  isValidPlanOutput,
} from './loopValidators';
import type {
  AgentLoopConfig,
  AgentLoopMode,
  LoopActivity,
  LoopCallbacks,
  LoopJsonShape,
  LoopProgress,
  LoopStopReason,
  ModelSlot,
  PlanOutput,
  ReflectionOutput,
} from './types';

const PLANNER_SYSTEM = `You are a senior software planner. Break the user's goal into concrete, ordered tasks.
Respond ONLY with JSON inside a fenced code block. Replace every placeholder below with real content from the user's goal — never echo the example strings literally.

\`\`\`json
{
  "summary": "<one sentence describing the plan>",
  "tasks": [
    {
      "title": "<specific task name>",
      "description": "<concrete steps the coder should take>",
      "priority": 10,
      "dependencies": []
    }
  ]
}
\`\`\``;

const CODER_SYSTEM = `You are an expert coding agent. Execute ONE task at a time in the user's project.

You MUST respond with a single JSON object in a \`\`\`json fenced code block. No prose outside the fence.
The JSON must include a non-empty "actions" array with at least one write_file, edit_file, or run_terminal action unless the task is explicitly research-only.

Valid action types:
- read_file (path)
- write_file / edit_file (path, content OR old_string + new_string, summary)
- search_files (search)
- run_terminal (command, summary)

Example:
\`\`\`json
{
  "actions": [
    { "type": "read_file", "path": "src/App.tsx" },
    { "type": "edit_file", "path": "src/App.tsx", "old_string": "old code", "new_string": "new code", "summary": "Fix bug" }
  ]
}
\`\`\`

Use relative paths from the project root. Prefer small, safe changes. For audit/research tasks, use search_files and read_file before editing.`;

const REFLECTOR_SYSTEM = `You analyze execution results and decide what happens next.
Respond ONLY with JSON:

\`\`\`json
{
  "status": "complete|partial|failed",
  "reason": "explanation",
  "nextAction": "what to do next",
  "newTasks": [
    { "title": "...", "description": "...", "priority": 5, "dependencies": [] }
  ]
}
\`\`\``;

function parseJsonBlock<T>(raw: string): T | null {
  const trimmed = raw.trim();
  const candidates: string[] = [];

  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) candidates.push(jsonFence[1].trim());

  const anyFence = trimmed.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  if (anyFence) candidates.push(anyFence[1].trim());

  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function emitActivity(
  callbacks: LoopCallbacks,
  kind: LoopActivity['kind'],
  message: string,
  taskId?: string,
): void {
  try {
    callbacks.onActivity({
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind,
      message: message.slice(0, 2000),
      timestamp: Date.now(),
      taskId,
    });
  } catch (err) {
    console.error('AgentLoopEngine: onActivity callback failed:', err);
  }
}

function safeCallback(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('AgentLoopEngine: callback failed:', err);
  }
}

function normalizePlanTask(
  raw: unknown,
): { title: string; description: string; priority: number; dependencies: unknown } | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const description =
    typeof item.description === 'string'
      ? item.description.trim()
      : typeof item.title === 'string'
        ? item.title.trim()
        : '';
  if (!title && !description) return null;
  if (isPlaceholderPlanText(title) || isPlaceholderPlanText(description)) return null;
  const priority =
    typeof item.priority === 'number' && Number.isFinite(item.priority) ? item.priority : 0;
  return {
    title: title || description.slice(0, 80),
    description: description || title,
    priority,
    dependencies: item.dependencies,
  };
}

export class AgentLoopEngine {
  private queue = new TaskQueue();
  private memory!: MemoryStore;
  private running = false;
  private stopped = false;
  private iteration = 0;
  private abortController: AbortController | null = null;
  private modifiedFiles: string[] = [];
  private executedCommands: string[] = [];

  async run(
    goal: string,
    workspacePath: string,
    config: AgentLoopConfig,
    callbacks: LoopCallbacks,
  ): Promise<LoopStopReason> {
    if (this.running) throw new Error('Agent loop is already running');
    this.running = true;
    this.stopped = false;
    this.iteration = 0;
    this.modifiedFiles = [];
    this.executedCommands = [];
    this.abortController = new AbortController();
    this.queue.clear();
    this.memory = MemoryStore.load(workspacePath, goal);
    this.memory.resetSessionForRun(goal);
    safeCallback(() => callbacks.onMemoryChanged(this.memory.get()));

    let finalStopReason: LoopStopReason | null = null;

    const updateProgress = (currentTaskId: string | null, stopReason: LoopStopReason | null = null) => {
      if (stopReason) finalStopReason = stopReason;
      const progress: LoopProgress = {
        iteration: this.iteration,
        maxIterations: config.maxIterations,
        percent: this.queue.progressPercent(),
        currentTaskId,
        stopReason: stopReason ?? finalStopReason,
        running: this.running && !stopReason && !finalStopReason,
      };
      safeCallback(() => callbacks.onProgress(progress));
    };

    const enqueueTasks = (
      items: Array<{
        title: string;
        description: string;
        priority?: number;
        dependencies?: unknown;
      }>,
      limit: number,
    ): number => {
      const room = Math.max(0, LOOP_LIMITS.maxTasks - this.queue.getAll().length);
      const batch = items.slice(0, Math.min(limit, room));
      if (batch.length > 0) this.queue.addMany(batch);
      return batch.length;
    };

    const iterationLimit =
      config.mode === 'infinite' ? Number.MAX_SAFE_INTEGER : config.maxIterations;

    const toolCtx = {
      workspacePath,
      requireApprovalForEdits: config.mode === 'guided',
      onApprovalRequired: async (request: import('./types').ApprovalRequest) => {
        if (this.stopped) return false;
        emitActivity(callbacks, 'waiting_approval', request.title);
        const approved = await callbacks.onApprovalRequired(request);
        return approved && !this.stopped;
      },
      onFilesModified: (paths: string[]) => {
        this.modifiedFiles.push(...paths);
        safeCallback(() => callbacks.onFilesModified([...new Set(this.modifiedFiles)]));
      },
      onCommandsExecuted: (commands: string[]) => {
        this.executedCommands.push(...commands);
        safeCallback(() => callbacks.onCommandsExecuted([...new Set(this.executedCommands)]));
      },
    };

    try {
      if (config.transport === 'cli' && !config.runCliPrompt) {
        throw new Error('CLI transport requires runCliPrompt');
      }

      if (config.transport === 'cli') {
        emitActivity(
          callbacks,
          'planning',
          `Using local CLI (${config.workerCLI ?? 'claude'}) — subscription billing, not API keys.`,
        );
      }

      emitActivity(callbacks, 'planning', 'Analyzing goal and generating initial plan…');
      await this.generatePlan(goal, config, callbacks);
      safeCallback(() => callbacks.onTasksChanged(this.queue.getAll()));
      updateProgress(null);

      if (config.mode === 'assist') {
        emitActivity(callbacks, 'completed', 'Assist mode: plan ready for review.');
        updateProgress(null, 'goal_completed');
        return 'goal_completed';
      }

      while (!this.stopped && this.iteration < iterationLimit) {
        this.iteration += 1;
        const task = this.queue.getNextRunnable();

        if (!task) {
          if (!this.queue.hasPendingOrRunning()) {
            if (this.queue.hasFailures() || !this.queue.allComplete()) {
              emitActivity(callbacks, 'error', 'Goal not reached — tasks failed or produced no results.');
              updateProgress(null, 'fatal_error');
              return 'fatal_error';
            }
            if (!canClaimGoalReached(config.mode, this.modifiedFiles, this.executedCommands)) {
              emitActivity(
                callbacks,
                'error',
                'Loop finished with no file changes or commands — the goal was not actually implemented.',
              );
              updateProgress(null, 'no_deliverables');
              return 'no_deliverables';
            }
            emitActivity(callbacks, 'completed', 'All tasks complete — goal reached.');
            updateProgress(null, 'goal_completed');
            return 'goal_completed';
          }
          emitActivity(callbacks, 'error', 'No runnable tasks — dependency deadlock or all failed.');
          updateProgress(null, 'fatal_error');
          return 'fatal_error';
        }

        updateProgress(task.id);
        this.queue.markRunning(task.id);
        safeCallback(() => callbacks.onTasksChanged(this.queue.getAll()));
        emitActivity(callbacks, 'executing', `Executing: ${task.title}`, task.id);

        let taskSuccess = false;
        let taskOutput = '';
        const taskPromptBase = `${this.memory.toContextBlock()}\n\nTASK:\n${task.title}\n${task.description}\n\nWorkspace: ${workspacePath}`;
        let lastFailure = '';

        for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
          if (this.stopped) {
            updateProgress(null, 'user_stopped');
            return 'user_stopped';
          }
          if (attempt > 0) {
            emitActivity(
              callbacks,
              'retrying',
              `Retry ${attempt}/${config.maxRetries}: ${task.title} — ${lastFailure.slice(0, 120)}`,
              task.id,
            );
          }

          const retryNote =
            attempt > 0 && lastFailure
              ? `\n\nPREVIOUS ATTEMPT FAILED:\n${lastFailure}\n\nRespond with valid \`\`\`json containing a non-empty "actions" array.`
              : '';

          const execRaw = await this.completeLlm(
            CODER_SYSTEM,
            taskPromptBase + retryNote,
            config.slots.coding,
            config,
            callbacks,
            { label: `Coder: ${task.title}`, maxTokens: 8192, activityKind: 'executing', jsonShape: 'actions', validateResult: (text) => {
              const parsed = parseActionsFromResponse(text);
              if (parsed.actions.length === 0) return false;
              if (isResearchTask(task)) return true;
              return actionsProduceDeliverables(parsed.actions);
            } },
          );

          const parsed = parseActionsFromResponse(execRaw);
          if (parsed.actions.length === 0) {
            lastFailure = parsed.error ?? 'No valid actions in response.';
            taskOutput = lastFailure;
            emitActivity(callbacks, 'error', `${task.title}: ${lastFailure}`, task.id);
            continue;
          }

          let allOk = true;
          let combinedOutput = '';
          let declinedApproval = false;
          let successCount = 0;
          for (const action of parsed.actions) {
            const result = await executeAction(action, toolCtx);
            combinedOutput += `\n[${action.type}] ${result.output}`;
            if (result.success) successCount += 1;
            else {
              allOk = false;
              if (result.output.includes('User declined approval')) {
                declinedApproval = true;
              }
            }
          }
          taskOutput = combinedOutput.trim();

          if (declinedApproval) {
            lastFailure = 'User declined approval.';
            break;
          }

          const researchOnly = actionsAreResearchOnly(parsed.actions);
          if (allOk && actionsProduceDeliverables(parsed.actions)) {
            taskSuccess = true;
            break;
          }
          if (researchOnly && successCount > 0 && isResearchTask(task)) {
            taskSuccess = true;
            break;
          }
          if (researchOnly && successCount > 0 && !isResearchTask(task)) {
            lastFailure =
              'Task only read/searched files. Include write_file, edit_file, or run_terminal actions that implement the task.';
            emitActivity(callbacks, 'error', `${task.title}: ${lastFailure}`, task.id);
            continue;
          }

          lastFailure = combinedOutput.slice(0, 800) || 'One or more actions failed.';
          emitActivity(callbacks, 'error', `${task.title}: action failed`, task.id);
        }

        if (!taskSuccess) {
          this.queue.markFailed(task.id);
          this.memory.recordFailure(`Task failed: ${task.title}`);
          safeCallback(() => callbacks.onTasksChanged(this.queue.getAll()));
          safeCallback(() => callbacks.onMemoryChanged(this.memory.get()));
          continue;
        }

        this.queue.markComplete(task.id);
        this.memory.recordCompletedTask(task.title);
        safeCallback(() => callbacks.onTasksChanged(this.queue.getAll()));
        safeCallback(() => callbacks.onMemoryChanged(this.memory.get()));
        this.memory.persist(workspacePath);

        if (config.mode === 'autonomous' || config.mode === 'infinite') {
          emitActivity(callbacks, 'verifying', 'Running verification checks…', task.id);
          const verification = await runVerification(workspacePath);
          if (!verification.success) {
            emitActivity(callbacks, 'fixing', `Verification failed: ${verification.errors[0] ?? 'unknown'}`, task.id);
            enqueueTasks(
              [
                {
                  title: `Fix verification: ${task.title}`,
                  description: verification.errors.join('\n').slice(0, 2000),
                  priority: task.priority + 5,
                  dependencies: [task.id],
                },
              ],
              1,
            );
            safeCallback(() => callbacks.onTasksChanged(this.queue.getAll()));
          }
        }

        emitActivity(callbacks, 'reflecting', 'Reflecting on progress…', task.id);
        const reflection = await this.reflect(goal, config, callbacks, taskOutput);
        if (reflection?.status === 'complete' && !this.queue.hasPendingOrRunning()) {
          if (!canClaimGoalReached(config.mode, this.modifiedFiles, this.executedCommands)) {
            emitActivity(
              callbacks,
              'error',
              'Reflector marked complete, but no files were changed and no commands were run.',
            );
            updateProgress(null, 'no_deliverables');
            return 'no_deliverables';
          }
          emitActivity(callbacks, 'completed', reflection.reason);
          updateProgress(null, 'goal_completed');
          return 'goal_completed';
        }
        if (reflection?.newTasks?.length) {
          const normalized = reflection.newTasks
            .map(normalizePlanTask)
            .filter((t): t is NonNullable<typeof t> => t !== null);
          const added = enqueueTasks(normalized, LOOP_LIMITS.maxNewTasksPerReflection);
          if (added > 0) {
            safeCallback(() => callbacks.onTasksChanged(this.queue.getAll()));
          }
        }

        updateProgress(null);
      }

      if (this.stopped) {
        updateProgress(null, 'user_stopped');
        return 'user_stopped';
      }
      if (!canClaimGoalReached(config.mode, this.modifiedFiles, this.executedCommands)) {
        emitActivity(
          callbacks,
          'error',
          'Iteration limit reached with no file changes or commands — goal not implemented.',
        );
        updateProgress(null, 'no_deliverables');
        return 'no_deliverables';
      }
      updateProgress(null, 'max_iterations');
      return 'max_iterations';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        emitActivity(callbacks, 'completed', 'Stopped by user.');
        updateProgress(null, 'user_stopped');
        return 'user_stopped';
      }
      const message = err instanceof Error ? err.message : String(err);
      emitActivity(callbacks, 'error', message);
      updateProgress(null, 'fatal_error');
      return 'fatal_error';
    } finally {
      this.queue.resetRunningTasks();
      this.running = false;
      this.abortController = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.abortController?.abort();
  }

  isRunning(): boolean {
    return this.running;
  }

  getTasks() {
    return this.queue.getAll();
  }

  getMemory() {
    return this.memory?.get();
  }

  private async completeLlm(
    system: string,
    user: string,
    slot: ModelSlot,
    config: AgentLoopConfig,
    callbacks: LoopCallbacks,
    options?: {
      label?: string;
      maxTokens?: number;
      activityKind?: LoopActivity['kind'];
      jsonShape?: LoopJsonShape;
      validateResult?: (text: string) => boolean;
    },
  ): Promise<string> {
    const signal = this.abortController?.signal;
    const activityKind = options?.activityKind ?? 'planning';

    if (config.transport === 'cli') {
      if (!config.runCliPrompt) {
        throw new Error('CLI transport selected but runCliPrompt is not configured');
      }
      return config.runCliPrompt(system, user, {
        signal,
        label: options?.label,
        expectJson: true,
        jsonShape: options?.jsonShape ?? 'any',
        validateResult: options?.validateResult,
        onProgress: (message) => emitActivity(callbacks, activityKind, message),
      });
    }

    const apiTimeoutMs = 180_000;
    const apiCall = aiService.chatWithSlot(system, user, slot, {
      signal,
      maxTokens: options?.maxTokens,
    });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`API request timed out after ${Math.round(apiTimeoutMs / 1000)}s`)),
        apiTimeoutMs,
      );
    });
    try {
      return await Promise.race([apiCall, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private async generatePlan(
    goal: string,
    config: AgentLoopConfig,
    callbacks: LoopCallbacks,
  ): Promise<void> {
    const raw = await this.completeLlm(
      PLANNER_SYSTEM,
      `${this.memory.toContextBlock()}\n\nGOAL:\n${goal}`,
      config.slots.planning,
      config,
      callbacks,
      { label: 'Planner', jsonShape: 'plan', validateResult: (text) => isValidPlanOutput(parseJsonBlock<PlanOutput>(text)) },
    );
    const plan = parseJsonBlock<PlanOutput>(raw);
    if (plan && isValidPlanOutput(plan)) {
      const normalized = plan.tasks
        .map(normalizePlanTask)
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .slice(0, LOOP_LIMITS.maxTasks);
      if (normalized.length > 0) {
        this.queue.addMany(normalized);
        emitActivity(callbacks, 'planning', plan.summary || 'Plan created.');
      } else {
        this.queue.add({ title: 'Execute goal', description: goal, priority: 10 });
      }
    } else {
      this.queue.add({ title: 'Execute goal', description: goal, priority: 10 });
    }
    safeCallback(() => callbacks.onTasksChanged(this.queue.getAll()));
  }

  private async reflect(
    goal: string,
    config: AgentLoopConfig,
    callbacks: LoopCallbacks,
    lastOutput: string,
  ): Promise<ReflectionOutput | null> {
    const raw = await this.completeLlm(
      REFLECTOR_SYSTEM,
      `GOAL: ${goal}\n\nTASK OUTPUT:\n${lastOutput}\n\nQUEUE:\n${JSON.stringify(this.queue.getAll().map((t) => ({ title: t.title, status: t.status })))}`,
      config.slots.reasoning,
      config,
      callbacks,
      { label: 'Reflector', activityKind: 'reflecting', jsonShape: 'any' },
    );
    return parseJsonBlock<ReflectionOutput>(raw);
  }
}

export const agentLoopEngine = new AgentLoopEngine();

/** Limits to keep the loop stable and avoid runaway memory / UI crashes. */
export const LOOP_LIMITS = {
  maxTasks: 40,
  maxNewTasksPerReflection: 5,
  maxMemoryListItems: 30,
  maxFilePreviewChars: 80_000,
  maxActivityItems: 120,
} as const;
