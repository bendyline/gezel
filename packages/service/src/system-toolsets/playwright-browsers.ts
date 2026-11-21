import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PNPM_MANAGED_TREE_EXEC_CONFIG, type PnpmInvocation } from '@bendyline/gezel';
import { isPathInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { resolvePnpmCommand, spawnPnpm } from '../packages/pnpm.js';
import { killProcessTree } from '../utils/kill-process-tree.js';
import type { SystemStatusBus } from './status-bus.js';

/**
 * The Chromium builds a Playwright install launches. Playwright looks for one
 * exact revision under `PLAYWRIGHT_BROWSERS_PATH`, read from the
 * `playwright-core` it loads; a browser folder of any other revision is
 * invisible to it, however complete.
 */
export interface PlaywrightBrowserRequirement {
  /** Root of the `playwright-core` package the install resolves. */
  playwrightCoreDir: string;
  /** Chromium revision from that package's `browsers.json`. */
  revision: string;
  /** Folders that hold Chrome for Testing, used by a headed launch. */
  chromium: string[];
  /** Folders that hold the headless shell, used by every `headless: true` launch. */
  headlessShell: string[];
}

interface BrowsersJsonEntry {
  name?: string;
  revision?: string;
  revisionOverrides?: Record<string, string>;
}

/**
 * The `playwright-core` that `import 'playwright'` reaches from the install,
 * which is what the page check and `run_playwright_script` both load. Only a
 * package inside the install counts: `require` also searches ancestor
 * folders and `NODE_PATH` (which pnpm sets), and under a dev launch that
 * found the repo's own Playwright for an install that had none.
 */
function resolvePlaywrightCore(installPath: string): string | null {
  try {
    const root = realpathSync(installPath);
    const inside = (file: string) => isPathInside(realpathSync(file), root);
    const fromInstall = createRequire(join(root, 'package.json'));
    let fromPlaywright = fromInstall;
    try {
      const playwright = fromInstall.resolve('playwright');
      if (inside(playwright)) fromPlaywright = createRequire(playwright);
    } catch {
      /* an install that depends on playwright-core alone */
    }
    const core = fromPlaywright.resolve('playwright-core/package.json');
    return inside(core) ? dirname(core) : null;
  } catch {
    return null;
  }
}

/** Playwright names a browser folder `<name with _ for ->-<revision>`. */
function browserFolders(
  browsers: BrowsersJsonEntry[],
  name: string,
): { revision: string; folders: string[] } | null {
  const entry = browsers.find((browser) => browser.name === name);
  if (!entry?.revision) return null;
  // Playwright picks a per-platform override when one is listed; any of them
  // is a folder it may look in on this machine.
  const revisions = new Set([entry.revision, ...Object.values(entry.revisionOverrides ?? {})]);
  return {
    revision: entry.revision,
    folders: [...revisions].map((revision) => `${name.replaceAll('-', '_')}-${revision}`),
  };
}

/** The browsers the install's Playwright launches, or null when it does not resolve one. */
export function playwrightBrowserRequirement(
  installPath: string,
): PlaywrightBrowserRequirement | null {
  const playwrightCoreDir = resolvePlaywrightCore(installPath);
  if (!playwrightCoreDir) return null;
  let browsers: BrowsersJsonEntry[];
  try {
    const parsed = JSON.parse(readFileSync(join(playwrightCoreDir, 'browsers.json'), 'utf8')) as {
      browsers?: BrowsersJsonEntry[];
    };
    browsers = parsed.browsers ?? [];
  } catch {
    return null;
  }
  const chromium = browserFolders(browsers, 'chromium');
  const headlessShell = browserFolders(browsers, 'chromium-headless-shell');
  if (!chromium || !headlessShell) return null;
  return {
    playwrightCoreDir,
    revision: chromium.revision,
    chromium: chromium.folders,
    headlessShell: headlessShell.folders,
  };
}

/**
 * Whether the required browsers finished downloading. Playwright writes
 * `INSTALLATION_COMPLETE` last, and its runtime trusts the same marker.
 */
export function playwrightBrowsersInstalled(
  browsersDir: string,
  requirement: PlaywrightBrowserRequirement,
  which: 'all' | 'headless-shell' = 'all',
): boolean {
  const complete = (folders: string[]) =>
    folders.some((folder) => existsSync(join(browsersDir, folder, 'INSTALLATION_COMPLETE')));
  return (
    complete(requirement.headlessShell) &&
    (which === 'headless-shell' || complete(requirement.chromium))
  );
}

/**
 * Download Chromium using Playwright's own CLI, redirected to our
 * managed directory at `~/.gezel/playwright-browsers/`.
 *
 *   pnpm --dir <playwrightInstallPath> exec playwright install chromium
 *
 * Invoked explicitly (not via a pnpm post-install hook) so we control
 * exactly when this runs and can stream progress to the status bus.
 * Chromium adds ~281 MB to `~/.gezel/`.
 */
export async function ensureChromiumInstalled(args: {
  home: string;
  /** Path to the installed `@playwright/mcp` package directory. */
  playwrightInstallPath: string;
  statusBus: SystemStatusBus;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /**
   * Stops the download and kills the installer's whole process tree. The
   * browser is then left without Playwright's completion marker, so the next
   * run installs it again from the start.
   */
  signal?: AbortSignal;
  /** Test seam: the pnpm launch to run in place of `playwright install chromium`. */
  invocation?: PnpmInvocation;
}): Promise<{ ok: boolean; error?: string; cancelled?: boolean; revision?: string }> {
  if (args.signal?.aborted) return { ok: false, cancelled: true, error: 'install was cancelled' };
  const browsersDir = playwrightBrowsersDir(args.home);

  // Only the revision this toolset's Playwright launches counts. Any
  // complete `chromium-*` folder used to: after the pin moved to 1232, the
  // previous pin's chromium-1217 satisfied the check, nothing was
  // downloaded, and every launch failed with "Executable doesn't exist"
  // (2026-11-21). With no requirement to read, Playwright's own installer
  // decides; it skips a download that is already in place.
  const requirement = playwrightBrowserRequirement(args.playwrightInstallPath);
  if (requirement && playwrightBrowsersInstalled(browsersDir, requirement)) {
    return { ok: true, revision: requirement.revision };
  }

  args.statusBus.publish({
    phase: 'downloading-browser',
    browserProgress: { bytesDownloaded: 0, bytesTotal: null },
  });

  // `pnpm exec playwright install chromium` resolves Playwright from the
  // MCP toolset's own node_modules, so there's no global Playwright dep.
  // The managed-tree config keeps pnpm from reinstalling the tree before
  // exec'ing (see PNPM_MANAGED_TREE_EXEC_CONFIG).
  const pnpm =
    args.invocation ??
    resolvePnpmCommand([
      ...PNPM_MANAGED_TREE_EXEC_CONFIG,
      '--dir',
      args.playwrightInstallPath,
      'exec',
      'playwright',
      'install',
      'chromium',
    ]);
  return new Promise((resolve) => {
    const child = spawnPnpm(pnpm, {
      cwd: args.playwrightInstallPath,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browsersDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      processGroup: true,
    });
    // pnpm exits on a signal without its children, which left Playwright's
    // downloader running as an orphan after the app quit.
    const onAbort = () => killProcessTree(child);
    args.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (result: {
      ok: boolean;
      error?: string;
      cancelled?: boolean;
      revision?: string;
    }) => {
      args.signal?.removeEventListener('abort', onAbort);
      resolve(
        args.signal?.aborted
          ? { ok: false, cancelled: true, error: 'install was cancelled' }
          : result,
      );
    };
    let stderrTail = '';
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-2000);
      for (const p of parseProgress(text)) {
        args.statusBus.publish({
          phase: 'downloading-browser',
          browserProgress: p,
        });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', (err) => {
      args.logger?.warn?.(`[system-toolsets] playwright install error: ${err.message}`);
      settle({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        settle({
          ok: false,
          error: `playwright install chromium exited with ${code}: ${stderrTail.trim()}`,
        });
        return;
      }
      if (!requirement) {
        settle({ ok: true });
        return;
      }
      // An exit of 0 is not proof: the record of success is what later boots trust.
      if (!playwrightBrowsersInstalled(browsersDir, requirement)) {
        settle({
          ok: false,
          error: `playwright install chromium finished, but ${requirement.headlessShell[0]} is not in ${browsersDir}`,
        });
        return;
      }
      settle({ ok: true, revision: requirement.revision });
    });
  });
}

/**
 * Parse Playwright's progress lines. Format varies across versions but
 * commonly includes something like:
 *   "Downloading Chromium 119.0.6045.9 - 142.1 MiB / 155.4 MiB [=====>    ]"
 * We extract MiB numbers so the UI can show a percentage. When we can't
 * parse, we still transition to `downloading-browser` without numbers so
 * the pill reads "Downloading Chromium…".
 */
function parseProgress(
  line: string,
): Array<{ bytesDownloaded: number; bytesTotal: number | null }> {
  const out: Array<{ bytesDownloaded: number; bytesTotal: number | null }> = [];
  const re = /(\d+(?:\.\d+)?)\s*MiB\s*\/\s*(\d+(?:\.\d+)?)\s*MiB/gi;
  for (const m of line.matchAll(re)) {
    const downloaded = Number.parseFloat(m[1]!) * 1024 * 1024;
    const total = Number.parseFloat(m[2]!) * 1024 * 1024;
    out.push({
      bytesDownloaded: Math.round(downloaded),
      bytesTotal: Math.round(total),
    });
  }
  return out;
}
