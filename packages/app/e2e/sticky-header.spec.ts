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
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';
import { captureScreenshot } from './helpers/screenshot.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

async function openMeesterChat() {
  const brand = page.getByRole('button', { name: 'Meester home' });
  await expect(brand).toBeVisible({ timeout: 20_000 });
  await brand.click();
  await expect(page.getByTestId('home-workshop')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: 20_000 });
}

/**
 * A session's first user turn runs auto-recall (`ChatManager.tryAutoRecall`),
 * which cold-loads the fp32 sentence-transformer on CPU while the shared
 * library project is still doing its boot-time index — and auto-recall
 * searches that library for every session regardless of project. Measured
 * on an M-series laptop: turn 1 costs ~41s, turns 2-4 cost 44/91/35ms.
 * Budget the two cases separately rather than raising every wait, so the
 * warm turns keep a tight bound and a real streaming regression still
 * fails fast instead of hiding inside a blanket timeout.
 */
const COLD_FIRST_REPLY_MS = 120_000;
const WARM_REPLY_MS = 15_000;

async function sendAndWaitForReply(
  message: string,
  replyMarker: string,
  replyTimeout: number = WARM_REPLY_MS,
) {
  const composer = page.getByTestId('chat-composer');
  const editor = composer.locator('.squisq-wysiwyg-editor');
  const timeline = page.getByTestId('chat-timeline');

  await editor.click();
  await editor.fill(message);
  await editor.press('Shift+Enter');
  const reply = timeline
    .locator('.msg-from-gezel, .msg-assistant')
    .filter({ hasText: 'Mock reply:' })
    .filter({ hasText: replyMarker })
    .last();
  await expect(reply).toBeVisible({ timeout: replyTimeout });
  await expect(composer.getByTestId('chat-send')).toBeVisible({ timeout: WARM_REPLY_MS });
}

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
});

test.beforeEach(async () => {
  // Each assertion targets the Meester conversation, so establish that
  // surface explicitly instead of relying on whichever view was selected
  // by the preceding test or a background navigation event.
  await openMeesterChat();
});

test.afterAll(async () => {
  await closeApp(app);
  await rm(gezelHome, { recursive: true, force: true }).catch(() => {});
});

test('sticky header does NOT show while the bubble header is visible', async () => {
  // Absorbs the one-time cold auto-recall described above; the config
  // default of 30s cannot cover a turn that legitimately costs ~41s.
  test.setTimeout(180_000);
  // Send a few messages so there's enough content for the sticky to
  // potentially trigger. Then scroll to a position where an
  // assistant bubble is almost — but not quite — off the top. The
  // sticky should stay hidden because the real bubble header is
  // still peeking into view.
  for (let i = 0; i < 4; i++) {
    const marker = `Setup msg ${i + 1}:`;
    await sendAndWaitForReply(
      `${marker} lorem ipsum dolor sit amet, ${'x'.repeat(80)}`,
      marker,
      i === 0 ? COLD_FIRST_REPLY_MS : WARM_REPLY_MS,
    );
  }
  // Position a middle assistant bubble so its top sits ~25 px BELOW
  // the timeline's visible top — header fully visible, bubble not
  // occluded.
  const timeline = page.getByTestId('chat-timeline');
  const assistantBubbles = timeline.locator('.msg-from-gezel, .msg-assistant');
  await expect(assistantBubbles).toHaveCount(4);
  const target = assistantBubbles.nth(Math.floor((await assistantBubbles.count()) / 2));

  // Explicitly leave auto-follow before applying the precise position.
  // Waiting for the pin toggle proves React has processed the scroll and
  // prevents a pending row-growth effect from snapping the timeline back
  // to the bottom after the test has measured it.
  await timeline.evaluate((el) => {
    el.scrollBy({ top: -100, behavior: 'instant' as ScrollBehavior });
  });
  await expect(page.getByRole('button', { name: 'Jump to newest and follow' })).toBeVisible();

  await target.evaluate((bubble) => {
    const timeline = bubble.closest<HTMLElement>('.chat-timeline');
    if (!timeline) throw new Error('assistant bubble is not inside the chat timeline');
    const delta = bubble.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 25;
    timeline.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
  });

  // Assert the precondition instead of assuming a fixed sleep left the
  // bubble where the test put it. This also gives a useful geometry failure
  // if a future layout change makes the requested position unreachable.
  await expect
    .poll(() =>
      target.evaluate((bubble) => {
        const timeline = bubble.closest<HTMLElement>('.chat-timeline');
        if (!timeline) throw new Error('assistant bubble is not inside the chat timeline');
        return bubble.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
      }),
    )
    .toBeCloseTo(25, 0);

  await expect(page.locator('.chat-sticky-header')).toBeHidden();
  await captureScreenshot(page, {
    path: join(screenshotDir, 'sticky-02-no-trigger.png'),
    fullPage: true,
  });
});

test('sticky header aligns with chat bubbles', async () => {
  // Four long turns are enough to overflow the timeline at the test viewport.
  // Keep this fixture below Chromium's per-origin connection limit: mock
  // replies finish so quickly that the prior finite SSE response may still be
  // retiring when the next turn starts, unlike a real model-paced chat.
  test.setTimeout(180_000);
  // Send enough messages to create vertical overflow so the sticky can
  // actually trigger on scroll. The mock echoes each padded user message,
  // producing a tall user/assistant pair per turn.
  for (let i = 0; i < 4; i++) {
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
    await sendAndWaitForReply(
      filler,
      `Turn ${i + 1}:`,
      i === 0 ? COLD_FIRST_REPLY_MS : WARM_REPLY_MS,
    );
  }

  await captureScreenshot(page, {
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

  await captureScreenshot(page, {
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
