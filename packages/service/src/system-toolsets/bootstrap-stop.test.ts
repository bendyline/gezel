import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { runSystemBootstrap, stopSystemBootstraps } from './bootstrap.js';
import type { PinnedSystemToolset } from './manifest.js';
import { ensureChromiumInstalled } from './playwright-browsers.js';
import { installDirName } from './resolve.js';
import { type SystemBootstrapStatus, SystemStatusBus } from './status-bus.js';
import { readSystemTracking, writeSystemTracking } from './tracking.js';

vi.mock('./playwright-browsers.js', () => ({ ensureChromiumInstalled: vi.fn() }));

const PLAYWRIGHT: PinnedSystemToolset = {
  toolsetId: '@fake/playwright',
  displayName: 'Fake Playwright',
  kind: 'mcp-toolset',
  pkg: '@fake/playwright',
  version: '1.0.0',
  integrity: `sha512-${'P'.repeat(86)}==`,
  entry: 'dist/cli.js',
  postInstall: 'playwright-chromium',
};

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-sysboot-stop-'));
  store = new Store({ home });
  await store.ensureLayout();
  // The toolset itself is installed; only the Chromium download remains.
  await writeSystemTracking(home, {
    toolsets: {
      [PLAYWRIGHT.toolsetId]: {
        toolsetId: PLAYWRIGHT.toolsetId,
        version: PLAYWRIGHT.version,
        integrity: PLAYWRIGHT.integrity,
        installedAt: '2026-09-01T00:00:00.000Z',
      },
    },
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  const pkgDir = join(systemToolsetsInstallDir(home), installDirName(PLAYWRIGHT), 'package');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: PLAYWRIGHT.pkg, version: PLAYWRIGHT.version }),
  );
});

afterEach(async () => {
  vi.mocked(ensureChromiumInstalled).mockReset();
  await rm(home, { recursive: true, force: true });
});

describe('stopSystemBootstraps', () => {
  it('stops a first-run Chromium download and leaves it to be redone', async () => {
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(ensureChromiumInstalled).mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          started();
          signal?.addEventListener('abort', () =>
            resolve({ ok: false, cancelled: true, error: 'install was cancelled' }),
          );
        }),
    );
    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    bus.subscribe((s) => received.push(s));

    const run = runSystemBootstrap({ home, store, statusBus: bus, manifest: [PLAYWRIGHT] });
    await downloading;
    await stopSystemBootstraps();
    await run;

    expect(vi.mocked(ensureChromiumInstalled).mock.calls[0]?.[0].signal?.aborted).toBe(true);
    // Neither "done" nor a failure the user has to act on.
    expect(received.some((s) => s.phase === 'ready' || s.phase === 'error')).toBe(false);
    expect((await readSystemTracking(home)).chromiumRevision).toBeUndefined();

    // The next boot sees the download as not done and runs it again.
    vi.mocked(ensureChromiumInstalled).mockResolvedValue({ ok: true });
    await runSystemBootstrap({ home, store, statusBus: bus, manifest: [PLAYWRIGHT] });
    expect(ensureChromiumInstalled).toHaveBeenCalledTimes(2);
    expect((await readSystemTracking(home)).chromiumRevision).toBeDefined();
  });

  it('returns at once when nothing is running', async () => {
    await expect(stopSystemBootstraps()).resolves.toBeUndefined();
  });
});
