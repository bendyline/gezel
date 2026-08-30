import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Threaded chat timeline E2E — seeds a session whose shape reproduces
 * the wild-caught misreading this feature exists to fix: the
 * continuation loop appended trailing status bubbles ("Waiting for the
 * user to respond…") minutes after their real trigger, then the
 * Meester's scheduled check-in landed below them, and in the old flat
 * interleave the stragglers read as replies to the check-in.
 *
 * With threading, every user message (human turn or gezel→gezel
 * handoff) roots a thread and replies rail underneath it — so the spec
 * asserts containment, not adjacency: stragglers inside the first
 * thread, the check-in as a root of its own thread, its real replies
 * inside that thread's reply column.
 */
import { type ElectronApplication, type Page, expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { closeApp } from './helpers/close-app.js';
import { buildLaunchEnv } from './helpers/launch-env.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
const screenshotDir = join(_dirname, '..', 'screenshots');
const appRoot = join(_dirname, '..');

let gezelHome: string;
let app: ElectronApplication;
let page: Page;

/** Absolute ISO timestamp `minutes` after the scenario origin (now - 40min). */
function at(minutes: number, seconds = 0): string {
  const origin = Date.now() - 40 * 60_000;
  return new Date(origin + minutes * 60_000 + seconds * 1_000).toISOString();
}

async function seedHome(home: string): Promise<void> {
  const gezelDir = join(home, 'gezels', 'sofiya');
  const sessionsDir = join(gezelDir, 'sessions');
  const projectDir = join(home, 'projects', 'spanish-lang');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  await writeFile(
    join(gezelDir, 'gezel.md'),
    [
      '---',
      'id: sofiya',
      'name: "Sofiya"',
      'role: "Language Trainer"',
      '---',
      '',
      'A tutor.',
      '',
    ].join('\n'),
  );

  await writeFile(
    join(projectDir, 'project.json'),
    JSON.stringify(
      {
        id: 'spanish-lang',
        name: 'Spanish Lang',
        voormanGezelId: 'sofiya',
        gezelIds: ['sofiya'],
        createdAt: at(-1),
        updatedAt: at(0),
        // Keep the ambient scheduler quiet — a live nudge firing
        // mid-test would append a fresh check-in + mock reply and
        // race the DOM assertions below.
        nudgeConfig: { enabled: false },
      },
      null,
      2,
    ),
  );

  const messages = [
    { role: 'user', content: 'hey there', at: at(0) },
    {
      role: 'assistant',
      content: "Hola! Bienvenido! I'm so glad you're here — what's your name, and why Spanish?",
      at: at(2, 40),
    },
    {
      role: 'assistant',
      content:
        "From my perspective, I'm waiting for the user to respond to my greeting and question about their name.",
      at: at(2, 56),
    },
    // A "late" straggler: >3 min after the previous reply, so it keeps
    // its author header and gains a relative timestamp.
    {
      role: 'assistant',
      content: 'Waiting for the user to respond to my Spanish greeting.',
      at: at(13),
    },
    {
      role: 'user',
      content:
        "[Message from Yusuf]: Checking in on Spanish Lang. Compare current progress against the project's objectives.",
      at: at(17),
      from: { gezelId: 'yusuf', gezelName: 'Yusuf' },
    },
    {
      role: 'assistant',
      content:
        'I sent you a quick question card to confirm whether the Spanish Lang project is ready to be marked stable.',
      at: at(19),
    },
    {
      role: 'assistant',
      content: "From my perspective, the project is stable and waiting for the user's response.",
      at: at(19, 11),
    },
    { role: 'user', content: 'My name is Mike', at: at(21) },
    { role: 'assistant', content: 'Hola Mike! Encantado de conocerte!', at: at(21, 37) },
  ];

  await writeFile(
    join(sessionsDir, 'aaaaaaaa-1111-2222-3333-444444444444.json'),
    JSON.stringify(
      {
        version: 1,
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        gezelId: 'sofiya',
        projectId: 'spanish-lang',
        providerName: 'copilot',
        title: 'hey there',
        createdAt: at(0),
        lastActivityAt: at(21, 37),
        providerState: {},
        messages,
      },
      null,
      2,
    ),
  );
}

test.beforeAll(async () => {
  gezelHome = await mkdtemp(join(tmpdir(), 'gezel-thread-e2e-'));
  await seedHome(gezelHome);
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

test('replies thread under their trigger, not under the next check-in', async () => {
  test.setTimeout(60_000);
  // Open the seeded project's chat surface from the sidebar.
  await page.getByTestId('app-sidebar').getByText('Spanish Lang').first().click();
  await expect(page.locator('.chat-timeline').first()).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText('Waiting for the user to respond to my Spanish greeting.'),
  ).toBeVisible({ timeout: 20_000 });

  await page.screenshot({
    path: join(screenshotDir, 'thread-timeline-01.png'),
    fullPage: true,
  });
  // Second shot from the top of the scrollback — the first thread with
  // the greeting run and the late straggler is what the containment
  // assertions below are about.
  await page.evaluate(() => {
    const el = document.querySelector('.chat-timeline');
    if (el) el.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: join(screenshotDir, 'thread-timeline-02-top.png'),
    fullPage: true,
  });
  // Same view in dark mode — the reply rail and time cues must stay
  // legible on both canvases.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(300);
  await page.screenshot({
    path: join(screenshotDir, 'thread-timeline-03-dark.png'),
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  const structure = await page.evaluate(() => {
    const threads = Array.from(document.querySelectorAll('.chat-timeline .timeline-thread'));
    const threadOf = (text: string) =>
      threads.findIndex((t) => (t.textContent ?? '').includes(text));
    const straggler = 'Waiting for the user to respond to my Spanish greeting.';
    const checkin = 'Checking in on Spanish Lang';
    const checkinReply = 'question card';
    const greetingThread = threadOf('hey there');
    const stragglerThread = threadOf(straggler);
    const checkinThread = threadOf(checkin);
    const checkinReplyThread = threadOf(checkinReply);
    const nameThread = threadOf('My name is Mike');
    // The check-in bubble must be a thread ROOT (direct thread child),
    // not railed inside a reply column.
    const checkinBubble = Array.from(document.querySelectorAll('.msg-from-gezel')).find((el) =>
      (el.textContent ?? '').includes(checkin),
    );
    const checkinInsideReplies = checkinBubble
      ? checkinBubble.closest('.timeline-thread-replies') !== null
      : null;
    // Straggler containment: inside a reply column, railed.
    const stragglerBubble = Array.from(document.querySelectorAll('.msg-assistant')).find((el) =>
      (el.textContent ?? '').includes(straggler),
    );
    const stragglerReplies = stragglerBubble?.closest('.timeline-thread-replies') ?? null;
    const railWidth = stragglerReplies ? getComputedStyle(stragglerReplies).borderLeftWidth : null;
    // Header suppression: the first thread's reply column shows one
    // header for the greeting run, plus one for the late straggler.
    const firstThreadReplies = threads[greetingThread]?.querySelector('.timeline-thread-replies');
    const headerCount = firstThreadReplies?.querySelectorAll('.msg-role').length ?? -1;
    const stragglerHeaderText =
      stragglerBubble?.querySelector('.msg-role')?.textContent ?? '(none)';
    const rootHeaderText =
      threads[greetingThread]?.querySelector('.msg-user .msg-role')?.textContent ?? '(none)';
    return {
      threadCount: threads.length,
      greetingThread,
      stragglerThread,
      checkinThread,
      checkinReplyThread,
      nameThread,
      checkinInsideReplies,
      railWidth,
      headerCount,
      stragglerHeaderText,
      rootHeaderText,
    };
  });

  console.log('thread structure:', JSON.stringify(structure, null, 2));

  // Three turns → three threads.
  expect(structure.threadCount).toBeGreaterThanOrEqual(3);
  // The stragglers live in the SAME thread as their real trigger…
  expect(structure.stragglerThread).toBe(structure.greetingThread);
  // …which renders before the check-in's own thread.
  expect(structure.greetingThread).toBeLessThan(structure.checkinThread);
  // The check-in is a root, and its real replies are in its thread.
  expect(structure.checkinInsideReplies).toBe(false);
  expect(structure.checkinReplyThread).toBe(structure.checkinThread);
  expect(structure.nameThread).toBeGreaterThan(structure.checkinThread);
  // Chromium snaps borders to physical pixels, so a declared 2px rail can
  // compute to a fractional CSS width at non-integer display scale factors.
  expect(Number.parseFloat(structure.railWidth ?? '0')).toBeCloseTo(2, 0);
  // Author-run header suppression: greeting header + late straggler
  // header — the 16s follow-up merges into the greeting's run.
  expect(structure.headerCount).toBe(2);
  // Late replies and thread roots carry the relative-time cue.
  expect(structure.stragglerHeaderText).toContain('ago');
  expect(structure.rootHeaderText).toContain('ago');
});
