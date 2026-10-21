import { describe, expect, it } from 'vitest';
import { repairTruncatedJson } from '../jsonRepair';
import { parseObjectResponse } from '../ClaudeCoordinator';

describe('repairTruncatedJson', () => {
  it('returns balanced documents unchanged', () => {
    expect(repairTruncatedJson('{"a":1}')).toBe('{"a":1}');
  });

  it('closes a truncated object after a complete value', () => {
    const fixed = repairTruncatedJson('{"summary":"ok","strategy":"x","assignments":[{"id":"a","task":"do"},{"id":"b","ta');
    const parsed = JSON.parse(fixed!);
    expect(parsed.summary).toBe('ok');
    // The cut-off second object keeps the fields that were completed before the cut.
    expect(parsed.assignments).toEqual([{ id: 'a', task: 'do' }, { id: 'b' }]);
  });

  it('drops a dangling key', () => {
    const parsed = JSON.parse(repairTruncatedJson('{"a":1,"b":')!);
    expect(parsed).toEqual({ a: 1 });
  });

  it('drops a half-written string value', () => {
    const parsed = JSON.parse(repairTruncatedJson('{"a":1,"b":"unfinis')!);
    expect(parsed).toEqual({ a: 1 });
  });

  it('handles escaped quotes inside strings', () => {
    const parsed = JSON.parse(repairTruncatedJson('{"a":"say \\"hi\\"","b":[1,2')!);
    expect(parsed.a).toBe('say "hi"');
  });

  it('keeps complete array items', () => {
    const parsed = JSON.parse(repairTruncatedJson('{"list":["a","b","c')!);
    expect(parsed.list).toEqual(['a', 'b']);
  });

  it('returns null for non-JSON', () => {
    expect(repairTruncatedJson('no json here')).toBeNull();
    expect(repairTruncatedJson('')).toBeNull();
  });
});

describe('parseObjectResponse', () => {
  it('parses fenced JSON', () => {
    expect(parseObjectResponse<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON surrounded by prose', () => {
    expect(parseObjectResponse<{ a: number }>('Here you go: {"a":2} hope it helps')).toEqual({ a: 2 });
  });

  it('salvages a truncated plan', () => {
    const out = parseObjectResponse<{ summary: string; assignments: unknown[] }>(
      '```json\n{"summary":"s","assignments":[{"assignmentId":"builder-1","task":"t"},{"assignmentId":"bui',
    );
    expect(out?.summary).toBe('s');
    expect(out?.assignments).toHaveLength(1);
  });

  it('returns null for garbage', () => {
    expect(parseObjectResponse('sorry, I cannot do that')).toBeNull();
  });
});
