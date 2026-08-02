import { ChatTurnErrorDetailSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { CapacityDeniedError } from '../providers/native/capacity-broker.js';
import { TurnAbortError } from '../providers/turn-abort-error.js';
import { describeTurnError } from './turn-error.js';

/** The shape `NativeEngineCrashedError` presents to the extractor. */
function nativeCrash() {
  return Object.assign(new Error('[llama-cpp] on-device engine crashed (SIGILL)'), {
    code: 'native-engine-crash',
    engine: 'llama-cpp',
    incidentId: 'native-51832-1785547847453',
    panicKind: 'cuda-out-of-memory',
    exitCode: null,
    signal: 'SIGILL',
    diagnostics: { model: 'gemma4-26b-q4', backend: 'vulkan', contextTotal: 32768, slots: 1 },
  });
}

describe('describeTurnError', () => {
  it('extracts every field a native engine crash carries', () => {
    expect(describeTurnError(nativeCrash())).toEqual({
      code: 'native-engine-crash',
      engine: 'llama-cpp',
      incidentId: 'native-51832-1785547847453',
      panicKind: 'cuda-out-of-memory',
      exitCode: null,
      signal: 'SIGILL',
      diagnostics: { model: 'gemma4-26b-q4', backend: 'vulkan', contextTotal: 32768, slots: 1 },
    });
  });

  it('classifies a turn abort', () => {
    const err = new TurnAbortError('stop re-emitting the file', 'The turn was stopped.');
    expect(describeTurnError(err)).toEqual({ code: 'turn-aborted' });
  });

  it('classifies a capacity denial apart from a crash', () => {
    expect(describeTurnError(new CapacityDeniedError('Not enough memory'))).toEqual({
      code: 'capacity-denied',
    });
  });

  it('picks up a Node errno for free', () => {
    const err = Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    expect(describeTurnError(err)).toEqual({ code: 'ENOENT' });
  });

  it('ignores a numeric code — only a string is a failure class', () => {
    expect(describeTurnError(Object.assign(new Error('x'), { code: 42 }))).toBeUndefined();
  });

  it('returns undefined rather than an empty object when nothing is knowable', () => {
    expect(describeTurnError(new Error('plain'))).toBeUndefined();
    expect(describeTurnError('a string')).toBeUndefined();
    expect(describeTurnError(null)).toBeUndefined();
    expect(describeTurnError(undefined)).toBeUndefined();
  });

  it('bounds the diagnostics map in both count and value length', () => {
    const diagnostics: Record<string, string> = {};
    for (let i = 0; i < 100; i++) diagnostics[`k${i}`] = 'v';
    diagnostics.long = 'x'.repeat(5000);
    const out = describeTurnError(Object.assign(new Error('x'), { code: 'c', diagnostics }));
    expect(Object.keys(out?.diagnostics ?? {})).toHaveLength(24);

    const single = describeTurnError(
      Object.assign(new Error('x'), { code: 'c', diagnostics: { long: 'x'.repeat(5000) } }),
    );
    expect(single?.diagnostics?.long).toHaveLength(120);
  });

  it('drops non-primitive diagnostics values', () => {
    const out = describeTurnError(
      Object.assign(new Error('x'), {
        code: 'c',
        diagnostics: { good: 'yes', nested: { a: 1 }, list: [1, 2] },
      }),
    );
    expect(out?.diagnostics).toEqual({ good: 'yes' });
  });

  it('scrubs credentials out of every string it emits', () => {
    const out = describeTurnError(
      Object.assign(new Error('x'), {
        code: 'c',
        engine: 'llama-cpp',
        diagnostics: { launchArg: 'token ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789' },
      }),
    );
    expect(out?.diagnostics?.launchArg).toContain('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('ghp_');
  });

  it('produces something the published schema accepts', () => {
    for (const err of [nativeCrash(), new TurnAbortError('a', 'b'), new CapacityDeniedError('c')]) {
      expect(() => ChatTurnErrorDetailSchema.parse(describeTurnError(err))).not.toThrow();
    }
  });
});
