import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundledDocblocksToolset } from './bundled-docblocks.js';
import {
  docblocksBrowserInstalled,
  docblocksBrowserRequirement,
  ensureDocblocksBrowser,
} from './docblocks-browser.js';

let browsersDir: string;
const installPath = bundledDocblocksToolset().installPath!;

beforeEach(async () => {
  browsersDir = await mkdtemp(join(tmpdir(), 'gezel-docblocks-browser-'));
});

afterEach(async () => {
  await rm(browsersDir, { recursive: true, force: true });
});

describe('docblocksBrowserRequirement', () => {
  it('reads the headless-shell revision from the playwright-core DocBlocks imports', async () => {
    const requirement = docblocksBrowserRequirement(installPath);
    expect(requirement).not.toBeNull();
    const { browsers } = JSON.parse(
      await readFile(join(requirement!.playwrightCoreDir, 'browsers.json'), 'utf8'),
    ) as { browsers: Array<{ name: string; revision: string }> };
    const shell = browsers.find((browser) => browser.name === 'chromium-headless-shell')!;
    expect(requirement!.revision).toBe(shell.revision);
    expect(requirement!.folder).toBe(`chromium_headless_shell-${shell.revision}`);
  });

  it('answers null for a package with no route to Playwright', () => {
    expect(docblocksBrowserRequirement(browsersDir)).toBeNull();
  });
});

describe('ensureDocblocksBrowser', () => {
  it("trusts Playwright's completion marker and starts no download", async () => {
    const requirement = docblocksBrowserRequirement(installPath)!;
    expect(docblocksBrowserInstalled(browsersDir, requirement)).toBe(false);
    await mkdir(join(browsersDir, requirement.folder), { recursive: true });
    await writeFile(join(browsersDir, requirement.folder, 'INSTALLATION_COMPLETE'), '');
    expect(docblocksBrowserInstalled(browsersDir, requirement)).toBe(true);
    expect(
      await ensureDocblocksBrowser({ docblocksInstallPath: installPath, browsersDir }),
    ).toEqual({
      ok: true,
    });
  });

  it('reports a DocBlocks tree it cannot resolve', async () => {
    expect(
      await ensureDocblocksBrowser({ docblocksInstallPath: browsersDir, browsersDir }),
    ).toMatchObject({ ok: false });
  });
});
