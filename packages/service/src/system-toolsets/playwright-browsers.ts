import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PNPM_HOISTED_NODE_LINKER, type PnpmInvocation } from '@bendyline/gezel';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { resolvePnpmCommand, spawnPnpm } from '../packages/pnpm.js';
import { killProcessTree } from '../utils/kill-process-tree.js';
import type { SystemStatusBus } from './status-bus.js';

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
}): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  if (args.signal?.aborted) return { ok: false, cancelled: true, error: 'install was cancelled' };
  const browsersDir = playwrightBrowsersDir(args.home);

  // If a chromium-* subdir already has Playwright's completion marker,
  // skip. The marker is `INSTALLATION_COMPLETE` and Playwright's runtime
  // checks the same file, so our skip is equivalent to Playwright's own
  // "already installed" decision.
  if (existsSync(browsersDir)) {
    try {
      const entries = await readdir(browsersDir, { withFileTypes: true });
      const chromium = entries.find((e) => e.isDirectory() && e.name.startsWith('chromium-'));
      if (chromium) {
        const marker = join(browsersDir, chromium.name, 'INSTALLATION_COMPLETE');
        if (existsSync(marker)) return { ok: true };
      }
    } catch {
      /* fall through to install */
    }
  }

  args.statusBus.publish({
    phase: 'downloading-browser',
    browserProgress: { bytesDownloaded: 0, bytesTotal: null },
  });

  // `pnpm exec playwright install chromium` resolves Playwright from the
  // MCP toolset's own node_modules, so there's no global Playwright dep.
  // The linker flag must match the install-time config or pnpm rebuilds
  // the tree before exec'ing (see PNPM_HOISTED_NODE_LINKER).
  const pnpm =
    args.invocation ??
    resolvePnpmCommand([
      PNPM_HOISTED_NODE_LINKER,
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
    const settle = (result: { ok: boolean; error?: string; cancelled?: boolean }) => {
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
      if (code === 0) settle({ ok: true });
      else
        settle({
          ok: false,
          error: `playwright install chromium exited with ${code}: ${stderrTail.trim()}`,
        });
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
