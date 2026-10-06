import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifier = fileURLToPath(new URL('./verify-vulkan-payload.mjs', import.meta.url));

// Exercise the CLI and real filesystem without needing Linux ELF execution
// on developer Macs. ldd is the sole platform seam; its output represents the
// bundled, host-resolved, and unresolved cases the Linux CI check must reject.
function fixture(
  t,
  { loader = true, hostLoader = false, missingPeer = false, consumerLocation = 'bundled' } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gezel-vulkan-payload-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'bundle with spaces');
  const tools = join(root, 'tools');
  mkdirSync(output);
  mkdirSync(tools);
  const consumerRoot = consumerLocation === 'bundled' ? output : `${output}-backup`;
  mkdirSync(consumerRoot, { recursive: true });
  const consumerTarget = join(consumerRoot, 'libggml-vulkan.so');
  writeFileSync(consumerTarget, 'Vulkan backend fixture');
  const consumer =
    consumerLocation === 'symlink' ? join(output, 'libggml-vulkan.so') : consumerTarget;
  if (consumerLocation === 'symlink') symlinkSync(consumerTarget, consumer);
  if (loader) writeFileSync(join(output, 'libvulkan.so.1'), 'Bundled loader fixture');
  const host = join(root, 'libvulkan.so.1');
  writeFileSync(host, 'Host loader fixture');
  const resolved = hostLoader ? host : join(output, 'libvulkan.so.1');
  writeFileSync(
    join(tools, 'ldd'),
    `#!/usr/bin/env node
if (process.env.LD_LIBRARY_PATH || process.env.LD_PRELOAD) process.exit(9);
if (process.argv[2] !== ${JSON.stringify(consumer)}) process.exit(10);
console.log(${JSON.stringify(`libvulkan.so.1 => ${resolved} (0x00001234)`)});
${missingPeer ? 'console.log("libggml-base.so.0 => not found");\n' : ''}`,
    { mode: 0o755 },
  );
  return spawnSync(process.execPath, [verifier, output, consumer], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      LD_LIBRARY_PATH: '/build-sdk/lib',
    },
  });
}

test('accepts a bundled Vulkan loader with the build SDK path cleared', (t) => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified bundled loader/);
});

test('rejects the missing-loader archive even when the host has a loader', (t) => {
  const result = fixture(t, { loader: false, hostLoader: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /libvulkan\.so\.1/);
});

test('rejects resolution to the host even when a bundled loader is present', (t) => {
  const result = fixture(t, { hostLoader: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /resolves outside the bundle/);
});

test('rejects unresolved dependencies of the dynamically loaded Vulkan plugin', (t) => {
  const result = fixture(t, { missingPeer: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unresolved dependencies/);
});

test('rejects a consumer in a sibling directory sharing the bundle prefix', (t) => {
  const result = fixture(t, { consumerLocation: 'sibling' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Vulkan consumer is outside the bundle/);
});

test('rejects a consumer symlink escaping the bundle', (t) => {
  const result = fixture(t, { consumerLocation: 'symlink' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Vulkan consumer is outside the bundle/);
});
