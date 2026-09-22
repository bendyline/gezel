import { describe, expect, it } from 'vitest';
import { RunScriptResponseSchema, type ScriptRun } from '../schemas/script.js';
import {
  notFoundBody,
  saveConflictResponse,
  saveConflicts,
  savedSourceResponse,
  scriptRunResponse,
} from './script-responses.js';

describe('scriptRunResponse', () => {
  it('produces the shared wire shape for a failed run too', () => {
    const run = {
      id: 'r1',
      projectId: 'p',
      scriptName: 's',
      startedAt: '2026-09-22T00:00:00.000Z',
      status: 'error',
      trigger: { kind: 'manual', userInitiated: true },
      inputs: {},
      calls: [{ kind: 'fs.read', durationMs: 3, error: 'nope' }],
      logs: '',
      error: 'Error: boom',
    } as unknown as ScriptRun;
    const reply = scriptRunResponse(run);
    expect(RunScriptResponseSchema.parse(reply)).toEqual(reply);
    expect(reply.callsSummary[0]).toEqual({ kind: 'fs.read', durationMs: 3, error: 'nope' });
  });
});

describe('save conflicts', () => {
  it('conflicts on a stale hash and on a script deleted underneath the editor', () => {
    expect(saveConflicts(undefined, null)).toBe(false);
    expect(saveConflicts('abc', { hash: 'abc' })).toBe(false);
    expect(saveConflicts('abc', { hash: 'def' })).toBe(true);
    expect(saveConflicts('abc', null)).toBe(true);
    expect(saveConflictResponse(null)).toEqual({
      status: 'conflict',
      currentHash: '',
      currentSource: '',
    });
  });
  it('reports a save with its inspection', () => {
    expect(savedSourceResponse('h', { diagnostics: [] })).toEqual({
      status: 'saved',
      hash: 'h',
      metaOk: false,
      diagnostics: [],
    });
  });
  it('names what was not found', () => {
    expect(notFoundBody('script run')).toEqual({ error: 'Script run not found' });
  });
});
