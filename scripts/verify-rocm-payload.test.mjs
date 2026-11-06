import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildKpack } from './trim-rocm-kpack.mjs';
import { verifyRocmPayload } from './verify-rocm-payload.mjs';

function pack(gfx, binaries) {
  const toc = {};
  const frames = [];
  for (const binary of binaries) {
    toc[binary] = { [gfx]: { type: 'hsaco', ordinal: frames.length, original_size: 1 } };
    frames.push(Buffer.from(binary));
  }
  return buildKpack({
    toc: {
      format_version: 1,
      group_name: 'blas_lib',
      gfx_arch_family: gfx,
      gfx_arches: [gfx],
      toc,
      compression_scheme: 'zstd-per-kernel',
      zstd_offset: 64,
      zstd_size: 0,
    },
    frames,
  });
}

/** A complete Windows payload for `targets`; `omit` names files to leave out. */
function fixture(t, targets, { omit = [], rocmTargets = targets, untrimmed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gezel-rocm-payload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (rel, data = 'x') => {
    if (omit.includes(rel)) return;
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), data);
  };
  write('gezel-llama-build.json', JSON.stringify({ backend: 'rocm', rocmTargets }));
  for (const file of ['ggml-hip.dll', 'amdhip64_7.dll', 'hipblas.dll', 'rocblas.dll']) write(file);
  for (const gfx of targets) {
    // gfx1151 keeps its library in a folder named for it, as TheRock ships it.
    write(
      gfx === 'gfx1151'
        ? `rocblas/library/${gfx}/TensileLibrary_lazy_${gfx}.dat`
        : `rocblas/library/TensileLibrary_lazy_${gfx}.dat`,
    );
    const binaries = ['bin/rocblas.dll#0', ...(untrimmed ? ['bin/rocsolver.dll#0'] : [])];
    write(`kpack/blas_lib_${gfx}.kpack`, pack(gfx, binaries));
  }
  return dir;
}

test('a complete payload passes, flat and per-architecture library layouts alike', (t) => {
  const targets = ['gfx1100', 'gfx1151', 'gfx1201'];
  assert.deepEqual(verifyRocmPayload(fixture(t, targets), targets), []);
});

test('a target without its kernel library or pack fails', (t) => {
  const targets = ['gfx1100', 'gfx1201'];
  const dir = fixture(t, targets, {
    omit: ['rocblas/library/TensileLibrary_lazy_gfx1201.dat', 'kpack/blas_lib_gfx1100.kpack'],
  });
  assert.deepEqual(verifyRocmPayload(dir, targets), [
    'no rocBLAS kernel pack for gfx1100',
    'no rocBLAS kernel library for gfx1201',
  ]);
});

test('build metadata must record exactly the targets the leg built', (t) => {
  const dir = fixture(t, ['gfx1201'], { rocmTargets: ['gfx1100', 'gfx1201'] });
  assert.match(
    verifyRocmPayload(dir, ['gfx1201']).join('\n'),
    /records rocmTargets gfx1100;gfx1201/,
  );
});

test('an untrimmed pack and a missing runtime library are both caught', (t) => {
  const dir = fixture(t, ['gfx1201'], { untrimmed: true, omit: ['hipblas.dll'] });
  assert.deepEqual(verifyRocmPayload(dir, ['gfx1201']), [
    'missing hipblas.dll',
    'kernel pack for gfx1201 was not trimmed (rocSOLVER/rocSPARSE kernels present)',
  ]);
});
