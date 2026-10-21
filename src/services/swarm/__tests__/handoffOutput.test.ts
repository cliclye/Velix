import { describe, expect, it } from 'vitest';
import { extractStructuredHandoff, formatCoordinatorHandoff, parseReviewVerdict, sanitizeTerminalOutput } from '../handoffOutput';

describe('extractStructuredHandoff', () => {
  it('extracts the scout block out of surrounding noise', () => {
    const out = ['noise', '---SCOUT-FINDINGS---', '## Relevant Files', '- src/a.ts', '---END-SCOUT-FINDINGS---', '❯'].join('\n');
    expect(extractStructuredHandoff(out, 'scout')).toContain('src/a.ts');
  });

  it('the LAST complete block wins when the worker mentions the marker earlier', () => {
    const out = [
      'I will finish with ---BUILDER-REPORT--- as required.',
      '---BUILDER-REPORT---',
      'real report',
      '---END-BUILDER-REPORT---',
    ].join('\n');
    const block = extractStructuredHandoff(out, 'builder');
    expect(block).toBe('---BUILDER-REPORT---\nreal report\n---END-BUILDER-REPORT---');
  });

  it('falls back to an earlier block when the last one is unterminated', () => {
    const out = '---BUILDER-REPORT---\nfirst\n---END-BUILDER-REPORT---\n---BUILDER-REPORT---\ncut off';
    expect(extractStructuredHandoff(out, 'builder')).toContain('first');
  });

  it('returns null without markers or for roles with no block', () => {
    expect(extractStructuredHandoff('nothing', 'scout')).toBeNull();
    expect(extractStructuredHandoff('---SCOUT-FINDINGS---\nx\n---END-SCOUT-FINDINGS---', 'planner')).toBeNull();
  });
});

describe('formatCoordinatorHandoff', () => {
  it('strips ANSI and timing noise, keeps the tail when over budget', () => {
    const noisy = '\u001b[32mgreen\u001b[0m\nBrewed for 12s\n' + 'x'.repeat(50);
    const out = formatCoordinatorHandoff(noisy, 'builder', 20);
    expect(out).not.toContain('\u001b');
    expect(out).toHaveLength(20);
    expect(out).not.toContain('Brewed');
  });

  it('never returns an empty string for non-empty input', () => {
    expect(formatCoordinatorHandoff('❯\n', 'builder')).toBe('❯');
  });
});

describe('sanitizeTerminalOutput', () => {
  it('normalizes CRLF and removes control chars', () => {
    expect(sanitizeTerminalOutput('a\r\nb\u0007c')).toBe('a\nbc');
  });
});

describe('parseReviewVerdict', () => {
  const block = (decision: string, extra = '') => [
    '---REVIEW-VERDICT---',
    `## Decision: ${decision}`,
    '',
    '## Findings',
    'src/a.ts:12 off-by-one',
    '',
    '## Missing Requirements',
    'None',
    '',
    '## Revision Instructions',
    'Fix the loop bound.',
    extra,
    '---END-REVIEW-VERDICT---',
  ].join('\n');

  it('parses REVISE with feedback, skipping "None" sections', () => {
    const v = parseReviewVerdict(block('REVISE'));
    expect(v.decision).toBe('REVISE');
    expect(v.feedback).toContain('off-by-one');
    expect(v.feedback).toContain('Fix the loop bound');
    expect(v.feedback).not.toContain('Missing requirements');
  });

  it('parses APPROVED, including bracket/bold variants', () => {
    expect(parseReviewVerdict(block('APPROVED')).decision).toBe('APPROVED');
    expect(parseReviewVerdict(block('**APPROVED**')).decision).toBe('APPROVED');
    expect(parseReviewVerdict(block('[REVISE]')).decision).toBe('REVISE');
  });

  it('is case-insensitive and ignores the unfilled template', () => {
    expect(parseReviewVerdict(block('approved')).decision).toBe('APPROVED');
    expect(parseReviewVerdict(block('[APPROVED or REVISE]')).decision).toBeNull();
  });

  it('returns null decision when there is no block', () => {
    expect(parseReviewVerdict('looks fine to me')).toEqual({ decision: null, feedback: '' });
  });
});
