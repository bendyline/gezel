import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKpack,
  decodeMsgpack,
  encodeMsgpack,
  parseKpack,
  trimKpack,
} from './trim-rocm-kpack.mjs';

/** A pack shaped like TheRock's blas_lib: rocBLAS, rocSOLVER and hipBLASLt entries for one target. */
function fixturePack() {
  const frames = ['rocblas-0', 'rocblas-1', 'rocsolver-0', 'hipblaslt-0', 'rocsparse-0'].map(
    (name) => Buffer.from(`zstd frame for ${name}`),
  );
  const entry = (ordinal) => ({
    gfx1201: {
      type: 'hsaco',
      ordinal,
      original_size: 1000 + ordinal,
      metadata: { target: 'hipv4-amdgcn-amd-amdhsa--gfx1201', source_prefix: 'math-libs/BLAS' },
    },
  });
  const toc = {
    format_version: 1,
    group_name: 'blas_lib',
    gfx_arch_family: 'gfx1201',
    gfx_arches: ['gfx1201'],
    toc: {
      'math-libs/BLAS/rocBLAS/stage/bin/rocblas.dll#0': entry(0),
      'math-libs/BLAS/rocBLAS/stage/bin/rocblas.dll#1': entry(1),
      'math-libs/BLAS/rocSOLVER/stage/bin/rocsolver.dll#0': entry(2),
      'math-libs/BLAS/hipBLASLt/stage/lib/libhipblaslt.so.1#0': entry(3),
      'math-libs/BLAS/rocSPARSE/stage/bin/rocsparse.dll#0': entry(4),
    },
    compression_scheme: 'zstd-per-kernel',
    zstd_offset: 64,
    zstd_size: 0,
  };
  return { frames, buffer: buildKpack({ toc, frames }) };
}

test('msgpack round-trips the value shapes a kpack TOC uses', () => {
  const value = {
    small: 7,
    negative: -3,
    wide: 70_000,
    huge: 5_000_000_000,
    float: 0.5,
    text: 'x'.repeat(40),
    list: [1, 'two', null, true, false],
    nested: { a: { b: [] } },
  };
  assert.deepEqual(decodeMsgpack(encodeMsgpack(value)), value);
});

test('an untrimmed pack rebuilds to identical bytes', () => {
  const { buffer } = fixturePack();
  assert.deepEqual(buildKpack(parseKpack(buffer)), buffer);
});

test('trimming keeps rocBLAS and hipBLASLt frames byte for byte and drops the rest', () => {
  const { buffer, frames } = fixturePack();
  const result = trimKpack(buffer);
  assert.equal(result.kept, 3);
  assert.equal(result.dropped, 2);
  const trimmed = parseKpack(result.buffer);
  assert.deepEqual(Object.keys(trimmed.toc.toc), [
    'math-libs/BLAS/rocBLAS/stage/bin/rocblas.dll#0',
    'math-libs/BLAS/rocBLAS/stage/bin/rocblas.dll#1',
    'math-libs/BLAS/hipBLASLt/stage/lib/libhipblaslt.so.1#0',
  ]);
  for (const [binary, arches] of Object.entries(trimmed.toc.toc)) {
    const original = parseKpack(buffer).toc.toc[binary].gfx1201.ordinal;
    assert.deepEqual(trimmed.frames[arches.gfx1201.ordinal], frames[original], binary);
  }
  assert.equal(trimmed.toc.zstd_offset, 64);
  assert.equal(trimmed.toc.zstd_size, 4 + trimmed.frames.reduce((n, f) => n + 4 + f.length, 0));
});

test('a pack with nothing to keep is refused rather than written empty', () => {
  const { buffer } = fixturePack();
  assert.throws(() => trimKpack(buffer, /no-such-library/), /no kpack entry matches/);
});

test('anything but a version-1 zstd pack is refused', () => {
  const { buffer } = fixturePack();
  const wrongMagic = Buffer.from(buffer);
  wrongMagic.write('NOPE', 0, 'latin1');
  assert.throws(() => parseKpack(wrongMagic), /KPAK/);
  const wrongVersion = Buffer.from(buffer);
  wrongVersion.writeUInt32LE(2, 4);
  assert.throws(() => parseKpack(wrongVersion), /version 2/);
});
