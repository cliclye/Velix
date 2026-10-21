import { describe, expect, it } from 'vitest';
import { buildWorkerInvocation, createStreamParser, splitCommand, MAX_ARGV_PROMPT_CHARS } from '../workerCli';

describe('splitCommand', () => {
  it('splits on whitespace and honours quotes', () => {
    expect(splitCommand(`mycli --flag "two words" 'single quoted'`)).toEqual([
      'mycli', '--flag', 'two words', 'single quoted',
    ]);
  });
  it('keeps empty quoted arguments', () => {
    expect(splitCommand(`a "" b`)).toEqual(['a', '', 'b']);
  });
  it('handles empty input', () => {
    expect(splitCommand('   ')).toEqual([]);
  });
});

describe('buildWorkerInvocation', () => {
  const prompt = `line one\nsecond line with 'quotes', "doubles", $(subshell) and \`ticks\``;

  it('claude: prompt goes through stdin untouched, never through argv', () => {
    const inv = buildWorkerInvocation('claude', prompt);
    expect(inv.program).toBe('claude');
    expect(inv.stdin).toBe(prompt);
    expect(inv.args).toContain('-p');
    expect(inv.args).toContain('stream-json');
    expect(inv.args.join(' ')).not.toContain('subshell');
    expect(inv.streamJson).toBe(true);
  });

  it('claude: passes --model only when set', () => {
    expect(buildWorkerInvocation('claude', 'x').args).not.toContain('--model');
    const inv = buildWorkerInvocation('claude', 'x', ' claude-sonnet-5-5 ');
    expect(inv.args.slice(-2)).toEqual(['--model', 'claude-sonnet-5-5']);
  });

  it('codex: reads from stdin via "-"', () => {
    const inv = buildWorkerInvocation('codex', prompt);
    expect(inv.args.slice(0, 2)).toEqual(['exec', '--full-auto']);
    expect(inv.args[inv.args.length - 1]).toBe('-');
    expect(inv.stdin).toBe(prompt);
  });

  it('gemini: prompt is one argv element (no shell quoting needed)', () => {
    const inv = buildWorkerInvocation('gemini', prompt);
    expect(inv.args).toEqual(['--yolo', '-p', prompt]);
    expect(inv.stdin).toBeUndefined();
  });

  it('truncates oversized argv prompts but never stdin prompts', () => {
    const huge = 'x'.repeat(MAX_ARGV_PROMPT_CHARS + 5000);
    const viaArgv = buildWorkerInvocation('gemini', huge);
    expect(viaArgv.args[2].length).toBeLessThan(huge.length);
    expect(viaArgv.args[2]).toContain('truncated');
    expect(buildWorkerInvocation('claude', huge).stdin).toHaveLength(huge.length);
  });

  it('unknown ids fall back to "<id> -p <prompt>"', () => {
    const inv = buildWorkerInvocation('my-agent', 'hello');
    expect(inv.program).toBe('my-agent');
    expect(inv.args).toEqual(['-p', 'hello']);
  });
});

describe('createStreamParser', () => {
  const line = (o: unknown) => JSON.stringify(o) + '\n';

  it('extracts tool activity, touched files and the final result', () => {
    const p = createStreamParser(() => 1);
    p.push(line({ type: 'system', subtype: 'init', model: 'm' }));
    p.push(line({ type: 'assistant', message: { content: [
      { type: 'text', text: 'Reading the file first.\nMore.' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ] } }));
    p.push(line({ type: 'result', subtype: 'success', is_error: false, result: 'FINAL TEXT', total_cost_usd: 0.42 }));
    p.end();

    const snap = p.snapshot();
    expect(snap.finalText).toBe('FINAL TEXT');
    expect(snap.costUsd).toBe(0.42);
    expect(snap.filesTouched).toEqual(['src/a.ts']);
    expect(snap.activity.map((a) => a.text)).toEqual([
      'Session started · m',
      'Reading the file first.',
      'Read src/a.ts',
      'Edit src/a.ts',
      'Bash npm test',
    ]);
    expect(snap.isError).toBeUndefined();
  });

  it('reassembles events split across chunks', () => {
    const p = createStreamParser();
    const full = line({ type: 'result', result: 'ok', is_error: false });
    p.push(full.slice(0, 10));
    p.push(full.slice(10));
    expect(p.snapshot().finalText).toBe('ok');
  });

  it('flags error results', () => {
    const p = createStreamParser();
    p.push(line({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Too many turns' }));
    const snap = p.snapshot();
    expect(snap.isError).toBe(true);
    expect(snap.activity[snap.activity.length - 1]?.kind).toBe('error');
  });

  it('keeps non-JSON lines as plain text so older CLIs lose nothing', () => {
    const p = createStreamParser();
    p.push('plain progress line\n{not json}\n');
    const snap = p.snapshot();
    expect(snap.assistantText).toContain('plain progress line');
    expect(snap.assistantText).toContain('{not json}');
  });

  it('flushes a trailing line without newline on end()', () => {
    const p = createStreamParser();
    p.push(JSON.stringify({ type: 'result', result: 'tail', is_error: false }));
    expect(p.snapshot().finalText).toBeUndefined();
    p.end();
    expect(p.snapshot().finalText).toBe('tail');
  });
});
