/**
 * The capture worker: a child process of the daemon and the only code that
 * points a browser at live web pages. One worker serves one capture session
 * (one sync pass) and is killed when the session ends or is stopped.
 *
 * Rules this file keeps, each enforced in code rather than by convention:
 * - Chromium's own sandbox is on (`chromiumSandbox: true`); a launch that
 *   cannot start sandboxed fails, it is never retried without the sandbox.
 * - All traffic goes through the daemon's filter proxy; the seeded profile
 *   turns off non-proxied UDP (WebRTC) and QUIC is disabled by flag.
 * - The page receives no input of any kind. A unit test scans this file and
 *   fails if a pointer or key API appears (page-capture/no-input.test.ts).
 * - Navigations are GET only; a main-frame navigation out of the site's scope,
 *   or any after the page settled, is aborted. Popups are closed, dialogs
 *   dismissed, downloads refused, no permission granted.
 *
 * Protocol (IPC, both directions JSON): see `WorkerRequest` / `WorkerReply`.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { type SiteScope, scopeOfUrl } from '@bendyline/gezel';
import type { BrowserContext, CDPSession, Page, Request, Response, Route } from 'playwright-core';
import {
  EXTRACT_SCRIPT,
  FINALIZE_SCRIPT,
  HIDE_OVERLAYS_SCRIPT,
  PREPARE_SCRIPT,
} from './extract-page.js';
import type { CaptureFailure, CapturedFile, PageCaptureOutcome, PageMetadata } from './types.js';

export type WorkerRequest =
  | {
      type: 'open';
      executablePath: string;
      proxyServer: string;
      profileDir: string;
      storageState?: unknown;
      allowScriptPost: boolean;
      signedIn: boolean;
      /** A visible window a person drives (sign-in). Captures never use it. */
      headed?: boolean;
      /** Headed only: where the window opens. */
      startUrl?: string;
      /** Headed only: the host the person is signing in to, shown first. */
      signInHost?: string;
    }
  | {
      type: 'capture';
      id: number;
      url: string;
      screenshots: number;
      maxImages: number;
      stagingDir: string;
      scopes: SiteScope[];
      pageTimeoutMs: number;
    }
  | { type: 'storage-state'; id: number }
  | { type: 'current-url'; id: number }
  | { type: 'close' };

export type WorkerReply =
  | { type: 'opened'; version: string; sandboxVerified: boolean }
  | { type: 'open-failed'; message: string }
  | { type: 'result'; id: number; outcome: PageCaptureOutcome }
  | { type: 'storage-state'; id: number; state?: unknown }
  | { type: 'current-url'; id: number; url?: string }
  | { type: 'window-closed' };

const VIEWPORT = { width: 1280, height: 900 } as const;
const TILE_HEIGHT = 1600;
const MAX_SCREENSHOT_PAGE_HEIGHT = 20_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_LINKS = 600;
const QUIET_MS = 600;
const QUIET_CAP_MS = 6_000;

/** Bot checks and challenge pages, by title. */
const CHALLENGE_TITLE =
  /just a moment|attention required|access denied|are you a (ro)?bot|verify (that )?you are (a )?human|security check|please wait|captcha|checking your browser|request blocked|pardon our interruption/i;

/** Profile preferences every capture browser starts from. */
const SEEDED_PREFERENCES = {
  webrtc: {
    ip_handling_policy: 'disable_non_proxied_udp',
    multiple_routes_enabled: false,
    nonproxied_udp_enabled: false,
  },
  credentials_enable_service: false,
  profile: { password_manager_enabled: false },
  autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
  safebrowsing: { enabled: false },
  translate: { enabled: false },
  download: { prompt_for_download: false },
} as const;

const LAUNCH_ARGS = [
  '--disable-quic',
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  '--dns-prefetch-disable',
  '--disable-sync',
  '--no-pings',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-background-networking',
  '--js-flags=--max-old-space-size=1024',
];

let context: BrowserContext | null = null;
let browserVersion = '';
let allowScriptPost = false;
const ownPages = new WeakSet<Page>();
/**
 * Pages the worker itself is opening right now. Playwright announces a new
 * page before `newPage()` returns, so without this the popup rule below would
 * close the worker's own page.
 */
