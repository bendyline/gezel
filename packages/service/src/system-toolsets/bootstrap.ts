import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SystemToolsetInstallEvent } from '@bendyline/gezel';
import { HttpStatusError, createLogger, retryTransient } from '@bendyline/gezel';
import {
  extractNpmPackageTarball,
  publishStagedNpmInstall,
  recoverInterruptedNpmInstall,
} from '@bendyline/gezel-catalog';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import type { Store } from '../fs/store.js';
import { type PnpmResult, runPnpm } from '../packages/pnpm.js';
import { SYSTEM_LOCKFILES } from './locks.js';
import {
  CHROMIUM_REVISION,
  type PinnedSystemToolset,
  SYSTEM_TOOLSETS,
  isPlaceholder,
} from './manifest.js';
import { ensureChromiumInstalled } from './playwright-browsers.js';
import { installDirName } from './resolve.js';
import type { SystemStatusBus } from './status-bus.js';
import { type SystemTrackingEntry, readSystemTracking, writeSystemTracking } from './tracking.js';

const log = createLogger('system-toolsets');
const MAX_PACKUMENT_BYTES = 5 * 1024 * 1024;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const REGISTRY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
/** Transient-fault retries for the registry read and the tarball fetch. The
 * tarball opens its destination with 'wx' and unlinks on failure, so a repeat
 * attempt starts from a clean slate. */
const NETWORK_ATTEMPTS = 3;
/** Progress-emit throttle for the tarball download. */
const PROGRESS_INTERVAL_BYTES = 256 * 1024;
const PROGRESS_INTERVAL_MS = 200;

export interface SystemBootstrapOptions {
  home: string;
  store: Store;
  statusBus: SystemStatusBus;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  /**
   * Optional process-wide debug flag. When enabled, each manifest
   * entry's evaluation (satisfied vs installing) is logged with
   * details, and install failures surface full stacks.
   */
  debug?: { isEnabled(): boolean };
  /**
   * Override the pinned manifest. Primarily for tests — production
   * callers leave this unset and the shipped `SYSTEM_TOOLSETS` is used.
   */
  manifest?: PinnedSystemToolset[];
}

/**
 * Bring the `~/.gezel/system-toolsets/` tree in line with the shipped
 * `SYSTEM_TOOLSETS` manifest. Idempotent — safe to call on every boot.
 *
 * Only *eager* entries are handled here. Entries flagged `onDemand` are
 * skipped entirely and installed by `SystemToolsetInstallRegistry` when the
 * user asks for them.
 *
 * For each eager entry in the manifest:
 *   1. Check `system-toolsets.json` — does the tracking record already
 *      match this version + integrity?
 *   2. If not, fetch the tarball, verify integrity, extract, install
 *      runtime deps via bundled pnpm (`--ignore-scripts`).
 *   3. Record the new install in both the tracking file AND the `Store`'s
 *      system-scope InstalledToolset list (so ChatManager picks it up on
 *      next session spawn).
 *   4. Run post-install — only `playwright-chromium` today, which uses
 *      Playwright's own CLI to download Chromium into our managed dir.
 */
