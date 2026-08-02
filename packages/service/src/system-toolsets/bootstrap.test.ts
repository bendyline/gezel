import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.unstubAllGlobals();
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

  // An on-demand entry is installed by SystemToolsetInstallRegistry when the
  // user asks, never at boot. If this regressed, the boot pass would start
  // downloading GitHub's proprietary Copilot CLI on every fresh install —
  // exactly what making it on-demand was meant to stop. The install here
  // would also hit the network, so a regression fails loudly rather than
  // quietly costing bandwidth.
  it('skips on-demand entries and still reports ready', async () => {
    const EAGER: PinnedSystemToolset = {
      toolsetId: '@fake/eager',
      displayName: 'Fake eager',
      kind: 'mcp-toolset',
      pkg: '@fake/eager',
      version: '1.0.0',
      integrity: `sha512-${'C'.repeat(86)}==`,
      entry: 'dist/cli.js',
    };
    const ON_DEMAND: PinnedSystemToolset = {
      toolsetId: '@fake/on-demand',
      displayName: 'Fake on-demand',
      kind: 'library',
      onDemand: true,
      pkg: '@fake/on-demand',
      version: '2.0.0',
      integrity: `sha512-${'D'.repeat(86)}==`,
      entry: 'dist/index.js',
    };

    // Seed only the eager entry as satisfied. The on-demand one is
    // deliberately absent — the bootstrap must not try to fetch it.
    await writeSystemTracking(home, {
      toolsets: {
        [EAGER.toolsetId]: {
          toolsetId: EAGER.toolsetId,
          version: EAGER.version,
          integrity: EAGER.integrity,
          installedAt: '2026-08-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const eagerPath = join(systemToolsetsInstallDir(home), installDirName(EAGER), 'package');
    await mkdir(eagerPath, { recursive: true });

    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    const unsub = bus.subscribe((s) => received.push(s));

    await runSystemBootstrap({ home, store, statusBus: bus, manifest: [EAGER, ON_DEMAND] });

    unsub();
    expect(received.at(-1)?.phase).toBe('ready');
    expect(received.some((s) => s.currentToolset === ON_DEMAND.toolsetId)).toBe(false);
    expect(received.some((s) => s.phase === 'error')).toBe(false);
    // Nothing was written for the on-demand entry.
    const installed = await store.listInstalledToolsets({ kind: 'system' });
    expect(installed.some((t) => t.toolsetId === ON_DEMAND.toolsetId)).toBe(false);
  });

  // Pins the ordering inside runSystemBootstrap: the placeholder check reads
  // the full manifest, and only then is the on-demand set filtered out.
  // Reversing those two makes a build whose only real pin is on-demand look
  // unpinned, which turns the Home health pill amber for no reason.
  it('reports setup-incomplete when every entry is a placeholder, on-demand included', async () => {
    const PLACEHOLDER_ON_DEMAND: PinnedSystemToolset = {
      toolsetId: '@fake/on-demand',
      displayName: 'Fake on-demand',
      kind: 'library',
      onDemand: true,
      pkg: '@fake/on-demand',
      version: '0.0.0',
      integrity: `sha512-${'A'.repeat(86)}==`,
      entry: 'dist/index.js',
    };
    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    const unsub = bus.subscribe((s) => received.push(s));

    await runSystemBootstrap({
      home,
      store,
      statusBus: bus,
      manifest: [...ALL_PLACEHOLDERS, PLACEHOLDER_ON_DEMAND],
    });

    unsub();
    expect(received.at(-1)?.phase).toBe('setup-incomplete');
  });

  // Regression for the Windows relocated-junction incident: a tracking
  // record that matches the pin is NOT proof of a working install. Builds
  // before the hoisted-linker fix left trees whose node_modules links
  // dangled, and the satisfied check kept vetoing the reinstall that
  // would have fixed them — the Chromium post-install then failed with
  // "Cannot find module 'playwright…'" on every boot, forever. A broken
  // tree must be treated as not installed.
  it('reinstalls a satisfied toolset whose dependency tree is broken', async () => {
    const BROKEN: PinnedSystemToolset = {
      toolsetId: '@fake/broken',
      displayName: 'Fake broken',
      kind: 'mcp-toolset',
      pkg: '@fake/broken',
      version: '1.0.0',
      integrity: `sha512-${'F'.repeat(86)}==`,
      entry: 'dist/cli.js',
    };
    await writeSystemTracking(home, {
      toolsets: {
        [BROKEN.toolsetId]: {
          toolsetId: BROKEN.toolsetId,
          version: BROKEN.version,
          integrity: BROKEN.integrity,
          installedAt: '2026-08-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const pkgDir = join(systemToolsetsInstallDir(home), installDirName(BROKEN), 'package');
    await mkdir(pkgDir, { recursive: true });
    // Declares a dependency but has no node_modules — the on-disk shape a
    // dangling-junction tree presents to the health check.
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: BROKEN.pkg,
        version: BROKEN.version,
        dependencies: { 'left-pad': '1.0.0' },
      }),
    );

    // The reinstall's registry read must not hit the network: answer 404,
    // which retryTransient treats as non-transient and fails fast.
    const fetchStub = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchStub);

    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    const unsub = bus.subscribe((s) => received.push(s));
    await runSystemBootstrap({ home, store, statusBus: bus, manifest: [BROKEN] });
    unsub();

    // The bootstrap decided to reinstall (rather than trusting tracking)…
    expect(
      received.some(
        (s) => s.phase === 'installing-toolsets' && s.currentToolset === BROKEN.toolsetId,
      ),
    ).toBe(true);
    expect(fetchStub).toHaveBeenCalled();
    // …and the stubbed registry failure surfaced as an install error.
    expect(received.at(-1)?.phase).toBe('error');
  });

  it('keeps trusting a satisfied toolset whose dependency tree resolves', async () => {
    const HEALTHY: PinnedSystemToolset = {
      toolsetId: '@fake/healthy',
      displayName: 'Fake healthy',
      kind: 'mcp-toolset',
      pkg: '@fake/healthy',
      version: '1.0.0',
      integrity: `sha512-${'G'.repeat(86)}==`,
      entry: 'dist/cli.js',
    };
    await writeSystemTracking(home, {
      toolsets: {
        [HEALTHY.toolsetId]: {
          toolsetId: HEALTHY.toolsetId,
          version: HEALTHY.version,
          integrity: HEALTHY.integrity,
          installedAt: '2026-08-01T00:00:00.000Z',
        },
      },
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    const pkgDir = join(systemToolsetsInstallDir(home), installDirName(HEALTHY), 'package');
    const depDir = join(pkgDir, 'node_modules', 'left-pad');
    await mkdir(depDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: HEALTHY.pkg,
        version: HEALTHY.version,
        dependencies: { 'left-pad': '1.0.0' },
      }),
    );
    await writeFile(join(depDir, 'package.json'), JSON.stringify({ name: 'left-pad' }));

    const fetchStub = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchStub);

    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    const unsub = bus.subscribe((s) => received.push(s));
    await runSystemBootstrap({ home, store, statusBus: bus, manifest: [HEALTHY] });
    unsub();

    expect(received.some((s) => s.phase === 'installing-toolsets')).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(received.at(-1)?.phase).toBe('ready');
  });

  // The inverse: a real on-demand pin alongside nothing else must NOT read as
  // an unpinned build. `ready` is the honest answer — every eagerly-installed
  // toolset (of which there are none) is in place.
  it('reports ready when the only real entry is on-demand', async () => {
    const ON_DEMAND: PinnedSystemToolset = {
      toolsetId: '@fake/on-demand',
      displayName: 'Fake on-demand',
      kind: 'library',
      onDemand: true,
      pkg: '@fake/on-demand',
      version: '2.0.0',
      integrity: `sha512-${'E'.repeat(86)}==`,
      entry: 'dist/index.js',
    };
    const bus = new SystemStatusBus();
    const received: SystemBootstrapStatus[] = [];
    const unsub = bus.subscribe((s) => received.push(s));

    await runSystemBootstrap({ home, store, statusBus: bus, manifest: [ON_DEMAND] });

    unsub();
    expect(received.at(-1)?.phase).toBe('ready');
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

  // A tree whose declared deps don't resolve (the relocated-junction
  // breakage) must not be vouched for — re-registering it would just move
  // the failure into the user's next tool call. The bootstrap reinstalls
  // it on the next boot instead.
  it('returns reconciled=false when the install tree is broken', async () => {
    const pkgDir = await seedOnDisk();
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ version: '1.2.3', dependencies: { 'left-pad': '1.0.0' } }),
    );
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
    expect(await store.listInstalledToolsets({ kind: 'system' })).toEqual([]);
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
