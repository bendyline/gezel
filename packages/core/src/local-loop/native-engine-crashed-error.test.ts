import { describe, expect, it } from 'vitest';
import type { NativeEngineExitSnapshot } from './engine-host.js';
import { NativeEngineCrashedError } from './llama-cpp-session.js';

// A silent SIGILL before readiness reads as unrunnable on every platform, so
// these cases do not depend on the host the suite runs on.
const silentStartupCrash: NativeEngineExitSnapshot = {
  incidentId: 'native-1-2',
  startedAt: 1,
  exitedAt: 2,
  uptimeMs: 1,
  code: null,
  signal: 'SIGILL',
  expected: false,
  reachedReady: false,
  panicKind: 'illegal-instruction',
  outputTail: '',
  diagnostics: { backend: 'cuda' },
};

describe('NativeEngineCrashedError', () => {
  it('says the same build restarts while the crash is only a strike', () => {
    const error = new NativeEngineCrashedError(silentStartupCrash, undefined, {
      kind: 'strike',
      strikes: 1,
      threshold: 3,
    });
    expect(error.message).toContain('It will restart on the next request.');
    expect(error.message).toContain('fails to start 2 more times in a row');
    // The chat hides Retry for this phrase, and retrying is how the count advances.
    expect(error.message).not.toMatch(/cannot run on this machine/i);
  });

  it('names the switch only when the crash switched the build off', () => {
    const switched = new NativeEngineCrashedError(silentStartupCrash, undefined, {
      kind: 'quarantined',
      switchedTo: 'vulkan',
    });
    expect(switched.message).toContain(
      'Gezel will switch to another engine backend on the next request.',
    );
    const atNextStart = new NativeEngineCrashedError(silentStartupCrash, undefined, {
      kind: 'quarantined',
    });
    expect(atNextStart.message).toContain(
      'Gezel will use another engine backend the next time it starts.',
    );
  });

  it('promises nothing it was not told', () => {
    const error = new NativeEngineCrashedError(silentStartupCrash);
    expect(error.message).toContain('It will restart on the next request.');
    expect(error.message).not.toContain('switch');
  });
});
