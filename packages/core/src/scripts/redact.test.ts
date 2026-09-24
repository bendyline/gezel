import { describe, expect, it } from 'vitest';
import type { ScriptRun } from '../schemas/script.js';
import { redactObject, redactScriptRun, redactString } from './redact.js';

describe('redactString', () => {
  it('is a no-op when the secret set is empty', () => {
    expect(redactString('ghp_abcdef', new Set())).toBe('ghp_abcdef');
  });

  it('replaces a single known secret with [REDACTED]', () => {
    const out = redactString('auth failed: Bearer ghp_abcdef rejected', new Set(['ghp_abcdef']));
    expect(out).toBe('auth failed: Bearer [REDACTED] rejected');
  });

  it('replaces multiple known secrets', () => {
    const out = redactString('token=ghp_xxx org=acme-secret', new Set(['ghp_xxx', 'acme-secret']));
    expect(out).toBe('token=[REDACTED] org=[REDACTED]');
  });

  it('ignores empty secret values in the set', () => {
    const out = redactString('hello', new Set(['']));
    expect(out).toBe('hello');
  });
});

describe('redactObject', () => {
  it('redacts string values anywhere in the object graph', () => {
    const input = {
      name: 'callTool',
      args: { path: 'README.md', token: 'ghp_xxx' },
      nested: [{ header: 'Bearer ghp_xxx' }],
    };
    const out = redactObject(input, new Set(['ghp_xxx']));
    expect(out).toEqual({
      name: 'callTool',
      args: { path: 'README.md', token: '[REDACTED]' },
      nested: [{ header: 'Bearer [REDACTED]' }],
    });
  });

  it('leaves numbers, booleans, and null untouched', () => {
    const input = { n: 42, b: true, z: null };
    expect(redactObject(input, new Set(['ghp_xxx']))).toEqual(input);
  });

  it('returns the same value untouched when there are no secrets', () => {
    const input = { token: 'ghp_xxx' };
    expect(redactObject(input, new Set())).toBe(input);
  });

  it('redacts a bare string and arrays of strings', () => {
    expect(redactObject('ghp_xxx', new Set(['ghp_xxx']))).toBe('[REDACTED]');
    expect(redactObject(['a', 'ghp_xxx'], new Set(['ghp_xxx']))).toEqual(['a', '[REDACTED]']);
  });
});

describe('redactScriptRun', () => {
  function run(overrides: Partial<ScriptRun> = {}): ScriptRun {
    return {
      id: 'r1',
      projectId: 'p1',
      scriptName: 'fetch',
      startedAt: '2026-09-23T00:00:00.000Z',
      status: 'error',
      trigger: { kind: 'manual', userInitiated: true },
      inputs: {},
      calls: [],
      logs: '',
      ...overrides,
    };
  }

  it('scrubs the log, error, output, and every call summary', () => {
    const record = run({
      logs: 'using ghp_xxx',
      error: 'rejected ghp_xxx',
      output: { header: 'Bearer ghp_xxx', count: 1 },
      calls: [
        {
          at: '2026-09-23T00:00:01.000Z',
          kind: 'http.authed',
          argsSummary: 'token=ghp_xxx',
          outputSummary: 'echo ghp_xxx',
          durationMs: 3,
          error: 'bad ghp_xxx',
        },
        {
          at: '2026-09-23T00:00:02.000Z',
          kind: 'fs.read',
          argsSummary: 'README.md',
          durationMs: 1,
        },
      ],
    });
    redactScriptRun(record, new Set(['ghp_xxx']));
    expect(record.logs).toBe('using [REDACTED]');
    expect(record.error).toBe('rejected [REDACTED]');
    expect(record.output).toEqual({ header: 'Bearer [REDACTED]', count: 1 });
    expect(record.calls[0]).toMatchObject({
      argsSummary: 'token=[REDACTED]',
      outputSummary: 'echo [REDACTED]',
      error: 'bad [REDACTED]',
    });
    expect(record.calls[1]).toEqual({
      at: '2026-09-23T00:00:02.000Z',
      kind: 'fs.read',
      argsSummary: 'README.md',
      durationMs: 1,
    });
  });

  it('leaves absent fields absent and does nothing without secrets', () => {
    const record = run({ logs: 'ghp_xxx' });
    redactScriptRun(record, new Set());
    expect(record.logs).toBe('ghp_xxx');
    redactScriptRun(record, new Set(['ghp_xxx']));
    expect(record).not.toHaveProperty('error');
    expect(record).not.toHaveProperty('output');
  });
});
