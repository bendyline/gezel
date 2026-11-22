import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  escapingLinkRefusal,
  findEscapingLinks,
  isProtectedSystemTarget,
} from './escaping-links.js';

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

  // A Python .venv's bin/python3 -> /usr/bin/python3 blocked every run.
  it('accepts a link to a protected system file, and still refuses one that is not', async () => {
    const { workspace, outside } = await layout();
    await dirLink(outside, join(workspace, 'python3'));
    const system = async () => true;
    expect(
      await findEscapingLinks([workspace], [workspace], { systemTarget: system }),
    ).toMatchObject({ ok: true });
    const writable = async () => false;
    expect(
      await findEscapingLinks([workspace], [workspace], { systemTarget: writable }),
    ).toMatchObject({ ok: false, reason: 'links' });
  });

  // Workspace scripts pass only their write roots: a link into the read-only
  // artifacts drawer carried writes there.
  it('refuses a link into a read-only root when only write roots may be reached', async () => {
    const { workspace, granted } = await layout();
    await dirLink(granted, join(workspace, 'artifacts-link'));
    expect(await findEscapingLinks([workspace], [workspace])).toMatchObject({
      ok: false,
      reason: 'links',
    });
  });
});

describe('isProtectedSystemTarget', () => {
  it.skipIf(process.platform === 'win32')(
    'is true for a root-owned file this account cannot change, false for its own',
    async () => {
      const { workspace } = await layout();
      expect(await isProtectedSystemTarget('/usr/bin/env')).toBe(process.getuid?.() !== 0);
      expect(await isProtectedSystemTarget(join(workspace, 'src', 'deep', 'a.txt'))).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    "is false for a root-owned folder, whose contents may be the account's own",
    async () => {
      expect(await isProtectedSystemTarget('/')).toBe(false);
      expect(await isProtectedSystemTarget('/usr')).toBe(false);
    },
  );

  // `h -> /home` passed as a protected target, and the account's own files
  // under it became writable through the link.
  it.skipIf(process.platform === 'win32')(
    'refuses a link to a root-owned folder through the default check',
    async () => {
      const { workspace } = await layout();
      await dirLink('/', join(workspace, 'h'));
      expect(await findEscapingLinks([workspace], [workspace])).toMatchObject({
        ok: false,
        reason: 'links',
        links: [{ target: '/' }],
      });
    },
  );

  it('is never true on Windows', async () => {
    if (process.platform !== 'win32') return;
    expect(await isProtectedSystemTarget('C:\\Windows\\System32\\cmd.exe')).toBe(false);
  });
});
