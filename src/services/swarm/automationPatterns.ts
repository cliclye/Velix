/**
 * Automation Patterns - Default patterns and policies for Claude Code prompt detection
 */

import { AutomationPattern, AutomationPolicy } from './types';

/**
 * Default patterns for detecting Claude Code prompts
 */
export const DEFAULT_AUTOMATION_PATTERNS: AutomationPattern[] = [
  {
    id: 'proceed_yn',
    name: 'Proceed Confirmation',
    pattern: /(?:proceed|continue|do you want to|shall I|should I|would you like me to)\s*\??\s*\(?(?:y(?:es)?\/n(?:o)?|yes\/no)\)?/i,
    category: 'confirmation',
    examples: [
      'Proceed? (y/n)',
      'Do you want to continue? (yes/no)',
      'Should I proceed?',
      'Would you like me to continue?',
    ],
  },
  {
    id: 'overwrite_file',
    name: 'File Overwrite',
    pattern: /(?:overwrite|replace|update|modify)\s+(?:the\s+)?(?:file|existing).*\?/i,
    category: 'file_operation',
    examples: [
      'Overwrite file? (y/n)',
      'Replace existing file src/App.tsx?',
      'Modify the file?',
    ],
  },
  {
    id: 'create_file',
    name: 'Create File',
    pattern: /(?:create|generate|write|add)\s+(?:a\s+)?(?:new\s+)?file.*\?/i,
    category: 'file_operation',
    examples: [
      'Create file src/utils/helper.ts?',
      'Generate new file?',
      'Write a new file?',
    ],
  },
  {
    id: 'delete_file',
    name: 'Delete File',
    pattern: /(?:delete|remove)\s+(?:the\s+)?file.*\?/i,
    category: 'file_operation',
    examples: [
      'Delete file old-component.tsx?',
      'Remove file?',
      'Delete the file?',
    ],
  },
  {
    id: 'install_dependency',
    name: 'Install Dependency',
    pattern: /(?:install|add)\s+(?:the\s+)?(?:dependency|package|module|library).*\?/i,
    category: 'dependency',
    examples: [
      'Install dependency lodash?',
      'Add package @types/node?',
      'Install the package?',
    ],
  },
  {
    id: 'npm_install',
    name: 'NPM Install',
    pattern: /(?:run|execute)\s+(?:npm|yarn|pnpm)\s+install.*\?/i,
    category: 'dependency',
    examples: [
      'Run npm install?',
      'Execute yarn install?',
    ],
  },
  {
    id: 'run_tests',
    name: 'Run Tests',
    pattern: /(?:run|execute)\s+(?:the\s+)?(?:tests?|test suite|specs?).*\?/i,
    category: 'test',
    examples: [
      'Run tests? (y/n)',
      'Execute test suite?',
      'Run the tests?',
    ],
  },
  {
    id: 'run_command',
    name: 'Run Shell Command',
    pattern: /(?:run|execute)\s+(?:the\s+)?(?:command|shell|terminal).*\?/i,
    category: 'confirmation',
    examples: [
      'Run command npm build?',
      'Execute shell command?',
    ],
  },
  {
    id: 'run_build',
    name: 'Run Build',
    pattern: /(?:run|execute)\s+(?:the\s+)?build.*\?/i,
    category: 'confirmation',
    examples: [
      'Run build?',
      'Execute the build?',
    ],
  },
  {
    id: 'apply_changes',
    name: 'Apply Changes',
    pattern: /(?:apply|save|commit)\s+(?:these\s+)?(?:changes|edits|modifications).*\?/i,
    category: 'confirmation',
    examples: [
      'Apply changes?',
      'Save these changes?',
      'Apply the modifications?',
    ],
  },
  {
    id: 'git_operation',
    name: 'Git Operation',
    pattern: /(?:run|execute)\s+git\s+(?:add|commit|push|pull|checkout|merge).*\?/i,
    category: 'confirmation',
    examples: [
      'Run git commit?',
      'Execute git push?',
    ],
  },
  {
    id: 'confirm_action',
    name: 'Generic Confirmation',
    pattern: /\[(?:y(?:es)?\/n(?:o)?|confirm)\]/i,
    category: 'confirmation',
    examples: [
      '[y/n]',
      '[yes/no]',
      '[confirm]',
    ],
  },
];

/**
 * Default policies for handling detected prompts
 */
export const DEFAULT_POLICIES: AutomationPolicy[] = [
  {
    patternId: 'proceed_yn',
    action: 'auto_approve',
    confidence: 0.8,
  },
  {
    patternId: 'overwrite_file',
    action: 'auto_approve',
    conditions: [
      { type: 'file_path', operator: 'not_contains', value: 'node_modules' },
      { type: 'file_path', operator: 'not_contains', value: '.env' },
      { type: 'file_path', operator: 'not_contains', value: '.git' },
    ],
    confidence: 0.7,
  },
  {
    patternId: 'create_file',
    action: 'auto_approve',
    conditions: [
      { type: 'file_path', operator: 'starts_with', value: 'src/' },
    ],
    confidence: 0.7,
  },
  {
    patternId: 'delete_file',
    action: 'escalate',
    confidence: 0.5,
  },
  {
    patternId: 'install_dependency',
    action: 'escalate',
    confidence: 0.6,
  },
  {
    patternId: 'npm_install',
    action: 'auto_approve',
    confidence: 0.7,
  },
  {
    patternId: 'run_tests',
    action: 'auto_approve',
    confidence: 0.9,
  },
  {
    patternId: 'run_command',
    action: 'escalate',
    confidence: 0.5,
  },
  {
    patternId: 'run_build',
    action: 'auto_approve',
    confidence: 0.8,
  },
  {
    patternId: 'apply_changes',
    action: 'auto_approve',
    confidence: 0.8,
  },
  {
    patternId: 'git_operation',
    action: 'escalate',
    confidence: 0.6,
  },
  {
    patternId: 'confirm_action',
    action: 'auto_approve',
    confidence: 0.7,
  },
];

/**
 * Response templates for actions
 */
export const RESPONSE_TEMPLATES: Record<string, { approve: string; deny: string }> = {
  proceed_yn: { approve: 'y', deny: 'n' },
  overwrite_file: { approve: 'y', deny: 'n' },
  create_file: { approve: 'y', deny: 'n' },
  delete_file: { approve: 'y', deny: 'n' },
  install_dependency: { approve: 'y', deny: 'n' },
  npm_install: { approve: 'y', deny: 'n' },
  run_tests: { approve: 'y', deny: 'n' },
  run_command: { approve: 'y', deny: 'n' },
  run_build: { approve: 'y', deny: 'n' },
  apply_changes: { approve: 'y', deny: 'n' },
  git_operation: { approve: 'y', deny: 'n' },
  confirm_action: { approve: 'y', deny: 'n' },
};

/**
 * Categories with descriptions
 */
export const PATTERN_CATEGORIES = {
  confirmation: {
    name: 'Confirmation',
    description: 'General confirmation prompts',
    defaultAction: 'auto_approve',
  },
  file_operation: {
    name: 'File Operation',
    description: 'File create, modify, delete operations',
    defaultAction: 'auto_approve',
  },
  dependency: {
    name: 'Dependency',
    description: 'Package installation and management',
    defaultAction: 'escalate',
  },
  test: {
    name: 'Test',
    description: 'Test execution prompts',
    defaultAction: 'auto_approve',
  },
  custom: {
    name: 'Custom',
    description: 'User-defined patterns',
    defaultAction: 'escalate',
  },
};
