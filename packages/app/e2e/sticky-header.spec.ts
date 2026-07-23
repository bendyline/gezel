/**
 * Sticky header alignment — regression + visual test.
 *
 * When the user scrolls past the first assistant bubble in a chat, the
 * `.chat-sticky-header` element pins to the top of the scroll viewport.
 * Its left/right edges MUST line up with a max-width chat bubble
 * (`.msg` caps at 92% of `.chat-timeline`'s content width). Historically
 * this has drifted by the timeline's horizontal padding (~12px) and by
 * the user-message / assistant-message lane asymmetry — this spec
 * measures the two bounding rects and asserts pixel alignment, AND
 * captures a screenshot so the visual is inspectable when the numbers
 * still pass but it "feels off".
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-sticky-e2e-'));
  app = await electron.launch({
    args: [appRoot],
    env: buildLaunchEnv({
      GEZEL_HOME: gezelHome,
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_EMBEDDED: '1',
      // This visual layout spec sends twelve deliberately long messages.
      // Mock memory extraction echoes its prompt and creates a large batch of
      // irrelevant writes, which can keep graceful shutdown alive past the
      // afterAll budget. Memory behavior is orthogonal to sticky positioning.
      GEZEL_DISABLE_MEMORY_EXTRACTION: '1',
    }),
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);
  // Home is fine — the Meester chat is the simplest surface to drive.
  // Home is the brand mark in the status header.
  await page.locator('.app-header-brand').click();
  await page.waitForTimeout(800);
});

test.afterAll(async () => {
  await app?.close();
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('sticky header does NOT show while the bubble header is visible', async () => {
  // Send a few messages so there's enough content for the sticky to
  // potentially trigger. Then scroll to a position where an
  // assistant bubble is almost — but not quite — off the top. The
  // sticky should stay hidden because the real bubble header is
  // still peeking into view.
  const editor = page.locator('.squisq-wysiwyg-editor').first();
  for (let i = 0; i < 4; i++) {
    await editor.click();
    await page.keyboard.type(`Setup msg ${i + 1}: lorem ipsum dolor sit amet, ${'x'.repeat(80)}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
  }
  // Position a middle assistant bubble so its top sits ~25 px BELOW
  // the timeline's visible top — header fully visible, bubble not
  // occluded.
  await page.evaluate(() => {
    const timeline = document.querySelector('.chat-timeline') as HTMLElement | null;
    if (!timeline) return;
    const bubbles = Array.from(
      timeline.querySelectorAll<HTMLElement>('.msg-from-gezel, .msg-assistant'),
    );
    const target = bubbles[Math.max(0, Math.floor(bubbles.length / 2))];
    if (!target) return;
    const timelineRect = timeline.getBoundingClientRect();
    const bubbleRect = target.getBoundingClientRect();
    // Push the bubble down so its top is 25 px below timeline top.
    const delta = bubbleRect.top - timelineRect.top - 25;
    timeline.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
  });
  await page.waitForTimeout(500);
  await page.screenshot({
    path: join(screenshotDir, 'sticky-02-no-trigger.png'),
    fullPage: true,
  });
  const stickyVisible = await page
    .locator('.chat-sticky-header')
    .first()
    .isVisible()
    .catch(() => false);
  expect(stickyVisible).toBe(false);
});

test('sticky header aligns with chat bubbles', async () => {
  // 8 turns × ~2s each = 16s of waitForTimeout alone, plus
  // message-send, render, scroll, and screenshot — comfortably past
  // Playwright's default 30s budget. Bumped to 60s with the same
  // generosity tabs.spec.ts uses for its multi-launch flow.
  test.setTimeout(60_000);
  // Send enough messages to create vertical overflow so the sticky can
  // actually trigger on scroll. Each mock reply is short; we pad the
  // user message with filler so the bubble is tall.
  const editor = page.locator('.squisq-wysiwyg-editor').first();
  for (let i = 0; i < 8; i++) {
    await editor.click();
    const filler = [
      `Turn ${i + 1}:`,
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
      'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris',
      'nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in',
      'reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla',
      'pariatur. Excepteur sint occaecat cupidatat non proident, sunt in',
      'culpa qui officia deserunt mollit anim id est laborum.',
    ].join(' ');
    await page.keyboard.type(filler);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
  }

  await page.screenshot({
    path: join(screenshotDir, 'sticky-00-before-scroll.png'),
    fullPage: true,
  });

  // Scroll to a point where an assistant bubble is actively occluded
  // by the top of the timeline — its top above the sticky band line,
  // its bottom still below it. Pick a tall bubble in the middle of the
  // conversation and scroll so its top sits ~40px above the timeline's
  // visible top edge.
  await page.evaluate(() => {
    const timeline = document.querySelector('.chat-timeline') as HTMLElement | null;
    if (!timeline) return;
    const bubbles = Array.from(
      timeline.querySelectorAll<HTMLElement>('.msg-from-gezel, .msg-assistant'),
    );
    // Pick the middle assistant bubble — guaranteed both prior user
    // messages above and later content below.
    const target = bubbles[Math.max(0, Math.floor(bubbles.length / 2))];
    if (!target) return;
    const timelineRect = timeline.getBoundingClientRect();
    const bubbleRect = target.getBoundingClientRect();
    // Put the bubble's top 40px ABOVE the timeline's top (so the
    // band line falls well inside the bubble). Positive scrollBy moves
    // content up = bubble top moves up toward negative. We want the
    // new top = timelineRect.top - 40, which means scroll down by
    // (bubble.top - (timeline.top - 40)).
    const delta = bubbleRect.top - timelineRect.top + 40;
    timeline.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
  });
  await page.waitForTimeout(700);

  await page.screenshot({
    path: join(screenshotDir, 'sticky-01-scrolled.png'),
    fullPage: true,
  });

  // Measure sticky + assistant-bubble rects and assert alignment.
  // The sticky is the topper for the *assistant* message the user
  // scrolled past, so that's the bubble type we compare against.
  // User bubbles right-align and intentionally won't match.
  const alignment = await page.evaluate(() => {
    const sticky = document.querySelector('.chat-sticky-header') as HTMLElement | null;
    const bubbles = Array.from(
      document.querySelectorAll('.chat-timeline .msg-from-gezel, .chat-timeline .msg-assistant'),
    ) as HTMLElement[];
    if (!sticky)
      return { ok: false, reason: 'no sticky element on screen', bubbles: bubbles.length };
    let widest: HTMLElement | null = null;
    let widestWidth = 0;
    for (const b of bubbles) {
      const r = b.getBoundingClientRect();
      if (r.width > widestWidth) {
        widestWidth = r.width;
        widest = b;
      }
    }
    if (!widest) return { ok: false, reason: 'no assistant bubbles', bubbles: bubbles.length };
    const stickyRect = sticky.getBoundingClientRect();
    const bubbleRect = widest.getBoundingClientRect();
    return {
      ok: true,
      sticky: {
        left: stickyRect.left,
        right: stickyRect.right,
        width: stickyRect.width,
      },
      bubble: {
        left: bubbleRect.left,
        right: bubbleRect.right,
        width: bubbleRect.width,
      },
      bubbles: bubbles.length,
    };
  });

  console.log('alignment:', JSON.stringify(alignment, null, 2));

  expect(alignment.ok).toBe(true);
  if (!alignment.ok || !alignment.sticky || !alignment.bubble) return;

  // Pixel-level tolerance: sub-pixel fractional widths + anti-aliasing
  // round to 1px at worst. Anything beyond that is a real drift.
  const leftDelta = Math.abs(alignment.sticky.left - alignment.bubble.left);
  const rightDelta = Math.abs(alignment.sticky.right - alignment.bubble.right);
  const widthDelta = Math.abs(alignment.sticky.width - alignment.bubble.width);
  console.log('deltas:', { leftDelta, rightDelta, widthDelta });
  expect(leftDelta).toBeLessThanOrEqual(1);
  expect(rightDelta).toBeLessThanOrEqual(1);
  expect(widthDelta).toBeLessThanOrEqual(1);
});