let openingOwnPages = 0;

async function newOwnPage(ctx: BrowserContext): Promise<Page> {
  openingOwnPages++;
  try {
    const page = await ctx.newPage();
    ownPages.add(page);
    return page;
  } finally {
    openingOwnPages--;
  }
}
let readabilitySource: string | null = null;

function send(msg: WorkerReply): void {
  process.send?.(msg);
}

async function readability(): Promise<string> {
  if (readabilitySource !== null) return readabilitySource;
  const require = createRequire(import.meta.url);
  readabilitySource = await readFile(
    require.resolve('@mozilla/readability/Readability.js'),
    'utf8',
  );
  return readabilitySource;
}

async function open(req: Extract<WorkerRequest, { type: 'open' }>): Promise<void> {
  mkdirSync(join(req.profileDir, 'Default'), { recursive: true });
  writeFileSync(join(req.profileDir, 'Default', 'Preferences'), JSON.stringify(SEEDED_PREFERENCES));
  allowScriptPost = req.allowScriptPost;
  const { chromium } = await import('playwright-core');
  const headed = req.headed === true;
  const ctx = await chromium.launchPersistentContext(req.profileDir, {
    headless: !headed,
    executablePath: req.executablePath,
    chromiumSandbox: true,
    proxy: { server: req.proxyServer },
    viewport: headed ? null : VIEWPORT,
    deviceScaleFactor: headed ? undefined : 1,
    acceptDownloads: false,
    permissions: [],
    serviceWorkers: 'block',
    ignoreHTTPSErrors: false,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: headed
      ? [...LAUNCH_ARGS, '--window-size=1100,800', '--disable-blink-features=AutomationControlled']
      : LAUNCH_ARGS,
    ...(headed ? { ignoreDefaultArgs: ['--enable-automation'] } : {}),
  });
  context = ctx;
  browserVersion = ctx.browser()?.version() ?? '';
  if (req.storageState) {
    await ctx.setStorageState(req.storageState as Parameters<BrowserContext['setStorageState']>[0]);
  }
  ctx.on('page', (p) => {
    p.on('dialog', (d) => void d.dismiss().catch(() => {}));
    // Popups and new tabs a page opens are closed; a headed sign-in window
    // keeps its tabs, since the person drives it.
    if (!headed && openingOwnPages === 0 && !ownPages.has(p)) void p.close().catch(() => {});
  });
  ctx.on('close', () => {
    if (headed) send({ type: 'window-closed' });
  });
  // A person drives the sign-in window; the capture rules are for pages no
  // one is watching. The filter proxy still carries every request.
  if (!headed) await ctx.route('**/*', (route) => routeRequest(route, req.signedIn));

  const sandboxVerified = headed ? true : await verifySandbox(ctx);
  if (!headed && sandboxVerified === false) {
    throw new Error('the browser started without its sandbox');
  }
  if (headed) {
    const existing = ctx.pages()[0];
    const page = existing ?? (await newOwnPage(ctx));
    ownPages.add(page);
    if (req.signInHost) {
      await page.setContent(signInIntroHtml(req.signInHost)).catch(() => {});
      await page.waitForTimeout(2_500);
    }
    if (req.startUrl)
      await page.goto(req.startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  send({ type: 'opened', version: browserVersion, sandboxVerified: sandboxVerified !== null });
}

/**
 * Confirm the renderers run sandboxed, where Chromium can say so. True when
 * confirmed, false when it reports a renderer outside the sandbox, null where
 * the page does not exist (macOS) — the launch itself asked for the sandbox.
 */
async function verifySandbox(ctx: BrowserContext): Promise<boolean | null> {
  if (process.platform !== 'win32' && process.platform !== 'linux') return null;
  const page = await newOwnPage(ctx);
  try {
    await page.goto('chrome://sandbox', { timeout: 10_000 });
    const text = await page.locator('body').innerText({ timeout: 5_000 });
    const rendererRows = text.split('\n').filter((l) => /\bRenderer\b/.test(l));
    if (rendererRows.length === 0) return null;
    return !rendererRows.some((l) => /not sandboxed/i.test(l));
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

interface PageState {
  settled: boolean;
  scopes: SiteScope[];
  inflight: number;
  lastActivity: number;
  images: Map<string, Response>;
}
const pageStates = new WeakMap<Page, PageState>();

async function routeRequest(route: Route, signedIn: boolean): Promise<void> {
  const request = route.request();
  const method = request.method().toUpperCase();
  const headers = request.headers();
  // Speculative loads (prefetch/prerender) are never needed for a capture.
  if (headers['sec-purpose'] || headers.purpose === 'prefetch')
    return route.abort('blockedbyclient');
  let frame: ReturnType<Request['frame']>;
  try {
    frame = request.frame();
  } catch {
    // A worker's request has no frame; it still goes through the proxy.
    if (method !== 'GET' && method !== 'HEAD' && (!allowScriptPost || signedIn)) {
      return route.abort('blockedbyclient');
    }
    return route.continue();
  }
  const page = frame.page();
  const state = pageStates.get(page);
  if (request.isNavigationRequest()) {
    if (method !== 'GET' && method !== 'HEAD') return route.abort('blockedbyclient');
    if (frame === page.mainFrame() && state) {
      if (state.settled) return route.abort('blockedbyclient');
      if (state.scopes.length > 0 && !scopeOfUrl(request.url(), state.scopes)) {
        return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  }
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (!allowScriptPost || signedIn) return route.abort('blockedbyclient');
  }
  return route.continue();
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function failure(
  kind: CaptureFailure['kind'],
  message: string,
  extra: Partial<CaptureFailure> = {},
): CaptureFailure {
  return { ok: false, kind, message, ...extra };
}

async function waitQuiet(page: Page, state: PageState, capMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    if (state.inflight <= 0 && Date.now() - state.lastActivity >= QUIET_MS) return;
    await page.waitForTimeout(150);
  }
}

async function isolatedWorld(
  page: Page,
): Promise<{ cdp: CDPSession; run: <T>(expr: string) => Promise<T> }> {
  if (!context) throw new Error('no browser');
  const cdp = await context.newCDPSession(page);
  const tree = (await cdp.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
  const { executionContextId } = (await cdp.send('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: 'gezel-capture',
  })) as { executionContextId: number };
  const run = async <T>(expression: string): Promise<T> => {
    const r = (await cdp.send('Runtime.evaluate', {
      expression,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'script error',
      );
    }
    return r.result.value as T;
  };
  return { cdp, run };
}

function imageExtension(contentType: string): string | null {
  const ct = contentType.toLowerCase();
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('avif')) return 'avif';
  return null;
}

function stripTagsForCheck(html: string): string {
  return html
    .slice(0, 2_000_000)
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

async function htmlToMarkdown(html: string): Promise<string> {
  const mod = (await import('@bendyline/squisq-formats')) as unknown as {
    htmlToMarkdown?: (html: string, opts?: { headMetadata?: boolean }) => unknown;
  };
  if (typeof mod.htmlToMarkdown !== 'function') return html.replace(/<[^>]+>/g, ' ');
  const out = mod.htmlToMarkdown(html, { headMetadata: false });
  const text = typeof out === 'string' ? out : ((out as { markdown?: string })?.markdown ?? '');
  // A line break with nothing before it converts to a lone backslash.
  return text
    .replace(/^\\[ \t]*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface ExtractResult {
  url: string;
  metadata: PageMetadata;
  method: 'readability' | 'landmark' | 'body' | 'none';
  hiddenElements: number;
  images: { key: string; src: string; alt: string }[];
  links: { href: string; text: string }[];
  mainChars: number;
  visibleChars: number;
  passwordField: boolean;
  textSample: string;
}

async function capture(
  req: Extract<WorkerRequest, { type: 'capture' }>,
): Promise<PageCaptureOutcome> {
  if (!context) return failure('unavailable', 'The browser is not running.');
  mkdirSync(req.stagingDir, { recursive: true });
  const page = await newOwnPage(context);
  const state: PageState = {
    settled: false,
    scopes: req.scopes,
    inflight: 0,
    lastActivity: Date.now(),
    images: new Map(),
  };
  pageStates.set(page, state);
  const touch = () => {
    state.lastActivity = Date.now();
  };
  page.on('request', () => {
    state.inflight++;
    touch();
  });
  const done = (r: Request) => {
    state.inflight = Math.max(0, state.inflight - 1);
    touch();
    void r;
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  page.on('response', (r) => {
    if (r.request().resourceType() === 'image' && state.images.size < 400)
      state.images.set(r.url(), r);
  });
  try {
    let response: Response | null;
    try {
      response = await page.goto(req.url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(5_000, Math.floor(req.pageTimeoutMs * 0.5)),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      if (/ERR_BLOCKED_BY_CLIENT/.test(message)) {
        return failure('left-scope', 'The address redirected outside the site.');
      }
      if (
        /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED/.test(
          message,
        )
      ) {
        return failure(
          'failed',
          'The site could not be reached (or it points at a private address).',
        );
      }
      return failure('failed', `The page did not load: ${message.slice(0, 160)}`);
    }
    if (!response) return failure('failed', 'The page sent no response.');
    const status = response.status();
    const finalUrl = page.url();
    const headers = response.headers();
    if (status === 404 || status === 410)
      return failure('gone', 'The site says this page no longer exists.', { status, finalUrl });
    if (status === 429 || status === 503) {
      const retry = Number(headers['retry-after']);
      return failure('rate-limited', 'The site asked us to slow down.', {
        status,
        finalUrl,
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSec: Math.min(retry, 86_400) } : {}),
      });
    }
    if (status === 401 || status === 403) {
      return failure(
        'blocked',
        'The site refused the visit (it may need a sign-in or block automated browsers).',
        { status, finalUrl },
      );
    }
    if (status >= 400)
      return failure('failed', `The site answered with an error (${status}).`, {
        status,
        finalUrl,
      });
    const contentType = (headers['content-type'] ?? '').toLowerCase();
    if (contentType && !contentType.includes('html')) {
      return failure('not-a-page', 'This address is a file, not a web page.', { status, finalUrl });
    }
    if (req.scopes.length > 0 && !scopeOfUrl(finalUrl, req.scopes)) {
      return failure('left-scope', 'The address redirected outside the site.', {
        status,
        finalUrl,
      });
    }
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await waitQuiet(page, state, QUIET_CAP_MS);

    const { cdp, run } = await isolatedWorld(page);
    try {
      await run(PREPARE_SCRIPT);
      await page.waitForTimeout(400);
      await waitQuiet(page, state, 3_000);
      state.settled = true;
      await run(HIDE_OVERLAYS_SCRIPT);
      await run(await readability());
      const ex = await run<ExtractResult>(
        `${EXTRACT_SCRIPT}(${JSON.stringify({ maxLinks: MAX_LINKS })})`,
      );

      // A bot check or a sign-in wall in place of the page.
      const title = ex.metadata.title ?? '';
      if (CHALLENGE_TITLE.test(title) && ex.mainChars < 1500) {
        return failure('blocked', 'The site showed a bot check instead of the page.', {
          status,
          finalUrl,
        });
      }
      if (ex.passwordField && ex.mainChars < 600) {
        return failure('blocked', 'The site asked for a sign-in instead of showing the page.', {
          status,
          finalUrl,
        });
      }

      // Content images the browser already received.
      const images: (CapturedFile & { alt: string; src: string })[] = [];
      const saved: Record<string, string> = {};
      for (const img of ex.images) {
        if (images.length >= req.maxImages) break;
        const resp = state.images.get(img.src);
        if (!resp) continue;
        const ext = imageExtension(resp.headers()['content-type'] ?? '');
        if (!ext) continue;
        const body = await resp.body().catch(() => null);
        if (!body || body.length === 0 || body.length > MAX_IMAGE_BYTES) continue;
        const name = `figure-${images.length + 1}.${ext}`;
        const path = join(req.stagingDir, name);
        await writeFile(path, body);
        images.push({
          path,
          name,
          sha256: sha256(body),
          size: body.length,
          alt: img.alt,
          src: img.src,
        });
        saved[img.key] = name;
      }
      const html = await run<string>(`${FINALIZE_SCRIPT}(${JSON.stringify(saved)})`);
      const markdown = await htmlToMarkdown(html);
      const words = markdown
        .replace(/\]\([^)]*\)/g, ']')
        .split(/\s+/)
        .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

      // Screenshots: the first screen, then tiles further down.
      const screenshots: CapturedFile[] = [];
      if (req.screenshots > 0) {
        const first = await page.screenshot({ type: 'jpeg', quality: 70 });
        const name = 'view-1.jpg';
        await writeFile(join(req.stagingDir, name), first);
        screenshots.push({
          path: join(req.stagingDir, name),
          name,
          sha256: sha256(first),
          size: first.length,
        });
        const height = Math.min(
          await run<number>(
            'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)',
          ),
          MAX_SCREENSHOT_PAGE_HEIGHT,
        );
        for (let i = 1; i < req.screenshots; i++) {
          const y = VIEWPORT.height + (i - 1) * TILE_HEIGHT;
          if (y >= height - 200) break;
          const tile = await page.screenshot({
            type: 'jpeg',
            quality: 70,
            fullPage: true,
            clip: { x: 0, y, width: VIEWPORT.width, height: Math.min(TILE_HEIGHT, height - y) },
          });
          const tileName = `page-${i + 1}.jpg`;
          await writeFile(join(req.stagingDir, tileName), tile);
          screenshots.push({
            path: join(req.stagingDir, tileName),
            name: tileName,
            sha256: sha256(tile),
            size: tile.length,
          });
        }
      }

      let staticText = false;
      if (ex.textSample.length >= 20) {
        const raw = await response.text().catch(() => '');
        staticText = raw.length > 0 && stripTagsForCheck(raw).includes(ex.textSample);
      }
      const method = ex.method === 'none' ? 'body' : ex.method;
      return {
        ok: true,
        finalUrl,
        status,
        render: 'browser',
        metadata: ex.metadata,
        markdown,
        method,
        words,
        links: ex.links,
        screenshots,
        images,
        hiddenElements: ex.hiddenElements,
        ...(ex.passwordField ? { passwordField: true } : {}),
        ...(headers.etag ? { etag: headers.etag } : {}),
        ...(headers['last-modified'] ? { lastModified: headers['last-modified'] } : {}),
        staticText,
      };
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    return failure('failed', `The page could not be read: ${message.slice(0, 160)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The first thing the sign-in window shows: who opened it and where it goes. */
function signInIntroHtml(host: string): string {
  return `<!doctype html><title>Gezel sign-in</title><body style="font:16px system-ui;margin:48px;max-width:640px;color:#222">
<h1 style="font-size:22px">Sign in to ${escapeHtml(host)}</h1>
<p>Gezel opened this window so you can sign in to <b>${escapeHtml(host)}</b>. Check the address bar before you type a password: it should show ${escapeHtml(host)} or the sign-in service that site uses.</p>
<p>When you are signed in, go back to Gezel and press <b>Done</b>. Gezel saves the sign-in for this connection only and never reads your password.</p>
</body>`;
}

let closing = false;
async function shutdown(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  const ctx = context;
  context = null;
  await ctx?.close().catch(() => {});
  process.exit(code);
}

process.on('message', (raw: unknown) => {
  const msg = raw as WorkerRequest;
  void (async () => {
    switch (msg.type) {
      case 'open':
        try {
          await open(msg);
        } catch (err) {
          const message =
            err instanceof Error ? err.message.split('\n').slice(0, 3).join(' ') : String(err);
          send({ type: 'open-failed', message: message.slice(0, 600) });
        }
        return;
      case 'capture':
        send({ type: 'result', id: msg.id, outcome: await capture(msg) });
        return;
      case 'storage-state': {
        const state = await context?.storageState({ indexedDB: true }).catch(() => undefined);
        send({ type: 'storage-state', id: msg.id, ...(state ? { state } : {}) });
        return;
      }
      case 'current-url': {
        const pages = context?.pages() ?? [];
        const url = pages.length > 0 ? pages[pages.length - 1]!.url() : undefined;
        send({ type: 'current-url', id: msg.id, ...(url ? { url } : {}) });
        return;
      }
      case 'close':
        await shutdown(0);
        return;
    }
  })();
});
process.on('disconnect', () => void shutdown(0));
