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

  const taskByRole: Record<'scout' | 'builder' | 'reviewer', string> = {
    scout: `Map the code paths most relevant to "${goal}", identify risks, and recommend clean ownership boundaries for the builders.`,
    builder: `Own the ${slot.label.toLowerCase()} implementation slice for "${goal}" and ship concrete progress inside the assigned boundary.`,
    reviewer: `Review completed builder slices for "${goal}", flag regressions or risks, and act as the release gate before the swarm calls the work done.`,
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

export class SwarmCoordinator {
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

  async createLaunchPlan(goal: string, workspacePath: string, roles: AgentRoleType[], config?: CoordinatorConfig): Promise<CoordinatorPlan> {
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

    const prompt = [
      `You are the coordinator for a multi-agent coding swarm. Goal: ${goal}`,
      '',
      'Return ONLY compact JSON:',
      '{"summary":"…","strategy":"…","coordinatorBrief":"…","assignments":[{"assignmentId":"…","label":"…","role":"…","task":"…","ownedFiles":["…"],"deliverables":["…"],"dependencies":["…"],"successCriteria":["…"]}]}',
      '',
      `Rules (${requestedSlots.length} assignments, one per slot):`,
      '- Use provided assignmentId/label exactly. No overlapping file ownership.',
      '- Scout: discovery first. Builders: narrow implementation slice each. Reviewer: quality gate only.',
      '',
      `Slots: ${JSON.stringify(roleCatalog)}`,
      `Workspace: ${workspacePath}`,
      fileList ? `Files:\n${fileList}` : '',
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

    // Compact snapshot for the prompt — only what the coordinator needs to assess state.
    const promptSnapshot = agents.map((agent) => ({
      id: agent.assignmentId || sanitizeId(agent.label || agent.role.name || agent.id),
      label: agent.label || agent.role.name,
      role: agent.role.type,
      status: agent.status,
      // Last 8 lines, max 600 chars — enough to detect stalls or completion
      tail: agent.outputBuffer.slice(-8).join('\n').slice(-600),
    }));

    // Strip bulky fields from plan; only send assignment IDs, labels, roles
    const planSummary = {
      summary: plan.summary,
      assignments: plan.assignments.map((a) => ({ id: a.id, label: a.label, role: a.role })),
    };

    const prompt = [
      `Coordinator sync. Goal: ${goal}`,
      `Plan: ${JSON.stringify(planSummary)}`,
      `Agents: ${JSON.stringify(promptSnapshot)}`,
      '',
      'Return ONLY compact JSON:',
      '{"summary":"…","overallStatus":"on_track|needs_attention|blocked","nextMilestone":"…","actions":[{"assignmentId":"…","message":"…"}]}',
      '',
      'Actions optional. Only send when redirection/handoff is needed. Max 2 sentences per action.',
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

  buildWorkerTask(goal: string, plan: CoordinatorPlan, assignment: CoordinatorAssignment): string {
    const role = getRole(assignment.role);
    const dependencyText = assignment.dependencies.length > 0
      ? assignment.dependencies.join(', ')
      : 'None';
    const ownershipLines = assignment.ownedFiles.length > 0
      ? assignment.ownedFiles.map((ownedFile) => `- ${ownedFile}`)
      : ['- Coordinator did not provide exact paths. Establish boundaries before making broad edits.'];

    return [
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
      'Success criteria:',
      ...assignment.successCriteria.map((criterion) => `- ${criterion}`),
      '',
      'Operating rules:',
      '- Treat file ownership as exclusive unless the coordinator explicitly changes it.',
      '- Do not edit files owned by another assignment.',
      '- If you need files outside your lane, stop and report the ownership gap instead of guessing.',
      '- Keep status updates short and operational. Mention touched files, validations, and blockers in your final summary.',
      '- Prioritize shipping code over conversation. Escalate quickly if blocked.',
    ].join('\n');
  }
}

export const swarmCoordinator = new SwarmCoordinator();
