import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { reconcileSystemToolsetFromDisk, runSystemBootstrap } from './bootstrap.js';
import type { PinnedSystemToolset } from './manifest.js';
import { installDirName } from './resolve.js';
import { type SystemBootstrapStatus, SystemStatusBus } from './status-bus.js';
import { writeSystemTracking } from './tracking.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-sysboot-test-'));
  store = new Store({ home });
  await store.ensureLayout();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** All-placeholder manifest: canonical "nothing to install" fixture. */
const ALL_PLACEHOLDERS: PinnedSystemToolset[] = [
  {
    toolsetId: '@fake/toolset',
    displayName: 'Fake placeholder',
    kind: 'mcp-toolset',
    pkg: '@fake/toolset',
    version: '0.0.0',
    integrity: `sha512-${'A'.repeat(86)}==`,
    entry: 'dist/cli.js',
  },
];

describe('runSystemBootstrap', () => {
  it('publishes setup-incomplete when all manifest entries are placeholders', async () => {
    // Nothing real to install — but we MUSTN'T advertise "ready" here,
    // because gezel flows that depend on system toolsets (Playwright,
    // browser automation, Copilot SDK) would fail silently downstream.
    // `setup-incomplete` keeps the Home HealthPanel non-green and
    // carries a human-readable `error` explaining why.
    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    const unsub = bus.subscribe((s) => received.push(s));

    await runSystemBootstrap({ home, store, statusBus: bus, manifest: ALL_PLACEHOLDERS });

    unsub();
    const last = received.at(-1);
    expect(last?.phase).toBe('setup-incomplete');
    expect(last?.error).toBeDefined();
  });

  it('leaves the system-scope InstalledToolset list empty when no real pins', async () => {
    const bus = new SystemStatusBus();
    await runSystemBootstrap({ home, store, statusBus: bus, manifest: ALL_PLACEHOLDERS });
    const installed = await store.listInstalledToolsets({ kind: 'system' });
    expect(installed).toEqual([]);
  });

  // Regression: the tracking file says a toolset is installed (version +
  // integrity match), but the Store's InstalledToolset list is empty —
  // e.g. installed-toolsets.json was wiped, or the user upgraded from a
  // gezel build that didn't write to the Store yet. Without re-registration
  // here, downstream features like the run_playwright route report
  // "@playwright/mcp not installed" even though it's sitting on disk.
  it('re-registers a satisfied toolset on the Store when its record is missing', async () => {
    const REAL_PIN: PinnedSystemToolset = {
      toolsetId: '@fake/installed',
      displayName: 'Fake installed',
      kind: 'mcp-toolset',
      pkg: '@fake/installed',
      version: '1.0.0',
      integrity: `sha512-${'B'.repeat(86)}==`,
      entry: 'dist/cli.js',
    };

    // Seed the satisfied state: tracking file says we installed it, the
    // package dir exists on disk, but the Store's list is empty.
    await writeSystemTracking(home, {
      toolsets: {
        [REAL_PIN.toolsetId]: {
          toolsetId: REAL_PIN.toolsetId,
          version: REAL_PIN.version,
          integrity: REAL_PIN.integrity,
          installedAt: '2026-04-19T00:00:00.000Z',
        },
      },
      updatedAt: '2026-04-19T00:00:00.000Z',
    });
    const expectedPath = join(systemToolsetsInstallDir(home), installDirName(REAL_PIN), 'package');
    await mkdir(expectedPath, { recursive: true });
    await writeFile(
      join(expectedPath, 'package.json'),
      JSON.stringify({ name: REAL_PIN.pkg, version: REAL_PIN.version }),
    );

    expect(await store.listInstalledToolsets({ kind: 'system' })).toEqual([]);

    const bus = new SystemStatusBus();
    await runSystemBootstrap({ home, store, statusBus: bus, manifest: [REAL_PIN] });

    const installed = await store.listInstalledToolsets({ kind: 'system' });
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({
      toolsetId: REAL_PIN.toolsetId,
      sourceId: 'system',
      version: REAL_PIN.version,
      installPath: expectedPath,
      runtime: {
        kind: 'npm-package',
        package: REAL_PIN.pkg,
        version: REAL_PIN.version,
        entry: REAL_PIN.entry,
      },
    });
  });
});

describe('SystemStatusBus', () => {
  it('replays the current state to new subscribers', () => {
    const bus = new SystemStatusBus();
    bus.publish({ phase: 'installing-toolsets', currentToolset: '@x/y' });
    const received: SystemBootstrapStatus[] = [];
    bus.subscribe((s) => received.push(s));
    expect(received).toHaveLength(1);
    expect(received[0]!.phase).toBe('installing-toolsets');
    expect(received[0]!.currentToolset).toBe('@x/y');
  });

  it('emits every subsequent transition to subscribers', () => {
    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    bus.subscribe((s) => received.push(s));
    bus.publish({
      phase: 'downloading-browser',
      browserProgress: { bytesDownloaded: 100, bytesTotal: 1000 },
    });
    bus.publish({ phase: 'ready' });
    expect(received.map((r) => r.phase)).toEqual(['idle', 'downloading-browser', 'ready']);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    const unsub = bus.subscribe((s) => received.push(s));
    unsub();
    bus.publish({ phase: 'ready' });
    expect(received.map((r) => r.phase)).toEqual(['idle']);
  });
});

