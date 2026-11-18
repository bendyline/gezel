/**
 * Website operations outside a sync pass: the listing the Web pages view and
 * `list_web_pages` read, a person saving one page, a gezel asking for a page
 * the crawler already found, and signing in to a site. Routes and MCP tools
 * share this; nothing here fetches on a model's say-so except an address the
 * crawler already saw as a link on a site the person follows.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ProjectConnectorBinding,
  type ProjectDetail,
  type WebPageEntry,
  type WebPagesListResponse,
  type WebSiteBinding,
  createLogger,
  normalizePageUrl,
  redactPageUrl,
  sameSite,
  scopeOfUrl,
} from '@bendyline/gezel';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import type { Store } from '../../fs/store.js';
import type { PageCaptureService, SignInWindow } from '../../page-capture/service.js';
import type { PageCapturer } from '../../page-capture/types.js';
import type { ConnectorManager } from '../manager.js';
import { crawlPageFor, readCrawlState, webPageEntries, writeCrawlState } from './website-crawl.js';
import {
  SESSION_FILE,
  type SavedSession,
  type SignInFingerprint,
  forgetSession,
  readSession,
  writeSession,
} from './website-session.js';
import { WEBSITE_TYPE_ID, parseWebsiteConfig, siteKey } from './website.js';

const log = createLogger('connectors');

/** Pages a gezel may ask for per project per day. */
export const GEZEL_REQUESTS_PER_DAY = 40;
/** A saved page this fresh is answered from disk, not fetched again. */
const REQUEST_FRESH_MS = 24 * 3_600_000;
const SAVED_PAGES_NAME = 'Saved pages';
const SIGN_IN_TTL_MS = 30 * 60_000;

export type WebPageRequestOutcome =
  | { status: 'saved'; page: WebPageEntry }
  | { status: 'queued'; page: WebPageEntry; message: string }
  | { status: 'needs-permission'; message: string }
  | { status: 'gone' | 'limit' | 'failed'; message: string };

interface OpenSignIn {
  projectId: string;
  bindingId: string;
  host: string;
  window: SignInWindow;
  openedAt: number;
}

export class WebsiteService {
  private readonly requestsToday = new Map<string, { day: string; count: number }>();
  private readonly signIns = new Map<string, OpenSignIn>();

  constructor(
    private readonly opts: {
      store: Store;
      connectors: ConnectorManager;
      secrets: SecretStore;
      capturer: PageCapturer;
    },
  ) {}

  private websiteBindings(project: Pick<ProjectDetail, 'connectors'>): ProjectConnectorBinding[] {
    return (project.connectors ?? []).filter((b) => b.type === WEBSITE_TYPE_ID);
  }

  private stateDir(projectId: string, bindingId: string): string {
    const dir = this.opts.connectors.bindingStateDir(projectId, bindingId);
    if (!dir) throw new Error('website connections need a private state folder');
    return dir;
  }

  private browserStatus(): { available: boolean; reason?: string } {
    const capture = this.opts.capturer as Partial<PageCaptureService>;
    return typeof capture.browserStatus === 'function'
      ? capture.browserStatus()
      : { available: true };
  }

