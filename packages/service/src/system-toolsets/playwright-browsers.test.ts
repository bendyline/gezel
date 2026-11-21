import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureChromiumInstalled,
  playwrightBrowserRequirement,
  playwrightBrowsersInstalled,
} from './playwright-browsers.js';
import { SystemStatusBus } from './status-bus.js';

/** A package whose `playwright-core` declares `revision` for both Chromium builds. */
async function writePlaywrightCore(dir: string, revision: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'playwright-core',
      version: '1.0.0',
      exports: { '.': './index.js', './package.json': './package.json' },
    }),
  );
  await writeFile(join(dir, 'index.js'), 'module.exports = {};\n');
  await writeFile(
    join(dir, 'browsers.json'),
    JSON.stringify({
      browsers: [
        { name: 'chromium', revision, installByDefault: true },
        { name: 'chromium-headless-shell', revision, installByDefault: true },
        { name: 'chromium-tip-of-tree', revision: '9999', installByDefault: false },
      ],
    }),
  );
}

/** A toolset install as `@playwright/mcp` lays it out: playwright beside its playwright-core. */
async function writeToolsetInstall(root: string, revision: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'toolset', private: true }));
  const playwright = join(root, 'node_modules', 'playwright');
  await mkdir(playwright, { recursive: true });
  await writeFile(
    join(playwright, 'package.json'),
    JSON.stringify({ name: 'playwright', version: '1.0.0', main: 'index.js' }),
  );
  await writeFile(join(playwright, 'index.js'), 'module.exports = {};\n');
  await writePlaywrightCore(join(root, 'node_modules', 'playwright-core'), revision);
}

async function writeBrowser(browsersDir: string, folder: string): Promise<void> {
  await mkdir(join(browsersDir, folder), { recursive: true });
  await writeFile(join(browsersDir, folder, 'INSTALLATION_COMPLETE'), '');
}

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-chromium-test-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('playwrightBrowserRequirement', () => {
  it('reads the revision from the playwright-core that playwright loads', async () => {
    const install = join(home, 'toolset');
    await writeToolsetInstall(install, '1217');
    // A nested copy wins over the hoisted one, as it does for `require`.
    await writePlaywrightCore(
      join(install, 'node_modules', 'playwright', 'node_modules', 'playwright-core'),
      '1232',
    );

    const requirement = playwrightBrowserRequirement(install);

    expect(requirement).toMatchObject({
      revision: '1232',
      chromium: ['chromium-1232'],
      headlessShell: ['chromium_headless_shell-1232'],
    });
  });

  it('is null when the install has no Playwright', () => {
    expect(playwrightBrowserRequirement(home)).toBeNull();
  });

  it('does not count another revision, however complete', async () => {
    const install = join(home, 'toolset');
    await writeToolsetInstall(install, '1232');
    const browsersDir = playwrightBrowsersDir(home);
    await writeBrowser(browsersDir, 'chromium-1217');
    await writeBrowser(browsersDir, 'chromium_headless_shell-1217');
    await writeBrowser(browsersDir, 'chromium_headless_shell-1243');
    const requirement = playwrightBrowserRequirement(install)!;

    expect(playwrightBrowsersInstalled(browsersDir, requirement)).toBe(false);
    expect(playwrightBrowsersInstalled(browsersDir, requirement, 'headless-shell')).toBe(false);

    await writeBrowser(browsersDir, 'chromium_headless_shell-1232');
    expect(playwrightBrowsersInstalled(browsersDir, requirement, 'headless-shell')).toBe(true);
    expect(playwrightBrowsersInstalled(browsersDir, requirement)).toBe(false);

    await writeBrowser(browsersDir, 'chromium-1232');
    expect(playwrightBrowsersInstalled(browsersDir, requirement)).toBe(true);
  });
});

describe('ensureChromiumInstalled', () => {
  // Regression (2026-11-21): after the pin moved to 1232, the previous pin's
  // complete chromium-1217 satisfied the skip check, nothing was downloaded,
  // and every page check failed with "Executable doesn't exist".
  it('downloads when only an earlier revision is on disk, and refuses a run that left it missing', async () => {
    const install = join(home, 'toolset');
    await writeToolsetInstall(install, '1232');
    const browsersDir = playwrightBrowsersDir(home);
    await writeBrowser(browsersDir, 'chromium-1217');
    await writeBrowser(browsersDir, 'chromium_headless_shell-1217');
    const ranFile = join(home, 'installer-ran');

    const result = await ensureChromiumInstalled({
      home,
      playwrightInstallPath: install,
      statusBus: new SystemStatusBus(),
      invocation: {
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ranFile)}, '')`],
        shell: false,
        mode: 'node-script',
      },
    });

    expect(existsSync(ranFile)).toBe(true);
    // Exit 0 without the browser is not a success the bootstrap may record.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('chromium_headless_shell-1232');
  });

  it('skips the installer and reports the revision when the required browsers are present', async () => {
    const install = join(home, 'toolset');
    await writeToolsetInstall(install, '1232');
    const browsersDir = playwrightBrowsersDir(home);
    await writeBrowser(browsersDir, 'chromium-1232');
    await writeBrowser(browsersDir, 'chromium_headless_shell-1232');

    const result = await ensureChromiumInstalled({
      home,
      playwrightInstallPath: install,
      statusBus: new SystemStatusBus(),
      invocation: {
        command: 'definitely-not-a-command',
        args: [],
        shell: false,
        mode: 'executable',
      },
    });

    expect(result).toEqual({ ok: true, revision: '1232' });
  });

  it('kills the installer and the downloader it spawned when cancelled', async () => {
    // Stands in for pnpm -> playwright install -> oopBrowserDownload: a
    // launcher that spawns a long-running grandchild and records its pid.
    const pidFile = join(home, 'grandchild.pid');
    const launcher = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const controller = new AbortController();

    const pending = ensureChromiumInstalled({
      home,
      playwrightInstallPath: home,
      statusBus: new SystemStatusBus(),
      signal: controller.signal,
      invocation: {
        command: process.execPath,
        args: ['-e', launcher],
        shell: false,
        mode: 'node-script',
      },
    });
    await waitFor(() => existsSync(pidFile));
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);

    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, cancelled: true });
    await waitFor(() => !alive(grandchild));
    // No completion marker, so the next boot installs again from the start.
    expect(existsSync(playwrightBrowsersDir(home))).toBe(false);
  }, 30_000);

  it('does not start at all once cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await ensureChromiumInstalled({
      home,
      playwrightInstallPath: home,
      statusBus: new SystemStatusBus(),
      signal: controller.signal,
      invocation: {
        command: 'definitely-not-a-command',
        args: [],
        shell: false,
        mode: 'executable',
      },
    });
    expect(result).toMatchObject({ ok: false, cancelled: true });
  });
});
