import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNPM_MANAGED_TREE_EXEC_CONFIG, createLogger } from '@bendyline/gezel';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import type { Store } from '../fs/store.js';
import { resolvePnpmCommand, spawnPnpm } from '../packages/pnpm.js';
import {
  playwrightBrowserRequirement,
  playwrightBrowsersInstalled,
} from '../system-toolsets/playwright-browsers.js';

const log = createLogger('page-check');

/**
 * Post-write runtime smoke check for HTML deliverables.
 *
 * `validate` proves a file parses; it cannot see runtime failures — the
 * canonical incident is DS4 writing `n.color + '33'` over a 3-digit hex
 * palette: syntactically perfect, and the first `addColorStop('#0ff33')`
 * kills the page's animation loop on frame one. The model has no browser
 * and ships on faith. This module is the harness-side answer: load the
 * just-written page headlessly for a moment, collect what the page threw,
 * and let the MCP write tools fold that into the tool result the model is
 * already reading — in-turn, while its context is hot, at zero model-token
 * cost. The model-profile prompts already teach every local model what to
 * do with a runtime nudge naming a concrete failure ("patch with
 * `replaceInFile`") — this supplies the missing signal.
 *
 * Browser runtime: the SAME bootstrapped `@playwright/mcp` toolset +
 * managed Chromium that `run_playwright_script` uses (Settings → Daemon).
 * When it isn't installed the check skips silently (`ran: false`) — a
 * missing browser must never fail or slow a write beyond the cheap fs
 * probes below. No background bootstrap is kicked off here (unlike the
 * run-playwright route): an implicit ~281 MB download is not an
 * acceptable side effect of writing an HTML file.
 */

export interface PageCheckOutcome {
  ran: boolean;
  ok?: boolean;
  errors?: string[];
  reason?: string;
}

/** Max distinct error lines surfaced to the model. */
const MAX_ERRORS = 5;
/** Max length per surfaced error line. */
const MAX_ERROR_CHARS = 300;

/**
 * The script executed inside the toolset's environment (cwd = the
 * installed `@playwright/mcp` package, so `createRequire` walks its
 * node_modules for `playwright`). Prints a single sentinel-prefixed JSON
 * line; always exits 0 — transport-level failures are the caller's to
 * classify via the sentinel's absence.
 *
 * Result-shape notes:
 * - `pageerror` is the money channel (uncaught exceptions — the dead-RAF
 *   class). `console.error` and network-level `requestfailed` ride along;
 *   HTTP 404s are responses, not request failures, and surface as the
 *   resource-load `error` events the preview shim reports instead.
 * - `waitUntil: 'load'` + a settle window: canvas/game pages throw on
 *   their first animation frame, not during parse.
 */
const RESULT_SENTINEL = 'GEZEL_PAGE_CHECK_RESULT:';
const RUNNER_SOURCE = `import { createRequire } from 'node:module';
const [url, settleMsArg, capMsArg, externalArg] = process.argv.slice(2);
const settleMs = Number(settleMsArg) || 1500;
const capMs = Number(capMsArg) || 12000;
const allowExternal = externalArg === '1';
const pageUrl = new URL(url);
// Contained: every request outside the page's own origin is aborted, and a
// proxy that answers nothing catches what routing cannot see off this host
// (WebSockets, WebRTC over TCP). Loopback and the page's own host skip the
// proxy, which Playwright otherwise forces loopback through, and are left to
// the route below. UDP and DNS prefetch are off outright.
const contained = allowExternal
  ? {}
  : {
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--dns-prefetch-disable'],
      proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,' + pageUrl.hostname },
    };
const finish = (result) => {
  console.log('${RESULT_SENTINEL}' + JSON.stringify(result));
  process.exit(0);
};
const hardCap = setTimeout(() => finish({ ok: false, errors: ['page check timed out in-browser'] }), capMs);
if (hardCap.unref) hardCap.unref();
const errors = [];
const push = (kind, message) => {
  if (errors.length < 20) errors.push(kind + ': ' + String(message));
};
let browser;
// A browser that cannot start says nothing about the page, so it is reported
// apart from what the page did; the caller treats it as no verdict.
try {
  const require = createRequire(process.cwd() + '/');
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true, ...contained });
} catch (err) {
  clearTimeout(hardCap);
  finish({ ok: false, launchError: String(err && err.message ? err.message : err) });
}
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(allowExternal ? {} : { serviceWorkers: 'block' }),
  });
  if (!allowExternal) {
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === pageUrl.origin
        ? route.continue()
        : route.abort('blockedbyclient'),
    );
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => push('pageerror', e && e.message ? e.message : e));
  page.on('console', (m) => { if (m.type() === 'error') push('console.error', m.text()); });
  page.on('requestfailed', (r) => {
    const f = r.failure();
    push('requestfailed', r.url() + ' (' + (f ? f.errorText : 'failed') + ')');
  });
  const response = await page.goto(url, { waitUntil: 'load', timeout: Math.max(1000, capMs - settleMs - 2000) });
  if (!response) {
    push('load', 'navigation completed without an HTTP response');
  } else if (!response.ok()) {
    push('http', response.status() + ' ' + response.statusText() + ' for ' + response.url());
  }
  await page.waitForTimeout(settleMs);
  clearTimeout(hardCap);
  await browser.close().catch(() => {});
  finish({ ok: errors.length === 0, errors });
} catch (err) {
  clearTimeout(hardCap);
  if (browser) await browser.close().catch(() => {});
  errors.push('load failed: ' + (err && err.message ? err.message : err));
  finish({ ok: false, errors });
}
`;

