import { invoke } from '../../platform/native';
import { velixEngine } from '../ai/velix-engine';
import { ProviderID, PROVIDERS } from '../ai/types';
import { workspaceService } from '../workspace';
import { getRole } from './roleDefinitions';
import { Agent, AgentRoleType } from './types';

export interface CoordinatorConfig {
  provider: ProviderID;
  model: string;
  apiKey: string;
}

export const SWARM_SPECIALIST_ROLE_ORDER: AgentRoleType[] = [
  'scout',
  'builder',
  'reviewer',
];

export const MAX_MODE_DIRECTIVE = `
--- MAX MODE ACTIVE ---
You are operating in MAX MODE. This means maximum effort, maximum depth, production-level quality.

BEHAVIOR:
- Do NOT take shortcuts or produce partial implementations.
- Do NOT assume anything without validating it.
- Do NOT stop at the first working solution — evaluate alternatives and pick the best.

STANDARDS:
- Build fully functional, end-to-end logic with no placeholders or hacks.
- Handle ALL edge cases and failure scenarios.
- Write clean, modular, maintainable, and scalable code.
- Self-review your work. Identify weaknesses and fix them before finishing.

QUALITY BAR:
- The result must work reliably and be production-ready.
- The design must be clean and extensible.
- Only consider your task complete when ALL requirements are met with zero known gaps.

Operate like a senior engineer building a critical system.
--- END MAX MODE ---
`.trim();

const DEFAULT_ROLE_DEPENDENCIES: Partial<Record<AgentRoleType, AgentRoleType[]>> = {
  architect: ['planner'],
  frontend: ['architect', 'scout'],
  backend: ['architect', 'scout'],
  builder: ['scout'],
  security: ['builder', 'backend', 'frontend'],
  qa: ['builder', 'backend', 'frontend'],
  reviewer: ['builder'],
};

interface RequestedAssignmentSlot {
  role: AgentRoleType;
  occurrence: number;
  totalForRole: number;
  label: string;
  assignmentId: string;
}

interface RawCoordinatorAssignment {
  assignmentId?: string;
  label?: string;
  role?: string;
  task?: string;
  ownedFiles?: unknown[];
  deliverables?: unknown[];
  dependencies?: unknown[];
  successCriteria?: unknown[];
}

interface RawCoordinatorAction {
  assignmentId?: string;
  label?: string;
  role?: string;
  message?: string;
}

export interface CoordinatorAssignment {
  id: string;
  label: string;
  role: AgentRoleType;
  task: string;
  ownedFiles: string[];
  deliverables: string[];
  dependencies: string[];
  successCriteria: string[];
}

export interface CoordinatorPlan {
  summary: string;
  strategy: string;
  coordinatorBrief: string;
  assignments: CoordinatorAssignment[];
}

export interface CoordinatorAction {
  assignmentId: string;
  message: string;
}

export interface CoordinatorSyncResult {
  summary: string;
  overallStatus: 'on_track' | 'needs_attention' | 'blocked';
  nextMilestone: string;
  actions: CoordinatorAction[];
}

const stripJsonEnvelope = (raw: string): string => {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return withoutFence.slice(firstBrace, lastBrace + 1);
  }
  return withoutFence;
};

const sanitizeId = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeRoleType = (value: string): AgentRoleType | null => {
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  const aliases: Record<string, AgentRoleType> = {
    scout: 'scout',
    planner: 'planner',
    architect: 'architect',
    frontend: 'frontend',
    frontlead: 'frontend',
    frontendspecialist: 'frontend',
    backend: 'backend',
    backendspecialist: 'backend',
    builder: 'builder',
    build: 'builder',
    engineer: 'builder',
    reviewer: 'reviewer',
    review: 'reviewer',
    qualitygate: 'reviewer',
    security: 'security',
    securitymanager: 'security',
    qa: 'qa',
    qualityassurance: 'qa',
    tester: 'qa',
    implementer: 'implementer',
    docwriter: 'docwriter',
    documentation: 'docwriter',
    refactorer: 'refactorer',
  };
  return aliases[normalized] || null;
};

