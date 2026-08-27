import { describe, expect, it } from 'vitest';
import { buildMidStreamDropMessage, isMidStreamConnectionDrop } from './provider.js';

describe('isMidStreamConnectionDrop', () => {
  it('matches undici’s bare "terminated" mid-stream error', () => {
    expect(isMidStreamConnectionDrop(new TypeError('terminated'))).toBe(true);
  });

  it('matches a terminated error whose cause is a socket error', () => {
    const err = new TypeError('terminated');
    (err as { cause?: unknown }).cause = Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    });
    expect(isMidStreamConnectionDrop(err)).toBe(true);
  });

  it('matches an ECONNRESET socket reset', () => {
    expect(isMidStreamConnectionDrop(Object.assign(new Error('read ECONNRESET'), {}))).toBe(true);
  });

  it('does not match our own AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isMidStreamConnectionDrop(err)).toBe(false);
  });

  it('does not match an unrelated error', () => {
    expect(isMidStreamConnectionDrop(new Error('model failed to load'))).toBe(false);
  });

  it('tolerates non-Error values', () => {
    expect(isMidStreamConnectionDrop('terminated')).toBe(false);
    expect(isMidStreamConnectionDrop(undefined)).toBe(false);
  });
});

describe('buildMidStreamDropMessage', () => {
  it('names the settings change when we stopped the engine ourselves', () => {
    const msg = buildMidStreamDropMessage(1817, true);
    expect(msg).toContain('after 1817 chars');
    expect(msg).toMatch(/settings/i);
    expect(msg).toMatch(/send the message again/i);
    // The whole point: never blame a crash or an OOM for our own teardown.
    expect(msg).not.toMatch(/crashed,|ran out of memory/i);
  });

  it('keeps the crash wording for an unplanned drop', () => {
    const msg = buildMidStreamDropMessage(1817, false);
    expect(msg).toMatch(/crashed, ran out of memory/i);
    expect(msg).not.toMatch(/settings change/i);
  });

  it('never blames a crash or an OOM while the engine is still running', () => {
    // Wild-caught: six turns died at ~300s to undici's default fetch
    // timeout while the engine was healthy and serving another session at
    // 6.8 tok/s. The old wording asserted a crash/OOM and told the user to
    // restart the engine — advice that could not help and sent a real
    // investigation looking for an OOM that never happened.
    const msg = buildMidStreamDropMessage(0, false, true);
    expect(msg).not.toMatch(/crashed|ran out of memory/i);
    expect(msg).not.toMatch(/restart the engine/i);
    expect(msg).toMatch(/still running/i);
    expect(msg).toMatch(/did not crash or run out of memory/i);
    // Points at the thing that actually distinguishes a timeout.
    expect(msg).toMatch(/same elapsed time/i);
  });

  it('keeps the crash wording when the engine really did go away', () => {
    const msg = buildMidStreamDropMessage(0, false, false);
    expect(msg).toMatch(/crashed, ran out of memory/i);
  });

  it('falls back to the crash wording when liveness is unknown', () => {
    const msg = buildMidStreamDropMessage(0, false, undefined);
    expect(msg).toMatch(/crashed, ran out of memory/i);
  });

  it('a planned stop still wins over engine liveness', () => {
    const msg = buildMidStreamDropMessage(10, true, true);
    expect(msg).toMatch(/settings/i);
    expect(msg).not.toMatch(/still running/i);
  });

  it('says "before any output" when nothing streamed', () => {
    expect(buildMidStreamDropMessage(0, true)).toContain('before any output');
    expect(buildMidStreamDropMessage(0, false)).toContain('before any output');
  });
});
