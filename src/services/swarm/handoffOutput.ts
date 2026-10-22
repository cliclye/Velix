/**
 * Extract structured swarm handoff blocks from worker CLI output.
 * Worker prompts require role-specific markers (---SCOUT-FINDINGS---, etc.) that
 * the coordinator and downstream agents consume — not raw logs.
 */

import type { AgentRoleType } from './types';

const ANSI_ESCAPE_REGEX = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\u009B[0-?]*[ -/]*[@-~]/g;

const ROLE_HANDOFF_BLOCKS: Partial<Record<AgentRoleType, { start: string; end: string }>> = {
  scout: { start: '---SCOUT-FINDINGS---', end: '---END-SCOUT-FINDINGS---' },
  builder: { start: '---BUILDER-REPORT---', end: '---END-BUILDER-REPORT---' },
  reviewer: { start: '---REVIEW-VERDICT---', end: '---END-REVIEW-VERDICT---' },
};

const TIMING_LINE = /^(?:Baked|Brewed|Worked|Churned|Cogitated)\s+for\s+/i;

export function sanitizeTerminalOutput(data: string): string {
  return data
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_ESCAPE_REGEX, '')
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '');
}

/**
 * Return the LAST complete handoff block for the role. The last one wins because a
 * worker may mention the marker while narrating before it writes the real report.
 */
export function extractStructuredHandoff(output: string, role: AgentRoleType): string | null {
  const markers = ROLE_HANDOFF_BLOCKS[role];
  if (!markers) return null;

  let searchFrom = output.length;
  while (searchFrom >= 0) {
    const startIdx = output.lastIndexOf(markers.start, searchFrom);
    if (startIdx === -1) return null;
    const endIdx = output.indexOf(markers.end, startIdx + markers.start.length);
    if (endIdx !== -1) {
      return output.slice(startIdx, endIdx + markers.end.length).trim();
    }
    // Unterminated block (e.g. truncated run): look at an earlier start marker.
    searchFrom = startIdx - 1;
  }
  return null;
}

export function stripTerminalNoise(output: string): string {
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t === '>' || t === '❯' || t === '›' || t === '%' || t === '$') return false;
      if (/Resume this session with:/i.test(t)) return false;
      return !TIMING_LINE.test(t);
    })
    .join('\n')
    .trim();
}

/**
 * Format worker output for coordinator consumption.
 * Prefers the structured handoff block; falls back to denoised text (tail).
 */
export function formatCoordinatorHandoff(output: string, role: AgentRoleType, maxChars = 12_000): string {
  const clean = sanitizeTerminalOutput(output);
  const structured = extractStructuredHandoff(clean, role);
  const text = structured ?? stripTerminalNoise(clean) ?? '';
  const result = text || clean.trim();
  if (result.length <= maxChars) return result;
  return structured ? structured.slice(0, maxChars) : result.slice(-maxChars);
}

// ---------------------------------------------------------------------------
// Reviewer verdicts
// ---------------------------------------------------------------------------

export interface ReviewVerdict {
  decision: 'APPROVED' | 'REVISE' | null;
  /** Findings + revision instructions, ready to hand to builders. */
  feedback: string;
}

function section(block: string, heading: string): string {
  const re = new RegExp(`^##\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|---END-REVIEW-VERDICT---|$)`, 'im');
  return block.match(re)?.[1].trim() ?? '';
}

/** Parse a reviewer's ---REVIEW-VERDICT--- block deterministically (no API call needed). */
export function parseReviewVerdict(output: string): ReviewVerdict {
  const block = extractStructuredHandoff(sanitizeTerminalOutput(output), 'reviewer');
  if (!block) return { decision: null, feedback: '' };

  const decisionLine = block.match(/##\s*Decision:([^\n]*)/i)?.[1] ?? '';
  // "[APPROVED or REVISE]" is the unfilled template, not a decision.
  const decisionMatch = /APPROVED/i.test(decisionLine) && /REVISE/i.test(decisionLine)
    ? null
    : decisionLine.match(/\b(APPROVED|REVISE)\b/i);
  const decision = decisionMatch ? (decisionMatch[1].toUpperCase() as 'APPROVED' | 'REVISE') : null;

  const parts = [
    ['Findings', section(block, 'Findings')],
    ['Missing requirements', section(block, 'Missing Requirements')],
    ['Revision instructions', section(block, 'Revision Instructions')],
  ]
    .filter(([, body]) => body && !/^none\.?$/i.test(body))
    .map(([title, body]) => `### ${title}\n${body}`);

  return { decision, feedback: parts.join('\n\n') };
}
