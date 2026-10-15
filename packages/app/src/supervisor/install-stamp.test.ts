import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type InstallStamp,
  clearInstallStamp,
  installStampMatches,
  writeInstallStamp,
} from './install-stamp.js';

let workRoot: string;
let stamp: InstallStamp;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'gezel-install-stamp-'));
  const root = join(workRoot, 'runtime');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'entry.mjs'), 'entry');
  await writeFile(join(root, 'dist', 'cli.mjs'), 'cli');
  stamp = {
    path: join(workRoot, 'bin', 'runtime.stamp.json'),
    identity: '1.0.0 abc',
    root,
    files: ['entry.mjs', 'dist/cli.mjs'],
  };
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('install stamps', () => {
  it('matches the files it was written for', async () => {
    await writeInstallStamp(stamp);
    expect(await installStampMatches(stamp)).toBe(true);
  });

  it('never matches without a stamp, or with a corrupt one', async () => {
    expect(await installStampMatches(stamp)).toBe(false);
    await mkdir(join(workRoot, 'bin'), { recursive: true });
    await writeFile(stamp.path, '{"schema":1,');
    expect(await installStampMatches(stamp)).toBe(false);
    await writeFile(stamp.path, 'null');
    expect(await installStampMatches(stamp)).toBe(false);
  });

  it('does not vouch for another version or manifest', async () => {
    await writeInstallStamp(stamp);
    expect(await installStampMatches({ ...stamp, identity: '1.0.1 abc' })).toBe(false);
    expect(await installStampMatches({ ...stamp, identity: '1.0.0 def' })).toBe(false);
  });

  it('does not vouch for a file that changed, went missing, or was not stamped', async () => {
    await writeInstallStamp(stamp);
    await writeFile(join(stamp.root, 'dist', 'cli.mjs'), 'cli, edited');
    expect(await installStampMatches(stamp)).toBe(false);

    await writeInstallStamp(stamp);
    await rm(join(stamp.root, 'entry.mjs'));
    expect(await installStampMatches(stamp)).toBe(false);

    await writeFile(join(stamp.root, 'entry.mjs'), 'entry');
    await writeInstallStamp(stamp);
    await writeFile(join(stamp.root, 'extra.mjs'), 'extra');
    expect(await installStampMatches({ ...stamp, files: [...stamp.files, 'extra.mjs'] })).toBe(
      false,
    );
  });

  it('does not vouch for an identical copy somewhere else', async () => {
    await writeInstallStamp(stamp);
    const elsewhere = join(workRoot, 'copied-runtime');
    await cp(stamp.root, elsewhere, { recursive: true });
    expect(await installStampMatches({ ...stamp, root: elsewhere })).toBe(false);
  });

  it('writes nothing when a file to stamp is missing', async () => {
    await rm(join(stamp.root, 'entry.mjs'));
    await writeInstallStamp(stamp);
    expect(existsSync(stamp.path)).toBe(false);
  });

  it('is removed before the files it describes are replaced', async () => {
    await writeInstallStamp(stamp);
    await clearInstallStamp(stamp.path);
    expect(existsSync(stamp.path)).toBe(false);
    await clearInstallStamp(stamp.path);
  });
});