/** Installed `@playwright/mcp` toolset directory, or null when absent. */
export async function resolvePlaywrightInstall(store: Store): Promise<string | null> {
  try {
    const installed = await store.listInstalledToolsets({ kind: 'system' });
    const playwright = installed.find((t) => t.toolsetId === '@playwright/mcp');
    return playwright?.installPath && existsSync(playwright.installPath)
      ? playwright.installPath
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether the headless shell this toolset's Playwright launches finished
 * downloading: its exact revision, not any Chromium folder. A leftover
 * build from an earlier pin once answered yes here, and every page check
 * then reported "Executable doesn't exist" as an error in the person's page.
 */
export async function isChromiumReady(home: string, installPath: string): Promise<boolean> {
  const requirement = playwrightBrowserRequirement(installPath);
  return requirement
    ? playwrightBrowsersInstalled(playwrightBrowsersDir(home), requirement, 'headless-shell')
    : false;
}

export interface RunPageCheckOptions {
  /** Installed `@playwright/mcp` package dir (module-resolution root). */
  installPath: string;
  /** `PLAYWRIGHT_BROWSERS_PATH` value — the managed browsers dir. */
  browsersPath: string;
  /** Absolute URL of the page (normally a freshly minted preview lease). */
  url: string;
  /**
   * Let the page reach other origins, as the preview does when the security
   * level allows web services. Otherwise it is contained: the preview's CSP
   * does not cover a meta refresh to `https://collector/?d=…`, WebRTC or
   * DNS, and this browser had nothing else between it and the network.
   */
  allowExternalNetwork?: boolean;
  /** How long the page gets after `load` to throw (animation-frame bugs). */
  settleMs?: number;
  /** Hard wall-clock cap on the whole child process. */
  timeoutMs?: number;
  /** Test seam. */
  spawnImpl?: typeof spawn;
}

/** Serialize checks — one Chromium at a time, whatever the write burst looks like. */
let pageCheckChain: Promise<unknown> = Promise.resolve();

export function runPageCheck(opts: RunPageCheckOptions): Promise<PageCheckOutcome> {
  const next = pageCheckChain.then(() => runPageCheckInner(opts));
  pageCheckChain = next.catch(() => undefined);
  return next;
}

async function runPageCheckInner(opts: RunPageCheckOptions): Promise<PageCheckOutcome> {
  const settleMs = opts.settleMs ?? 1_500;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const inBrowserCapMs = Math.max(3_000, timeoutMs - 5_000);
  const spawnImpl = opts.spawnImpl ?? spawn;

  const scratch = await mkdtemp(join(tmpdir(), 'gezel-page-check-'));
  const runnerPath = join(scratch, 'page-check-runner.mjs');
  await writeFile(runnerPath, RUNNER_SOURCE, 'utf8');

  const args = [
    ...PNPM_MANAGED_TREE_EXEC_CONFIG,
    '--dir',
    opts.installPath,
    'exec',
    'node',
    runnerPath,
    opts.url,
    String(settleMs),
    String(inBrowserCapMs),
    opts.allowExternalNetwork ? '1' : '0',
  ];
  const pnpm = resolvePnpmCommand(args);

  try {
    const raw = await new Promise<{ log: string; failed?: string }>((resolve) => {
      const child = spawnPnpm(
        pnpm,
        {
          cwd: opts.installPath,
          env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: opts.browsersPath },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        spawnImpl,
      );
      let out = '';
      const cap = (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.length > 100_000) out = out.slice(-100_000);
      };
      child.stdout?.on('data', cap);
      child.stderr?.on('data', cap);
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ log: out, failed: 'timeout' });
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(killer);
        resolve({ log: out, failed: err.message });
      });
      child.on('close', () => {
        clearTimeout(killer);
        resolve({ log: out });
      });
    });

    const line = raw.log
      .split('\n')
      .reverse()
      .find((l) => l.includes(RESULT_SENTINEL));
    if (!line) {
      log.warn(
        `[page-check] no result from runner (${raw.failed ?? 'child produced no sentinel'}): ${raw.log.slice(-400)}`,
      );
      return { ran: false, reason: raw.failed ?? 'runner-produced-no-result' };
    }
    const parsed = JSON.parse(
      line.slice(line.indexOf(RESULT_SENTINEL) + RESULT_SENTINEL.length),
    ) as {
      ok: boolean;
      errors?: string[];
      launchError?: string;
    };
    if (parsed.launchError !== undefined) {
      // The detail names local paths and Playwright's install banner; the
      // log keeps it, the model gets a reason it cannot mistake for its page.
      log.warn(`[page-check] browser did not start: ${parsed.launchError.slice(0, 600)}`);
      return { ran: false, reason: 'browser-did-not-start' };
    }
    const errors = (parsed.errors ?? [])
      .slice(0, MAX_ERRORS)
      .map((e) => (e.length > MAX_ERROR_CHARS ? `${e.slice(0, MAX_ERROR_CHARS)}…` : e));
    return { ran: true, ok: parsed.ok, errors };
  } catch (err) {
    log.warn(`[page-check] failed: ${err instanceof Error ? err.message : err}`);
    return { ran: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
