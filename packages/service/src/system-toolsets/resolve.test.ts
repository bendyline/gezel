import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYSTEM_TOOLSETS } from './manifest.js';
import {
  installDirName,
  resolveInstalledSystemLibrary,
  resolveSystemLibraryPath,
} from './resolve.js';
import { writeSystemTracking } from './tracking.js';

const COPILOT = '@github/copilot-sdk';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-resolve-test-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function pinned() {
  const entry = SYSTEM_TOOLSETS.find((e) => e.toolsetId === COPILOT);
  if (!entry) throw new Error('copilot entry missing from the manifest');
  return entry;
}

/** Put a tracking record + install directory on disk for `version`. */
async function seedInstall(version: string, integrity: string): Promise<string> {
  await writeSystemTracking(home, {
    toolsets: {
      [COPILOT]: {
        toolsetId: COPILOT,
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

describe('resolveInstalledSystemLibrary', () => {
  it('returns null when nothing is installed', async () => {
    expect(await resolveInstalledSystemLibrary(home, COPILOT)).toBeNull();
  });

  it('reports matchesPin for an install at the pinned version', async () => {
    const entry = pinned();
    const root = await seedInstall(entry.version, entry.integrity);
    const result = await resolveInstalledSystemLibrary(home, COPILOT);
    expect(result).toEqual({ path: root, version: entry.version, matchesPin: true });
  });

  it('appends the manifest entry path with withEntry', async () => {
    const entry = pinned();
    const root = await seedInstall(entry.version, entry.integrity);
    const result = await resolveInstalledSystemLibrary(home, COPILOT, { withEntry: true });
    expect(result?.path).toBe(join(root, entry.entry ?? ''));
  });

  // The migration guarantee. Copilot is an on-demand toolset, so nothing
  // upgrades it in the background: if a pin bump made the resolver return
  // null, every existing user's Copilot would report "not installed" until
  // they reinstalled by hand. The strict resolver does exactly that, which
  // is why this version-tolerant one exists.
  it('still resolves an install one version behind the pin, where the strict resolver gives up', async () => {
    const root = await seedInstall('0.0.1-stale', `sha512-${'Z'.repeat(86)}==`);

    expect(await resolveSystemLibraryPath(home, COPILOT)).toBeNull();

    const result = await resolveInstalledSystemLibrary(home, COPILOT);
    expect(result).toEqual({ path: root, version: '0.0.1-stale', matchesPin: false });
  });

  it('returns null when tracking claims an install whose directory is gone', async () => {
    const entry = pinned();
    await writeSystemTracking(home, {
      toolsets: {
        [COPILOT]: {
          toolsetId: COPILOT,
          version: entry.version,
          integrity: entry.integrity,
          installedAt: '2026-08-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    expect(await resolveInstalledSystemLibrary(home, COPILOT)).toBeNull();
  });

  it('returns null for an unknown toolset id', async () => {
    expect(await resolveInstalledSystemLibrary(home, '@nope/missing')).toBeNull();
  });
});
