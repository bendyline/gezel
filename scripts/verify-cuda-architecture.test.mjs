import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertCudaArchitectures,
  normalizeExpectedCudaArchitectures,
  parseCuobjdumpArchitectures,
  resolveCuobjdump,
} from './verify-cuda-architecture.mjs';

test('normalizes CMake real/virtual CUDA architecture suffixes', () => {
  assert.deepEqual(normalizeExpectedCudaArchitectures('60-virtual;75;121a-real'), [
    '60',
    '75',
    '121a',
  ]);
});

test('parses unique cubin/PTX targets from cuobjdump output', () => {
  assert.deepEqual(
    parseCuobjdumpArchitectures(
      'ELF file 1: lib.1.sm_121a.cubin\narch = sm_121a\nELF file 2: lib.2.sm_90.cubin',
    ),
    ['121a', '90'],
  );
});

test('accepts expected targets split across cubin and PTX payloads', () => {
  assert.deepEqual(
    assertCudaArchitectures({
      expected: '90;121a-real',
      elfOutput: 'ELF file 1: lib.1.sm_121a.cubin',
      ptxOutput: 'PTX file 1: lib.1.sm_90.ptx',
    }).expected,
    ['90', '121a'],
  );
});

test('prefers the toolkit cuobjdump over a bare PATH lookup', () => {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const root = mkdtempSync(join(tmpdir(), 'cuda-arch-'));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', `cuobjdump${suffix}`), '');

  assert.equal(resolveCuobjdump({ CUDA_PATH: root }), join(root, 'bin', `cuobjdump${suffix}`));
  assert.equal(resolveCuobjdump({ CUDA_HOME: root }), join(root, 'bin', `cuobjdump${suffix}`));
  // No toolkit root, or one without the binary: fall back to PATH.
  assert.equal(resolveCuobjdump({}), `cuobjdump${suffix}`);
  assert.equal(resolveCuobjdump({ CUDA_PATH: join(root, 'missing') }), `cuobjdump${suffix}`);
});

test('rejects the sm_52-only fallback that escaped native-v0.1.26', () => {
  assert.throws(
    () =>
      assertCudaArchitectures({
        expected: '121a-real',
        elfOutput: 'ELF file 1: lib.1.sm_52.cubin',
        ptxOutput: 'PTX file 1: lib.1.sm_52.ptx',
      }),
    /missing expected architecture.*found cubin=\[52\] ptx=\[52\]/,
  );
});
