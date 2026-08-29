import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MLX_DEFAULT_PACKAGE_SPEC, mlxVenvPackages } from './venv.js';

/**
 * MTP speculative decoding crosses the same untyped argv boundary the
 * kv-quant contract guards, plus a sharper hazard of its own: mlx-vlm
 * 0.6.6's MTP verify is measured-INEXACT (greedy spec diverged from
 * greedy no-spec — reports/mlx-mtp-rig-20260828.md), so the sidecar must
 * refuse to arm speculation on an older line no matter what the launcher
 * asks for. These are text-level assertions because nothing type-checks
 * across the two languages.
 */
const HERE = join(import.meta.dirname, '.');
const BUILDER = readFileSync(join(HERE, 'build-provider.ts'), 'utf8');
const SIDECAR = readFileSync(join(HERE, 'python', 'gezel_mlx_server.py'), 'utf8');
const SPEC = readFileSync(join(HERE, 'python', 'spec_decode.py'), 'utf8');

describe('MLX MTP speculative-decoding contract', () => {
  it('launcher emits exactly the flags the sidecar declares', () => {
    expect(BUILDER).toContain("'--spec-draft-model'");
    expect(BUILDER).toContain("'--spec-block-size'");
    for (const flag of ['--spec-draft-model', '--spec-draft-kind', '--spec-block-size']) {
      expect(SIDECAR, `${flag} must stay in the sidecar's argparse`).toContain(`"${flag}"`);
    }
  });

  it('arms from a resolved drafter, not from raw config', () => {
    // Default-on means "on when a drafter exists beside the model", so the
    // launcher must go through the resolver (which also prices the drafter
    // into the weights term) rather than reading a config path directly.
    expect(BUILDER).toContain('resolveSpecDrafter(');
    expect(BUILDER).toMatch(/specArgs[^=]*=\s*specDrafter/);
  });

  it('prices the drafter into the memory plan', () => {
    // A drafter is a second resident model. Leaving its bytes out of
    // mlxWeightsBytes under-reserves, and an MLX over-commit aborts the
    // whole python process rather than failing one request.
    expect(BUILDER).toMatch(/mlxWeightsBytes\s*=[\s\S]{0,200}specDrafter\?\.bytes/);
  });

  it('keeps a master off switch in config', () => {
    expect(BUILDER).toContain('config.mlxSpeculativeDecoding');
  });

  it('the sidecar refuses mlx-vlm lines with inexact MTP verify', () => {
    expect(SPEC).toContain('(0, 6, 17)');
    expect(SPEC).toContain('inexact');
  });

  it('keeps an operator kill-switch', () => {
    expect(SPEC).toContain('GEZEL_MLX_SPEC');
  });

  it('routes requests by mode and never hands processors to upstream spec', () => {
    // Upstream speculation applies per-sequence processors to the first
    // token only, then silently drops them (measured). Processor-armed
    // and sampled requests therefore go through the sidecar's assisted
    // route (positioned sampler + processed walk), never upstream's
    // sampler-only batch; greedy stays on the exactness-proven C1 path.
    expect(SPEC).toContain('def spec_mode');
    expect(SPEC).toContain('class PositionedSampler');
    expect(SPEC).toContain('def processed_walk');
    expect(SPEC).toContain('def assisted_rounds');
    expect(SIDECAR).toContain('spec_decode.spec_mode');
    expect(SIDECAR).toContain('spec_decode.assisted_rounds');
    expect(SIDECAR).toContain('[spec] off request=');
    // Operator fallback to the v1 greedy-only gate stays available.
    expect(SPEC).toContain('greedy-only');
  });

  it('the venv list pins mlx-lm explicitly on the 0.6.17 line', () => {
    // mlx-vlm 0.6.6 declared mlx-lm as a dependency; 0.6.17 dropped it.
    // The sidecar imports mlx_lm.generate.BatchGenerator unconditionally,
    // so a venv provisioned without an explicit mlx-lm pin kills the
    // batch engine at import time — on every fresh install, silently.
    const m = MLX_DEFAULT_PACKAGE_SPEC.match(/==0\.(\d+)\.(\d+)/);
    expect(m, `unparseable pin: ${MLX_DEFAULT_PACKAGE_SPEC}`).not.toBeNull();
    const [minor, patch] = [Number(m?.[1]), Number(m?.[2])];
    expect(minor * 1000 + patch, 'spec_decode.py refuses MTP below 0.6.17').toBeGreaterThanOrEqual(
      6017,
    );
    expect(
      mlxVenvPackages().some((s) => /^mlx-lm==\d+\.\d+\.\d+$/.test(s)),
      'mlxVenvPackages must carry an exact mlx-lm pin',
    ).toBe(true);
  });

  it('boot and per-turn fingerprints exist so an A/B can prove its arms', () => {
    expect(SIDECAR).toContain('[spec] active drafter=');
    expect(SIDECAR).toContain('[spec] stats request=');
  });

  it('the spec wave feeds the same finish/save machinery as batch turns', () => {
    // The saved-entry shape must stay indistinguishable from a batch
    // turn's, or the cache cascade (and the hybrid snapshot save) forks.
    expect(SIDECAR).toContain('async def _run_spec_wave');
    expect(SIDECAR).toContain('_capture_spec_snapshot');
    expect(SIDECAR).toMatch(/_finish\(sub, r\)/);
  });
});
