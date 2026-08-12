import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertLlamaVersionIdentity,
  parseLlamaPin,
  parseLlamaVersionOutput,
} from './assert-llama-version.mjs';

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/build-native.yml', import.meta.url)),
  'utf8',
);

const pin = parseLlamaPin(`
upstream=https://github.com/ggml-org/llama.cpp.git
tag=b10353
commit=f8def7fe168bab245fbf15d3f18b26dbb1ef73c8
`);

test('llama version identity accepts the expected build and short commit', () => {
  assert.deepEqual(parseLlamaVersionOutput('version: 10353 (f8def7fe1)\nbuilt with MSVC'), {
    buildNumber: 10353,
    commit: 'f8def7fe1',
  });
  assert.deepEqual(assertLlamaVersionIdentity('version: 10353 (f8def7fe1)', pin), {
    buildNumber: 10353,
    commit: 'f8def7fe1',
  });
});

test('llama version identity rejects a shallow build number', () => {
  assert.throws(
    () => assertLlamaVersionIdentity('version: 1 (f8def7fe1)', pin),
    /reports build 1, expected 10353/,
  );
});

test('llama version identity rejects the wrong commit', () => {
  assert.throws(
    () => assertLlamaVersionIdentity('version: 10353 (aaaaaaaaa)', pin),
    /reports commit aaaaaaaaa, expected a short prefix/,
  );
});

test('every llama matrix leg runs the executable identity assertion', () => {
  const start = workflow.indexOf('      - name: Assert llama executable version identity');
  const end = workflow.indexOf('      # ── Post-build sanity', start);
  assert.notEqual(start, -1, 'missing llama executable version assertion');
  assert.notEqual(end, -1, 'missing post-build boundary after llama version assertion');
  const step = workflow.slice(start, end);

  assert.match(step, /matrix\.engine == 'llama-cpp'/);
  assert.match(step, /scripts\/assert-llama-version\.mjs/);
  assert.match(step, /steps\.outdir\.outputs\.dir/);
  assert.match(step, /matrix\.artifact/);
  assert.match(step, /native\/engines\/llama-cpp\/VERSION/);
  assert.doesNotMatch(step, /matrix\.variant/);
  assert.doesNotMatch(step, /matrix\.platform/);
});
