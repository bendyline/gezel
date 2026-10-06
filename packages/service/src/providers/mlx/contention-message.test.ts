import { describe, expect, it } from 'vitest';
import { buildPreFirstByteAbortMessage } from './runtime-diagnostics.js';

// Engine vocabulary a person cannot act on. The old messages read "no first
// byte", "prefill stalled", "54,971 / 54,987 tokens", "mlx_vlm.server".
const JARGON = /first byte|prefill|token|mlx_vlm|server|budget|session|abort/i;

// A restart resumed four sessions onto one MLX engine. One turn waited
// 10m36s behind a neighbour's 124s prefill, got no first byte, and was told
// the model might be loading slowly or the server might be unhealthy — the
// engine had been ready for ten minutes and was demonstrably working. The
// reader's next step was "restart the engine in Settings", which would have
// killed a healthy engine and lost the neighbour's turn too.
describe('buildPreFirstByteAbortMessage', () => {
  it('says the message was waiting behind another chat', () => {
    const message = buildPreFirstByteAbortMessage(null, {
      detail: '54,971 / 54,987 tokens',
      secondsAgo: 194,
    });
    expect(message).toMatch(/another chat/);
    expect(message).toMatch(/send the message again/i);
    // The advice that would have killed a working engine (and the
    // neighbour's turn with it).
    expect(message).not.toMatch(/restart|reopen|loading/i);
    expect(message).not.toContain('54,971');
    expect(message).not.toMatch(JARGON);
  });

  it('prefers this turn’s own progress over a neighbour’s', () => {
    // Our request DID start reading — the stall is ours, so the
    // neighbour is irrelevant however recently it ran.
    const message = buildPreFirstByteAbortMessage(
      { progress: 0.42, detail: '10240/24317', at: Date.now() },
      { detail: 'someone else', secondsAgo: 2 },
    );
    expect(message).toContain('42% done');
    expect(message).not.toMatch(/another chat/);
    expect(message).not.toContain('10240');
    expect(message).not.toMatch(JARGON);
  });

  it('says it ran out of time while still reading when there is no percentage', () => {
    const message = buildPreFirstByteAbortMessage({ progress: 0, detail: '61K', at: Date.now() });
    expect(message).toMatch(/still reading/);
    expect(message).not.toMatch(JARGON);
  });

  it('falls back to the loading guess only when nothing was observed', () => {
    for (const message of [
      buildPreFirstByteAbortMessage(null, null),
      buildPreFirstByteAbortMessage(null),
    ]) {
      expect(message).toMatch(/didn't start answering/);
      expect(message).toMatch(/loading/);
      expect(message).not.toMatch(JARGON);
    }
  });
});
