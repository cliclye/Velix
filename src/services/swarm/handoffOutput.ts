/**
 * Extract structured swarm handoff blocks from noisy CLI / PTY output.
 * Worker CLIs embed role-specific markers (---SCOUT-FINDINGS---, etc.) that the
 * coordinator needs — not raw terminal tails or rolling line buffers.
 */

import { Agent, AgentRoleType } from './types';

const ANSI_ESCAPE_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g;

const ROLE_HANDOFF_BLOCKS: Partial<Record<AgentRoleType, { start: string; end: string }>> = {
  scout: { start: '---SCOUT-FINDINGS---', end: '---END-SCOUT-FINDINGS---' },
  builder: { start: '---BUILDER-REPORT---', end: '---END-BUILDER-REPORT---' },
  reviewer: { start: '---REVIEW-VERDICT---', end: '---END-REVIEW-VERDICT---' },
};

function isPromptOnlyLine(line: string): boolean {
  const t = line.trim();
  return t === '>' || t === '❯' || t === '›' || t === '%' || t === '$';
}

function isTerminalNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (isPromptOnlyLine(trimmed)) return true;
  if (/Resume this session with:/i.test(trimmed)) return true;
  if (/^(?:Baked|Brewed|Worked|Churned|Cogitated)\s+for\s+/i.test(trimmed)) return true;
  // Claude Code timing / status glyphs
  const first = trimmed.codePointAt(0);
  if (first && [0x2722, 0x273b, 0x2726, 0x2733, 0x273d].includes(first)) return true;
  return false;
}

export function sanitizeTerminalOutput(data: string): string {
  return data
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');
}

export function extractStructuredHandoff(output: string, role: AgentRoleType): string | null {
  const markers = ROLE_HANDOFF_BLOCKS[role];
  if (!markers) return null;

  const startIdx = output.indexOf(markers.start);
  if (startIdx === -1) return null;

  const endIdx = output.indexOf(markers.end, startIdx + markers.start.length);
  if (endIdx === -1) return null;

  return output.slice(startIdx, endIdx + markers.end.length).trim();
}

export function stripTerminalNoise(output: string): string {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !isTerminalNoiseLine(line))
    .join('\n')
    .trim();
}

export function getRawAgentOutput(agent: Agent): string {
  const fromTerm = sanitizeTerminalOutput(agent.terminalOutput).trim();
  if (fromTerm.length > 0) return fromTerm;
  return agent.outputBuffer.join('\n').trim();
}

/**
 * Format agent CLI output for coordinator consumption.
 * Prefers structured handoff blocks; falls back to denoised terminal text.
 */
export function formatCoordinatorHandoff(
  output: string,
  role: AgentRoleType,
  maxChars = 12_000,
): string {
  const structured = extractStructuredHandoff(output, role);
  let text = structured ?? stripTerminalNoise(output);
  if (!text) text = output.trim();
  if (text.length <= maxChars) return text;

  if (structured) {
    return structured.slice(0, maxChars);
  }
  return text.slice(-maxChars);
}

export function getAgentHandoffText(agent: Agent, maxChars = 12_000): string {
  return formatCoordinatorHandoff(getRawAgentOutput(agent), agent.role.type, maxChars);
}

export function getAgentSyncHandoffText(agent: Agent, maxChars = 4_000): string {
  return formatCoordinatorHandoff(getRawAgentOutput(agent), agent.role.type, maxChars);
}

/** Lightweight self-check used by scripts/verify-handoff.mjs parity tests. */
export function verifyHandoffExtraction(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  const scoutFixture = [
    'shell noise',
    '---SCOUT-FINDINGS---',
    '## Relevant Files',
    '- src/foo.ts',
    '---END-SCOUT-FINDINGS---',
    '❯',
  ].join('\n');

  const scout = extractStructuredHandoff(scoutFixture, 'scout');
  if (!scout?.includes('src/foo.ts')) {
    errors.push('scout extraction failed');
  }

  const builderFixture = [
    'cli ui',
    '---BUILDER-REPORT---',
    '## Files Modified',
    '- src/bar.ts',
    '---END-BUILDER-REPORT---',
  ].join('\n');

  const builder = extractStructuredHandoff(builderFixture, 'builder');
  if (!builder?.includes('src/bar.ts')) {
    errors.push('builder extraction failed');
  }

  const noisy = formatCoordinatorHandoff(
    '❯\nBrewed for 12s\n---REVIEW-VERDICT---\n## Decision: APPROVED\n---END-REVIEW-VERDICT---\n%',
    'reviewer',
    2_000,
  );
  if (!noisy.includes('APPROVED')) {
    errors.push('reviewer handoff formatting failed');
  }

  return { ok: errors.length === 0, errors };
}
