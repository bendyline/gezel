import assert from 'node:assert/strict';
import { test } from 'node:test';

import { helpSmokeFailure } from './smoke-native-help.mjs';

const limits = { binary: 'gezel-x', timeoutMs: 60_000, maxOutputBytes: 1024 };
const run = (fields) => ({
  output: 'usage: gezel-x [options]\n',
  outputExceeded: false,
  signal: null,
  status: 0,
  timedOut: false,
  ...fields,
});

test('help output passes, whatever the exit code', () => {
  assert.equal(helpSmokeFailure(run({}), limits), null);
  // GPU engines may exit non-zero on a runner with no device.
  assert.equal(helpSmokeFailure(run({ status: 1 }), limits), null);
});

test('a silent launch fails: the missing-DLL shape', () => {
  assert.match(
    helpSmokeFailure(run({ output: '', status: 0xc0000135 }), limits),
    /no --help output/,
  );
});

test('an assertion that printed output first still fails', () => {
  // native-v0.1.53's CUDA whisper-server in the merged win32-arm64-cuda folder.
  const output = [
    'ggml_cuda_init: found 1 CUDA devices (Total VRAM: 51827 MiB):',
    '  Device 0: NVIDIA RTX Spark N1X, compute capability 12.1, VMM: yes',
    'C:/a/gezel/ggml/src/ggml.cpp:22: GGML_ASSERT(prev != ggml_uncaught_exception) failed',
  ].join('\n');
  assert.match(
    helpSmokeFailure(run({ output, status: 0xc0000409 }), limits),
    /fatal error during --help: .*GGML_ASSERT\(prev != ggml_uncaught_exception\)/,
  );
  assert.match(
    helpSmokeFailure(run({ output: "x: x.c:1: main: Assertion `n > 0' failed.\n" }), limits),
    /fatal error/,
  );
});

test('a crash status or signal fails even after printing help', () => {
  assert.match(helpSmokeFailure(run({ status: 0xc000001d }), limits), /status=0xC000001D/);
  assert.match(helpSmokeFailure(run({ status: null, signal: 'SIGILL' }), limits), /SIGILL/);
  assert.match(helpSmokeFailure(run({ status: null, signal: 'SIGABRT' }), limits), /SIGABRT/);
});

test('timeouts and runaway output still fail', () => {
  assert.match(
    helpSmokeFailure(run({ timedOut: true, signal: 'SIGKILL' }), limits),
    /did not finish/,
  );
  assert.match(helpSmokeFailure(run({ outputExceeded: true }), limits), /more than 1024 bytes/);
});
