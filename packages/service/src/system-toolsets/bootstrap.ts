import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import {
  extractNpmPackageTarball,
  publishStagedNpmInstall,
  recoverInterruptedNpmInstall,
} from '@bendyline/gezel-catalog';
import { systemToolsetsInstallDir } from '@bendyline/gezel/paths';
import type { Store } from '../fs/store.js';
import { resolvePnpmBinary } from '../packages/pnpm.js';
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
 * For each entry in the manifest:
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

  const tracking = await readSystemTracking(home);

  // Install / refresh each manifest entry.
  for (const entry of real) {
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
      const { installPath } = await installOne(home, entry, logger);
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
  for (const entry of real) {
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

async function installOne(
  home: string,
  entry: PinnedSystemToolset,
  logger?: SystemBootstrapOptions['logger'],
): Promise<InstallOneResult> {
  const root = systemToolsetsInstallDir(home);
  const target = join(root, installDirName(entry));
  const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
  const backup = `${target}.previous`;
  await mkdir(root, { recursive: true });
  await recoverInterruptedNpmInstall(target, backup);
  await mkdir(staging, { recursive: true });

  try {
    const packumentUrl = `https://registry.npmjs.org/${encodePath(entry.pkg)}`;
    const packument = await fetchBounded(packumentUrl, REGISTRY_TIMEOUT_MS);
    try {
      if (!packument.response.ok) {
        throw new Error(`registry HTTP ${packument.response.status} for ${entry.pkg}`);
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

      const tarball = join(staging, 'package.tgz');
      await downloadWithIntegrity(dist.tarball, tarball, entry.integrity);
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

      logger?.info?.(`[system-toolsets] running pnpm install --prod for ${entry.toolsetId}`);
      await run(
        resolvePnpmBinary(),
        ['install', '--prod', '--frozen-lockfile', '--ignore-scripts'],
        pkgDir,
      );

      await publishStagedNpmInstall(staging, target, backup);
      return { installPath: join(target, 'package') };
    } finally {
      packument.dispose();
    }
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function encodePath(pkg: string): string {
  return pkg.replace('/', '%2f');
}

async function downloadWithIntegrity(url: string, dest: string, integrity: string): Promise<void> {
  const [algo, b64] = integrity.split('-');
  if (!algo || !b64) throw new Error(`bad integrity string: ${integrity}`);
  if (!['sha256', 'sha384', 'sha512'].includes(algo)) {
    throw new Error(`unsupported integrity algorithm: ${algo}`);
  }
  const hash = createHash(algo);
  const request = await fetchBounded(url, DOWNLOAD_TIMEOUT_MS);
  const handle = await open(dest, 'wx', 0o600);
  try {
    const finalUrl = new URL(request.response.url);
    if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password) {
      throw new Error('tarball download redirected to an insecure origin');
    }
    if (!request.response.ok || !request.response.body) {
      throw new Error(`tarball HTTP ${request.response.status} from ${url}`);
    }
    const declared = Number(request.response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
      throw new Error('system toolset tarball exceeds the 100 MiB limit');
    }
    let total = 0;
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
      }
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
  try {
    const response = await fetch(parsed, { redirect: 'follow', signal: controller.signal });
    return { response, dispose: () => clearTimeout(timer) };
  } catch (err) {
    clearTimeout(timer);
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

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Windows: pnpm, tar, and most tools we invoke here are resolved via
    // `.cmd` / `.bat` shims on PATH. Node's `spawn` without `shell` can't
    // launch those — it throws `ENOENT` even though the user sees the
    // command working in their terminal. `shell: true` delegates to
    // cmd.exe which handles shim resolution. Args are internally
    // constructed (never user-supplied), so shell injection isn't a
    // concern here.
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
      // Translate the Node-level `ENOENT` into something a user (or a
      // log reader) can actually act on.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const pnpmEnv = process.env.GEZEL_PNPM_PATH;
        const hint = pnpmEnv
          ? `GEZEL_PNPM_PATH=${pnpmEnv} but the file is missing or not executable.`
          : `GEZEL_PNPM_PATH is unset; the daemon's launcher did not provide a path to the bundled pnpm.`;
        reject(new Error(`Could not run '${cmd}' (${err.message}). ${hint}`));
        return;
      }
      reject(err);
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}