export async function runSystemBootstrap(opts: SystemBootstrapOptions): Promise<void> {
  const { home, store, statusBus, logger } = opts;
  const debugOn = opts.debug?.isEnabled() === true;

  // Dev-build state: if the manifest hasn't been bumped to real pins
  // yet, we CAN'T install and MUSTN'T advertise "ready" — gezel flows
  // that depend on these toolsets (Playwright preview, browser
  // automation, Copilot SDK) would fail silently downstream. Surface
  // the gap via the status bus instead; the Home health pill reads
  // this as a warning, not green.
  const manifest = opts.manifest ?? SYSTEM_TOOLSETS;
  const real = manifest.filter((e) => !isPlaceholder(e));
  if (real.length === 0) {
    logger?.warn?.(
      '[system-toolsets] every manifest entry is a placeholder — nothing installed. ' +
        'Gezel flows that need these toolsets (Playwright, browser automation, ' +
        'Copilot SDK) will not work until the manifest is populated.',
    );
    statusBus.publish({
      phase: 'setup-incomplete',
      error:
        'System toolsets are not pinned in this build — Playwright, browser automation, and the Copilot SDK are not installed.',
    });
    return;
  }

  // On-demand entries are installed by `SystemToolsetInstallRegistry` when
  // the user asks, never here. Derived AFTER the placeholder check above so
  // a manifest whose only real entry is on-demand still reports "pinned"
  // rather than `setup-incomplete` — that check answers "is this build
  // pinned?", which on-demand doesn't change.
  const eager = real.filter((e) => e.onDemand !== true);

  const tracking = await readSystemTracking(home);

  // Install / refresh each eager manifest entry.
  for (const entry of eager) {
    const existing = tracking.toolsets[entry.toolsetId];
    const satisfied =
      existing && existing.version === entry.version && existing.integrity === entry.integrity;
    if (satisfied) {
      logger?.info?.(`[system-toolsets] ${entry.toolsetId}@${entry.version} already installed`);
      if (debugOn) {
        log.info(
          `[system-toolsets] ${entry.toolsetId}@${entry.version} ok — integrity=${entry.integrity}`,
        );
      }
      // The tracking file says we installed this in a previous run, but
      // the Store's InstalledToolset list could be missing the record
      // (e.g. installed-toolsets.json was wiped, or the user upgraded
      // from a gezel build that didn't write to the Store yet). Without
      // the Store record, downstream features like the run_playwright
      // route report "@playwright/mcp not installed" even though it's
      // sitting on disk. Re-derive the install path and ensure the
      // record exists.
      if (entry.kind === 'mcp-toolset' && entry.entry) {
        const expectedPath = join(systemToolsetsInstallDir(home), installDirName(entry), 'package');
        if (existsSync(expectedPath)) {
          const list = await store.listInstalledToolsets({ kind: 'system' });
          const hasRecord = list.some(
            (t) => t.toolsetId === entry.toolsetId && t.installPath === expectedPath,
          );
          if (!hasRecord) {
            logger?.info?.(
              `[system-toolsets] re-registering ${entry.toolsetId} on Store (tracking satisfied but Store record missing)`,
            );
            const filtered = list.filter((t) => t.toolsetId !== entry.toolsetId);
            filtered.push({
              toolsetId: entry.toolsetId,
              sourceId: 'system',
              version: entry.version,
              installedAt: existing.installedAt,
              installPath: expectedPath,
              runtime: {
                kind: 'npm-package',
                package: entry.pkg,
                version: entry.version,
                sha256: entry.integrity,
                entry: entry.entry,
                args: entry.args ?? [],
                envHints: [],
              },
            });
            await store.writeInstalledToolsets({ kind: 'system' }, filtered);
          }
        }
      }
      continue;
    }

    if (debugOn) {
      log.info(
        `[system-toolsets] ${entry.toolsetId}@${entry.version} install needed ` +
          `(have=${existing?.version ?? 'none'}, want integrity=${entry.integrity})`,
      );
    }

    statusBus.publish({ phase: 'installing-toolsets', currentToolset: entry.toolsetId });
    try {
      const { installPath } = await installOne(home, entry, logger, existing?.version);
      const trackingEntry: SystemTrackingEntry = {
        toolsetId: entry.toolsetId,
        version: entry.version,
        integrity: entry.integrity,
        installedAt: new Date().toISOString(),
      };
      tracking.toolsets[entry.toolsetId] = trackingEntry;
      await writeSystemTracking(home, tracking);

      if (entry.kind === 'mcp-toolset') {
        if (!entry.entry) {
          throw new Error(
            `system-toolset ${entry.toolsetId} is kind=mcp-toolset but has no entry path`,
          );
        }
        // Register on the Store's system-scope InstalledToolset list so
        // ChatManager spawns it alongside shared + per-gezel toolsets.
        const existingInstalled = await store.listInstalledToolsets({ kind: 'system' });
        const filtered = existingInstalled.filter((t) => t.toolsetId !== entry.toolsetId);
        filtered.push({
          toolsetId: entry.toolsetId,
          sourceId: 'system',
          version: entry.version,
          installedAt: trackingEntry.installedAt,
          installPath,
          runtime: {
            kind: 'npm-package',
            package: entry.pkg,
            version: entry.version,
            sha256: entry.integrity,
            entry: entry.entry,
            args: entry.args ?? [],
            envHints: [],
          },
        });
        await store.writeInstalledToolsets({ kind: 'system' }, filtered);
      }
      // Library entries: nothing else to do — callers look them up via
      // `resolveSystemLibraryPath()` against the tracking file.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.error?.(`[system-toolsets] failed to install ${entry.toolsetId}: ${msg}`);
      if (debugOn && err instanceof Error && err.stack) {
        log.error(`[system-toolsets] stack:\n${err.stack}`);
      }
      statusBus.publish({ phase: 'error', error: msg });
      return;
    }
  }

  // Post-install hooks. Only `playwright-chromium` today.
  for (const entry of eager) {
    if (entry.postInstall !== 'playwright-chromium') continue;
    const installed = await store.listInstalledToolsets({ kind: 'system' });
    const rec = installed.find((t) => t.toolsetId === entry.toolsetId);
    if (!rec?.installPath) continue;

    if (tracking.chromiumRevision === CHROMIUM_REVISION) {
      // On-disk revision already matches — trust the tracking record.
      continue;
    }
    const res = await ensureChromiumInstalled({
      home,
      playwrightInstallPath: rec.installPath,
      statusBus,
      logger,
    });
    if (!res.ok) {
      statusBus.publish({
        phase: 'error',
        error: res.error ?? 'Chromium install failed',
      });
      return;
    }
    tracking.chromiumRevision = CHROMIUM_REVISION;
    await writeSystemTracking(home, tracking);
  }

  statusBus.publish({ phase: 'ready' });
}

