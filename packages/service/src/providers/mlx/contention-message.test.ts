import { describe, expect, it } from 'vitest';
import { buildPreFirstByteAbortMessage } from './runtime-diagnostics.js';

// A restart resumed four sessions onto one MLX engine. One turn waited
// 10m36s behind a neighbour's 124s prefill, got no first byte, and was told
// the model might be loading slowly or the server might be unhealthy — the
// engine had been ready for ten minutes and was demonstrably working. The
// reader's next step was "restart the engine in Settings", which would have
// killed a healthy engine and lost the neighbour's turn too.
describe('buildPreFirstByteAbortMessage', () => {
  it('names contention when the engine was prefilling another session', () => {
    const message = buildPreFirstByteAbortMessage(null, {
      detail: '24317 tokens',
      secondsAgo: 87,
    });
    expect(message).toContain("busy with another session's turn");
    expect(message).toContain('24317 tokens');
    expect(message).toContain('87s ago');
    // The advice that would have killed a working engine (and the
    // neighbour's turn with it).
    expect(message).not.toMatch(/restart the engine/i);
    expect(message).not.toMatch(/loading slowly/i);
  });

  it('prefers this turn’s own prefill evidence over a neighbour’s', () => {
    // Our request DID start prefilling — the stall is ours, so the
    // neighbour is irrelevant however recently it ran.
    const message = buildPreFirstByteAbortMessage(
      { progress: 0.42, detail: '10240/24317', at: Date.now() },
      { detail: 'someone else', secondsAgo: 2 },
    );
    expect(message).toContain('prefill stalled at 42%');
    expect(message).not.toContain('another session');
  });

  it('falls back to the health guess only when nothing was observed', () => {
    expect(buildPreFirstByteAbortMessage(null, null)).toMatch(/loading slowly|unhealthy/);
    expect(buildPreFirstByteAbortMessage(null)).toMatch(/loading slowly|unhealthy/);
  });
});