/**
 * `reconcileSystemToolsetFromDisk` is the self-heal path for the
 * class of stuck state where the physical install is on disk but
 * the Store's installed-toolsets record got wiped — by an app
 * update, crash, or manual cleanup. Without this, the user's next
 * tool call keeps failing "not installed" forever, even though
 * nothing is actually missing.
 */
describe('reconcileSystemToolsetFromDisk', () => {
  // Valid-looking integrity (not the A*86 placeholder form that
  // `isPlaceholder` filters out) + non-`0.0.0` version so the
  // reconcile path actually runs.
  const VALID_INTEGRITY = `sha512-${'B'.repeat(86)}==`;
  const PLAYWRIGHT_ENTRY: PinnedSystemToolset = {
    toolsetId: '@playwright/mcp',
    displayName: 'Playwright MCP',
    kind: 'mcp-toolset',
    pkg: '@playwright/mcp',
    version: '1.2.3',
    integrity: VALID_INTEGRITY,
    entry: 'dist/cli.js',
  };

  async function seedOnDisk(): Promise<string> {
    const pkgDir = join(
      systemToolsetsInstallDir(home),
      installDirName(PLAYWRIGHT_ENTRY),
      'package',
    );
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    return pkgDir;
  }

  it('returns reconciled=false when tracking has no entry', async () => {
    const result = await reconcileSystemToolsetFromDisk({
      home,
      store,
      toolsetId: '@playwright/mcp',
      manifest: [PLAYWRIGHT_ENTRY],
    });
    expect(result.reconciled).toBe(false);
  });

  it('returns reconciled=false when tracking is satisfied but files missing', async () => {
    await writeSystemTracking(home, {
      chromiumRevision: undefined,
      toolsets: {
        '@playwright/mcp': {
          toolsetId: '@playwright/mcp',
          version: '1.2.3',
          integrity: VALID_INTEGRITY,
          installedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    });
    const result = await reconcileSystemToolsetFromDisk({
      home,
      store,
      toolsetId: '@playwright/mcp',
      manifest: [PLAYWRIGHT_ENTRY],
    });
    expect(result.reconciled).toBe(false);
  });

  it('re-registers the Store record when tracking + files agree but Store is empty', async () => {
    const pkgDir = await seedOnDisk();
    await writeSystemTracking(home, {
      chromiumRevision: undefined,
      toolsets: {
        '@playwright/mcp': {
          toolsetId: '@playwright/mcp',
          version: '1.2.3',
          integrity: VALID_INTEGRITY,
          installedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    });
    // Store starts empty — this is the exact wedge that broke
    // `run_playwright_script` for a week-old install after
    // installed-toolsets.json got truncated.
    expect(await store.listInstalledToolsets({ kind: 'system' })).toEqual([]);

    const result = await reconcileSystemToolsetFromDisk({
      home,
      store,
      toolsetId: '@playwright/mcp',
      manifest: [PLAYWRIGHT_ENTRY],
    });
    expect(result.reconciled).toBe(true);
    expect(result.installPath).toBe(pkgDir);
    const list = await store.listInstalledToolsets({ kind: 'system' });
    expect(list).toHaveLength(1);
    expect(list[0]?.toolsetId).toBe('@playwright/mcp');
    expect(list[0]?.installPath).toBe(pkgDir);
  });

  it('is idempotent when the Store already has the record', async () => {
    await seedOnDisk();
    const trackingPayload = {
      chromiumRevision: null as unknown as string | undefined,
      toolsets: {
        '@playwright/mcp': {
          toolsetId: '@playwright/mcp',
          version: '1.2.3',
          integrity: VALID_INTEGRITY,
          installedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    await writeSystemTracking(home, trackingPayload);
    // Defensive verification — if the first reconcile is failing
    // with an "empty toolsets" tracking read, something upstream is
    // stomping the file. We catch that here rather than in the
    // reconcile debug output.
    const { readSystemTracking } = await import('./tracking.js');
    const roundtripped = await readSystemTracking(home);
    expect(Object.keys(roundtripped.toolsets)).toContain('@playwright/mcp');

    // First call: reconciles the record in. Second call: finds it
    // already present and returns true without duplicating.
    const first = await reconcileSystemToolsetFromDisk({
      home,
      store,
      toolsetId: '@playwright/mcp',
      manifest: [PLAYWRIGHT_ENTRY],
    });
    expect(first.reconciled).toBe(true);
    const second = await reconcileSystemToolsetFromDisk({
      home,
      store,
      toolsetId: '@playwright/mcp',
      manifest: [PLAYWRIGHT_ENTRY],
    });
    expect(second.reconciled).toBe(true);
    const list = await store.listInstalledToolsets({ kind: 'system' });
    expect(list).toHaveLength(1);
  });
});
