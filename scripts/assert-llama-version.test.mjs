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
tag=v0.3.0
build=10621
commit=c1d0e7a004015f23bc0233470b747b596f29b264
`);

test('llama version identity accepts the v0.3.0 output format', () => {
  // Verbatim from a local build of the pinned tag.
  const real =
    'version: 0.3.0 (build 10621, commit c1d0e7a)\nbuilt with MSVC 19.51.36256.0 for x64';
  assert.deepEqual(parseLlamaVersionOutput(real), {
    buildNumber: 10621,
    commit: 'c1d0e7a',
    version: '0.3.0',
  });
  assert.deepEqual(assertLlamaVersionIdentity(real, pin), {
    buildNumber: 10621,
    commit: 'c1d0e7a',
    version: '0.3.0',
  });
});

test('llama version identity still accepts the legacy b#### output format', () => {
  assert.deepEqual(parseLlamaVersionOutput('version: 10621 (c1d0e7a00)\nbuilt with MSVC'), {
    buildNumber: 10621,
    commit: 'c1d0e7a00',
  });
});

test('llama version identity rejects a -dev build against a semver pin', () => {
  assert.throws(
    () => assertLlamaVersionIdentity('version: 0.3.0-dev (build 10621, commit c1d0e7a)', pin),
    /reports version 0\.3\.0-dev, expected 0\.3\.0 from v0\.3\.0 .* -DLLAMA_BUILD_IS_DEV=OFF/,
  );
});

test('llama version identity rejects a semver that disagrees with the pinned tag', () => {
  assert.throws(
    () => assertLlamaVersionIdentity('version: 0.4.0 (build 10621, commit c1d0e7a)', pin),
    /reports version 0\.4\.0, expected 0\.3\.0 from v0\.3\.0/,
  );
});

test('llama version output with no recognizable identity is rejected', () => {
  assert.throws(
    () => parseLlamaVersionOutput('llama-server: unrecognized option'),
    /no recognizable identity/,
  );
});

test('llama version identity rejects a shallow build number', () => {
  assert.throws(
    () => assertLlamaVersionIdentity('version: 0.3.0 (build 1, commit c1d0e7a)', pin),
    /reports build 1, expected 10621/,
  );
});

test('llama version identity rejects the wrong commit', () => {
  assert.throws(
    () => assertLlamaVersionIdentity('version: 0.3.0 (build 10621, commit aaaaaaaaa)', pin),
    /reports commit aaaaaaaaa, expected a short prefix/,
  );
});

test('llama pin derives the build number from a b#### tag', () => {
  const derived = parseLlamaPin(`
tag=b10621
commit=c1d0e7a004015f23bc0233470b747b596f29b264
`);
  assert.equal(derived.buildNumber, 10621);
  assert.equal(derived.tag, 'b10621');
});

test('llama pin accepts a semver tag that declares its build number', () => {
  const semver = parseLlamaPin(`
tag=v0.3.0
build=10621
commit=c1d0e7a004015f23bc0233470b747b596f29b264
`);
  assert.equal(semver.buildNumber, 10621);
  assert.equal(semver.tag, 'v0.3.0');
});

test('llama pin rejects a semver tag with no declared build number', () => {
  assert.throws(
    () =>
      parseLlamaPin(`
tag=v0.3.0
commit=c1d0e7a004015f23bc0233470b747b596f29b264
`),
    /tag v0\.3\.0 is not a b<number> tag, so it must declare build=<number>/,
  );
});

test('llama pin rejects a declared build number that contradicts a b#### tag', () => {
  assert.throws(
    () =>
      parseLlamaPin(`
tag=b10621
build=10622
commit=c1d0e7a004015f23bc0233470b747b596f29b264
`),
    /declares build=10622 but tag b10621 implies 10621/,
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
