import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_TOOLSETS } from '../system-toolsets/manifest.js';
import { installDirName } from '../system-toolsets/resolve.js';
import { writeSystemTracking } from '../system-toolsets/tracking.js';
import {
  COPILOT_TOOLSET_ID,
  resetCopilotAvailabilityCache,
  resolveCopilotAvailability,
} from './copilot-availability.js';

const WIN = { platform: 'win32', arch: 'x64' } as const;
const PLATFORM_PKG = '@github/copilot-win32-x64';

let home: string;
let dir: string;

function pinned() {
  const entry = SYSTEM_TOOLSETS.find((e) => e.toolsetId === COPILOT_TOOLSET_ID);
  if (!entry) throw new Error('copilot entry missing from the manifest');
  return entry;
}

/** Empty env by default so a real COPILOT_CLI_PATH can't leak into a case. */
function isolate(overrides: Record<string, unknown> = {}) {
  return { ...WIN, env: {} as NodeJS.ProcessEnv, ...overrides };
}

async function writePackage(root: string, name: string, files: string[]): Promise<string> {
  const pkgDir = join(root, ...name.split('/'));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  for (const file of files) await writeFile(join(pkgDir, file), '');
  return pkgDir;
}

async function seedManagedInstall(version: string, integrity: string): Promise<string> {
  await writeSystemTracking(home, {
    toolsets: {
      [COPILOT_TOOLSET_ID]: {
        toolsetId: COPILOT_TOOLSET_ID,
        version,
        integrity,
        installedAt: '2026-08-01T00:00:00.000Z',
      },
    },
    updatedAt: '2026-08-01T00:00:00.000Z',
  });
  const root = join(
    systemToolsetsInstallDir(home),
    installDirName({ pkg: pinned().pkg, version }),
    'package',
  );
  await mkdir(root, { recursive: true });
  return root;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-copilot-avail-home-'));
  dir = await realpath(await mkdtemp(join(tmpdir(), 'gezel-copilot-avail-')));
  resetCopilotAvailabilityCache();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
  resetCopilotAvailabilityCache();
});

describe('resolveCopilotAvailability', () => {
  it('reports unavailable when nothing is installed anywhere', async () => {
    const result = await resolveCopilotAvailability(home, isolate());
    expect(result).toMatchObject({
      available: false,
      source: null,
      managed: 'absent',
      updateAvailable: false,
      pinnedVersion: pinned().version,
    });
    expect(result.installedVersion).toBeUndefined();
  });

  it('reports the managed install when it matches the pin', async () => {
    const entry = pinned();
    const root = await seedManagedInstall(entry.version, entry.integrity);
    expect(await resolveCopilotAvailability(home, isolate())).toMatchObject({
      available: true,
      source: 'managed',
      managed: 'current',
      installedVersion: entry.version,
      installDir: root,
      updateAvailable: false,
    });
  });

  // A pin bump must read as "update available", never as "not installed" —
  // the on-disk SDK still works, and Copilot is on-demand so nothing is going
  // to upgrade it in the background.
  it('treats an install behind the pin as available with an update offered', async () => {
    await seedManagedInstall('0.0.1-stale', `sha512-${'Z'.repeat(86)}==`);
    expect(await resolveCopilotAvailability(home, isolate())).toMatchObject({
      available: true,
      source: 'managed',
      managed: 'outdated',
      installedVersion: '0.0.1-stale',
      updateAvailable: true,
    });
  });

  // The case the whole feature hangs on: someone who ran
  // `npm i -g @github/copilot` already has everything Copilot needs and must
  // never be offered a second copy of GitHub's proprietary CLI.
  it('accepts a CLI the user installed themselves on PATH, with no managed install', async () => {
    const prefix = join(dir, 'npm-global');
    const platform = await writePackage(join(prefix, 'node_modules'), PLATFORM_PKG, ['index.js']);
    await writePackage(join(prefix, 'node_modules'), '@github/copilot', ['npm-loader.js']);
    await writeFile(join(prefix, 'copilot.cmd'), '');

    expect(
      await resolveCopilotAvailability(home, isolate({ env: { PATH: prefix } })),
    ).toMatchObject({
      available: true,
      source: 'path',
      managed: 'absent',
      cliPath: join(platform, 'index.js'),
      updateAvailable: false,
    });
  });

  it('lets COPILOT_CLI_PATH win over everything else', async () => {
    const entry = pinned();
    await seedManagedInstall(entry.version, entry.integrity);
    expect(
      await resolveCopilotAvailability(
        home,
        isolate({ env: { COPILOT_CLI_PATH: '/opt/copilot' } }),
      ),
    ).toMatchObject({
      available: true,
      source: 'env',
      cliPath: '/opt/copilot',
      // Still reports what we manage, so the settings card can show both.
      managed: 'current',
    });
  });

  it('memoizes within the TTL and re-probes after a reset', async () => {
    expect((await resolveCopilotAvailability(home, isolate())).available).toBe(false);

    const entry = pinned();
    await seedManagedInstall(entry.version, entry.integrity);
    // Still the cached answer — the install landed after the first probe.
    expect((await resolveCopilotAvailability(home, isolate())).available).toBe(false);

    // The reset the install path fires on `done` is what makes a fresh
    // install visible without waiting out the TTL.
    resetCopilotAvailabilityCache();
    expect((await resolveCopilotAvailability(home, isolate())).available).toBe(true);
  });
});
