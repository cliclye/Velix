import type { GoalMemory, LoopMemory, ProjectMemory, SessionMemory } from './types';

const STORAGE_KEY = 'velix-agent-loop-memory';
const MAX_LIST_ITEMS = 30;

function trimList(items: string[]): string[] {
  if (items.length <= MAX_LIST_ITEMS) return items;
  return items.slice(-MAX_LIST_ITEMS);
}

export class MemoryStore {
  private memory: LoopMemory;

  constructor(objective: string) {
    this.memory = {
      goal: { objective, constraints: [], requirements: [] },
      session: { completedTasks: [], failures: [], decisions: [] },
      project: { architecture: [], techStack: [], importantFiles: [], conventions: [] },
    };
  }

  get(): LoopMemory {
    try {
      return structuredClone(this.memory);
    } catch {
      return JSON.parse(JSON.stringify(this.memory)) as LoopMemory;
    }
  }

  setGoal(goal: Partial<GoalMemory>): void {
    this.memory.goal = { ...this.memory.goal, ...goal };
  }

  recordCompletedTask(title: string): void {
    this.memory.session.completedTasks = trimList([...this.memory.session.completedTasks, title]);
  }

  recordFailure(message: string): void {
    this.memory.session.failures = trimList([...this.memory.session.failures, message]);
  }

  recordDecision(decision: string): void {
    this.memory.session.decisions = trimList([...this.memory.session.decisions, decision]);
  }

  /** Clear per-run session state while keeping project memory from prior runs. */
  resetSessionForRun(objective: string): void {
    this.memory.goal.objective = objective;
    this.memory.session = { completedTasks: [], failures: [], decisions: [] };
  }

  updateProject(update: Partial<ProjectMemory>): void {
    this.memory.project = {
      architecture: [...this.memory.project.architecture, ...(update.architecture ?? [])],
      techStack: [...this.memory.project.techStack, ...(update.techStack ?? [])],
      importantFiles: [...this.memory.project.importantFiles, ...(update.importantFiles ?? [])],
      conventions: [...this.memory.project.conventions, ...(update.conventions ?? [])],
    };
  }

  toContextBlock(): string {
    const m = this.memory;
    return [
      '=== GOAL ===',
      m.goal.objective,
      m.goal.constraints.length ? `Constraints: ${m.goal.constraints.join('; ')}` : '',
      m.goal.requirements.length ? `Requirements: ${m.goal.requirements.join('; ')}` : '',
      '',
      '=== SESSION MEMORY ===',
      m.session.completedTasks.length
        ? `Completed: ${m.session.completedTasks.join(', ')}`
        : 'No completed tasks yet.',
      m.session.failures.length ? `Failures: ${m.session.failures.join(' | ')}` : '',
      m.session.decisions.length ? `Decisions: ${m.session.decisions.join(' | ')}` : '',
      '',
      '=== PROJECT MEMORY ===',
      m.project.techStack.length ? `Stack: ${m.project.techStack.join(', ')}` : '',
      m.project.architecture.length ? `Architecture: ${m.project.architecture.join(' | ')}` : '',
      m.project.importantFiles.length ? `Files: ${m.project.importantFiles.join(', ')}` : '',
      m.project.conventions.length ? `Conventions: ${m.project.conventions.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  persist(projectDir: string): void {
    if (typeof window === 'undefined') return;
    try {
      const key = `${STORAGE_KEY}:${projectDir}`;
      window.localStorage.setItem(key, JSON.stringify(this.memory));
    } catch {
      // Best-effort persistence
    }
  }

  static load(projectDir: string, objective: string): MemoryStore {
    const store = new MemoryStore(objective);
    if (typeof window === 'undefined') return store;
    try {
      const key = `${STORAGE_KEY}:${projectDir}`;
      const raw = window.localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw) as LoopMemory;
        store.memory = { ...store.memory, ...parsed, goal: { ...store.memory.goal, objective } };
      }
    } catch {
      // Ignore corrupt storage
    }
    return store;
  }
}
