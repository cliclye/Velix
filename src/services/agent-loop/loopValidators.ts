import type { PlanOutput } from './types';

export const PLAN_PLACEHOLDER_TEXT = new Set([
  'short title',
  'title',
  'task',
  'actionable description',
  'description',
  'one-line plan summary',
  '<one sentence describing the plan>',
  '<specific task name>',
  '<concrete steps the coder should take>',
  '...',
]);

export function isPlaceholderPlanText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return PLAN_PLACEHOLDER_TEXT.has(normalized);
}

export function isResearchTask(task: { title: string; description: string }): boolean {
  const text = `${task.title} ${task.description}`.toLowerCase();
  return /\b(research|explore|audit|investigate|analyze|read[- ]only|survey|discover)\b/.test(text);
}

export function hasLoopDeliverables(modifiedFiles: string[], executedCommands: string[]): boolean {
  return modifiedFiles.length > 0 || executedCommands.length > 0;
}

export function canClaimGoalReached(
  mode: 'assist' | 'guided' | 'autonomous' | 'infinite',
  modifiedFiles: string[],
  executedCommands: string[],
): boolean {
  if (mode === 'assist') return true;
  return hasLoopDeliverables(modifiedFiles, executedCommands);
}

export function isValidPlanOutput(plan: PlanOutput | null): boolean {
  if (!plan?.tasks?.length) return false;
  if (isPlaceholderPlanText(plan.summary ?? '')) return false;
  return plan.tasks.some((task) => {
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    const description = typeof task.description === 'string' ? task.description.trim() : '';
    return title && description && !isPlaceholderPlanText(title) && !isPlaceholderPlanText(description);
  });
}
