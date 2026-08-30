import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Home Workshop tall-window screenshot — mirrors home.spec.ts launch
 * boilerplate exactly (mock provider on a fresh GEZEL_HOME so the Home
 * tab renders the workshop), but resizes the BrowserWindow to a tall
 * 1400x900 and captures a viewport-only (fullPage:false) PNG to
 * /tmp/gezel-home-workshop.png for CSS layout inspection of the chat
 * column height. Also instruments the fill chain (getBoundingClientRect
 * + computed styles) and prints a JSON table for diagnosis.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-home-shot-e2e-'));
  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('captures the workshop home at a tall window', async () => {
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.home-workshop-conversation')).toBeVisible();

  // Resize the real Electron BrowserWindow to a tall 1400x900 content
  // size so the chat column's full-height behaviour is visible.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setContentSize(1400, 900);
  });
  await page.waitForTimeout(800);

  // ── Instrumentation: measure the fill chain ───────────────────────
  const measurements = await page.evaluate(() => {
    const sel = [
      'html',
      'body',
      '.app',
      '.app-main',
      '.home-workshop',
      '.home-workshop-body',
      '.home-workshop-main',
      '.home-workshop-conversation',
      '.home-workshop-conversation .chat-rail-body',
      '.home-workshop-conversation .chat-rail-main',
      '.home-workshop-conversation .chat-rail-side',
      '.home-workshop-conversation .chat-timeline-viewport',
      '.home-workshop-conversation .chat-timeline',
      '.home-workshop-conversation .chat-composer',
    ];
    const rects: Record<string, unknown> = {};
    for (const s of sel) {
      const el =
        s === 'html'
          ? document.documentElement
          : s === 'body'
            ? document.body
            : document.querySelector(s);
      if (!el) {
        rects[s] = 'MISSING';
        continue;
      }
      const r = el.getBoundingClientRect();
      rects[s] = {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        height: Math.round(r.height),
        scrollH: (el as HTMLElement).scrollHeight,
        clientH: (el as HTMLElement).clientHeight,
      };
    }
    const styleSel = [
      '.home-workshop-body',
      '.home-workshop-main',
      '.home-workshop-conversation',
      '.home-workshop-conversation .chat-rail-body',
      '.home-workshop-conversation .chat-rail-main',
    ];
    const styles: Record<string, unknown> = {};
    for (const s of styleSel) {
      const el = document.querySelector(s);
      if (!el) {
        styles[s] = 'MISSING';
        continue;
      }
      const cs = getComputedStyle(el);
      styles[s] = {
        display: cs.display,
        height: cs.height,
        flex: cs.flex,
        gridTemplateRows: cs.gridTemplateRows,
        alignContent: cs.alignContent,
        minHeight: cs.minHeight,
      };
    }
    return { innerHeight: window.innerHeight, rects, styles };
  });
  console.log('GEZEL_MEASURE_START');
  console.log(JSON.stringify(measurements, null, 2));
  console.log('GEZEL_MEASURE_END');

  // The chat surface must reach the window bottom (no dead gap under the
  // composer). The rail itself lands flush, while the composer keeps its
  // deliberate 0.25rem (4px) inset so its rounded lower corners stay visible.
  const railMain = measurements.rects['.home-workshop-conversation .chat-rail-main'] as {
    bottom: number;
  };
  const composer = measurements.rects['.home-workshop-conversation .chat-composer'] as {
    bottom: number;
  };
  expect(Math.abs(railMain.bottom - measurements.innerHeight)).toBeLessThanOrEqual(2);
  expect(Math.abs(composer.bottom - measurements.innerHeight)).toBeLessThanOrEqual(4);

  await page.screenshot({ path: '/tmp/gezel-home-workshop.png', fullPage: false });
});

test('narrow window keeps the conversation visible without a side rail', async () => {
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 20000 });

  // Drop to a 700px-wide window and confirm the single conversation column
  // remains inside the viewport.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.setContentSize(700, 900);
  });
  await page.waitForTimeout(800);

  const narrow = await page.evaluate(() => {
    const rect = (s: string) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
    };
    const body = document.querySelector('.home-workshop-body');
    const bodyStyle = body ? getComputedStyle(body) : null;
    return {
      conversation: rect('.home-workshop-conversation'),
      rail: rect('.home-workshop-rail'),
      bodyColumns: bodyStyle?.gridTemplateColumns ?? null,
    };
  });
  console.log('GEZEL_NARROW_START');
  console.log(JSON.stringify(narrow, null, 2));
  console.log('GEZEL_NARROW_END');

  expect(narrow.conversation).not.toBeNull();
  expect(narrow.rail).toBeNull();
  expect(narrow.bodyColumns?.split(' ')).toHaveLength(1);

  await page.screenshot({ path: '/tmp/gezel-home-workshop-narrow.png', fullPage: false });
});
