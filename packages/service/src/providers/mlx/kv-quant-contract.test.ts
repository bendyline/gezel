import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The MLX launcher and its python sidecar are two languages either side of an
 * argv boundary, and nothing type-checks across it. `--kv-bits` sat in the
 * launcher for months against a sidecar whose `parse_args()` rejected it, so
 * the one setting that halves a 16 GiB KV cache took the engine down on use
 * instead. It was invisible because the flag is opt-in and defaults to off.
 */
const HERE = join(import.meta.dirname, '.');
const BUILDER = readFileSync(join(HERE, 'build-provider.ts'), 'utf8');
const SIDECAR = readFileSync(join(HERE, 'python', 'gezel_mlx_server.py'), 'utf8');

/** Long-form flags the launcher can put on the sidecar's command line. */
function launcherFlags(): string[] {
  return [...new Set(BUILDER.match(/'--[a-z0-9-]+'/g) ?? [])].map((s) => s.slice(1, -1));
}

/** Long-form flags the sidecar's argparse declares. */
function sidecarFlags(): string[] {
  return [...new Set(SIDECAR.match(/"--[a-z0-9-]+"/g) ?? [])].map((s) => s.slice(1, -1));
}

describe('MLX launcher ↔ sidecar argv contract', () => {
  it('every flag the launcher emits is one the sidecar declares', () => {
    const accepted = new Set(sidecarFlags());
    const unknown = launcherFlags().filter((flag) => !accepted.has(flag));
    expect(
      unknown,
      'gezel_mlx_server.py uses parse_args(), which exits non-zero on an unrecognized ' +
        'argument — so a flag here that it does not declare kills the engine at startup. ' +
        'Add the matching add_argument() in python/gezel_mlx_server.py.',
    ).toEqual([]);
  });

  it('declares the KV-quantization flags mlxKvBits depends on', () => {
    // Named explicitly: the generic check above passes trivially if someone
    // deletes the launcher side, and a silently-dropped `--kv-bits` reads as
    // "quantization is off" rather than as a break.
    const accepted = new Set(sidecarFlags());
    for (const flag of ['--kv-bits', '--kv-quant-scheme', '--kv-group-size']) {
      expect(accepted.has(flag), `${flag} must stay in the sidecar's argparse`).toBe(true);
    }
    expect(BUILDER).toContain("'--kv-bits'");
  });

  it('forwards the quantization options into the serial generation path', () => {
    // Accepting the flag and acting on it are different failures with the same
    // symptom: memory that never drops. `_kv_quant_kwargs` is what carries it
    // into `stream_generate` → mlx-vlm's `generate_step`.
    expect(SIDECAR).toContain('def _kv_quant_kwargs()');
    expect(SIDECAR).toMatch(/\*\*_kv_quant_kwargs\(\)/);
    for (const key of ['kv_bits', 'kv_group_size', 'kv_quant_scheme', 'quantized_kv_start']) {
      expect(SIDECAR).toContain(`"${key}"`);
    }
  });

  it('plans KV at f16 whenever batching may be on', () => {
    // mlx-lm's BatchGenerator builds BatchKVCache layers, which have no
    // `to_quantized`; `maybe_quantize_kv_cache` skips them without a word. If
    // planning took the q8 discount anyway it would under-reserve by ~45%, and
    // an MLX overcommit SIGABRTs the whole python process rather than failing
    // one slot. `mayBatch` defaults to true precisely so an unset config is
    // planned as batched.
    expect(BUILDER).toMatch(
      /const mayBatch =[\s\S]{0,120}config\.batchedInference\?\.enabled \?\? true;/,
    );
    expect(BUILDER).toContain('const kvBitsForPlanning = mayBatch ? 0 : kvBits;');
    expect(BUILDER).toMatch(/kvBitsForPlanning === 4 \? 'q4_0' : kvBitsForPlanning === 8/);
    // The engine still gets the flag — a wave that collapses to serial takes
    // the saving, and over-reserving is the safe direction.
    expect(BUILDER).toMatch(/kvQuantArgs[\s\S]{0,160}kvBits > 0/);
  });
});
