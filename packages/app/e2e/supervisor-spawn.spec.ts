import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Supervisor spawn E2E — exercises the GEZEL_SPAWN=1 dev-mode path end to
 * end. Unlike the other specs (which set GEZEL_EMBEDDED=1 for speed), this
 * one actually boots gezeld as a child process and verifies:
 *   • the UI connects to the spawned daemon
 *   • ~/.gezel/runtime/pid points at a live process
 *   • Electron's before-quit handler stops the child cleanly
 *
 * Restart-on-crash coverage lands with chunk 4's supervision work.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = join(_dirname, '..');

let app: ElectronApplication;
let page: Page;
let gezelHome: string;
let runtimePidPath: string;

/**
 * How long the spawned daemon gets to come up. The supervisor provisions the
 * bundled Node/pnpm runtimes and boots gezeld before `connectOrStart`
 * resolves; on a cold CI home that is minutes, not seconds.
 */
const DAEMON_BOOT_TIMEOUT_MS = 180_000;
/** Slack past the daemon boot for the splash-to-UI handoff and Electron launch. */
const HOOK_TIMEOUT_MS = DAEMON_BOOT_TIMEOUT_MS + 60_000;
const UI_LOAD_TIMEOUT_MS = 60_000;

async function waitForRuntimePid(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`runtime/pid was never written within ${timeoutMs}ms: ${path}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

test.beforeAll(async () => {
  test.setTimeout(HOOK_TIMEOUT_MS);
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-spawn-e2e-'));
  runtimePidPath = join(gezelHome, 'runtime', 'pid');

  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_SPAWN: '1',
      // Crucially NOT setting GEZEL_EMBEDDED — we want the real spawn path.
      // Same reason as app.spec.ts: skip the on-device model download and the
      // system-toolset bootstrap. This spec is about supervisor spawn, and
      // paying for first-run provisioning only widens the boot window.
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // The window is painted *before* `connectOrStart` resolves so a cold install
  // shows the splash instead of nothing (see createWindow in src/main.ts), so
  // reaching here proves nothing about the daemon — a fixed sleep just races
  // the bundle unpack. Wait on the daemon's own artifacts instead: the pid file
  // the supervisor writes, then the UI the splash hands off to.
  await waitForRuntimePid(runtimePidPath, DAEMON_BOOT_TIMEOUT_MS);
  await expect(page.locator('.app-header')).toBeVisible({ timeout: UI_LOAD_TIMEOUT_MS });
});

test.afterAll(async () => {
  await app?.close();
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('spawn - runtime/pid is written and points at a live child', async () => {
  const pidRaw = await readFile(runtimePidPath, 'utf8');
  const pid = Number.parseInt(pidRaw.trim(), 10);
  expect(Number.isFinite(pid)).toBe(true);
  expect(pid).toBeGreaterThan(0);
  // `process.kill(pid, 0)` throws if the process is dead.
  expect(() => process.kill(pid, 0)).not.toThrow();
});

test('spawn - UI reaches the spawned service', async () => {
  // If the supervisor connected to a real daemon, the app header should
  // render and the page title should match.
  const title = await page.title();
  expect(title).toBe('Gezel');
  await expect(page.locator('.app-header')).toBeVisible();
});

test('spawn - child exits after Electron close', async () => {
  const pidRaw = await readFile(runtimePidPath, 'utf8');
  const pid = Number.parseInt(pidRaw.trim(), 10);
  await app.close();
  // Give gracefullyStop its 3-second SIGTERM window plus a bit of slack.
  await new Promise((r) => setTimeout(r, 4000));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(false);
});
