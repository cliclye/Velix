import { invoke, readTextFile } from '../../platform/native';
import type { VerificationResult } from './types';

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const VERIFY_COMMANDS = [
  { label: 'build', command: 'npm run build' },
  { label: 'lint', command: 'npm run lint' },
  { label: 'test', command: 'npm test' },
];

async function runCheck(
  workspacePath: string,
  command: string,
): Promise<{ command: string; exitCode: number; output: string }> {
  try {
    const result = await invoke<ShellResult>('execute_shell_command', {
      command,
      cwd: workspacePath,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4000);
    return { command, exitCode: result.exitCode, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { command, exitCode: 1, output: message };
  }
}

/** Run build/lint/test when package.json scripts exist; skip missing scripts. */
export async function runVerification(workspacePath: string): Promise<VerificationResult> {
  const commands: VerificationResult['commands'] = [];
  const errors: string[] = [];

  let packageJson: { scripts?: Record<string, string> } | null = null;
  try {
    const raw = await readTextFile(`${workspacePath.replace(/\/$/, '')}/package.json`);
    packageJson = JSON.parse(raw);
  } catch {
    // No package.json — skip npm checks
    return { success: true, errors: [], commands: [] };
  }

  const scripts = packageJson?.scripts ?? {};
  for (const check of VERIFY_COMMANDS) {
    const scriptName = check.label;
    if (!scripts[scriptName]) continue;
    const result = await runCheck(workspacePath, check.command);
    commands.push(result);
    if (result.exitCode !== 0) {
      errors.push(`${check.label} failed (exit ${result.exitCode}): ${result.output.slice(0, 500)}`);
    }
  }

  return { success: errors.length === 0, errors, commands };
}
