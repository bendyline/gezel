/**
 * The macOS hardened-runtime entitlement set is pinned, and the assumption
 * that lets it stay small is pinned with it.
 *
 * Every entitlement hands back a protection hardened runtime gives for free,
 * so the set should only ever grow deliberately. The v1.26211.26 release audit
 * dropped two:
 *
 *   - allow-unsigned-executable-memory, which disabled W^X process-wide. It
 *     was the Intel-era V8 workaround; the arm64 build JITs through MAP_JIT
 *     and needs only allow-jit.
 *   - allow-dyld-environment-variables, which opened a DYLD_INSERT_LIBRARIES
 *     path into a signed process for no benefit — nothing sets a DYLD_ var.
 *
 * The first removal is only sound while macOS ships arm64 exclusively. Restore
 * an x86_64 mac target and V8 goes back to mapping RWX pages directly, at
 * which point the app fails to launch on Intel with a codesign violation
 * rather than anything that looks like a missing entitlement. That is the trap
 * this test exists to spring: adding an Intel target fails here, with the
 * reason, instead of shipping a Mac build that dies on first run.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const plistPath = join(root, 'packages/app/entitlements.mac.plist');
const builderPath = join(root, 'packages/app/electron-builder.yml');

/**
 * The complete set, each with the payload fact that justifies it. Kept as
 * prose so a reviewer removing an entitlement has to confront the claim.
 */
const ALLOWED = new Map([
  ['com.apple.security.cs.allow-jit', 'V8/Chromium JIT via MAP_JIT on Apple Silicon'],
  ['com.apple.security.network.client', 'outbound provider, model-download and update traffic'],
  ['com.apple.security.network.server', 'gezeld loopback HTTPS listener'],
  [
    'com.apple.security.cs.disable-library-validation',
    'vendor-signed Mach-Os preserved by sign-macho-tree.mjs, plus native addons installed at runtime by pnpm/uv',
  ],
]);

/**
 * Removed deliberately. Listed separately from "not in ALLOWED" so the
 * failure message can carry the reason rather than a bare set difference.
 */
const REMOVED = new Map([
  [
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'disables W^X process-wide; the arm64 build needs only allow-jit',
  ],
  [
    'com.apple.security.cs.allow-dyld-environment-variables',
    'permits DYLD_INSERT_LIBRARIES injection; nothing in the tree sets a DYLD_ variable',
  ],
]);

/** Never valid in a distribution build — it makes the app debuggable by any process. */
const FORBIDDEN = new Map([
  [
    'com.apple.security.get-task-allow',
    'development-only; breaks notarization and lets any process attach',
  ],
]);

/**
 * Entitlement keys actually granted. The file documents the removed keys in a
 * comment block, so comments have to come out before parsing or the
 * documentation would read as configuration.
 */
async function grantedKeys() {
  const raw = await readFile(plistPath, 'utf8');
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '');
  return new Set(Array.from(withoutComments.matchAll(/<key>([^<]+)<\/key>/g), (m) => m[1].trim()));
}

test('grants exactly the reviewed entitlement set', async () => {
  const granted = await grantedKeys();
  for (const [key, why] of ALLOWED) {
    assert.ok(granted.has(key), `missing entitlement ${key} — required for: ${why}`);
  }
  for (const key of granted) {
    assert.ok(
      ALLOWED.has(key),
      `${key} is granted but not in the reviewed set. Adding an entitlement gives back a hardened-runtime protection: document why the payload needs it in entitlements.mac.plist and add it to ALLOWED here.`,
    );
  }
});

test('does not reinstate the entitlements removed in the v1.26211.26 audit', async () => {
  const granted = await grantedKeys();
  for (const [key, why] of REMOVED) {
    assert.ok(
      !granted.has(key),
      `${key} was removed deliberately (${why}). Restoring it needs a written reason in the plist header.`,
    );
  }
});

test('never ships a development-only entitlement', async () => {
  const granted = await grantedKeys();
  for (const [key, why] of FORBIDDEN) {
    assert.ok(!granted.has(key), `${key} must never ship: ${why}`);
  }
});

test('macOS stays arm64-only, which is what makes allow-jit sufficient', async () => {
  const builder = await readFile(builderPath, 'utf8');
  // `mac:` is not the last top-level key and not always followed by the same
  // one, so bound the block by the next key at column 0 rather than by name.
  const block = builder.match(/^mac:$[\s\S]*?(?=^\S)/m);
  assert.ok(block, 'could not locate the mac: block in electron-builder.yml');
  const mac = block[0];

  const arches = new Set(
    Array.from(mac.matchAll(/^\s+-\s+(x64|arm64|universal)\s*$/gm), (m) => m[1]),
  );
  assert.ok(arches.has('arm64'), 'expected an arm64 macOS target');
  for (const arch of arches) {
    assert.equal(
      arch,
      'arm64',
      `macOS target "${arch}" is not arm64. On x86_64 (and inside a universal slice) V8 maps RWX pages without MAP_JIT, so allow-jit alone is not enough and the app dies at launch with a codesign violation. Re-add com.apple.security.cs.allow-unsigned-executable-memory — and its rationale — before shipping this target.`,
    );
  }
});
