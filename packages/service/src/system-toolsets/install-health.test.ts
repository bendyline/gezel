import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkInstallTree } from './install-health.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-install-health-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writePkg(deps?: Record<string, string>): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: '@fake/pkg', version: '1.0.0', dependencies: deps }),
  );
}

describe('checkInstallTree', () => {
  it('reports healthy when package.json is absent', async () => {
    expect(await checkInstallTree(root)).toEqual({ ok: true });
  });

  it('reports healthy when package.json is unreadable JSON', async () => {
    await writeFile(join(root, 'package.json'), 'not json');
    expect(await checkInstallTree(root)).toEqual({ ok: true });
  });

  it('reports healthy when no dependencies are declared', async () => {
    await writePkg();
    expect(await checkInstallTree(root)).toEqual({ ok: true });
  });

  it('reports healthy when every declared dependency resolves', async () => {
    await writePkg({ 'left-pad': '1.0.0' });
    const dep = join(root, 'node_modules', 'left-pad');
    await mkdir(dep, { recursive: true });
    await writeFile(join(dep, 'package.json'), JSON.stringify({ name: 'left-pad' }));
    expect(await checkInstallTree(root)).toEqual({ ok: true });
  });

  it('flags a declared dependency with no node_modules entry', async () => {
    await writePkg({ 'left-pad': '1.0.0' });
    expect(await checkInstallTree(root)).toEqual({ ok: false, missingDep: 'left-pad' });
  });

  // The incident shape: pnpm's isolated linker links node_modules entries
  // to a staging path that no longer exists after the publish rename.
  // On Windows those are junctions with absolute targets; a dangling
  // symlink models the same breakage on every platform.
  it('flags a dependency whose link dangles', async () => {
    await writePkg({ 'left-pad': '1.0.0' });
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await symlink(
      join(root, 'gone', 'left-pad'),
      join(root, 'node_modules', 'left-pad'),
      'junction',
    );
    expect(await checkInstallTree(root)).toEqual({ ok: false, missingDep: 'left-pad' });
  });

  it('scopes the check to dependencies, not optionalDependencies', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@fake/pkg',
        version: '1.0.0',
        optionalDependencies: { fsevents: '2.3.2' },
      }),
    );
    expect(await checkInstallTree(root)).toEqual({ ok: true });
  });
});