/**
 * Reconcile a single system-toolset's Store record against the
 * on-disk state, without running any network installs. Used by the
 * `run_playwright_script` route to self-heal the common stuck case
 * where the files are already on disk (previous install completed
 * successfully on a prior boot) but the Store's
 * `installed-toolsets.json` got wiped — by an app update, crash, or
 * version-skew during development. In that case we want the tool
 * call to succeed immediately rather than telling the user to wait
 * for a bootstrap pass that already ran.
 *
 * Returns `true` when the Store now has a record pointing at a real
 * on-disk install (either because it already did, or because we just
 * re-registered one). Returns `false` when reconciliation can't
 * help — tracking file says it's not installed, or the expected
 * install directory is missing. Callers should fall back to a user-
 * facing "still installing" message in that case.
 *
 * Fast + idempotent: no network, no subprocess, just a few fs
 * stat-equivalent checks + an atomic JSON rewrite. ~1 ms on a warm
 * cache.
 */
export async function reconcileSystemToolsetFromDisk(opts: {
  home: string;
  store: Store;
  toolsetId: string;
  manifest?: PinnedSystemToolset[];
}): Promise<{ reconciled: boolean; installPath?: string }> {
  const { home, store, toolsetId } = opts;
  const manifest = opts.manifest ?? SYSTEM_TOOLSETS;
  const entry = manifest.find((e) => e.toolsetId === toolsetId);
  if (!entry || isPlaceholder(entry)) return { reconciled: false };
  if (entry.kind !== 'mcp-toolset' || !entry.entry) return { reconciled: false };

  const tracking = await readSystemTracking(home);
  const existing = tracking.toolsets[entry.toolsetId];
  const trackingSatisfied =
    existing && existing.version === entry.version && existing.integrity === entry.integrity;
  if (!trackingSatisfied) return { reconciled: false };

  const expectedPath = join(systemToolsetsInstallDir(home), installDirName(entry), 'package');
  if (!existsSync(expectedPath)) return { reconciled: false };

  const list = await store.listInstalledToolsets({ kind: 'system' });
  const hasRecord = list.some(
    (t) => t.toolsetId === entry.toolsetId && t.installPath === expectedPath,
  );
  if (hasRecord) return { reconciled: true, installPath: expectedPath };

  const filtered = list.filter((t) => t.toolsetId !== entry.toolsetId);
  filtered.push({
    toolsetId: entry.toolsetId,
    sourceId: 'system',
    version: entry.version,
    installedAt: existing.installedAt,
    installPath: expectedPath,
    runtime: {
      kind: 'npm-package',
      package: entry.pkg,
      version: entry.version,
      sha256: entry.integrity,
      entry: entry.entry,
      args: entry.args ?? [],
      envHints: [],
    },
  });
  await store.writeInstalledToolsets({ kind: 'system' }, filtered);
  return { reconciled: true, installPath: expectedPath };
}

interface InstallOneResult {
  installPath: string;
}

export interface InstallSystemToolsetOptions {
  signal?: AbortSignal;
  logger?: SystemBootstrapOptions['logger'];
  /**
   * The version currently recorded in the tracking file, when this install
   * is an upgrade. Install directories are version-named, so a new version
   * publishes *beside* its predecessor rather than over it — pass this and
   * the old tree gets reaped.
   */
  previousVersion?: string;
}

