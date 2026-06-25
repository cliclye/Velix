/**
 * Timeline simulations for agent-loop invariants.
 * Run: npx tsx src/services/agent-loop/loopSimulations.test.ts
 */

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
import { TaskQueue } from './TaskQueue';
import { parseActionsFromResponse, actionsProduceDeliverables } from './AgentTools';
import {
  canClaimGoalReached,
  isPlaceholderPlanText,
  isValidPlanOutput,
  isResearchTask,
} from './loopValidators';

function simulateUserRequestTimeline() {
  // T0: User asks "add dark mode" — Codex echoes planner template
  assert(
    !isValidPlanOutput({
      summary: 'one-line plan summary',
      tasks: [{ title: 'short title', description: 'actionable description', priority: 10, dependencies: [] }],
    }),
    'BUG: placeholder plan must be rejected',
  );

  // T1: Valid plan with cross-batch dependency
  const queue = new TaskQueue();
  const a = queue.add({ title: 'Setup theme tokens', description: 'Add CSS vars', priority: 10 });
  queue.addMany([
    {
      title: 'Wire toggle',
      description: 'Use tokens in App',
      priority: 9,
      dependencies: [a.title],
    },
  ]);
  const runnable = queue.getNextRunnable();
  assert(runnable?.title === 'Setup theme tokens', 'first task should be setup');
  queue.markComplete(a.id);
  const next = queue.getNextRunnable();
  assert(next?.title === 'Wire toggle', 'BUG: deps must resolve by title across batches');

  // T2: Coder returns read-only actions for coding task
  const readOnly = parseActionsFromResponse(
    '```json\n{"actions":[{"type":"read_file","path":"src/App.tsx"}]}\n```',
  );
  assert(readOnly.actions.length > 0, 'read actions parse');
  assert(!actionsProduceDeliverables(readOnly.actions), 'read-only is not deliverable');
  assert(
    !isResearchTask({ title: 'Add dark mode', description: 'Implement theme toggle' }),
    'coding task is not research',
  );

  // T3: Goal reached without deliverables
  assert(!canClaimGoalReached('guided', [], []), 'guided needs deliverables');
  assert(canClaimGoalReached('assist', [], []), 'assist allows plan-only');

  // T4: Stop mid-task leaves no stuck running
  const q2 = new TaskQueue();
  const t = q2.add({ title: 'Run', description: 'Do work', priority: 1 });
  q2.markRunning(t.id);
  q2.resetRunningTasks();
  assert(q2.getAll()[0].status === 'failed', 'running task reset on abort');

  // T5: edit_file patch fields parse
  const patch = parseActionsFromResponse(
    '{"actions":[{"type":"edit_file","path":"a.ts","old_string":"foo","new_string":"bar"}]}',
  );
  assert(patch.actions[0]?.oldString === 'foo', 'old_string parses');
  assert(patch.actions[0]?.newString === 'bar', 'new_string parses');

  console.log('loopSimulations: all timeline checks passed');
}

simulateUserRequestTimeline();
