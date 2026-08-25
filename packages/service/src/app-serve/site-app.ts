import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { PageApiBootstrap } from '@bendyline/gezel';
import {
  AppServeChatSendRequestSchema,
  InvokePageToolRequestSchema,
  PageReadRequestSchema,
  createLogger,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChatEventBus } from '../chat/events.js';
import type { ChatManager } from '../chat/manager.js';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { mimeTypeForPath } from '../http/mime.js';
import {
  PAGE_READ_MAX_BYTES,
  invokePageTool,
  readPageData,
  resolveScopedPageFile,
} from '../http/page-io.js';
import { previewContentSecurityPolicy } from '../http/routes/preview.js';
import { preparePreviewHtml } from '../http/routes/preview.js';
import { resolvePageTools, resolveProjectTypeManifest } from '../project-type/script-tools.js';
import { createTenantLimiter } from '../remotes/tenant-limits.js';
import type { ScriptRunner } from '../scripts/runner.js';
import {
  VISITOR_CHAT_MESSAGE_CAP,
  engagementBlocked,
  ensureVisitorChatSession,
  projectVisitorEvent,
} from './chat.js';
import type { VisitorRecord, VisitorStore } from './visitors.js';
import { readCookie, visitorCookieHeader, visitorCookieName } from './visitors.js';

const log = createLogger('app-serve');

export const APP_SERVE_MARKER_HEADER = 'x-gezel-app-serve';

/** Whole-site concurrent request ceiling (all classes combined). */
const SITE_MAX_INFLIGHT = 32;
/** Site-wide sliding-minute budgets per request class. */
const SITE_WINDOW_BUDGETS = { invoke: 120, read: 1_200, page: 1_200, chat: 30 } as const;
/** Concurrent visitor chat turns, site-wide — this is real GPU spend. */
const SITE_MAX_CHAT_TURNS = 2;
/** Concurrent SSE streams per visitor. */
const VISITOR_MAX_STREAMS = 2;

export interface AppServeSiteDeps {
  store: Store;
  catalog: CatalogService;
  chat: ChatManager;
  chatEvents: ChatEventBus;
  history: HistoryManager;
  scriptRunner: ScriptRunner;
}

/** The mutable per-site state the controller owns and the app reads. */
export interface AppServeSiteRuntime {
  siteId: string;
  projectId: string;
  chat: boolean;
  public: boolean;
  /** Lowercased hostnames accepted by the Host check (beyond loopback + bound IP). */
  allowedHosts: string[];
  boundHost: string;
  /** Getter so key rotation needs no app rebuild. */
  siteKey: () => string;
  visitors: VisitorStore;
  counters: { pageViews: number; invokes: number; reads: number; chatMessages: number };
}

/**
 * Explicit route allowlist, remote-server.ts style: anything not listed
 * 404s, so a route added to the daemon's loopback app can never become
 * visitor-reachable as an accidental side effect.
 */