/**
 * Turn a callback-driven async operation into a generator of its callback
 * payloads.
 *
 * `start` gets an `emit` it may call any number of times; the generator
 * yields each payload as it arrives and finally returns (or rethrows) what
 * the operation settled with. Without this, awaiting a long operation like
 * the tarball download would buffer every progress event until it finished
 * — which is precisely when nobody needs them any more.
 */
async function* pump<E, R>(
  start: (emit: (e: E) => void) => Promise<R>,
): AsyncGenerator<E, R, void> {
  const queue: E[] = [];
  let wake: (() => void) | null = null;
  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  let settled = false;
  let failed = false;
  let result!: R;
  let failure: unknown;
  // Never rejects — a rejection here would become an unhandled rejection on
  // the `Promise.race` below, since the race is re-entered each loop.
  const tracked = start((e) => {
    queue.push(e);
    nudge();
  }).then(
    (r) => {
      result = r;
      settled = true;
      nudge();
    },
    (err) => {
      failure = err;
      failed = true;
      settled = true;
      nudge();
    },
  );

  while (true) {
    while (queue.length) yield queue.shift() as E;
    if (settled) {
      if (failed) throw failure;
      return result;
    }
    await Promise.race([
      tracked,
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    ]);
  }
}

/**
 * Install one pinned system-toolset, yielding progress as it goes.
 *
 * The eager boot path drains this through {@link installOne} and ignores
 * every event; the on-demand path (`SystemToolsetInstallRegistry`) forwards
 * them to the UI. One implementation, so an on-demand install is provably
 * the same install the bootstrap would have run.
 */
