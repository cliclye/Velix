/**
 * Swarm presets — one-click starting points for the common jobs people hand to a swarm.
 * A preset fills the goal template and picks a sensible roster; the user can still edit both.
 */

export interface SwarmRoleCounts {
  scout: number;
  builder: number;
  reviewer: number;
}

export interface SwarmPreset {
  id: string;
  name: string;
  blurb: string;
  /** Goal text; the user is expected to replace the bracketed part. */
  goal: string;
  roles: SwarmRoleCounts;
  maxMode?: boolean;
}

export const SWARM_PRESETS: SwarmPreset[] = [
  {
    id: 'feature',
    name: 'Build a feature',
    blurb: 'Scout the code, split the work, review before done.',
    goal: 'Implement this feature end to end, following the existing patterns and adding tests: [describe the feature]',
    roles: { scout: 1, builder: 2, reviewer: 1 },
  },
  {
    id: 'bugfix',
    name: 'Fix a bug',
    blurb: 'Find the root cause, fix it, prove it with a test.',
    goal: 'Find the root cause of this bug and fix it properly, with a regression test: [describe the bug and how to reproduce it]',
    roles: { scout: 1, builder: 1, reviewer: 1 },
  },
  {
    id: 'tests',
    name: 'Write tests',
    blurb: 'Raise coverage where it matters most.',
    goal: 'Add meaningful tests for the least-covered, highest-risk modules. Do not change production behavior: [optionally name the area]',
    roles: { scout: 1, builder: 3, reviewer: 1 },
  },
  {
    id: 'refactor',
    name: 'Refactor safely',
    blurb: 'Clean up structure without changing behavior.',
    goal: 'Refactor for clarity and maintainability without changing behavior; keep the build and tests green: [describe the area]',
    roles: { scout: 1, builder: 2, reviewer: 2 },
  },
  {
    id: 'security',
    name: 'Security audit',
    blurb: 'Hunt vulnerabilities, then harden them.',
    goal: 'Audit the codebase for security problems (injection, path traversal, secrets handling, unsafe defaults) and fix the confirmed ones.',
    roles: { scout: 2, builder: 2, reviewer: 1 },
    maxMode: true,
  },
  {
    id: 'docs',
    name: 'Docs & cleanup',
    blurb: 'README, comments, dead code.',
    goal: 'Bring the documentation up to date with the code: fix the README, document public APIs, and remove dead code you can prove is unused.',
    roles: { scout: 1, builder: 2, reviewer: 1 },
  },
];

export function getSwarmPreset(id: string): SwarmPreset | undefined {
  return SWARM_PRESETS.find((p) => p.id === id);
}
