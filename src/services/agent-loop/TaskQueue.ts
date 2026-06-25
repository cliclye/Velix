import type { Task } from './types';

let taskCounter = 0;

function depToString(dep: unknown): string {
  if (typeof dep === 'string') return dep.trim();
  if (typeof dep === 'number' && Number.isFinite(dep)) return String(dep);
  if (dep == null) return '';
  return String(dep).trim();
}

function normalizeDependencies(deps: unknown): string[] {
  if (!Array.isArray(deps)) return [];
  return deps.map(depToString).filter(Boolean);
}

function newTaskId(): string {
  taskCounter += 1;
  return `task-${Date.now()}-${taskCounter}`;
}

export class TaskQueue {
  private tasks: Task[] = [];

  getAll(): Task[] {
    return [...this.tasks].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.createdAt - b.createdAt;
    });
  }

  add(input: {
    title: string;
    description: string;
    priority?: number;
    dependencies?: unknown;
  }): Task {
    const now = Date.now();
    const title =
      typeof input.title === 'string' ? input.title.trim() : String(input.title ?? '').trim();
    const description =
      typeof input.description === 'string'
        ? input.description.trim()
        : String(input.description ?? '').trim();
    const task: Task = {
      id: newTaskId(),
      title: title || 'Untitled task',
      description: description || title || 'No description',
      status: 'pending',
      priority: input.priority ?? 0,
      retries: 0,
      dependencies: normalizeDependencies(input.dependencies),
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    return task;
  }

  addMany(
    items: Array<{
      title: string;
      description: string;
      priority?: number;
      dependencies?: unknown;
    }>,
  ): Task[] {
    const created: Task[] = [];
    for (const item of items) {
      created.push(
        this.add({
          title: item.title,
          description: item.description,
          priority: item.priority,
          dependencies: [],
        }),
      );
    }
    for (let i = 0; i < items.length; i++) {
      const rawDeps = normalizeDependencies(items[i].dependencies);
      created[i].dependencies = this.resolveDependencyRefs(rawDeps, created, i);
    }
    return created;
  }

  /** Map planner dependency strings (IDs, titles, or indices) to task IDs. */
  private resolveDependencyRefs(
    rawDeps: string[],
    batchTasks: Task[],
    selfIndex: number,
  ): string[] {
    const allTasks = [...this.tasks, ...batchTasks];
    const idSet = new Set(allTasks.map((t) => t.id));
    const titleToId = new Map(allTasks.map((t) => [t.title.toLowerCase(), t.id]));
    return rawDeps
      .map((dep) => {
        const trimmed = depToString(dep);
        if (!trimmed) return '';
        if (idSet.has(trimmed)) return trimmed;
        const byTitle = titleToId.get(trimmed.toLowerCase());
        if (byTitle) return byTitle;
        const idx = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(idx) && idx >= 0 && idx < batchTasks.length && idx !== selfIndex) {
          return batchTasks[idx].id;
        }
        return '';
      })
      .filter(Boolean);
  }

  resetRunningTasks(): void {
    for (const task of this.tasks) {
      if (task.status === 'running') {
        task.status = 'failed';
        task.updatedAt = Date.now();
      }
    }
  }

  remove(taskId: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
  }

  retry(taskId: string): Task | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    task.status = 'pending';
    task.retries += 1;
    task.updatedAt = Date.now();
    return task;
  }

  reorder(taskId: string, newPriority: number): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.priority = newPriority;
    task.updatedAt = Date.now();
  }

  getNextRunnable(): Task | null {
    const resolved = new Set(
      this.tasks
        .filter((t) => t.status === 'complete' || t.status === 'failed')
        .map((t) => t.id),
    );
    const sorted = this.getAll();
    for (const task of sorted) {
      if (task.status !== 'pending') continue;
      if (task.dependencies.length === 0) return task;
      const depsMet = task.dependencies.every((dep) => resolved.has(dep));
      if (depsMet) return task;
    }
    return null;
  }

  markRunning(taskId: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.status = 'running';
    task.updatedAt = Date.now();
  }

  markComplete(taskId: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.status = 'complete';
    task.updatedAt = Date.now();
  }

  markFailed(taskId: string): void {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.status = 'failed';
    task.updatedAt = Date.now();
  }

  hasPendingOrRunning(): boolean {
    return this.tasks.some((t) => t.status === 'pending' || t.status === 'running');
  }

  hasFailures(): boolean {
    return this.tasks.some((t) => t.status === 'failed');
  }

  allComplete(): boolean {
    return this.tasks.length > 0 && this.tasks.every((t) => t.status === 'complete');
  }

  progressPercent(): number {
    if (this.tasks.length === 0) return 0;
    const done = this.tasks.filter((t) => t.status === 'complete').length;
    return Math.round((done / this.tasks.length) * 100);
  }

  clear(): void {
    this.tasks = [];
  }

  replaceAll(tasks: Task[]): void {
    this.tasks = tasks;
  }
}
