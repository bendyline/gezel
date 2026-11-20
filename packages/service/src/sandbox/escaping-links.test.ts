import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { escapingLinkRefusal, findEscapingLinks } from './escaping-links.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gezel-links-')));
  dirs.push(root);
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  const granted = join(root, 'artifacts');
  await mkdir(join(workspace, 'src', 'deep'), { recursive: true });
  await mkdir(outside);
  await mkdir(granted);
  await writeFile(join(workspace, 'src', 'deep', 'a.txt'), 'a');
  return { root, workspace, outside, granted };
}

// Junctions need no privilege on Windows; a directory symlink there does.
const dirLink = (target: string, path: string) =>
  symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');

// A cloned repository's `r -> /` let a script write ~/.bashrc through the
// permission model, which checks the path it was given, not where it leads.
describe('findEscapingLinks', () => {
  it('finds a link that leads out of the granted folders, however deep', async () => {
    const { workspace, outside, granted } = await layout();
    await dirLink(outside, join(workspace, 'src', 'deep', 'r'));
    const result = await findEscapingLinks([workspace], [workspace, granted]);
    expect(result).toMatchObject({ ok: false, reason: 'links' });
    if (result.ok || result.reason !== 'links') return;
    expect(result.links).toEqual([{ path: join(workspace, 'src', 'deep', 'r'), target: outside }]);
    expect(escapingLinkRefusal(result)).toContain('leads out of it');
  });

  it('accepts links that stay inside what the run may reach', async () => {
    const { workspace, granted } = await layout();
    await dirLink(join(workspace, 'src'), join(workspace, 'src-link'));
    await dirLink(granted, join(workspace, 'artifacts-link'));
    expect(await findEscapingLinks([workspace], [workspace, granted])).toMatchObject({ ok: true });
  });

  it.skipIf(process.platform === 'win32')(
    'resolves a dangling link by hand, since writing through it creates the target',
    async () => {
      const { workspace, outside } = await layout();
      await symlink(join(outside, 'not-yet', 'autostart.desktop'), join(workspace, 'later'));
      const result = await findEscapingLinks([workspace], [workspace]);
      expect(result).toMatchObject({
        ok: false,
        links: [{ target: join(outside, 'not-yet', 'autostart.desktop') }],
      });
    },
  );

  it('refuses a folder too large to check before the run', async () => {
    const { workspace } = await layout();
    const result = await findEscapingLinks([workspace], [workspace], { maxEntries: 2 });
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
  });
});
