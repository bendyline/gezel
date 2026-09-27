import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureChromiumInstalled } from './playwright-browsers.js';
import { SystemStatusBus } from './status-bus.js';

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

describe('ensureChromiumInstalled', () => {
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