const parseObjectResponse = <T,>(raw: string): T | null => {
  try {
    return JSON.parse(stripJsonEnvelope(raw)) as T;
  } catch {
    return null;
  }
};

const buildAssignmentLabel = (role: AgentRoleType, occurrence: number, totalForRole: number): string => {
  const baseLabel = getRole(role).name;
  if (totalForRole <= 1) return baseLabel;
  return `${baseLabel}-${occurrence}`;
};

const buildRequestedAssignmentSlots = (roles: AgentRoleType[]): RequestedAssignmentSlot[] => {
  const totals = roles.reduce<Record<string, number>>((acc, role) => {
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  const seen = new Map<AgentRoleType, number>();

  return roles.map((role) => {
    const occurrence = (seen.get(role) || 0) + 1;
    seen.set(role, occurrence);
    const totalForRole = totals[role] || 1;
    const label = buildAssignmentLabel(role, occurrence, totalForRole);
    return {
      role,
      occurrence,
      totalForRole,
      label,
      assignmentId: sanitizeId(label),
    };
  });
};

const buildRoleCatalog = (slots: RequestedAssignmentSlot[]) =>
  slots.map((slot) => {
    const def = getRole(slot.role);
    return {
      assignmentId: slot.assignmentId,
      label: slot.label,
      role: slot.role,
      name: def.name,
      description: def.description,
      capabilities: def.capabilities,
      restrictions: def.restrictions,
    };
  });

const normalizeStringList = (values: unknown[] | undefined): string[] =>
  Array.isArray(values)
    ? Array.from(
        new Set(
          values
            .map((value) => String(value).trim())
            .filter((value) => value.length > 0),
        ),
      )
    : [];

const fallbackDependencyLabels = (
  slot: RequestedAssignmentSlot,
  requestedSlots: RequestedAssignmentSlot[],
): string[] => {
  const roleDependencies = DEFAULT_ROLE_DEPENDENCIES[slot.role] || [];
  return Array.from(
    new Set(
      roleDependencies.flatMap((dependencyRole) =>
        requestedSlots
          .filter((candidate) => candidate.role === dependencyRole)
          .map((candidate) => candidate.label),
      ),
    ),
  );
};

const normalizeDependencies = (
  rawDependencies: unknown[] | undefined,
  slot: RequestedAssignmentSlot,
  requestedSlots: RequestedAssignmentSlot[],
): string[] => {
  const directDependencies = normalizeStringList(rawDependencies).flatMap((dependency) => {
    const normalized = sanitizeId(dependency);
    const directMatch = requestedSlots.find(
      (candidate) =>
        candidate.assignmentId === normalized || sanitizeId(candidate.label) === normalized,
    );
    if (directMatch) return [directMatch.label];

    const role = normalizeRoleType(dependency);
    if (role) {
      return requestedSlots
        .filter((candidate) => candidate.role === role)
        .map((candidate) => candidate.label);
    }

    return [dependency];
  });

  const uniqueDependencies = Array.from(new Set(directDependencies)).filter(
    (dependency) => dependency !== slot.label,
  );

  return uniqueDependencies.length > 0
    ? uniqueDependencies
    : fallbackDependencyLabels(slot, requestedSlots);
};

const createFallbackAssignment = (
  goal: string,
  slot: RequestedAssignmentSlot,
  requestedSlots: RequestedAssignmentSlot[],
): CoordinatorAssignment => {
  const roleDef = getRole(slot.role);
  const dependencyLabels = fallbackDependencyLabels(slot, requestedSlots);

  const builderSlots = requestedSlots.filter((s) => s.role === 'builder');
  const builderIndex = builderSlots.findIndex((s) => s.assignmentId === slot.assignmentId);

  const taskByRole: Record<'scout' | 'builder' | 'reviewer', string> = {
    scout: `Investigate the codebase for: "${goal}". Map every file, module, and pattern relevant to this goal. Identify risks, hidden dependencies, and constraints. Recommend clear file-ownership boundaries so ${builderSlots.length} builder(s) can work without collisions. Be specific — name exact files and directories.`,
    builder: builderSlots.length > 1
      ? `You are builder ${builderIndex + 1} of ${builderSlots.length} for the goal: "${goal}". Implement your assigned slice end-to-end inside your owned files. Do not touch files outside your ownership boundary. Validate your work before reporting completion.`
      : `Implement the full goal: "${goal}". Ship working, validated code. Report touched files and any blockers in your final summary.`,
    reviewer: `Review all completed builder work for the goal: "${goal}". Check for correctness, regressions, style consistency, and security. Provide a clear go/no-go verdict with actionable findings tied to specific files.`,
  };

  const deliverablesByRole: Record<'scout' | 'builder' | 'reviewer', string[]> = {
    scout: [
      'A concise map of relevant files, patterns, and constraints',
      'Ownership recommendations that keep builders from colliding',
    ],
    builder: [
      'Production code or integration work inside the owned slice',
      'A summary of touched files, validation, and remaining blockers',
    ],
    reviewer: [
      'A clear go/no-go review outcome for completed builder slices',
      'Actionable findings tied to files or observable behaviors',
    ],
  };

  const successByRole: Record<'scout' | 'builder' | 'reviewer', string[]> = {
    scout: [
      'Builders can start with clear ownership and project context',
      'Non-obvious risks or blockers are surfaced explicitly',
    ],
    builder: [
      'The assigned slice is implemented and locally validated',
      'Any ownership gaps or blockers are stated explicitly',
    ],
    reviewer: [
      'Real risks are identified before the swarm marks work done',
      'Approval or rejection is clear and justified',
    ],
  };

  const roleKey = (slot.role === 'scout' || slot.role === 'builder' || slot.role === 'reviewer')
    ? slot.role
    : 'builder';

  return {
    id: slot.assignmentId,
    label: slot.label,
    role: slot.role,
    task: taskByRole[roleKey] || `Own the ${roleDef.name.toLowerCase()} slice of "${goal}".`,
    ownedFiles: [],
    deliverables: deliverablesByRole[roleKey],
    dependencies: dependencyLabels,
    successCriteria: successByRole[roleKey],
  };
};

const normalizePlan = (
  goal: string,
  selectedRoles: AgentRoleType[],
  rawPlan: Partial<CoordinatorPlan> | null,
): CoordinatorPlan => {
  const requestedSlots = buildRequestedAssignmentSlots(selectedRoles);
  const parsedAssignments = Array.isArray(rawPlan?.assignments) ? rawPlan.assignments : [];
  const usedAssignments = new Set<number>();

  const assignments = requestedSlots.map((slot) => {
    const fallback = createFallbackAssignment(goal, slot, requestedSlots);
    const matchIndex = parsedAssignments.findIndex((assignment, index) => {
      if (usedAssignments.has(index)) return false;
      const rawAssignment = assignment as RawCoordinatorAssignment;
      const role = normalizeRoleType(String(rawAssignment.role || ''));
      const labelId = typeof rawAssignment.label === 'string' ? sanitizeId(rawAssignment.label) : '';
      const assignmentId = typeof rawAssignment.assignmentId === 'string'
        ? sanitizeId(rawAssignment.assignmentId)
        : '';

      return (
        assignmentId === slot.assignmentId ||
        labelId === slot.assignmentId ||
        (role === slot.role)
      );
    });

    if (matchIndex === -1) {
      return fallback;
    }

    usedAssignments.add(matchIndex);
    const match = parsedAssignments[matchIndex] as RawCoordinatorAssignment;
    const ownedFiles = normalizeStringList(match.ownedFiles);
    const deliverables = normalizeStringList(match.deliverables);
    const successCriteria = normalizeStringList(match.successCriteria);
    const dependencies = normalizeDependencies(match.dependencies, slot, requestedSlots);

    return {
      id: slot.assignmentId,
      label: typeof match.label === 'string' && match.label.trim()
        ? match.label.trim()
        : slot.label,
      role: slot.role,
      task: typeof match.task === 'string' && match.task.trim()
        ? match.task.trim()
        : fallback.task,
      ownedFiles,
      deliverables: deliverables.length > 0 ? deliverables : fallback.deliverables,
      dependencies,
      successCriteria: successCriteria.length > 0 ? successCriteria : fallback.successCriteria,
    };
  });

  return {
    summary: rawPlan?.summary?.trim() || 'Coordinator created a parallel execution board with explicit ownership lanes.',
    strategy: rawPlan?.strategy?.trim() || 'Front-load discovery, keep ownership non-overlapping, and push completed work through review before calling it done.',
    coordinatorBrief: rawPlan?.coordinatorBrief?.trim() || 'Watch ownership boundaries, dependency handoffs, and review readiness. Redirect quickly when a builder needs files outside its lane.',
    assignments,
  };
};

const resolveActionAssignmentId = (
  action: RawCoordinatorAction,
  snapshot: Array<{ assignmentId: string; label: string; role: AgentRoleType }>,
): string | null => {
  const candidateValues = [action.assignmentId, action.label, action.role]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());

  for (const candidateValue of candidateValues) {
    const normalized = sanitizeId(candidateValue);
    const directMatch = snapshot.find(
      (item) =>
        item.assignmentId === normalized || sanitizeId(item.label) === normalized,
    );
    if (directMatch) {
      return directMatch.assignmentId;
    }

    const role = normalizeRoleType(candidateValue);
    if (role) {
      const roleMatches = snapshot.filter((item) => item.role === role);
      if (roleMatches.length === 1) {
        return roleMatches[0].assignmentId;
      }
      if (roleMatches.length > 1) {
        return roleMatches[0].assignmentId;
      }
    }
  }

  return null;
};

export class ClaudeCoordinator {
  async hasClaudeKey(): Promise<boolean> {
    return this.hasCoordinatorKey('claude');
  }

  async hasCoordinatorKey(provider: ProviderID): Promise<boolean> {
    try {
      const key = await invoke<string>('get_api_key', { provider });
      return Boolean(key);
    } catch {
      return false;
    }
  }

  /** Fetch the stored API key for a provider. Returns empty string if not found. */
  async getCoordinatorApiKey(provider: ProviderID): Promise<string> {
    try {
      const key = await invoke<string>('get_api_key', { provider });
      return key || '';
    } catch {
      return '';
    }
  }

  private async callCoordinator(prompt: string, config: CoordinatorConfig): Promise<string> {
    const sessionID = await velixEngine.createSession();
    try {
      return await velixEngine.sendMessage({
        sessionID,
        text: prompt,
        velixProviderID: config.provider,
        velixModelID: config.model,
        apiKey: config.apiKey,
        maxTokens: 2048,
      });
    } finally {
      await velixEngine.deleteSession(sessionID);
    }
  }

  /**
   * Scout external research via API — gathers best practices, comparisons,
   * and recommendations before the CLI agent does internal code analysis.
   */
  async scoutResearch(
    goal: string,
    scoutTask: string,
    config: CoordinatorConfig,
    maxMode?: boolean,
  ): Promise<string> {
    const depth = maxMode
      ? 'Perform exhaustive research. Compare multiple approaches with detailed pros/cons. Leave no stone unturned.'
      : 'Provide focused, actionable research. Compare the most relevant approaches.';

    const prompt = [
      'You are the Scout (external research mode) in a coordinated engineering swarm.',
      `Overall goal: ${goal}`,
      '',
      `Your research task: ${scoutTask}`,
      '',
      '## Instructions',
      depth,
      '',
      'Provide structured findings:',
      '1. Best practices relevant to the goal',
      '2. Recommended approaches with pros and cons',
      '3. Key risks, trade-offs, and considerations',
      '4. Specific, actionable recommendations',
      '',
      'Be concrete and specific. Reference real patterns, libraries, or techniques.',
      'Format your output as clean markdown sections.',
    ].join('\n');

    return this.callCoordinator(prompt, config);
  }

  async createLaunchPlan(goal: string, workspacePath: string, roles: AgentRoleType[], config?: CoordinatorConfig, maxMode?: boolean): Promise<CoordinatorPlan> {
    const requestedSlots = buildRequestedAssignmentSlots(roles);
    const roleCatalog = buildRoleCatalog(requestedSlots);

    // Only send the file-name list — sending full file contents burns tokens unnecessarily.
    let fileList = '';
    try {
      const workspaceContext = await workspaceService.scan(workspacePath);
      const names = Object.keys(workspaceContext.loadedFiles ?? {}).slice(0, 120);
      if (names.length > 0) fileList = names.join('\n');
    } catch {
      // proceed without file list
    }

    const builderCount = requestedSlots.filter((s) => s.role === 'builder').length;
    const scoutCount = requestedSlots.filter((s) => s.role === 'scout').length;

    const prompt = [
      `You are the coordinator for a multi-agent coding swarm.`,
      `User goal: ${goal}`,
      '',
      '## Your job',
      'Break the user goal into concrete, non-overlapping sub-tasks and assign each to an agent slot.',
      '',
      '## Task splitting rules',
      scoutCount > 0
        ? [
            `- SCOUT task: Write a detailed, goal-specific investigation prompt. The scout must know exactly what parts of the codebase to map and what risks to look for based on the goal.`,
            `  Example — if the goal mentions "redesign UI and fix sorting bug", the scout should map BOTH the UI component tree AND the sorting algorithm, not just do a generic scan.`,
          ].join('\n')
        : '',
      builderCount > 1
        ? [
            `- BUILDER tasks (${builderCount} builders): Intelligently decompose the goal into ${builderCount} distinct sub-tasks. Each builder gets ONE focused sub-task — not a fraction of the same task.`,
            `  Example — "redesign website and fix algorithm bug" with 2 builders → Builder-1 gets the full redesign, Builder-2 gets the full algorithm fix.`,
            `  Example — "add auth system" with 3 builders → Builder-1 gets login/signup UI, Builder-2 gets auth API + middleware, Builder-3 gets session management + token refresh.`,
            `  Each builder's "task" field must be a detailed, actionable prompt (3-5 sentences) explaining exactly what to build, not a vague one-liner.`,
          ].join('\n')
        : `- BUILDER task: Write a detailed, actionable prompt (3-5 sentences) for the builder covering the full goal.`,
      '- REVIEWER task: Review all completed builder work for correctness, regressions, and quality.',
      '- Every assignment must have a specific "task" field — never leave it generic.',
      '- Assign "ownedFiles" to each builder so they don\'t collide. Use the file list below to pick real paths.',
      '',
      '## Output format',
      'Return ONLY compact JSON:',
      '{"summary":"...","strategy":"...","coordinatorBrief":"...","assignments":[{"assignmentId":"...","label":"...","role":"...","task":"...","ownedFiles":["..."],"deliverables":["..."],"dependencies":["..."],"successCriteria":["..."]}]}',
      '',
      `Slots (${requestedSlots.length} total — use these assignmentId/label values exactly):`,
      JSON.stringify(roleCatalog),
      `Workspace: ${workspacePath}`,
      fileList ? `\nFiles in project:\n${fileList}` : '',
      maxMode ? `\n## MAX MODE ACTIVE\nThe swarm is in MAX MODE. Write extremely detailed, thorough task prompts for each agent. Each builder task must be 5-8 sentences with specific implementation details, edge cases to handle, and quality requirements. Scout tasks must cover every relevant area exhaustively. Reviewer tasks must demand production-level quality with zero tolerance for shortcuts.` : '',
    ].filter(Boolean).join('\n');

    const resolvedConfig = config ?? {
      provider: 'claude' as ProviderID,
      model: PROVIDERS.find((p) => p.id === 'claude')?.models[0] ?? 'claude-sonnet-4-6',
      apiKey: await this.getCoordinatorApiKey('claude'),
    };

    const raw = await this.callCoordinator(prompt, resolvedConfig);

    return normalizePlan(goal, roles, parseObjectResponse<CoordinatorPlan>(raw));
  }

  async createSyncResult(
    goal: string,
    _workspacePath: string,
    plan: CoordinatorPlan,
    agents: Agent[],
    config?: CoordinatorConfig,
  ): Promise<CoordinatorSyncResult> {
    // Full snapshot used for action routing (resolveActionAssignmentId needs assignmentId).
    const snapshot = agents.map((agent) => ({
      assignmentId: agent.assignmentId || sanitizeId(agent.label || agent.role.name || agent.id),
      label: agent.label || agent.role.name,
      role: agent.role.type,
    }));

    // Compact snapshot for the prompt — what the coordinator needs to assess state.
    const promptSnapshot = agents.map((agent) => {
      const assignment = plan.assignments.find((a) => a.id === agent.assignmentId);
      return {
        id: agent.assignmentId || sanitizeId(agent.label || agent.role.name || agent.id),
        label: agent.label || agent.role.name,
        role: agent.role.type,
        status: agent.status,
        task: assignment?.task || agent.assignedTask || '',
        ownedFiles: assignment?.ownedFiles || [],
        // Last 15 lines, max 1200 chars — enough to understand progress and detect issues
        tail: agent.outputBuffer.slice(-15).join('\n').slice(-1200),
      };
    });

    const prompt = [
      `You are the coordinator managing a coding swarm. Goal: ${goal}`,
      `Strategy: ${plan.strategy}`,
      '',
      '## Current agent status',
      JSON.stringify(promptSnapshot, null, 1),
      '',
      '## Your job',
      '- Assess whether each agent is making progress on their assigned task.',
      '- If an agent is stuck, drifting off-task, or working outside their owned files, send a corrective action.',
      '- If an agent finished and another depends on it, send a nudge with relevant context.',
      '- If everything looks good, return no actions.',
      '',
      'Return ONLY compact JSON:',
      '{"summary":"...","overallStatus":"on_track|needs_attention|blocked","nextMilestone":"...","actions":[{"assignmentId":"...","message":"..."}]}',
      '',
      'Actions optional. Only send when redirection/handoff is needed. Keep messages actionable (2-3 sentences max).',
    ].join('\n');

    const resolvedConfig = config ?? {
      provider: 'claude' as ProviderID,
      model: PROVIDERS.find((p) => p.id === 'claude')?.models[0] ?? 'claude-sonnet-4-6',
      apiKey: await this.getCoordinatorApiKey('claude'),
    };

    const raw = await this.callCoordinator(prompt, resolvedConfig);

    const parsed = parseObjectResponse<Partial<CoordinatorSyncResult> & { actions?: RawCoordinatorAction[] }>(raw);
    const actions = Array.isArray(parsed?.actions)
      ? parsed.actions
          .map((action) => {
            const assignmentId = resolveActionAssignmentId(action, snapshot);
            const message = typeof action.message === 'string' ? action.message.trim() : '';
            if (!assignmentId || !message) return null;
            return { assignmentId, message };
          })
          .filter((action): action is CoordinatorAction => action !== null)
      : [];

    const overallStatus = parsed?.overallStatus === 'blocked' || parsed?.overallStatus === 'needs_attention'
      ? parsed.overallStatus
      : 'on_track';

    return {
      summary: parsed?.summary?.trim() || 'Coordinator completed a sync round.',
      overallStatus,
      nextMilestone: parsed?.nextMilestone?.trim() || 'Keep builders moving inside their lanes and send completed work through review.',
      actions,
    };
  }

  buildWorkerTask(
    goal: string,
    plan: CoordinatorPlan,
    assignment: CoordinatorAssignment,
    dependencyOutputs?: Map<string, string>,
    maxMode?: boolean,
  ): string {
    const role = getRole(assignment.role);
    const dependencyText = assignment.dependencies.length > 0
      ? assignment.dependencies.join(', ')
      : 'None';
    const ownershipLines = assignment.ownedFiles.length > 0
      ? assignment.ownedFiles.map((ownedFile) => `- ${ownedFile}`)
      : ['- Coordinator did not provide exact paths. Establish boundaries before making broad edits.'];

    const lines = [
      `You are ${assignment.label}, the ${role.name} in a coordinated coding swarm.`,
      `Overall goal: ${goal}`,
      '',
      `Coordinator strategy: ${plan.strategy}`,
      `Coordinator brief: ${plan.coordinatorBrief}`,
      '',
      `Assignment ID: ${assignment.id}`,
      `Your assigned task: ${assignment.task}`,
      '',
      'Owned files or slices:',
      ...ownershipLines,
      '',
      'Deliverables:',
      ...assignment.deliverables.map((deliverable) => `- ${deliverable}`),
      '',
      `Dependencies: ${dependencyText}`,
    ];

    // Inject findings from completed dependency agents
    if (dependencyOutputs && dependencyOutputs.size > 0) {
      lines.push('');
      lines.push('--- Dependency findings (from completed agents) ---');
      for (const [depLabel, depOutput] of dependencyOutputs) {
        // Cap each dependency's output to avoid blowing up the prompt
        const trimmed = depOutput.length > 3000 ? depOutput.slice(-3000) : depOutput;
        lines.push(`\n## ${depLabel} output:\n${trimmed}`);
      }
      lines.push('--- End dependency findings ---');
    }

    lines.push(
      '',
      'Success criteria:',
      ...assignment.successCriteria.map((criterion) => `- ${criterion}`),
      '',
      'Operating rules:',
      '- Treat file ownership as exclusive unless the coordinator explicitly changes it.',
      '- Do not edit files owned by another assignment.',
      '- If you need files outside your lane, stop and report the ownership gap instead of guessing.',
      '- Keep status updates short and operational. Mention touched files, validations, and blockers in your final summary.',
      '- Prioritize shipping code over conversation. Escalate quickly if blocked.',
      '- Do NOT ask follow-up questions or request clarification. Work with the information you have. If anything is ambiguous, make a reasonable decision and note it in your summary.',
      '- When your assigned work is fully complete, end this interactive session using your CLI\'s normal quit flow (e.g. /exit, exit, quit, or Ctrl+D — see your tool\'s docs) so the swarm can continue.',
    );

    if (maxMode) {
      lines.push('', MAX_MODE_DIRECTIVE);
    }

    return lines.join('\n');
  }

  /**
   * Evaluate reviewer output and determine APPROVED or REVISE.
   * Returns the verdict and revision instructions if REVISE.
   */
  async evaluateReview(
    goal: string,
    reviewerOutputs: Map<string, string>,
    builderOutputs: Map<string, string>,
    config?: CoordinatorConfig,
  ): Promise<{ verdict: 'APPROVED' | 'REVISE'; summary: string; revisionInstructions: string }> {
    if (reviewerOutputs.size === 0) {
      return { verdict: 'REVISE', summary: 'Reviewers produced no output — requesting revision.', revisionInstructions: 'Reviewers did not produce output. Re-verify your work and ensure all requirements are met.' };
    }

    const reviewTexts = Array.from(reviewerOutputs.entries())
      .map(([label, output]) => {
        const trimmed = output.length > 3000 ? output.slice(-3000) : output;
        return `### ${label}:\n${trimmed}`;
      })
      .join('\n\n');

    const prompt = [
      'You are the Coordinator evaluating reviewer feedback for a coding swarm.',
      `Goal: ${goal}`,
      '',
      '## Reviewer outputs',
      reviewTexts,
      '',
      '## Your job',
      'Analyze the reviewer outputs and determine if the work should be APPROVED or sent back for REVISION.',
      '',
      'Look for the ---REVIEW-VERDICT--- block in each reviewer output.',
      '- If all reviewers say APPROVED and there are no critical issues: return APPROVED',
      '- If any reviewer says REVISE or there are unresolved critical issues: return REVISE',
      '',
      'Return ONLY compact JSON:',
      '{"verdict":"APPROVED|REVISE","summary":"...","revisionInstructions":"..."}',
      '',
      'revisionInstructions: If REVISE, compile all reviewer feedback into clear, actionable instructions for builders. If APPROVED, leave empty.',
    ].join('\n');

    const resolvedConfig = config ?? {
      provider: 'claude' as ProviderID,
      model: PROVIDERS.find((p) => p.id === 'claude')?.models[0] ?? 'claude-sonnet-4-6',
      apiKey: await this.getCoordinatorApiKey('claude'),
    };

    const raw = await this.callCoordinator(prompt, resolvedConfig);
    const parsed = parseObjectResponse<{ verdict?: string; summary?: string; revisionInstructions?: string }>(raw);

    const verdict = parsed?.verdict?.toUpperCase() === 'APPROVED' ? 'APPROVED' : 'REVISE';

    return {
      verdict,
      summary: parsed?.summary?.trim() || (verdict === 'APPROVED' ? 'All work approved.' : 'Revisions needed.'),
      revisionInstructions: parsed?.revisionInstructions?.trim() || '',
    };
  }

  /**
   * Build a revision task for a builder based on reviewer feedback.
   */
  buildRevisionTask(
    goal: string,
    plan: CoordinatorPlan,
    assignment: CoordinatorAssignment,
    originalBuilderOutput: string,
    revisionInstructions: string,
    iterationNumber: number,
    maxMode?: boolean,
  ): string {
    const role = getRole(assignment.role);
    const ownershipLines = assignment.ownedFiles.length > 0
      ? assignment.ownedFiles.map((ownedFile) => `- ${ownedFile}`)
      : ['- Same files as your previous iteration.'];

    const prevOutput = originalBuilderOutput.length > 2000
      ? originalBuilderOutput.slice(-2000)
      : originalBuilderOutput;

    const lines = [
      `You are ${assignment.label}, the ${role.name} in a coordinated coding swarm.`,
      `Overall goal: ${goal}`,
      '',
      `## REVISION ROUND ${iterationNumber}`,
      'The Reviewer evaluated your previous work and found issues that must be fixed.',
      '',
      '## Reviewer feedback and required changes:',
      revisionInstructions,
      '',
      '## Your previous work summary (for reference):',
      prevOutput,
      '',
      `Your assigned task (unchanged): ${assignment.task}`,
      '',
      'Owned files or slices:',
      ...ownershipLines,
      '',
      'INSTRUCTIONS:',
      '- Fix every issue listed in the reviewer feedback above.',
      '- Do not skip any required change.',
      '- Stay within your file ownership boundary.',
      '- Validate your fixes before reporting completion.',
      '- End with the ---BUILDER-REPORT--- structured block.',
      '- Do NOT ask follow-up questions or request clarification. Work with the information you have.',
      '- When the revision is complete, quit this CLI session the same way (e.g. /exit, exit, or your tool\'s documented command) so the swarm can continue.',
    ];

    if (maxMode) {
      lines.push('', MAX_MODE_DIRECTIVE);
    }

    return lines.join('\n');
  }
}

export const claudeCoordinator = new ClaudeCoordinator();
