/**
 * Pure TypeScript LCS-based line diff — no external dependencies.
 * Used by DiffPanel to compute file change hunks before presenting to the user.
 */

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  oldLineNum: number | null; // null for added lines
  newLineNum: number | null; // null for removed lines
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

// Internal type used during LCS backtracking
type RawKind = 'same' | 'added' | 'removed';
interface RawLine {
  kind: RawKind;
  text: string;
}

/** Build an LCS DP table. Uses Uint32Array rows for speed. */
function buildLCS(a: string[], b: string[]): Uint32Array[] {
  const m = a.length;
  const n = b.length;
  // Allocate m+1 rows
  const dp: Uint32Array[] = new Array(m + 1);
  for (let i = m; i >= 0; i--) {
    dp[i] = new Uint32Array(n + 1);
  }
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        const down = dp[i + 1][j];
        const right = dp[i][j + 1];
        dp[i][j] = down >= right ? down : right;
      }
    }
  }
  return dp;
}

/** Backtrack the LCS table to produce a flat sequence of raw lines. */
function backtrack(dp: Uint32Array[], a: string[], b: string[]): RawLine[] {
  const result: RawLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ kind: 'removed', text: a[i] });
      i++;
    } else {
      result.push({ kind: 'added', text: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    result.push({ kind: 'removed', text: a[i++] });
  }
  while (j < b.length) {
    result.push({ kind: 'added', text: b[j++] });
  }
  return result;
}

/**
 * Group a flat raw-line sequence into display hunks with surrounding context.
 * Adjacent change regions that are within 2*contextLines of each other are merged.
 */
function buildHunks(raw: RawLine[], contextLines: number): DiffHunk[] {
  // Assign line numbers
  interface NumberedLine {
    kind: RawKind;
    oldLineNum: number | null;
    newLineNum: number | null;
    text: string;
  }

  const numbered: NumberedLine[] = [];
  let oldNum = 1;
  let newNum = 1;
  for (const r of raw) {
    if (r.kind === 'same') {
      numbered.push({ kind: 'same', oldLineNum: oldNum++, newLineNum: newNum++, text: r.text });
    } else if (r.kind === 'removed') {
      numbered.push({ kind: 'removed', oldLineNum: oldNum++, newLineNum: null, text: r.text });
    } else {
      numbered.push({ kind: 'added', oldLineNum: null, newLineNum: newNum++, text: r.text });
    }
  }

  // Find indices of all changed lines
  const changeIndices: number[] = [];
  for (let idx = 0; idx < numbered.length; idx++) {
    if (numbered[idx].kind !== 'same') changeIndices.push(idx);
  }

  if (changeIndices.length === 0) return [];

  // Build windows: [start, end] inclusive, expanded by contextLines
  type Window = [number, number];
  const windows: Window[] = [];
  let winStart = Math.max(0, changeIndices[0] - contextLines);
  let winEnd = Math.min(numbered.length - 1, changeIndices[0] + contextLines);

  for (let k = 1; k < changeIndices.length; k++) {
    const nextStart = Math.max(0, changeIndices[k] - contextLines);
    const nextEnd = Math.min(numbered.length - 1, changeIndices[k] + contextLines);
    if (nextStart <= winEnd + 1) {
      // Merge adjacent windows
      winEnd = Math.max(winEnd, nextEnd);
    } else {
      windows.push([winStart, winEnd]);
      winStart = nextStart;
      winEnd = nextEnd;
    }
  }
  windows.push([winStart, winEnd]);

  // Convert each window to a DiffHunk
  const hunks: DiffHunk[] = windows.map(([start, end]) => {
    const lines: DiffLine[] = numbered.slice(start, end + 1).map(nl => ({
      kind: nl.kind === 'same' ? 'context' : nl.kind,
      oldLineNum: nl.oldLineNum,
      newLineNum: nl.newLineNum,
      text: nl.text,
    }));

    const firstOld = lines.find(l => l.oldLineNum !== null)?.oldLineNum ?? 1;
    const firstNew = lines.find(l => l.newLineNum !== null)?.newLineNum ?? 1;

    return { oldStart: firstOld, newStart: firstNew, lines };
  });

  return hunks;
}

/**
 * Compute a unified diff between `original` and `modified`.
 * Returns hunks suitable for rendering in DiffPanel, plus added/removed line counts.
 *
 * For files exceeding 2000 lines the LCS approach is skipped and the entire
 * content is shown as a single remove-then-add hunk for performance.
 */
export function computeLineDiff(
  original: string,
  modified: string,
  contextLines = 3,
): { hunks: DiffHunk[]; addedCount: number; removedCount: number } {
  // Special case: empty original → new file, all lines added
  if (original === '') {
    const lines = modified === '' ? [] : modified.split('\n');
    const diffLines: DiffLine[] = lines.map((text, i) => ({
      kind: 'added' as DiffLineKind,
      oldLineNum: null,
      newLineNum: i + 1,
      text,
    }));
    return {
      hunks: diffLines.length > 0 ? [{ oldStart: 0, newStart: 1, lines: diffLines }] : [],
      addedCount: lines.length,
      removedCount: 0,
    };
  }

  const a = original.split('\n');
  const b = modified.split('\n');

  // Performance guard: fall back to full-replace hunk for very large files
  if (a.length > 2000 || b.length > 2000) {
    const removed: DiffLine[] = a.map((text, i) => ({
      kind: 'removed' as DiffLineKind,
      oldLineNum: i + 1,
      newLineNum: null,
      text,
    }));
    const added: DiffLine[] = b.map((text, i) => ({
      kind: 'added' as DiffLineKind,
      oldLineNum: null,
      newLineNum: i + 1,
      text,
    }));
    return {
      hunks: [{ oldStart: 1, newStart: 1, lines: [...removed, ...added] }],
      addedCount: b.length,
      removedCount: a.length,
    };
  }

  const dp = buildLCS(a, b);
  const raw = backtrack(dp, a, b);
  const hunks = buildHunks(raw, contextLines);
  const addedCount = raw.filter(l => l.kind === 'added').length;
  const removedCount = raw.filter(l => l.kind === 'removed').length;

  return { hunks, addedCount, removedCount };
}
