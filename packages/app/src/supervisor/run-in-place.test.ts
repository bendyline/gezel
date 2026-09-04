import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRuntimeInPlace, shouldRunRuntimesInPlace } from './run-in-place.js';

let dir: string;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-inplace-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('shouldRunRuntimesInPlace', () => {
  it('is on only for a store build on macOS', () => {
    expect(shouldRunRuntimesInPlace({ storeProfile: true, platform: 'darwin' })).toBe(true);
  });

  it('leaves the Windows store build on the extract path', () => {
    // MSIX is full trust with a real user profile, and no store rule forbids
    // the copy — so it keeps the sharing an extracted runtime buys.
    expect(shouldRunRuntimesInPlace({ storeProfile: true, platform: 'win32' })).toBe(false);
  });

  it('never applies to a direct-download build', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(shouldRunRuntimesInPlace({ storeProfile: false, platform })).toBe(false);
    }
  });
});

describe('resolveRuntimeInPlace', () => {
  it('returns the in-bundle path when the manifest authenticates it', async () => {
    await writeFile(join(dir, 'node'), 'BINARY');
    await writeFile(join(dir, 'version.txt'), '24.1.0\n');
    await writeFile(join(dir, 'sha256.txt'), `${sha('BINARY')}  node\n`);

    const found = await resolveRuntimeInPlace({ bundleDir: dir, entry: 'node' });
    expect(found).toMatchObject({ path: join(dir, 'node'), version: '24.1.0', verified: true });
  });

  it('withholds the path when the manifest does not match', async () => {
    // Returning the path with verified:false would leave a branch that could
    // execute bytes which just failed their own integrity check.
    await writeFile(join(dir, 'node'), 'TAMPERED');
    await writeFile(join(dir, 'sha256.txt'), `${sha('BINARY')}  node\n`);

    const found = await resolveRuntimeInPlace({ bundleDir: dir, entry: 'node' });
    expect(found.path).toBeNull();
    expect(found.verified).toBe(false);
    expect(found.reason).toMatch(/sha256 mismatch/);
  });

  it('reports honestly when the bundle shipped no manifest', async () => {
    // Dev bundles (GEZEL_NODE_SKIP=1) ship none. Claiming verification that
    // did not happen would be worse than saying so and letting the caller
    // decide.
    await writeFile(join(dir, 'node'), 'BINARY');
    const found = await resolveRuntimeInPlace({ bundleDir: dir, entry: 'node' });
    expect(found.path).toBe(join(dir, 'node'));
    expect(found.verified).toBe(false);
    expect(found.reason).toMatch(/no sha256\.txt/);
  });

  it('verifies every file the runtime needs, not just its entrypoint', async () => {
    // pnpm's entry is a shim that loads the real CLI. Verifying only the shim
    // would leave the code that does the work unchecked.
    await mkdir(join(dir, 'bin'), { recursive: true });
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'bin', 'pnpm.mjs'), 'SHIM');
    await writeFile(join(dir, 'dist', 'pnpm.mjs'), 'TAMPERED-CLI');
    await writeFile(
      join(dir, 'sha256.txt'),
      `${sha('SHIM')}  bin/pnpm.mjs\n${sha('REAL-CLI')}  dist/pnpm.mjs\n`,
    );

    const found = await resolveRuntimeInPlace({
      bundleDir: dir,
      entry: join('bin', 'pnpm.mjs'),
      manifestFiles: ['bin/pnpm.mjs', 'dist/pnpm.mjs'],
    });
    expect(found.path).toBeNull();
    expect(found.reason).toMatch(/dist\/pnpm\.mjs/);
  });

  it('reports a missing bundle rather than throwing', async () => {
    const found = await resolveRuntimeInPlace({ bundleDir: join(dir, 'absent'), entry: 'node' });
    expect(found).toMatchObject({ path: null, verified: false });
    expect(found.reason).toMatch(/no bundle/);
  });

  it('reports an empty bundle directory as having no payload', async () => {
    // What a build with a placeholder pin leaves behind. Not an error — there
    // is simply nothing to run.
    const found = await resolveRuntimeInPlace({ bundleDir: dir, entry: 'node' });
    expect(found.path).toBeNull();
    expect(found.reason).toMatch(/has no node/);
  });

  it('never writes anything — the bundle stays read-only', async () => {
    await writeFile(join(dir, 'node'), 'BINARY');
    await writeFile(join(dir, 'sha256.txt'), `${sha('BINARY')}  node\n`);
    const { readdir } = await import('node:fs/promises');
    const before = (await readdir(dir)).sort();
    await resolveRuntimeInPlace({ bundleDir: dir, entry: 'node' });
    expect((await readdir(dir)).sort()).toEqual(before);
  });
});
