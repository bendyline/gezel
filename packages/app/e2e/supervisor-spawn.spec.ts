import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-spawn-e2e-'));
  runtimePidPath = join(gezelHome, 'runtime', 'pid');

  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_SPAWN: '1',
      // Crucially NOT setting GEZEL_EMBEDDED — we want the real spawn path.
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);
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