export async function* installSystemToolsetStreaming(
  home: string,
  entry: PinnedSystemToolset,
  opts: InstallSystemToolsetOptions = {},
): AsyncGenerator<SystemToolsetInstallEvent, InstallOneResult, void> {
  const { signal, logger } = opts;
  const root = systemToolsetsInstallDir(home);
  const target = join(root, installDirName(entry));
  const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
  const backup = `${target}.previous`;
  await mkdir(root, { recursive: true });
  await recoverInterruptedNpmInstall(target, backup);
  await mkdir(staging, { recursive: true });

  try {
    yield { type: 'phase', phase: 'resolving' };
    const dist = yield* pump<SystemToolsetInstallEvent, { tarball: string }>((emit) =>
      retryTransient(() => resolvePinnedDist(entry), {
        attempts: NETWORK_ATTEMPTS,
        label: `${entry.pkg}@${entry.version} packument`,
        ...(signal ? { signal } : {}),
        onRetry: (info) => {
          logger?.info?.(
            `[system-toolsets] registry read for ${entry.pkg} failed (${info.reason}); retrying in ${info.delayMs}ms`,
          );
          emit({ type: 'retrying', ...info });
        },
      }),
    );

    yield { type: 'phase', phase: 'downloading' };
    const tarball = join(staging, 'package.tgz');
    yield* pump<SystemToolsetInstallEvent, void>((emit) =>
      retryTransient(
        () =>
          downloadWithIntegrity(dist.tarball, tarball, entry.integrity, {
            ...(signal ? { signal } : {}),
            onProgress: (bytesWritten, totalBytes) =>
              emit({ type: 'progress', bytesWritten, totalBytes }),
          }),
        {
          attempts: NETWORK_ATTEMPTS,
          label: `${entry.pkg}@${entry.version} tarball`,
          ...(signal ? { signal } : {}),
          onRetry: (info) => {
            logger?.info?.(
              `[system-toolsets] tarball download for ${entry.pkg} failed (${info.reason}); retrying in ${info.delayMs}ms`,
            );
            emit({ type: 'retrying', ...info });
          },
        },
      ),
    );

    yield { type: 'phase', phase: 'extracting' };
    const pkgDir = await extractNpmPackageTarball({
      tarballPath: tarball,
      destination: staging,
      expectedName: entry.pkg,
      expectedVersion: entry.version,
    });
    await rm(tarball, { force: true });

    // System packages use the reviewed lockfile and never auto-run package
    // install hooks. This does not affect user-approved npm/package commands.
    const pkgJsonPath = join(pkgDir, 'package.json');
    const installedPkg = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as {
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      [key: string]: unknown;
    };
    const lockfile = SYSTEM_LOCKFILES[entry.toolsetId];
    if (!lockfile) {
      throw new Error(
        `system-toolset ${entry.toolsetId} has no committed lockfile in SYSTEM_LOCKFILES`,
      );
    }
    if (installedPkg.devDependencies) delete installedPkg.devDependencies;
    if (installedPkg.scripts) delete installedPkg.scripts;
    await writeFile(pkgJsonPath, `${JSON.stringify(installedPkg, null, 2)}\n`);
    await writeFile(join(pkgDir, 'pnpm-lock.yaml'), lockfile);

    yield { type: 'phase', phase: 'installing-deps' };
    logger?.info?.(`[system-toolsets] running pnpm install --prod for ${entry.toolsetId}`);
    // `runPnpm` prepends `--ignore-scripts` itself — passing it here would
    // duplicate the flag.
    const pnpmResult = yield* pump<SystemToolsetInstallEvent, PnpmResult>((emit) =>
      runPnpm(['install', '--prod', '--frozen-lockfile'], {
        cwd: pkgDir,
        ...(signal ? { signal } : {}),
        onLine: (chunk) => emit({ type: 'log', line: chunk }),
      }),
    );
    if (!pnpmResult.ok) {
      if (signal?.aborted) throw new Error('install was cancelled');
      const tail = pnpmResult.log.trim() ? `\n${tailLines(pnpmResult.log, 40)}` : '';
      throw new Error(
        `pnpm install for ${entry.toolsetId} exited with code ${pnpmResult.code}.${pnpmLaunchHint(pnpmResult)}${tail}`,
      );
    }

    yield { type: 'phase', phase: 'publishing' };
    await publishStagedNpmInstall(staging, target, backup);

    // Install dirs are version-named, so an upgrade lands beside the old
    // tree instead of over it. Best-effort: a Windows file lock must not
    // fail an otherwise-successful install.
    if (opts.previousVersion && opts.previousVersion !== entry.version) {
      const stale = join(root, installDirName({ pkg: entry.pkg, version: opts.previousVersion }));
      await rm(stale, { recursive: true, force: true }).catch((err) => {
        logger?.warn?.(
          `[system-toolsets] could not remove superseded ${entry.pkg}@${opts.previousVersion}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }

    return { installPath: join(target, 'package') };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Last `n` non-empty lines of a log blob, for error messages. */
function tailLines(log: string, n: number): string {
  const lines = log.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-n).join('\n');
}

/** Drain {@link installSystemToolsetStreaming}, discarding progress. */
async function installOne(
  home: string,
  entry: PinnedSystemToolset,
  logger?: SystemBootstrapOptions['logger'],
  previousVersion?: string,
): Promise<InstallOneResult> {
  const gen = installSystemToolsetStreaming(home, entry, {
    ...(logger ? { logger } : {}),
    ...(previousVersion ? { previousVersion } : {}),
  });
  while (true) {
    const step = await gen.next();
    if (step.done) return step.value;
  }
}

function encodePath(pkg: string): string {
  return pkg.replace('/', '%2f');
}

/**
 * Read the registry packument and return the pinned version's `dist` block.
 * Split out of `installOne` so the whole read — fetch, origin check, bounded
 * parse — can be retried as one unit on a transient fault.
 */
async function resolvePinnedDist(
  entry: PinnedSystemToolset,
): Promise<{ tarball: string; integrity?: string }> {
  const packumentUrl = `https://registry.npmjs.org/${encodePath(entry.pkg)}`;
  const packument = await fetchBounded(packumentUrl, REGISTRY_TIMEOUT_MS);
  try {
    if (!packument.response.ok) {
      throw new HttpStatusError(
        packument.response.status,
        `registry HTTP ${packument.response.status} for ${entry.pkg}`,
      );
    }
    if (new URL(packument.response.url).origin !== 'https://registry.npmjs.org') {
      throw new Error('registry metadata redirected to an untrusted origin');
    }
    const body = (await readBoundedJson(packument.response, MAX_PACKUMENT_BYTES)) as {
      versions?: Record<string, { dist?: { tarball?: string; integrity?: string } }>;
    };
    const dist = body.versions?.[entry.version]?.dist;
    if (!dist?.tarball) {
      throw new Error(`version ${entry.version} of ${entry.pkg} missing from packument`);
    }
    if (dist.integrity && dist.integrity !== entry.integrity) {
      throw new Error(
        `integrity mismatch for ${entry.pkg}@${entry.version}: manifest=${entry.integrity} registry=${dist.integrity}`,
      );
    }
    return { tarball: dist.tarball, ...(dist.integrity ? { integrity: dist.integrity } : {}) };
  } finally {
    packument.dispose();
  }
}

interface DownloadOptions {
  signal?: AbortSignal;
  /** Throttled to {@link PROGRESS_INTERVAL_MS} / {@link PROGRESS_INTERVAL_BYTES}. */
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

async function downloadWithIntegrity(
  url: string,
  dest: string,
  integrity: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const [algo, b64] = integrity.split('-');
  if (!algo || !b64) throw new Error(`bad integrity string: ${integrity}`);
  if (!['sha256', 'sha384', 'sha512'].includes(algo)) {
    throw new Error(`unsupported integrity algorithm: ${algo}`);
  }
  const hash = createHash(algo);
  const request = await fetchBounded(url, DOWNLOAD_TIMEOUT_MS, opts.signal);
  const handle = await open(dest, 'wx', 0o600);
  try {
    const finalUrl = new URL(request.response.url);
    if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password) {
      throw new Error('tarball download redirected to an insecure origin');
    }
    if (!request.response.ok || !request.response.body) {
      throw new HttpStatusError(
        request.response.status,
        `tarball HTTP ${request.response.status} from ${url}`,
      );
    }
    const declared = Number(request.response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
      throw new Error('system toolset tarball exceeds the 100 MiB limit');
    }
    const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : 0;
    let total = 0;
    let lastEmitAt = 0;
    let lastEmitBytes = 0;
    const reader = request.response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_TARBALL_BYTES) {
          throw new Error('system toolset tarball exceeds the 100 MiB limit');
        }
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const result = await handle.write(value, offset, value.byteLength - offset);
          offset += result.bytesWritten;
        }
        // Throttled — an unthrottled emit turns a 40 MB tarball into
        // thousands of SSE frames, each of which is a JSON encode and a
        // socket write per subscriber.
        const now = Date.now();
        if (
          total - lastEmitBytes >= PROGRESS_INTERVAL_BYTES ||
          now - lastEmitAt >= PROGRESS_INTERVAL_MS
        ) {
          lastEmitBytes = total;
          lastEmitAt = now;
          opts.onProgress?.(total, totalBytes);
        }
      }
      opts.onProgress?.(total, totalBytes || total);
    } finally {
      await reader.cancel().catch(() => {});
    }
    const actual = hash.digest('base64');
    if (actual !== b64) {
      throw new Error(
        `integrity check failed for ${url}: expected ${integrity}, got ${algo}-${actual}`,
      );
    }
  } catch (err) {
    await handle.close().catch(() => {});
    await rm(dest, { force: true }).catch(() => {});
    throw err;
  } finally {
    request.dispose();
    await handle.close().catch(() => {});
  }
}

async function fetchBounded(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ response: Response; dispose: () => void }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('system toolset downloads require HTTPS URLs without credentials');
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('system toolset request timed out')),
    timeoutMs,
  );
  timer.unref?.();
  const onCallerAbort = () => controller.abort(new Error('install was cancelled'));
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const dispose = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  };
  try {
    const response = await fetch(parsed, { redirect: 'follow', signal: controller.signal });
    return { response, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('registry returned an empty response');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('registry metadata response exceeds the 5 MiB limit');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('registry metadata response exceeds the 5 MiB limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('registry returned malformed package metadata');
  }
}

/**
 * Explain a pnpm that could not be launched at all. `ENOENT` here means the
 * bundled runtime the supervisor was supposed to lay down isn't where we
 * were told it is — a deployment problem, not an install problem, and the
 * bare Node error names neither.
 */
function pnpmLaunchHint(result: PnpmResult): string {
  if (result.code !== null || !/ENOENT/.test(result.stderr)) return '';
  const pnpmEnv = process.env.GEZEL_PNPM_PATH;
  return pnpmEnv
    ? ` GEZEL_PNPM_PATH=${pnpmEnv} could not be launched; check that it exists and that GEZEL_NODE_PATH names a working Node runtime when it is a JavaScript entrypoint.`
    : " GEZEL_PNPM_PATH is unset; the daemon's launcher did not provide a path to the bundled pnpm.";
}