export function isAppServeRoute(method: string, path: string): boolean {
  if (method === 'GET' && (path === '/' || path.startsWith('/pages/'))) return true;
  if (method === 'GET' && path.startsWith('/data/')) return true;
  if (method === 'GET' && path === '/app/api/site') return true;
  if (method === 'POST' && (path === '/app/api/invoke' || path === '/app/api/read')) return true;
  if (method === 'POST' && path === '/app/api/chat/send') return true;
  if (method === 'GET' && (path === '/app/api/chat/events' || path === '/app/api/chat/history')) {
    return true;
  }
  return false;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function hostWithoutPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * The page CSP, adapted for a top-level document: the iframe-only `sandbox`
 * directive goes (it would give the page an opaque origin and break the
 * same-origin cookie fetches the serve transport depends on), and
 * `frame-ancestors` hardens from `'self'` to `'none'` — nobody frames a
 * mini-site.
 */
export function appServeContentSecurityPolicy(allowExternalNetwork: boolean): string {
  return previewContentSecurityPolicy(allowExternalNetwork)
    .split('; ')
    .filter((directive) => !directive.startsWith('sandbox'))
    .map((directive) =>
      directive === "frame-ancestors 'self'" ? "frame-ancestors 'none'" : directive,
    )
    .join('; ');
}

async function allowsExternalNetwork(store: Store): Promise<boolean> {
  try {
    const policy = resolveSecurityPolicy(await store.readConfig());
    return policy.allowExternalServices && policy.allowAppNetwork;
  } catch {
    return false;
  }
}

export function buildAppServeSiteApp(deps: AppServeSiteDeps, site: AppServeSiteRuntime): Hono {
  const app = new Hono();

  // Per-visitor budgets, one limiter per class (concurrency + sliding minute).
  const invokeLimiter = createTenantLimiter({
    maxConcurrentPerDevice: 4,
    requestsPerMinute: 30,
  });
  const readLimiter = createTenantLimiter({
    maxConcurrentPerDevice: 8,
    requestsPerMinute: 300,
  });
  const chatLimiter = createTenantLimiter({
    maxConcurrentPerDevice: 1,
    maxChatPerDevice: 1,
    requestsPerMinute: 6,
  });

  // Site-wide budgets: sliding windows per class + one inflight ceiling.
  const siteWindows = new Map<keyof typeof SITE_WINDOW_BUDGETS, number[]>();
  let siteInflight = 0;
  let siteChatTurns = 0;
  const streamsByVisitor = new Map<string, number>();

  function siteWindowExceeded(clazz: keyof typeof SITE_WINDOW_BUDGETS): boolean {
    const now = Date.now();
    const recent = (siteWindows.get(clazz) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= SITE_WINDOW_BUDGETS[clazz]) {
      siteWindows.set(clazz, recent);
      return true;
    }
    recent.push(now);
    siteWindows.set(clazz, recent);
    return false;
  }

  // Hardening + marker on EVERY response, including 401/404/500.
  app.use('*', async (c, next) => {
    if (siteInflight >= SITE_MAX_INFLIGHT) {
      c.res = c.json({ error: 'site is busy' }, 503);
      return;
    }
    siteInflight += 1;
    try {
      await next();
    } finally {
      siteInflight -= 1;
    }
    c.res.headers.delete('connection');
    c.res.headers.delete('keep-alive');
    c.res.headers.delete('upgrade');
    c.res.headers.delete('transfer-encoding');
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
    c.res.headers.set(APP_SERVE_MARKER_HEADER, '1');
  });

  app.onError((err, c) => {
    log.warn(`[site ${site.siteId}] ${c.req.method} ${c.req.path} failed: ${String(err)}`);
    return c.json({ error: 'internal error' }, 500);
  });

  // Host check: loopback, the bound IP, and the operator's explicit
  // reverse-proxy hostnames. Anything else — a rebound DNS name included —
  // is refused before any handler runs.
  app.use('*', async (c, next) => {
    const host = hostWithoutPort(c.req.header('host') ?? '');
    const allowed =
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === site.boundHost.toLowerCase() ||
      site.allowedHosts.includes(host);
    if (!allowed) return c.json({ error: 'unrecognized host' }, 403);
    return next();
  });

  // Route allowlist — everything else 404s.
  app.use('*', async (c, next) => {
    if (!isAppServeRoute(c.req.method, c.req.path)) return c.json({ error: 'not found' }, 404);
    return next();
  });

  // Cross-site request forgery: JSON POSTs must come from our own pages.
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST') {
      const origin = c.req.header('origin');
      if (origin) {
        let originHost: string;
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {
          return c.json({ error: 'bad origin' }, 403);
        }
        const host = (c.req.header('host') ?? '').toLowerCase();
        if (originHost !== host) return c.json({ error: 'cross-origin request refused' }, 403);
      }
    }
    return next();
  });

  const cookieName = visitorCookieName(site.siteId);
  const visitorOf = (c: Context) =>
    site.visitors.byCookie(readCookie(c.req.header('cookie'), cookieName));
  const secureCookies = (c: Context) => c.req.header('x-forwarded-proto') === 'https';

  /** Key exchange on page GETs: mint a visitor, set the cookie, drop `k`. */
  function admitOrChallenge(c: Context, target: string): Response | null {
    const existing = visitorOf(c);
    const key = c.req.query('k');
    if (existing) {
      // Strip a lingering key from the location bar even for known visitors.
      return key !== undefined ? c.redirect(target, 302) : null;
    }
    const keyOk = key !== undefined && timingSafeStringEqual(key, site.siteKey());
    if (!site.public && !keyOk) {
      return c.body(
        '<!doctype html><meta charset="utf-8"><title>Gezel app</title><p>This Gezel app link needs its key. Ask whoever shared it for the full link.</p>',
        401,
        { 'content-type': 'text/html; charset=utf-8' },
      );
    }
    const minted = site.visitors.mint();
    if (!minted) return c.json({ error: 'site is full — try again later' }, 503);
    c.header(
      'set-cookie',
      visitorCookieHeader({
        siteId: site.siteId,
        cookieValue: minted.cookieValue,
        secure: secureCookies(c),
      }),
    );
    return c.redirect(target, 302);
  }

  app.get('/', async (c) => {
    const project = await deps.store.getProject(site.projectId).catch(() => null);
    const manifest = project ? await resolveProjectTypeManifest(deps.catalog, project) : null;
    const entry = manifest?.pages?.entry;
    if (!entry) return c.json({ error: 'this app has no pages' }, 404);
    const challenged = admitOrChallenge(c, `/pages/${entry}`);
    return challenged ?? c.redirect(`/pages/${entry}`, 302);
  });

  app.get('/pages/*', async (c) => {
    if (siteWindowExceeded('page')) return c.json({ error: 'rate limited' }, 429);
    const challenged = admitOrChallenge(c, c.req.path);
    if (challenged) return challenged;
    const visitor = visitorOf(c);
    if (!visitor) return c.json({ error: 'visitor session required' }, 401);

    let filePath = c.req.path.slice('/pages/'.length);
    try {
      filePath = decodeURIComponent(filePath);
    } catch {
      return c.json({ error: 'bad path' }, 400);
    }
    if (filePath === '' || filePath.endsWith('/')) filePath = `${filePath}index.html`;

    const project = await deps.store.getProject(site.projectId).catch(() => null);
    const pt = project?.projectType;
    if (!project || !pt) return c.json({ error: 'project has no applied project type' }, 404);
    // `catalog.readItemFile` rejects `..` / absolute paths, so a page can't
    // escape the `pages/` subtree.
    const buf = await deps.catalog
      .readItemFile('project-type', pt.id, `pages/${filePath}`, pt.source, pt.version)
      .catch(() => null);
    if (!buf) return c.json({ error: 'not found' }, 404);
    const mime = mimeTypeForPath(filePath);
    const external = await allowsExternalNetwork(deps.store);
    const headers: Record<string, string> = {
      'content-type': mime,
      'content-security-policy': appServeContentSecurityPolicy(external),
      'cache-control': 'no-store',
      'x-dns-prefetch-control': 'off',
    };
    if (!mime.startsWith('text/html')) return c.body(new Uint8Array(buf), 200, headers);

    site.counters.pageViews += 1;
    const pageTools = await resolvePageTools(deps.catalog, project).catch(() => null);
    const pageApi: PageApiBootstrap = {
      api: 1,
      projectId: site.projectId,
      source: 'type',
      entry: filePath,
      typeName: pageTools?.typeName ?? pt.id,
      params: pageTools?.params ?? {},
      tools: (pageTools?.tools ?? []).map((t) => t.name),
      serve: { apiBase: '/app/api', dataBase: '/data', chat: site.chat },
    };
    return c.body(preparePreviewHtml(buf.toString('utf8'), { pageApi }), 200, headers);
  });

  app.post('/app/api/invoke', async (c) => {
    const visitor = visitorOf(c);
    if (!visitor) return c.json({ error: 'visitor session required' }, 401);
    if (siteWindowExceeded('invoke')) return c.json({ error: 'rate limited' }, 429);
    const admission = invokeLimiter.tryAcquire(visitor.visitorId, 'generation');
    if (!admission.ok) {
      c.header('retry-after', String(admission.retryAfterSec));
      return c.json({ error: 'rate limited', errorCode: 'rate-limited' }, 429);
    }
    try {
      const body = InvokePageToolRequestSchema.parse(await c.req.json());
      site.counters.invokes += 1;
      const result = await invokePageTool(deps, {
        projectId: site.projectId,
        request: body,
        allowReaction: site.chat,
        origin: 'serve',
      });
      return c.json(result.body, result.status);
    } finally {
      admission.release();
    }
  });

  app.post('/app/api/read', async (c) => {
    const visitor = visitorOf(c);
    if (!visitor) return c.json({ error: 'visitor session required' }, 401);
    if (siteWindowExceeded('read')) return c.json({ error: 'rate limited' }, 429);
    const admission = readLimiter.tryAcquire(visitor.visitorId, 'generation');
    if (!admission.ok) {
      c.header('retry-after', String(admission.retryAfterSec));
      return c.json({ error: 'rate limited', errorCode: 'rate-limited' }, 429);
    }
    try {
      const body = PageReadRequestSchema.parse(await c.req.json());
      site.counters.reads += 1;
      const result = await readPageData(deps, { projectId: site.projectId, request: body });
      return c.json(result.body, result.status);
    } finally {
      admission.release();
    }
  });

  // Direct media GETs for `gezel.data.url()` — <img>/<audio>/<video> send
  // cookies same-origin. Same declared-scope enforcement as /app/api/read.
  app.get('/data/*', async (c) => {
    const visitor = visitorOf(c);
    if (!visitor) return c.json({ error: 'visitor session required' }, 401);
    if (siteWindowExceeded('read')) return c.json({ error: 'rate limited' }, 429);
    const admission = readLimiter.tryAcquire(visitor.visitorId, 'generation');
    if (!admission.ok) {
      c.header('retry-after', String(admission.retryAfterSec));
      return c.json({ error: 'rate limited' }, 429);
    }
    try {
      const rest = c.req.path.slice('/data/'.length);
      const slash = rest.indexOf('/');
      if (slash === -1) return c.json({ error: 'bad path' }, 400);
      const source = rest.slice(0, slash);
      if (source !== 'workspace' && source !== 'artifacts') {
        return c.json({ error: 'bad source' }, 400);
      }
      let path: string;
      try {
        path = decodeURIComponent(rest.slice(slash + 1));
      } catch {
        return c.json({ error: 'bad path' }, 400);
      }
      const resolved = await resolveScopedPageFile(deps, {
        projectId: site.projectId,
        source,
        path,
      });
      if (!resolved.ok) return c.json(resolved.result.body, resolved.result.status);
      let stats: Awaited<ReturnType<typeof stat>>;
      try {
        stats = await stat(resolved.full);
      } catch {
        return c.json({ error: 'not found' }, 404);
      }
      if (stats.isDirectory()) return c.json({ error: 'is a directory' }, 400);
      if (stats.size > PAGE_READ_MAX_BYTES) {
        return c.json({ error: 'file exceeds read cap' }, 413);
      }
      site.counters.reads += 1;
      const buf = await readFile(resolved.full);
      return c.body(new Uint8Array(buf), 200, {
        'content-type': mimeTypeForPath(resolved.requested),
        'cache-control': 'no-store',
      });
    } finally {
      admission.release();
    }
  });

  app.get('/app/api/site', async (c) => {
    const visitor = visitorOf(c);
    if (!visitor) return c.json({ error: 'visitor session required' }, 401);
    const project = await deps.store.getProject(site.projectId).catch(() => null);
    const pageTools = project
      ? await resolvePageTools(deps.catalog, project).catch(() => null)
      : null;
    return c.json({
      typeName: pageTools?.typeName ?? project?.projectType?.id ?? '',
      typeVersion: project?.projectType?.version ?? '',
      chat: site.chat,
      limits: { maxInflight: 4, maxReadBytes: PAGE_READ_MAX_BYTES },
    });
  });

  app.post('/app/api/chat/send', async (c) => {
    if (!site.chat) return c.json({ error: 'chat is not enabled on this site' }, 403);
    const visitor = visitorOf(c);
    if (!visitor) return c.json({ error: 'visitor session required' }, 401);
    if (visitor.chatMessages >= VISITOR_CHAT_MESSAGE_CAP) {
      return c.json({ error: 'message limit reached for this visit' }, 429);
    }
    if (siteWindowExceeded('chat') || siteChatTurns >= SITE_MAX_CHAT_TURNS) {
      c.header('retry-after', '5');
      return c.json({ error: 'the site is busy — try again shortly' }, 429);
    }
    const admission = chatLimiter.tryAcquire(visitor.visitorId, 'chat');
    if (!admission.ok) {
      c.header('retry-after', String(admission.retryAfterSec));
      return admission.reason === 'concurrency'
        ? c.json({ error: 'a reply is already streaming' }, 409)
        : c.json({ error: 'rate limited' }, 429);
    }
    let admitted = false;
    try {
      const body = AppServeChatSendRequestSchema.parse(await c.req.json());
      const config = await deps.store.readConfig();
      const blocked = engagementBlocked(config);
      if (blocked) return c.json({ error: blocked }, 403);
      const session = await ensureVisitorChatSession(deps, {
        projectId: site.projectId,
        visitor,
      });
      if ('error' in session) return c.json({ error: session.error }, session.status);
      visitor.chatMessages += 1;
      site.counters.chatMessages += 1;
      siteChatTurns += 1;
      admitted = true;
      const release = admission.release;
      const turn = deps.chat
        .send(session.sessionId, body.message)
        .catch((err) => log.warn(`[site ${site.siteId}] visitor turn failed: ${String(err)}`))
        .finally(() => {
          siteChatTurns -= 1;
          release();
        });
      deps.chat.trackBackground(turn);
      return c.json({ accepted: true }, 202);
    } finally {
      if (!admitted) admission.release();
    }
  });

  app.get('/app/api/chat/events', async (c) => {
    if (!site.chat) return c.json({ error: 'chat is not enabled on this site' }, 403);
    const visitor = visitorOf(c);
    if (!visitor) return c.json({ error: 'visitor session required' }, 401);
    const sessionId = visitor.chatSessionId;
    if (!sessionId) return c.json({ error: 'no conversation yet — send a message first' }, 404);
    const streams = streamsByVisitor.get(visitor.visitorId) ?? 0;
    if (streams >= VISITOR_MAX_STREAMS) return c.json({ error: 'too many open streams' }, 429);
    streamsByVisitor.set(visitor.visitorId, streams + 1);
    return streamSSE(c, async (stream) => {
      let closed = false;
      // Single ordered write lane — Hono's SSE writer is stateful and
      // overlapping writeSSE calls interleave frame bytes.
      let chain = Promise.resolve();
      const write = (data: string, event?: string) => {
        chain = chain
          .then(() => stream.writeSSE(event ? { event, data } : { data }))
          .catch(() => {
            closed = true;
          });
      };
      const unsubscribe = deps.chatEvents.subscribe(sessionId, (event) => {
        const projected = projectVisitorEvent(event);
        if (!projected) return;
        write(JSON.stringify(projected));
        if (projected.type === 'done' || projected.type === 'error') closed = true;
      });
      stream.onAbort(() => {
        closed = true;
      });
      try {
        while (!closed) {
          await stream.sleep(1_000);
          write('', 'ping');
          await chain;
        }
        await chain;
      } finally {
        unsubscribe();
        const open = streamsByVisitor.get(visitor.visitorId) ?? 1;
        if (open <= 1) streamsByVisitor.delete(visitor.visitorId);
        else streamsByVisitor.set(visitor.visitorId, open - 1);
      }
    });
  });

  app.get('/app/api/chat/history', async (c) => {
    if (!site.chat) return c.json({ error: 'chat is not enabled on this site' }, 403);
    const visitor = visitorOf(c);
    if (!visitor) return c.json({ error: 'visitor session required' }, 401);
    if (!visitor.chatSessionId) return c.json({ messages: [] });
    const record = await deps.chat.getSessionRecord(visitor.chatSessionId);
    if (!record) return c.json({ messages: [] });
    const messages = record.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-100)
      .map((message) => ({ role: message.role, content: message.content, at: message.at }));
    return c.json({ messages });
  });

  return app;
}