  /** Every website binding's pages, for the Web pages view and `list_web_pages`. */
  async list(
    project: ProjectDetail,
    opts: { limit?: number; bindingId?: string } = {},
  ): Promise<WebPagesListResponse> {
    const limit = Math.max(1, Math.min(opts.limit ?? 2000, 5000));
    const bindings: WebSiteBinding[] = [];
    const pages: WebPageEntry[] = [];
    const browser = this.browserStatus();
    for (const b of this.websiteBindings(project)) {
      if (opts.bindingId && b.id !== opts.bindingId) continue;
      const dir = this.stateDir(project.id, b.id);
      const state = await readCrawlState(dir);
      const entries = webPageEntries(state, b.id);
      const { config } = parseWebsiteConfig(b.config);
      const count = (s: WebPageEntry['state']) => entries.filter((e) => e.state === s).length;
      const nextRefreshAt =
        config.refreshEveryHours > 0 && b.lastSyncedAt
          ? new Date(
              Date.parse(b.lastSyncedAt) + config.refreshEveryHours * 3_600_000,
            ).toISOString()
          : undefined;
      bindings.push({
        bindingId: b.id,
        displayName:
          b.displayName ??
          (config.sites.length === 1 ? new URL(config.sites[0]!).hostname : 'Web pages'),
        sites: config.sites,
        corpusDir: b.corpusDir ?? '',
        ...(b.lastSyncedAt ? { lastSyncedAt: b.lastSyncedAt } : {}),
        ...(b.lastError ? { lastError: b.lastError } : {}),
        ...(b.disabled ? { disabled: true } : {}),
        browser: config.useBrowser && browser.available,
        ...(config.useBrowser && !browser.available && browser.reason
          ? { browserUnavailableReason: browser.reason }
          : {}),
        signedIn: existsSync(join(dir, SESSION_FILE)),
        counts: {
          saved: entries.filter((e) => e.path && e.state !== 'gone').length,
          queued: count('queued'),
          failed: count('failed'),
          blocked: count('blocked'),
        },
        ...(nextRefreshAt ? { nextRefreshAt } : {}),
        gezelRequests: config.gezelRequests,
      });
      pages.push(...entries);
    }
    const rank = (e: WebPageEntry) =>
      e.path && e.state !== 'gone'
        ? 0
        : e.state === 'failed' || e.state === 'blocked'
          ? 1
          : e.state === 'queued'
            ? 2
            : 3;
    pages.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.changedAt ?? b.capturedAt ?? '').localeCompare(a.changedAt ?? a.capturedAt ?? '') ||
        a.url.localeCompare(b.url),
    );
    return {
      bindings,
      pages: pages.slice(0, limit),
      truncated: pages.length > limit,
      canSave: await this.opts.connectors.typeAvailable(WEBSITE_TYPE_ID),
    };
  }

  /**
   * The saved copy of one address, from any website binding. Two connections
   * can both know an address (one saved it, one only saw the link); the saved
   * copy wins.
   */
  async find(project: ProjectDetail, rawUrl: string): Promise<WebPageEntry | null> {
    const url = normalizePageUrl(rawUrl);
    if (!url) return null;
    let known: WebPageEntry | null = null;
    for (const b of this.websiteBindings(project)) {
      const entry = await this.findIn(project.id, b.id, url);
      if (entry?.path) return entry;
      known ??= entry;
    }
    return known;
  }

  private async findIn(
    projectId: string,
    bindingId: string,
    url: string,
  ): Promise<WebPageEntry | null> {
    const state = await readCrawlState(this.stateDir(projectId, bindingId));
    const page = crawlPageFor(state, url);
    return page
      ? (webPageEntries({ ...state, pages: { [page.url]: page } }, bindingId)[0] ?? null)
      : null;
  }

  /** A connection (not the Saved pages one) that follows an address or has already found it. */
  private async bindingFollowing(
    project: ProjectDetail,
    url: string,
  ): Promise<ProjectConnectorBinding | undefined> {
    for (const b of this.websiteBindings(project)) {
      if (b.config?.savedPages === true) continue;
      if (scopeOfUrl(url, parseWebsiteConfig(b.config).config.scopes)) return b;
      if (crawlPageFor(await readCrawlState(this.stateDir(project.id, b.id)), url)) return b;
    }
    return undefined;
  }

  /** The address as a connection would hold it, or the problem a person can fix. */
  private savableUrl(rawUrl: string): string {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl.trim())
      ? rawUrl.trim()
      : `https://${rawUrl.trim()}`;
    const { config: parsed, problems } = parseWebsiteConfig({ sites: [withScheme] });
    if (problems.length > 0 || !parsed.sites[0])
      throw new Error(problems[0] ?? 'Not a web address.');
    return parsed.sites[0];
  }

  /** Whether `savePage` would accept this address at all. */
  savable(rawUrl: string): boolean {
    try {
      this.savableUrl(rawUrl);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The person saves one address now: into a connection that already follows
   * its site, or into the project's "Saved pages" connection (no link
   * following, no schedule), created on first use.
   */
  async savePage(
    project: ProjectDetail,
    rawUrl: string,
    sessionId?: string,
  ): Promise<{ bindingId: string; page: WebPageEntry }> {
    const url = this.savableUrl(rawUrl);
    let binding = await this.bindingFollowing(project, url);
    if (!binding) {
      binding = this.websiteBindings(project).find((b) => b.config?.savedPages === true);
      if (binding) {
        const sites = parseWebsiteConfig(binding.config).config.sites;
        const sessionPages = { ...((binding.config.sessionPages as Record<string, string>) ?? {}) };
        if (sessionId) sessionPages[url] = sessionId;
        if (!sites.includes(url) || sessionId) {
          binding = await this.opts.connectors.patchBinding(project, binding.id, {
            config: {
              ...binding.config,
              sites: [...new Set([...sites, url])],
              ...(sessionId ? { sessionPages } : {}),
            },
          });
        }
      } else {
        if (!(await this.opts.connectors.typeAvailable(WEBSITE_TYPE_ID))) {
          throw new Error(
            "This copy of Gezel can't save web pages yet: its catalog has no website connection.",
          );
        }
        binding = await this.opts.connectors.bind(project, {
          type: WEBSITE_TYPE_ID,
          displayName: SAVED_PAGES_NAME,
          config: {
            sites: [url],
            followLinks: 0,
            refreshEveryHours: 0,
            savedPages: true,
            ...(sessionId ? { sessionPages: { [url]: sessionId } } : {}),
          },
        });
      }
    }
    await this.markRequested(project.id, binding.id, url, 'person');
    const fresh = (await this.opts.store.getProject(project.id)) ?? project;
    await this.opts.connectors.syncBinding(fresh, binding.id, { trigger: 'request' });
    const page = await this.findIn(project.id, binding.id, url);
    if (!page) throw new Error('The page could not be saved.');
    return { bindingId: binding.id, page };
  }

  /**
   * Keep synopses the enrichment pass wrote, so the site overview and the
   * Web pages view carry them. Derived from page text: untrusted.
   */
  async noteSummaries(
    projectId: string,
    summaries: { path: string; summary: string }[],
  ): Promise<void> {
    const byPath = new Map(summaries.map((s) => [s.path.replace(/\\/g, '/'), s.summary]));
    const project = await this.opts.store.getProject(projectId);
    if (!project) return;
    for (const b of this.websiteBindings(project)) {
      const dir = this.stateDir(projectId, b.id);
      await this.opts.connectors.withProjectLock(projectId, async () => {
        const state = await readCrawlState(dir);
        let changed = false;
        for (const page of Object.values(state.pages)) {
          const summary = page.path ? byPath.get(page.path) : undefined;
          if (!summary) continue;
          page.summary = summary.replace(/\s+/g, ' ').trim().slice(0, 600);
          changed = true;
        }
        if (changed) await writeCrawlState(dir, state);
      });
    }
  }

  /** Remove the pages saved only for a chat that was deleted. */
  async forgetSessionPages(projectId: string, sessionId: string): Promise<void> {
    const project = await this.opts.store.getProject(projectId);
    const binding =
      project && this.websiteBindings(project).find((b) => b.config?.savedPages === true);
    if (!project || !binding) return;
    const sessionPages = { ...((binding.config.sessionPages as Record<string, string>) ?? {}) };
    const drop = Object.entries(sessionPages)
      .filter(([, sid]) => sid === sessionId)
      .map(([url]) => url);
    if (drop.length === 0) return;
    for (const url of drop) delete sessionPages[url];
    const sites = parseWebsiteConfig(binding.config).config.sites.filter((s) => !drop.includes(s));
    if (sites.length === 0) {
      await this.opts.connectors.unbind(project, binding.id);
      return;
    }
    await this.opts.connectors.patchBinding(project, binding.id, {
      config: { ...binding.config, sites, sessionPages },
    });
  }

  private async markRequested(
    projectId: string,
    bindingId: string,
    url: string,
    by: 'person' | 'gezel',
  ): Promise<void> {
    const dir = this.stateDir(projectId, bindingId);
    await this.opts.connectors.withProjectLock(projectId, async () => {
      const state = await readCrawlState(dir);
      const page = crawlPageFor(state, url);
      if (page) {
        page.priority = Date.now();
        page.requestedBy = by;
        if (page.state === 'skipped') {
          page.state = 'queued';
          delete page.reason;
        }
        delete page.nextAttemptAt;
      } else {
        // A start address the person just added; the pass seeds it, this
        // only makes sure it goes first.
        const scope = parseWebsiteConfig({ sites: [url] }).config.scopes[0];
        state.pages[url] = {
          url,
          site: siteKey(scope?.host ?? new URL(url).hostname),
          depth: 0,
          state: 'queued',
          firstSeenAt: new Date().toISOString(),
          priority: Date.now(),
          requestedBy: by,
        };
      }
      await writeCrawlState(dir, state);
    });
  }

  /**
   * A gezel asks for a page. Fetched only when the address is exactly a link
   * the crawler already found inside a site the person follows, the binding
   * lets gezels ask, and today's cap is not spent. Anything else is the
   * person's decision; the tool turns it into a question for them.
   */
  async requestPage(project: ProjectDetail, rawUrl: string): Promise<WebPageRequestOutcome> {
    const url = normalizePageUrl(rawUrl);
    if (!url) return { status: 'failed', message: 'That is not a web address.' };
    for (const b of this.websiteBindings(project)) {
      const dir = this.stateDir(project.id, b.id);
      const state = await readCrawlState(dir);
      const page = crawlPageFor(state, url);
      if (!page) continue;
      const { config } = parseWebsiteConfig(b.config);
      const signedIn = existsSync(join(dir, SESSION_FILE));
      const allowed =
        config.gezelRequests === 'allow' && !(signedIn && b.config?.gezelRequests !== 'allow');
      if (!allowed) {
        return {
          status: 'needs-permission',
          message: `The person asked to approve page requests on ${page.site}.`,
        };
      }
      if (page.state === 'gone')
        return { status: 'gone', message: 'The site says this page no longer exists.' };
      const entry = webPageEntries({ ...state, pages: { [page.url]: page } }, b.id)[0]!;
      if (
        page.path &&
        page.capturedAt &&
        Date.now() - Date.parse(page.capturedAt) < REQUEST_FRESH_MS
      ) {
        return { status: 'saved', page: entry };
      }
      const day = new Date().toISOString().slice(0, 10);
      const used = this.requestsToday.get(project.id);
      const count = used?.day === day ? used.count : 0;
      if (count >= GEZEL_REQUESTS_PER_DAY) {
        return {
          status: 'limit',
          message: `This project already fetched ${GEZEL_REQUESTS_PER_DAY} requested pages today.`,
        };
      }
      this.requestsToday.set(project.id, { day, count: count + 1 });
      await this.markRequested(project.id, b.id, page.url, 'gezel');
      log.info(`website ${b.id}: a gezel asked for ${redactPageUrl(url)}`);
      const fresh = (await this.opts.store.getProject(project.id)) ?? project;
      await this.opts.connectors.syncBinding(fresh, b.id, { trigger: 'request' }).catch((err) => {
        log.info(
          `website ${b.id}: requested page not fetched: ${err instanceof Error ? err.message : err}`,
        );
      });
      const after = await this.findIn(project.id, b.id, url);
      if (after?.path && after.state !== 'gone') return { status: 'saved', page: after };
      return {
        status: 'queued',
        page: after ?? entry,
        message: after?.reason ?? 'The page is queued and will be saved on the next pass.',
      };
    }
    return {
      status: 'needs-permission',
      message: 'This address is not a link Gezel has found on a site this project follows.',
    };
  }

  // ── Signing in ────────────────────────────────────────────────────────

  private capture(): PageCaptureService {
    const capture = this.opts.capturer as Partial<PageCaptureService>;
    if (typeof capture.openSignIn !== 'function')
      throw new Error('Signing in is not available here.');
    return this.opts.capturer as PageCaptureService;
  }

  /** Open a window for the person to sign in to the binding's site. */
  async startSignIn(
    project: ProjectDetail,
    bindingId: string,
  ): Promise<{ signInId: string; host: string }> {
    this.gcSignIns();
    const binding = this.websiteBindings(project).find((b) => b.id === bindingId);
    if (!binding) throw new Error('No such website connection.');
    const { config } = parseWebsiteConfig(binding.config);
    const start = config.sites[0];
    if (!start) throw new Error('This connection lists no address.');
    for (const [id, open] of this.signIns) {
      if (open.bindingId === bindingId) {
        await open.window.close().catch(() => {});
        this.signIns.delete(id);
      }
    }
    const host = new URL(start).hostname;
    const window = await this.capture().openSignIn({
      startUrl: start,
      host,
      privateHosts: config.scopes.map((s) => (s.port ? `${s.host}:${s.port}` : s.host)),
    });
    const signInId = `si-${Math.random().toString(36).slice(2, 10)}`;
    this.signIns.set(signInId, {
      projectId: project.id,
      bindingId,
      host,
      window,
      openedAt: Date.now(),
    });
    return { signInId, host };
  }

  async cancelSignIn(signInId: string): Promise<void> {
    const open = this.signIns.get(signInId);
    this.signIns.delete(signInId);
    await open?.window.close().catch(() => {});
  }

  /**
   * The person says they are signed in: keep the window's cookies for the
   * site, check them in a fresh headless browser against the same page
   * without them, and save the sign-in.
   */
  async finishSignIn(
    project: ProjectDetail,
    bindingId: string,
    signInId: string,
  ): Promise<{ ok: boolean; message: string; unverifiable?: boolean }> {
    const open = this.signIns.get(signInId);
    if (!open || open.bindingId !== bindingId || open.projectId !== project.id) {
      throw new Error('That sign-in window is no longer open. Start again.');
    }
    const state = await open.window.storageState();
    const lastUrl = await open.window.currentUrl();
    this.signIns.delete(signInId);
    await open.window.close().catch(() => {});
    if (!state)
      return {
        ok: false,
        message: 'The window closed before the sign-in could be saved. Try again.',
      };
    const binding = this.websiteBindings(project).find((b) => b.id === bindingId)!;
    const { config } = parseWebsiteConfig(binding.config);
    const hosts = config.scopes.map((s) => s.host);
    const lastNormalized = lastUrl ? normalizePageUrl(lastUrl) : null;
    const probeUrl =
      lastNormalized && hosts.some((h) => sameSite(new URL(lastNormalized).hostname, { host: h }))
        ? lastNormalized
        : config.sites[0]!;
    const signedIn = await this.fingerprint(config, probeUrl, state);
    const anonymous = await this.fingerprint(config, probeUrl, undefined);
    if (!signedIn || signedIn.passwordField) {
      return {
        ok: false,
        message: `${open.host} still asks for a sign-in. Sign in fully in the window, then press Done.`,
      };
    }
    const unverifiable =
      !anonymous ||
      (anonymous.title === signedIn.title &&
        anonymous.finalUrl === signedIn.finalUrl &&
        !anonymous.passwordField);
    const session: SavedSession = {
      version: 1,
      state,
      savedAt: new Date().toISOString(),
      hosts,
      probeUrl,
      signedIn,
      ...(anonymous ? { anonymous } : {}),
      ...(unverifiable ? { unverifiable: true } : {}),
      lastVerifiedAt: new Date().toISOString(),
    };
    await writeSession(this.stateDir(project.id, bindingId), this.opts.secrets, bindingId, session);
    return {
      ok: true,
      message: unverifiable
        ? `Signed in to ${open.host}. The page looks the same signed out, so Gezel cannot tell if the sign-in later expires.`
        : `Signed in to ${open.host}. Refreshes now see what you see when signed in.`,
      ...(unverifiable ? { unverifiable: true } : {}),
    };
  }

  private async fingerprint(
    config: ReturnType<typeof parseWebsiteConfig>['config'],
    url: string,
    storageState: SavedSession['state'] | undefined,
  ): Promise<SignInFingerprint | null> {
    const session = await this.opts.capturer.open({
      privateHosts: config.scopes.map((s) => (s.port ? `${s.host}:${s.port}` : s.host)),
      browser: true,
      allowScriptPost: false,
      ...(storageState ? { storageState } : {}),
    });
    try {
      const outcome = await session.capture({
        url,
        screenshots: 0,
        maxImages: 0,
        stagingDir: join(this.opts.store.homePath, 'runtime', 'sign-in-check'),
        scopes: config.scopes,
      });
      if (!outcome.ok) {
        return outcome.kind === 'blocked'
          ? {
              finalUrl: outcome.finalUrl ?? url,
              status: outcome.status ?? 0,
              title: '',
              passwordField: true,
              words: 0,
            }
          : null;
      }
      return {
        finalUrl: outcome.finalUrl,
        status: outcome.status,
        title: outcome.metadata.title,
        passwordField: Boolean(outcome.passwordField),
        words: outcome.words,
      };
    } finally {
      await session.close().catch(() => {});
    }
  }

  async sessionInfo(
    project: ProjectDetail,
    bindingId: string,
  ): Promise<{
    signedIn: boolean;
    hosts?: string[];
    savedAt?: string;
    lastVerifiedAt?: string;
    unverifiable?: boolean;
  }> {
    const session = await readSession(
      this.stateDir(project.id, bindingId),
      this.opts.secrets,
      bindingId,
    );
    if (!session) return { signedIn: false };
    return {
      signedIn: true,
      hosts: session.hosts,
      savedAt: session.savedAt,
      ...(session.lastVerifiedAt ? { lastVerifiedAt: session.lastVerifiedAt } : {}),
      ...(session.unverifiable ? { unverifiable: true } : {}),
    };
  }

  async forgetSignIn(project: ProjectDetail, bindingId: string): Promise<void> {
    this.opts.connectors.cancelPasses({ bindingId }, 'the sign-in was forgotten');
    await forgetSession(this.stateDir(project.id, bindingId), this.opts.secrets, bindingId);
  }

  /**
   * Fallback where no window can open (a daemon with no display): the
   * person pastes a browser storage state exported from their own browser.
   */
  async importSignIn(
    project: ProjectDetail,
    bindingId: string,
    state: { cookies: unknown[]; origins?: unknown[] },
  ): Promise<void> {
    const binding = this.websiteBindings(project).find((b) => b.id === bindingId);
    if (!binding) throw new Error('No such website connection.');
    const { config } = parseWebsiteConfig(binding.config);
    if (!Array.isArray(state.cookies))
      throw new Error('Expected a browser storage state with a cookies list.');
    await writeSession(this.stateDir(project.id, bindingId), this.opts.secrets, bindingId, {
      version: 1,
      state: { cookies: state.cookies, origins: Array.isArray(state.origins) ? state.origins : [] },
      savedAt: new Date().toISOString(),
      hosts: config.scopes.map((s) => s.host),
      ...(config.sites[0] ? { probeUrl: config.sites[0] } : {}),
      unverifiable: true,
    });
  }

  private gcSignIns(): void {
    for (const [id, open] of this.signIns) {
      if (Date.now() - open.openedAt > SIGN_IN_TTL_MS || open.window.windowClosed) {
        void open.window.close().catch(() => {});
        this.signIns.delete(id);
      }
    }
  }

  /** Close every open sign-in window (shutdown, emergency stop). */
  closeAll(): void {
    for (const open of this.signIns.values()) void open.window.close().catch(() => {});
    this.signIns.clear();
  }
}
