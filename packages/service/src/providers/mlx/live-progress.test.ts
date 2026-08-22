import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyDs4Line } from '../ds4/stdout-parser.js';

/**
 * Live decode telemetry travels as fields on the `generating` phase event
 * (`outputTokens`, `tokensPerSec`) — never folded into the human-readable
 * `detail`. The UI names the phase itself and renders its own counter row,
 * so a prose copy is not a second opinion, it is the same numbers in a
 * format the other side has to scrape back apart.
 *
 * It cost us a header reading "Koray · · 61 tokens": MLX composed
 * "24 tok/s · 61 tokens" as the whole detail, the pill stripped the rate it
 * was never meant to show, and what survived was an orphaned separator plus
 * the counter that belongs in the dropdown. llama.cpp already emitted
 * counters-only; MLX and ds4 are aligned to it here.
 */
const MLX_PROVIDER = readFileSync(join(import.meta.dirname, 'provider.ts'), 'utf8');

/** The `generating` emit that fires on the MLX decode ticker. */
function mlxGeneratingEmit(): string {
  const marker = MLX_PROVIDER.indexOf("phase: 'generating',\n                  //");
  expect(marker, 'the MLX decode-ticker phase emit moved or was renamed').toBeGreaterThan(-1);
  return MLX_PROVIDER.slice(marker, marker + 700);
}

describe('local-engine live decode telemetry', () => {
  it('MLX ships the decode counters as fields, not as phase prose', () => {
    const emit = mlxGeneratingEmit();
    expect(emit).toContain('outputTokens: completionTokens');
    expect(emit).toContain('tokensPerSec: generationTps');
    expect(emit).not.toMatch(/detail:/);
  });

  it('ds4 ships its decode ticker as counters with no detail', () => {
    const phase = classifyDs4Line(
      '[ds4-server] 0718 14:35:12 ds4-server: chat ctx=7880..8030:150 gen=150 TOOLS decoding chunk=5.20 t/s avg=5.35 t/s 28.846s',
    );
    expect(phase?.phase).toBe('generating');
    expect(phase?.outputTokens).toBe(150);
    expect(phase?.tokensPerSec).toBeCloseTo(5.35, 2);
    expect(phase?.detail).toBeUndefined();
  });

  it('ds4 omits the rate when the line carries none, keeping the count', () => {
    const phase = classifyDs4Line(
      '0718 15:02:33 ds4-server: chat ctx=7880..9130:1250 gen=1250 TOOLS THINKING decoding chunk=4.98 t/s avg=0 t/s 249.0s',
    );
    expect(phase?.outputTokens).toBe(1250);
    expect(phase?.tokensPerSec).toBeUndefined();
    expect(phase?.detail).toBeUndefined();
  });
});
