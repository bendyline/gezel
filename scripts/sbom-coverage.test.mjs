/**
 * The SBOM published beside every installer must inventory what the installer
 * actually redistributes.
 *
 * A July 2026 audit of v1.26210.19 found it listing npm packages only: the
 * native engines, the pinned Node and pnpm runtimes, Electron, and NVIDIA's
 * CUDA redistributables — roughly a gigabyte of payload, and the one
 * proprietary component in it — were all absent, even though the installed
 * `resources/licenses/` manifest covered them. Nothing failed, because nothing
 * checked.
 *
 * These tests drive generate-sbom.mjs's non-npm half directly. The npm half is
 * left alone: it needs a real `pnpm licenses list`, which is slow and, on
 * Windows, cannot spawn `pnpm.cmd` outside a pnpm script.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { verifyNoticeInventory } from './check-notice.mjs';
import { ENGINE_FOR_BINARY, allPlatformKeys } from './native-payload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('the generator sources every non-npm component kind', async () => {
  const generator = await readFile(join(here, 'generate-sbom.mjs'), 'utf8');
  for (const kind of ['native-engine', 'bundled-runtime', 'native-redistributable']) {
    assert.match(
      generator,
      new RegExp(`'gezel:component-kind', value: '${kind}'`),
      `generate-sbom.mjs no longer emits ${kind} components`,
    );
  }
  // The platform caveat is the honest part of shipping one SBOM for four
  // platforms; losing it would make the superset look authoritative.
  assert.match(generator, /gezel:npm-platform/);
  assert.match(generator, /gezel:native-platforms/);
  assert.match(generator, /superset-across-platforms/);
});

test('every native engine and bundled runtime reaches the SBOM with a pin', async () => {
  const notice = await verifyNoticeInventory();

  const engineIds = new Set(Object.values(ENGINE_FOR_BINARY).filter(Boolean));
  const inventoried = new Set(notice.native.components.map((c) => c.id));
  assert.deepEqual(
    [...engineIds].sort(),
    [...inventoried].sort(),
    'the engines staged into installers and the engines NOTICE.md pins must be the same set',
  );

  for (const engine of notice.native.components) {
    assert.ok(engine.version, `${engine.id} has no pinned version`);
    assert.ok(engine.license, `${engine.id} has no license`);
    assert.ok(engine.commit, `${engine.id} has no upstream commit`);
    assert.match(engine.source ?? '', /^https:\/\//, `${engine.id} has no source URL`);
  }

  assert.equal(notice.runtimes.components.length, notice.runtimes.count);
  for (const runtime of notice.runtimes.components) {
    assert.ok(runtime.version, `${runtime.name} has no pinned version`);
    assert.ok(runtime.license, `${runtime.name} has no license`);
  }
});

test('CUDA components are scoped to the platforms that carry them', () => {
  const cuda = allPlatformKeys().filter((key) => key.endsWith('-cuda'));
  assert.ok(cuda.length > 0, 'no CUDA platform keys — the scoping property would be empty');
  assert.ok(
    cuda.every((key) => !key.startsWith('darwin-')),
    'macOS carries no CUDA payload; scoping it there would overstate the SBOM',
  );
});
