/**
 * The headless Chromium the bundled DocBlocks renders previews with.
 *
 * DocBlocks reaches Playwright through squisq-cli, which imports its own
 * exact-pinned `playwright-core` and launches `chromium` with no executable
 * path. Playwright then wants one specific browser revision under
 * `PLAYWRIGHT_BROWSERS_PATH`, and that revision is not the one the managed
 * `@playwright/mcp` installs: squisq-cli 2.9.5 pins playwright-core 1.63
 * (headless shell 1243) while the MCP's Playwright uses 1228. With nothing
 * installed for it, every `preview_document` failed with "Executable doesn't
 * exist" and models retried it a dozen times a step (2026-10-21 sweep).
 *
 * So the revision is read from the playwright-core DocBlocks will actually
 * load, and installed by that same CLI into the managed browsers folder,
 * beside the MCP's browser rather than replacing it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { isPathInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { killProcessTree } from '../utils/kill-process-tree.js';

const log = createLogger('docblocks-browser');

export interface DocblocksBrowserRequirement {
  /** Root of the playwright-core package DocBlocks imports. */
  playwrightCoreDir: string;
  /** Headless-shell revision that playwright-core launches. */
  revision: string;
  /** Folder Playwright looks for under `PLAYWRIGHT_BROWSERS_PATH`. */
  folder: string;
}

/**
 * Find a dependency's package root as an `import` from `fromDir` would,
 * ignoring its `exports` map. Only the ancestor `node_modules` folders count:
 * ESM resolution never reads the global folders `require` also searches.
 */
function dependencyRoot(fromDir: string, name: string): string | null {
  const require = createRequire(join(fromDir, 'package.json'));
  for (const base of require.resolve.paths(name) ?? []) {
    if (basename(base) !== 'node_modules' || !isPathInside(fromDir, dirname(base))) continue;
    const candidate = join(base, name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/** The browser DocBlocks' previews need, or null when its dependency tree does not lead to Playwright. */
export function docblocksBrowserRequirement(
  docblocksInstallPath: string,
): DocblocksBrowserRequirement | null {
  const squisqCli = dependencyRoot(docblocksInstallPath, '@bendyline/squisq-cli');
  const playwrightCoreDir = squisqCli ? dependencyRoot(squisqCli, 'playwright-core') : null;
  if (!playwrightCoreDir) return null;
  try {
    const { browsers } = JSON.parse(
      readFileSync(join(playwrightCoreDir, 'browsers.json'), 'utf8'),
    ) as { browsers?: Array<{ name?: string; revision?: string }> };
    const shell = browsers?.find((browser) => browser.name === 'chromium-headless-shell');
    if (!shell?.revision) return null;
    return {
      playwrightCoreDir,
      revision: shell.revision,
      folder: `chromium_headless_shell-${shell.revision}`,
    };
  } catch {
    return null;
  }
}

/** Playwright writes this marker last; its runtime and ours treat the browser as present only then. */
export function docblocksBrowserInstalled(
  browsersDir: string,
  requirement: DocblocksBrowserRequirement,
): boolean {
  return existsSync(join(browsersDir, requirement.folder, 'INSTALLATION_COMPLETE'));
}

/** A Node to run Playwright's CLI with: the bundled runtime, else this process told to act as Node. */
function nodeRuntime(): { command: string; env: NodeJS.ProcessEnv } {
  const bundled = process.env.GEZEL_NODE_PATH?.trim();
  if (bundled && existsSync(bundled)) return { command: bundled, env: {} };
  return {
    command: process.execPath,
    env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

/**
 * Install DocBlocks' headless shell into `browsersDir` when it is missing.
 * `--no-remove` keeps Playwright from collecting the other browsers there.
 */
export async function ensureDocblocksBrowser(opts: {
  docblocksInstallPath: string;
  browsersDir: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; installed?: boolean; error?: string }> {
  const requirement = docblocksBrowserRequirement(opts.docblocksInstallPath);
  if (!requirement) return { ok: false, error: 'DocBlocks does not resolve playwright-core' };
  if (docblocksBrowserInstalled(opts.browsersDir, requirement)) return { ok: true };
  if (opts.signal?.aborted) return { ok: false, error: 'install was cancelled' };

  const runtime = nodeRuntime();
  log.info(
    `[docblocks-browser] installing ${requirement.folder} into ${opts.browsersDir} for document previews`,
  );
  return new Promise((resolve) => {
    const child = spawn(
      runtime.command,
      [
        join(requirement.playwrightCoreDir, 'cli.js'),
        'install',
        '--only-shell',
        '--no-remove',
        'chromium',
      ],
      {
        cwd: dirname(requirement.playwrightCoreDir),
        env: { ...process.env, ...runtime.env, PLAYWRIGHT_BROWSERS_PATH: opts.browsersDir },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    const onAbort = () => killProcessTree(child);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    const settle = (result: { ok: boolean; installed?: boolean; error?: string }) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(opts.signal?.aborted ? { ok: false, error: 'install was cancelled' } : result);
    };
    child.on('error', (err) => settle({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code === 0 && docblocksBrowserInstalled(opts.browsersDir, requirement)) {
        settle({ ok: true, installed: true });
      } else {
        settle({
          ok: false,
          error: `playwright install exited with ${code}: ${stderrTail.trim() || 'no output'}`,
        });
      }
    });
  });
}
