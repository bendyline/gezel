/**
 * The website connector: keeps an offline copy of the web pages a person
 * follows, so gezels can read and search them without any web access of
 * their own. The person lists start addresses; the daemon visits each one in
 * a sandboxed browser (or downloads it, in text-only mode), saves what a
 * visitor would read as markdown with a few screenshots, follows links inside
 * the site up to a depth and a page cap, and refreshes on a schedule.
 *
 * One scope per site (host). State that must survive between passes lives in
 * the binding's private crawl list (website-crawl.ts). A page's record is
 * written only when its text changed; a sign-in wall, a bot check or a page
 * that came back nearly empty never replaces a good copy.
 * Contract: docs/website-connector.md.
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type SiteScope,
  awakeNow,
  createLogger,
  linkRefusal,
  normalizePageUrl,
  redactPageUrl,
  sameSite,
  scopeOfUrl,
  siteScopeFor,
} from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { safeFetchPage, textHash } from '../../page-capture/http-session.js';
import {
  type CaptureSession,
  CaptureUnavailableError,
  type CapturedPage,
  type StorageStateLike,
} from '../../page-capture/types.js';
import { registerNativeAdapter } from '../registry.js';
import {
  type AdapterDeps,
  type ChangeBatch,
  type ConnectorAdapter,
  type ConnectorBindingRef,
  type NormalizedRecord,
  PassStoppedError,
  type RecordRef,
  RecordSkippedError,
} from '../types.js';
import { sha8 } from '../writer.js';
import {
  MONTH_ENTRIES_KEPT,
  type PageChange,
  changeForLog,
  changeLogRecord,
  newPageChange,
  saveChangeBatch,
  summarizeChange,
} from './website-changes.js';
import {
  type CrawlPage,
  type CrawlState,
  type RobotsRules,
  assignFolder,
  crawlPageFor,
  pageLocation,
  parseRobots,
  readCrawlState,
  robotsAllows,
  writeCrawlState,
} from './website-crawl.js';
import { WEBSITE_TYPE_ID, pageRecord, siteOverviewRecord } from './website-record.js';
import { type SavedSession, looksSignedOut, readSession, writeSession } from './website-session.js';

const log = createLogger('connectors');

export { WEBSITE_TYPE_ID };

/** Pages one pass captures, and its awake-time budget, by who started it. */
const PASS_BUDGET = {
  manual: { pages: 15, ms: 120_000 },
  schedule: { pages: 40, ms: 240_000 },
  task: { pages: 40, ms: 240_000 },
  request: { pages: 5, ms: 90_000 },
} as const;
/** A page captured this recently is not re-captured by a person's "Sync now". */
const MANUAL_FRESH_MS = 10 * 60_000;
const MIN_HOST_GAP_MS = 1_500;
const ROBOTS_TTL_MS = 24 * 3_600_000;
const MAX_IMAGES = 6;
/** Retry ladder for a page that failed to load. */
const FAILURE_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 3_600_000, 24 * 3_600_000];
/** How long a bot check or a refusal is left alone. */
const BLOCKED_RETRY_MS = 24 * 3_600_000;
/** Entries the crawl list keeps beyond the page cap (links found but not followed). */
const KNOWN_LINKS_FACTOR = 3;

export interface WebsiteConfig {
  sites: string[];
  scopes: SiteScope[];
  followLinks: number;
  maxPages: number;
  refreshEveryHours: number;
  screenshots: number;
  exclude: string[];
  respectRobots: boolean;
  useBrowser: boolean;
  /** Signed-in crawls only: let page scripts send POST requests. */
  allowScriptPost: boolean;
  /** Whether a gezel may ask for a found link without asking the person (Stage 4). */
  gezelRequests: 'allow' | 'ask';
}

function list(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === 'string')
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function intIn(raw: unknown, min: number, max: number, fallback: number): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : Number.NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

/** Addresses a connection the person sets up may follow. */
export const WEBSITE_MAX_ADDRESSES = 25;

/**
 * Addresses a project's Saved pages connection may hold. Every page saved
 * from a chat adds one, and an address leaving `sites` takes its saved copy
 * with it, so this limit is generous rather than a rolling window. At 25,
 * the 26th link a person pasted in a project failed for good (1.26326.112
 * release audit).
 */
export const SAVED_PAGES_MAX_ADDRESSES = 500;

/** Read a binding's config, with the problems a person can fix. */
export function parseWebsiteConfig(raw: Record<string, unknown> | undefined): {
  config: WebsiteConfig;
  problems: string[];
} {
  const c = raw ?? {};
  const problems: string[] = [];
  const scopes: SiteScope[] = [];
  const sites: string[] = [];
  const entries = list(c.sites);
  const savedPages = c.savedPages === true;
  const maxAddresses = savedPages ? SAVED_PAGES_MAX_ADDRESSES : WEBSITE_MAX_ADDRESSES;
  if (entries.length === 0) problems.push('Add at least one web address.');
  if (entries.length > maxAddresses)
    problems.push(
      savedPages
        ? `Saved pages keeps at most ${SAVED_PAGES_MAX_ADDRESSES} pages; remove some, or follow the site with a connection of its own.`
        : `A connection follows at most ${WEBSITE_MAX_ADDRESSES} addresses; add another connection for more.`,
    );
  for (const entry of entries.slice(0, maxAddresses)) {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`;
    let parsed: URL | null = null;
    try {
      parsed = new URL(withScheme);
    } catch {
      parsed = null;
    }
    if (parsed && (parsed.username || parsed.password)) {
      problems.push(
        `"${redactPageUrl(withScheme)}" has a user name or password in it; remove it and sign in instead.`,
      );
      continue;
    }
    const scope = siteScopeFor(withScheme);
    if (!scope || (!scope.host.includes('.') && scope.host !== 'localhost')) {
      problems.push(`"${entry.slice(0, 120)}" is not a web address.`);
      continue;
    }
    if (!sites.includes(scope.start)) {
      sites.push(scope.start);
      scopes.push(scope);
    }
  }
  return {
    config: {
      sites,
      scopes,
      followLinks: intIn(c.followLinks, 0, 5, 2),
      maxPages: intIn(c.maxPages, 1, 2000, 150),
      refreshEveryHours: intIn(c.refreshEveryHours, 0, 720, 24),
      screenshots: intIn(c.screenshots, 0, 6, 2),
      exclude: list(c.exclude).slice(0, 50),
      respectRobots: c.respectRobots !== false,
      useBrowser: c.useBrowser !== false,
      allowScriptPost: c.allowScriptPost === true,
      gezelRequests: c.gezelRequests === 'ask' ? 'ask' : 'allow',
    },
    problems,
  };
}

/** The engine scope (and folder) for a site: its host without `www.`. */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

interface Pending {
  page: CrawlPage;
  text: string;
  screenshotNames: string[];
  change: PageChange | null;
}

interface RunState {
  config: WebsiteConfig;
  state: CrawlState;
  stateDir: string;
  session: CaptureSession | null;
  signedIn: SavedSession | null;
  signedOut: boolean;
  passStartedAt: number | null;
  captured: number;
  writesSincePersist: number;
  passIso: string;
}

interface WebsiteCursor {
  at: string;
}

export interface WebsiteAdapterOptions {
  /** Clock (tests step past the refresh window with it). */
  now?: () => number;
  /** Gap between two visits to one host; tests set 0. */
  minHostGapMs?: number;
}

export class WebsiteAdapter implements ConnectorAdapter<NormalizedRecord, WebsiteCursor> {
  readonly typeId = WEBSITE_TYPE_ID;
  /**
   * Everything a pass changes after construction lives in this one object.
   * Callers may wrap an adapter (`Object.create(adapter)` in the conformance
   * kit) and call `close()` on the original: state assigned straight onto
   * `this` would land on the wrapper, and close() would never see it.
   */
  private readonly run: RunState = {
    config: undefined as unknown as WebsiteConfig,
    state: undefined as unknown as CrawlState,
    stateDir: '',
    session: null,
    signedIn: null,
    signedOut: false,
    passStartedAt: null,
    captured: 0,
    writesSincePersist: 0,
    passIso: '',
  };
  private readonly batches = new Map<string, ChangeBatch<WebsiteCursor>>();
  private readonly pending = new Map<string, Pending>();
  private readonly changes = new Map<string, PageChange[]>();
  /** Per site: its first crawl had finished when this pass began. */
  private readonly crawledBefore = new Map<string, boolean>();
  private readonly lastNavAt = new Map<string, number>();

  constructor(
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
    private readonly options: WebsiteAdapterOptions = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get budget() {
    return PASS_BUDGET[this.deps.trigger ?? 'manual'];
  }

  private get stagingRoot(): string {
    return join(this.run.stateDir, 'staging');
  }

  async ensureAuth(): Promise<void> {
    const { config, problems } = parseWebsiteConfig(this.binding.config);
    if (problems.length > 0) throw new Error(problems.join(' '));
    if (!this.deps.stateDir)
      throw new Error('This connection has no private folder to keep its crawl list in.');
    if (!this.deps.capturer) throw new Error('Saving web pages is not available in this build.');
    this.run.config = config;
    this.run.stateDir = this.deps.stateDir;
    this.run.passIso = new Date(this.now()).toISOString();
    await mkdir(this.run.stateDir, { recursive: true });
    this.run.state = await readCrawlState(this.run.stateDir);
    this.run.signedIn = await readSession(
      this.run.stateDir,
      this.deps.secrets,
      this.binding.id,
    ).catch(() => null);
  }

  async listScopes(): Promise<string[]> {
    const configured = [...new Set(this.run.config.scopes.map((s) => siteKey(s.host)))];
    // A site removed from the list still has records; list it once more so
    // its records are removed.
    const leftover = [...new Set(Object.values(this.run.state.pages).map((p) => p.site))].filter(
      (s) => !configured.includes(s),
    );
    return [...configured, ...leftover];
  }

  /**
   * The scopes in force: the person's, plus the folder a start address
   * redirected to within its own site (nodejs.org sends /en/learn/… to
   * /learn/…), remembered so links there are followed and not pruned.
   */
  private allScopes(): SiteScope[] {
    const extra: SiteScope[] = [];
    for (const site of Object.values(this.run.state.sites)) {
      for (const [start, scope] of Object.entries(site.redirectScopes ?? {})) {
        if (this.run.config.sites.includes(start)) extra.push(scope);
      }
    }
    return [...this.run.config.scopes, ...extra];
  }

  private scopesFor(site: string): SiteScope[] {
    return this.allScopes().filter((s) => siteKey(s.host) === site);
  }

  /** Scopes the browser holds a page's navigations to: its sites, any folder. */
  private siteLevelScopes(): SiteScope[] {
    return this.allScopes().map((s) => ({ ...s, pathPrefix: '/' }));
  }

  private knownCount(): number {
    return Object.values(this.run.state.pages).filter(
      (p) => p.state !== 'skipped' && p.state !== 'gone',
    ).length;
  }

  /** Add the person's start addresses as pages, depth 0. */
  private seedStarts(site: string, nowIso: string): void {
    // Only the addresses the person typed; a redirect scope's start is where one landed.
    for (const scope of this.run.config.scopes.filter((s) => siteKey(s.host) === site)) {
      const existing = this.run.state.pages[scope.start];
      if (existing) {
        if (existing.depth !== 0) existing.depth = 0;
        if (existing.state === 'skipped') {
          existing.state = 'queued';
          delete existing.reason;
        }
        continue;
      }
      this.run.state.pages[scope.start] = {
        url: scope.start,
        site,
        depth: 0,
        state: 'queued',
        firstSeenAt: nowIso,
        requestedBy: 'person',
      };
    }
  }

  /**
   * Pages that no longer belong to the connection (the site was removed,
   * narrowed, or an exclude pattern now covers them). Returns the record ids
   * the engine should remove; drops them from the list.
   */
  private pruneOutOfScope(site: string): string[] {
    const removed: string[] = [];
    const scopes = this.scopesFor(site);
    for (const page of Object.values(this.run.state.pages)) {
      if (page.site !== site) continue;
      const isStart = this.run.config.sites.includes(page.url);
      const inScope = scopes.length > 0 && Boolean(scopeOfUrl(page.url, scopes));
      if (!inScope) {
        // Outside every site the person lists: forget it entirely.
        if (page.path) removed.push(page.url);
        this.forgetPage(page.url);
        continue;
      }
      if (isStart || page.state === 'skipped' || page.state === 'gone') continue;
      const asked = page.requestedBy === 'gezel' || page.requestedBy === 'person';
      const excluded = linkRefusal(page.url, { exclude: this.run.config.exclude }) === 'excluded';
      const tooDeep = !asked && page.depth > this.run.config.followLinks;
      if (!excluded && !tooDeep) continue;
      // Still a known link (a gezel may ask for it by name); no longer saved.
      if (page.path) removed.push(page.url);
      delete page.path;
      delete page.screenshots;
      this.settle(
        page,
        'skipped',
        excluded
          ? 'Matches one of the patterns this connection skips.'
          : 'Further from the start address than this connection follows.',
      );
    }
    if (scopes.length === 0) {
      removed.push(`overview:${site}`);
      for (const month of this.run.state.sites[site]?.loggedMonths ?? [])
        removed.push(`changes:${site}:${month}`);
      delete this.run.state.sites[site];
    }
    return removed;
  }

  private isDue(page: CrawlPage, now: number): boolean {
    if (page.state === 'gone' || page.state === 'skipped') return false;
    const cooldown = this.run.state.hostCooldown[page.site];
    if (cooldown && Date.parse(cooldown) > now) return false;
    const trigger = this.deps.trigger ?? 'manual';
    if (page.nextAttemptAt && Date.parse(page.nextAttemptAt) > now) {
      // Sync now retries a failed page, but not one this sync's own follow-up
      // passes just tried, or a refusal would be retried every pass.
      const lastAttempt = page.lastAttemptAt ? Date.parse(page.lastAttemptAt) : 0;
      if (trigger !== 'manual' || now - lastAttempt < MANUAL_FRESH_MS) return false;
    }
    // Asked-for pages only; a request never turns into a full refresh.
    if (trigger === 'request') return page.priority !== undefined;
    if (
      trigger === 'schedule' &&
      this.run.config.refreshEveryHours === 0 &&
      page.priority === undefined
    ) {
      return false;
    }
    if (!page.capturedAt) return true;
    const age = now - Date.parse(page.capturedAt);
    if (page.priority !== undefined) return age >= MANUAL_FRESH_MS;
    if (trigger !== 'schedule') return age >= MANUAL_FRESH_MS;
    return age >= this.run.config.refreshEveryHours * 3_600_000;
  }

  async listChangesSince(
    scope: string,
    _cursor: WebsiteCursor | undefined,
    opts?: { limit?: number },
  ): Promise<ChangeBatch<WebsiteCursor>> {
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    this.crawledBefore.set(scope, this.run.state.sites[scope]?.initialCrawlDone === true);
    this.seedStarts(scope, nowIso);
    const removed = this.pruneOutOfScope(scope);
    const cursor = { at: nowIso };
    if (this.scopesFor(scope).length === 0) {
      const batch: ChangeBatch<WebsiteCursor> = { records: [], cursor, removed };
      this.batches.set(scope, batch);
      return batch;
    }
    const due = Object.values(this.run.state.pages)
      .filter((p) => p.site === scope && this.isDue(p, now))
      .sort(
        (a, b) =>
          (b.priority ?? 0) - (a.priority ?? 0) ||
          a.depth - b.depth ||
          Number(Boolean(a.capturedAt)) - Number(Boolean(b.capturedAt)) ||
          (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''),
      );
    const remaining = Math.max(0, this.budget.pages - this.run.captured);
    const take = due.slice(0, Math.min(remaining, opts?.limit ?? remaining));
    if (take.length > 0 && this.run.signedOut) throw new Error(signedOutMessage(scope));
    if (take.length > 0) await this.ensureSession();
    // Newest-first ordering keys: pages in priority order, then the change
    // log and the overview last, once every page of the pass is on disk.
    const records: RecordRef[] = take.map((p, i) => ({
      id: p.url,
      ordinalKey: take.length - i + 2,
    }));
    records.push({ id: `changes:${scope}`, ordinalKey: 1 });
    records.push({ id: `overview:${scope}`, ordinalKey: 0 });
    const batch: ChangeBatch<WebsiteCursor> = {
      records,
      cursor,
      ...(removed.length > 0 ? { removed } : {}),
      ...(due.length > take.length ? { deferred: true } : {}),
    };
    this.batches.set(scope, batch);
    return batch;
  }

  private async ensureSession(): Promise<CaptureSession> {
    if (this.run.session) return this.run.session;
    const capturer = this.deps.capturer;
    if (!capturer) throw new Error('Saving web pages is not available in this build.');
    try {
      this.run.session = await capturer.open({
        privateHosts: this.run.config.scopes.map((s) => (s.port ? `${s.host}:${s.port}` : s.host)),
        browser: this.run.config.useBrowser,
        allowScriptPost: this.run.signedIn ? this.run.config.allowScriptPost : true,
        ...(this.run.signedIn ? { storageState: this.run.signedIn.state } : {}),
        ...(this.deps.signal ? { signal: this.deps.signal } : {}),
      });
    } catch (err) {
      if (err instanceof CaptureUnavailableError) throw new Error(err.message);
      throw err;
    }
    if (
      this.run.session.render === 'http' &&
      this.run.session.browserUnavailableReason &&
      this.run.config.useBrowser
    ) {
      log.info(`website ${this.binding.id}: ${this.run.session.browserUnavailableReason}`);
    }
    if (this.run.signedIn) await this.probeSignedIn(this.run.session);
    return this.run.session;
  }

  /**
   * Before a signed-in pass touches a page: does the saved sign-in still
   * work? A pass that would only save sign-in walls stops here, with every
   * record left as it was.
   */
  private async probeSignedIn(session: CaptureSession): Promise<void> {
    const probe = this.run.signedIn?.probeUrl ?? this.run.config.sites[0];
    if (!this.run.signedIn || !probe) return;
    const outcome = await session.capture({
      url: probe,
      screenshots: 0,
      maxImages: 0,
      stagingDir: join(this.stagingRoot, 'probe'),
      scopes: this.siteLevelScopes(),
    });
    const site = siteKey(new URL(probe).hostname);
    if (!outcome.ok) {
      if (outcome.kind === 'blocked') {
        this.run.signedOut = true;
        throw new Error(signedOutMessage(site));
      }
      return;
    }
    if (
      looksSignedOut(this.run.signedIn, {
        finalUrl: outcome.finalUrl,
        status: outcome.status,
        title: outcome.metadata.title,
        passwordField: Boolean(outcome.passwordField),
        words: outcome.words,
      })
    ) {
      this.run.signedOut = true;
      throw new Error(signedOutMessage(site));
    }
  }

  private outOfTime(): boolean {
    if (this.run.passStartedAt === null) return false;
    return (
      awakeNow() - this.run.passStartedAt >= this.budget.ms ||
      this.run.captured >= this.budget.pages
    );
  }

  private markDeferred(site: string): void {
    const batch = this.batches.get(site);
    if (batch) batch.deferred = true;
  }

  private markRemoved(site: string, recordId: string): void {
    const batch = this.batches.get(site);
    if (batch) batch.removed = [...(batch.removed ?? []), recordId];
  }

  async fetchRecord(scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    if (ref.id.startsWith('overview:')) {
      return siteOverviewRecord({
        site: scope,
        starts: this.scopesFor(scope).map((s) => s.start),
        pages: Object.values(this.run.state.pages).filter((p) => p.site === scope),
      });
    }
    if (ref.id.startsWith('changes:')) return this.changeLog(scope);
    const page = this.run.state.pages[ref.id];
    if (!page) throw new RecordSkippedError('no longer listed', 'unknown');
    if (this.run.signedOut) throw new RecordSkippedError('signed out', 'signed-out');
    if (this.run.passStartedAt === null) this.run.passStartedAt = awakeNow();
    if (this.outOfTime()) {
      this.markDeferred(scope);
      throw new RecordSkippedError('pass budget reached', 'budget');
    }
    const now = this.now();
    const nowIso = new Date(now).toISOString();
    page.lastAttemptAt = nowIso;

    // robots.txt applies to links the crawler follows, not to addresses the person typed.
    if (page.depth > 0 && page.requestedBy !== 'person' && this.run.config.respectRobots) {
      const rules = await this.robotsFor(page.url);
      const u = new URL(page.url);
      if (!robotsAllows(rules, `${u.pathname}${u.search}`)) {
        this.settle(page, 'skipped', 'The site asks crawlers not to visit this page (robots.txt).');
        throw new RecordSkippedError('robots', 'robots');
      }
    }
    await this.politeWait(page);
    const session = await this.ensureSession();

    // A page whose text the server sends directly can be checked cheaply first.
    if (
      session.render === 'browser' &&
      page.staticText &&
      page.path &&
      (page.etag || page.lastModified)
    ) {
      const pre = await safeFetchPage(page.url, {
        privateHosts: this.run.config.scopes.map((s) => s.host),
        ...(this.deps.fetch ? { fetchImpl: this.deps.fetch } : {}),
        ...(this.deps.signal ? { signal: this.deps.signal } : {}),
        ...(page.etag ? { etag: page.etag } : {}),
        ...(page.lastModified ? { lastModified: page.lastModified } : {}),
      }).catch(() => null);
      if (pre?.status === 304) {
        page.capturedAt = nowIso;
        this.settle(page, page.path ? 'saved' : page.state);
        this.run.captured++;
        throw new RecordSkippedError('not modified', 'unchanged');
      }
    }

    const staging = join(this.stagingRoot, sha8(page.url));
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    const outcome = await session.capture({
      url: page.url,
      screenshots: this.run.config.screenshots,
      maxImages: MAX_IMAGES,
      stagingDir: staging,
      scopes: this.siteLevelScopes(),
      ...(session.render === 'http' && page.etag ? { etag: page.etag } : {}),
      ...(session.render === 'http' && page.lastModified
        ? { lastModified: page.lastModified }
        : {}),
    });
    this.run.captured++;
    this.lastNavAt.set(page.site, Date.now());

    if (!outcome.ok) {
      switch (outcome.kind) {
        case 'not-modified':
          page.capturedAt = nowIso;
          this.settle(page, page.path ? 'saved' : 'queued');
          break;
        case 'gone':
          page.goneCount = (page.goneCount ?? 0) + 1;
          if (page.goneCount >= 2) {
            if (page.path) this.markRemoved(scope, page.url);
            this.recordChange(scope, {
              url: page.url,
              title: page.title ?? page.url,
              kind: 'removed',
            });
            delete page.path;
            delete page.screenshots;
            this.settle(page, 'gone', outcome.message);
          } else {
            this.backoff(page, 'failed', outcome.message, 0);
          }
          break;
        case 'rate-limited': {
          const waitMs = Math.max(10 * 60_000, (outcome.retryAfterSec ?? 0) * 1000);
          this.run.state.hostCooldown[page.site] = new Date(now + waitMs).toISOString();
          page.reason = outcome.message;
          break;
        }
        case 'blocked':
          if (this.run.signedIn) {
            this.run.signedOut = true;
            throw new PassStoppedError(signedOutMessage(page.site));
          }
          this.backoff(page, 'blocked', outcome.message, BLOCKED_RETRY_MS);
          break;
        case 'left-scope':
        case 'not-a-page':
          if (page.depth === 0) this.backoff(page, 'failed', outcome.message, BLOCKED_RETRY_MS);
          else this.settle(page, 'skipped', outcome.message);
          break;
        case 'unavailable':
          throw new PassStoppedError(outcome.message);
        default:
          this.backoff(page, 'failed', outcome.message);
      }
      this.persistSoon();
      throw new RecordSkippedError(outcome.message, outcome.kind);
    }

    if (
      this.run.signedIn &&
      looksSignedOut(this.run.signedIn, {
        finalUrl: outcome.finalUrl,
        status: outcome.status,
        title: outcome.metadata.title,
        passwordField: Boolean(outcome.passwordField),
        words: outcome.words,
      })
    ) {
      this.run.signedOut = true;
      throw new PassStoppedError(signedOutMessage(page.site));
    }

    // The browser kept the page on its site; the folder is checked here, where
    // the page's depth is known.
    const finalUrl = normalizePageUrl(outcome.finalUrl) ?? page.url;
    if (finalUrl !== page.url && !scopeOfUrl(finalUrl, this.allScopes())) {
      const scope = page.depth === 0 ? siteScopeFor(finalUrl) : null;
      if (scope && siteKey(scope.host) === page.site) {
        const siteState = this.run.state.sites[page.site] ?? {};
        this.run.state.sites[page.site] = siteState;
        siteState.redirectScopes = { ...(siteState.redirectScopes ?? {}), [page.url]: scope };
      } else {
        this.settle(
          page,
          'skipped',
          'The address redirected outside the part of the site this connection follows.',
        );
        this.persistSoon();
        throw new RecordSkippedError('redirected out of scope', 'left-scope');
      }
    }
    if (finalUrl !== page.url) this.claimLanding(scope, page, finalUrl);
    this.discoverLinks(page, outcome, nowIso);
    if (outcome.etag) page.etag = outcome.etag;
    else delete page.etag;
    if (outcome.lastModified) page.lastModified = outcome.lastModified;
    else delete page.lastModified;
    page.staticText = outcome.staticText === true;
    page.render = outcome.render;
    page.goneCount = 0;

    // A page that came back nearly empty keeps its earlier copy.
    if (page.path && (page.words ?? 0) >= 200 && outcome.words < (page.words ?? 0) * 0.25) {
      this.backoff(
        page,
        page.state === 'saved' ? 'saved' : 'failed',
        'The page came back nearly empty, so the earlier copy was kept.',
        6 * 3_600_000,
      );
      throw new RecordSkippedError('thin', 'thin');
    }

    const hash = textHash(outcome.markdown);
    if (hash === page.textHash && page.path) {
      page.capturedAt = nowIso;
      if (outcome.metadata.title) page.title = outcome.metadata.title;
      this.settle(page, 'saved');
      this.persistSoon();
      throw new RecordSkippedError('unchanged', 'unchanged');
    }

    if (!page.folder || !page.stem) {
      const loc = pageLocation(page.url);
      page.folder = assignFolder(this.run.state, page.site, loc.folder);
      page.stem = loc.stem;
    }
    const changedAt = nowIso;
    const record = pageRecord({
      page,
      captured: outcome,
      capturedAt: nowIso,
      changedAt,
      signedIn: Boolean(this.run.signedIn),
    });
    const previousText = page.path ? await this.readText(page.url) : null;
    const next: CrawlPage = {
      ...page,
      state: 'saved',
      capturedAt: nowIso,
      changedAt,
      textHash: hash,
      words: outcome.words,
      title: outcome.metadata.title || page.title || page.url,
      signedIn: Boolean(this.run.signedIn),
    };
    delete next.reason;
    delete next.failures;
    delete next.nextAttemptAt;
    delete next.priority;
    this.pending.set(page.url, {
      page: next,
      text: outcome.markdown,
      screenshotNames: outcome.screenshots.map((s) => s.name),
      change: page.path
        ? summarizeChange({
            url: page.url,
            title: next.title ?? page.url,
            before: previousText ?? '',
            after: outcome.markdown,
          })
        : newPageChange({ url: page.url, title: next.title ?? page.url, text: outcome.markdown }),
    });
    return record;
  }

  async recordWritten(
    scope: string,
    ref: RecordRef,
    result: { status: string; relPath?: string },
  ): Promise<void> {
    const pending = this.pending.get(ref.id);
    if (!pending) return;
    this.pending.delete(ref.id);
    const page = pending.page;
    if (result.relPath) {
      page.path = result.relPath;
      const dir = dirname(result.relPath).replace(/\\/g, '/');
      const ordinal = result.relPath.split('/').pop()?.slice(0, 3) ?? '';
      page.screenshots = pending.screenshotNames.map((n) => `${dir}/attachments/${ordinal}/${n}`);
    }
    if (result.status === 'quarantined') {
      page.reason =
        'Held for safety review: its text looked like instructions to an AI, so only a placeholder is saved.';
    }
    this.run.state.pages[ref.id] = page;
    await this.writeText(ref.id, pending.text);
    if (pending.change) {
      this.recordChange(scope, { ...pending.change, ...(page.path ? { path: page.path } : {}) });
    }
    this.persistSoon();
  }

  /**
   * The site's change log for this month. During the first crawl one running
   * line counts the pages saved so far; after it, each pass that changed
   * something adds an entry.
   */
  private changeLog(site: string): NormalizedRecord {
    const siteState = this.run.state.sites[site] ?? {};
    this.run.state.sites[site] = siteState;
    const month = this.run.passIso.slice(0, 7);
    if (siteState.logMonth !== month) {
      siteState.logMonth = month;
      siteState.logEntries = [];
    }
    const entries = siteState.logEntries ?? [];
    siteState.logEntries = entries;
    const pass = this.changes.get(site) ?? [];
    const pages = Object.values(this.run.state.pages).filter((p) => p.site === site);
    const saved = pages.filter((p) => p.path && p.state !== 'gone').length;
    if (!siteState.initialCrawlDone) {
      if (saved > 0) {
        siteState.firstSavedAt ??= this.run.passIso;
        const started = entries.find((e) => e.started !== undefined);
        if (started) started.started = saved;
        else entries.push({ at: siteState.firstSavedAt, started: saved, changes: [] });
        const notAdded = pass.filter((c) => c.kind !== 'added').map(changeForLog);
        if (notAdded.length > 0) entries.push({ at: this.run.passIso, changes: notAdded });
      }
      const waiting = pages.some((p) => p.state === 'queued' && !p.capturedAt);
      if (saved > 0 && !waiting) siteState.initialCrawlDone = true;
    } else if (pass.length > 0) {
      entries.push({ at: this.run.passIso, changes: pass.map(changeForLog) });
    }
    if (entries.length > MONTH_ENTRIES_KEPT) entries.splice(0, entries.length - MONTH_ENTRIES_KEPT);
    if (entries.length === 0)
      throw new RecordSkippedError('nothing logged this month', 'unchanged');
    const months = siteState.loggedMonths ?? [];
    if (!months.includes(month)) siteState.loggedMonths = [...months, month];
    return changeLogRecord({ site, month, entries });
  }

  private recordChange(site: string, change: PageChange): void {
    const list = this.changes.get(site) ?? [];
    list.push(change);
    this.changes.set(site, list);
  }

  /**
   * A page that redirected answers for the address it landed on, so a link to
   * that address is not saved a second time. When the landing address is a
   * page in its own right (saved already, typed or asked for), this one is the
   * duplicate instead.
   */
  private claimLanding(scope: string, page: CrawlPage, finalUrl: string): void {
    const state = this.run.state;
    const landed = state.pages[finalUrl];
    if (
      landed &&
      (landed.path || this.run.config.sites.includes(finalUrl) || landed.priority !== undefined)
    ) {
      if (page.path) this.markRemoved(scope, page.url);
      delete page.path;
      delete page.screenshots;
      this.settle(page, 'skipped', 'Redirects to a page this connection already saves.');
      this.persistSoon();
      throw new RecordSkippedError('redirects to a saved page', 'duplicate');
    }
    if (landed) delete state.pages[finalUrl];
    state.aliases = { ...(state.aliases ?? {}), [finalUrl]: page.url };
  }

  private forgetPage(url: string): void {
    const state = this.run.state;
    delete state.pages[url];
    if (!state.aliases) return;
    for (const [alias, target] of Object.entries(state.aliases)) {
      if (target === url || alias === url) delete state.aliases[alias];
    }
  }

  private discoverLinks(page: CrawlPage, captured: CapturedPage, nowIso: string): void {
    const cap = this.run.config.maxPages;
    const limit = cap * KNOWN_LINKS_FACTOR;
    let known = this.knownCount();
    let total = Object.keys(this.run.state.pages).length;
    for (const link of captured.links) {
      if (total >= limit) break;
      const url = normalizePageUrl(link.href);
      if (!url || crawlPageFor(this.run.state, url)) continue;
      const scope = scopeOfUrl(url, this.allScopes());
      if (!scope) continue;
      const refusal = linkRefusal(url, {
        signedIn: Boolean(this.run.signedIn),
        exclude: this.run.config.exclude,
      });
      if (refusal && refusal !== 'excluded') continue;
      const depth = page.depth + 1;
      const base: CrawlPage = {
        url,
        site: siteKey(scope.host),
        depth,
        state: 'queued',
        firstSeenAt: nowIso,
        ...(link.text ? { title: link.text.slice(0, 160) } : {}),
      };
      if (refusal === 'excluded') {
        // Kept as a known link a gezel can ask for by name; never followed on its own.
        this.run.state.pages[url] = {
          ...base,
          state: 'skipped',
          reason: 'Matches one of the patterns this connection skips.',
        };
      } else if (depth > this.run.config.followLinks) {
        this.run.state.pages[url] = {
          ...base,
          state: 'skipped',
          reason: 'Further from the start address than this connection follows.',
        };
      } else if (known >= cap) {
        this.run.state.pages[url] = {
          ...base,
          state: 'skipped',
          reason: `This connection saves at most ${cap} pages.`,
        };
      } else {
        this.run.state.pages[url] = base;
        known++;
        // Found during this pass, so the person's sync keeps going for it.
        this.markDeferred(base.site);
      }
      total++;
    }
  }

  private settle(page: CrawlPage, state: CrawlPage['state'], reason?: string): void {
    page.state = state;
    if (reason) page.reason = reason;
    else delete page.reason;
    delete page.nextAttemptAt;
    delete page.failures;
    delete page.priority;
  }

  private backoff(
    page: CrawlPage,
    state: CrawlPage['state'],
    reason: string,
    fixedMs?: number,
  ): void {
    const failures = (page.failures ?? 0) + 1;
    const wait =
      fixedMs ?? FAILURE_BACKOFF_MS[Math.min(failures - 1, FAILURE_BACKOFF_MS.length - 1)]!;
    page.state = page.path && state === 'failed' ? 'failed' : state;
    page.reason = reason;
    page.failures = failures;
    page.nextAttemptAt = new Date(this.now() + wait).toISOString();
    delete page.priority;
  }

  private async politeWait(page: CrawlPage): Promise<void> {
    const robots = this.run.state.robots[new URL(page.url).origin]?.rules;
    const gap = Math.max(
      this.options.minHostGapMs ?? MIN_HOST_GAP_MS,
      (robots?.crawlDelaySec ?? 0) * 1000,
    );
    const last = this.lastNavAt.get(page.site);
    if (last === undefined) return;
    const wait = last + gap - Date.now();
    if (wait <= 0) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      this.deps.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async robotsFor(pageUrl: string): Promise<RobotsRules | null> {
    const origin = new URL(pageUrl).origin;
    const cached = this.run.state.robots[origin];
    if (cached && this.now() - Date.parse(cached.fetchedAt) < ROBOTS_TTL_MS) return cached.rules;
    let rules: RobotsRules | null = null;
    try {
      const res = await safeFetchPage(`${origin}/robots.txt`, {
        privateHosts: this.run.config.scopes.map((s) => s.host),
        ...(this.deps.fetch ? { fetchImpl: this.deps.fetch } : {}),
        ...(this.deps.signal ? { signal: this.deps.signal } : {}),
      });
      if (res.status >= 200 && res.status < 300 && res.body.length < 512 * 1024)
        rules = parseRobots(res.body);
    } catch {
      rules = null;
    }
    this.run.state.robots[origin] = { fetchedAt: new Date(this.now()).toISOString(), rules };
    return rules;
  }

  private textPath(url: string): string {
    return join(this.run.stateDir, 'text', `${sha8(url)}.md`);
  }

  private async readText(url: string): Promise<string | null> {
    return readFile(this.textPath(url), 'utf8').catch(() => null);
  }

  private async writeText(url: string, text: string): Promise<void> {
    await mkdir(join(this.run.stateDir, 'text'), { recursive: true });
    await writeFileAtomic(this.textPath(url), text);
  }

  private persistSoon(): void {
    this.run.writesSincePersist++;
    if (this.run.writesSincePersist >= 5) {
      this.run.writesSincePersist = 0;
      void writeCrawlState(this.run.stateDir, this.run.state).catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.run.session) {
      // A signed-in session's cookies rotate; keep the newest while it still works.
      if (
        this.run.signedIn &&
        !this.run.signedOut &&
        this.run.captured > 0 &&
        this.run.session.storageState
      ) {
        const state = (await this.run.session.storageState().catch(() => undefined)) as
          | StorageStateLike
          | undefined;
        if (state) {
          await writeSession(this.run.stateDir, this.deps.secrets, this.binding.id, {
            ...this.run.signedIn,
            state,
            lastVerifiedAt: new Date(this.now()).toISOString(),
          }).catch((err) =>
            log.warn(`website ${this.binding.id}: could not re-save the sign-in: ${err}`),
          );
        }
      }
      await this.run.session.close().catch(() => {});
      this.run.session = null;
    }
    // What the website lookouts see: during a site's first crawl every page
    // is "new", which is not news.
    const changes = [...this.changes.entries()].flatMap(([site, list]) =>
      this.crawledBefore.get(site) ? list : list.filter((c) => c.kind !== 'added'),
    );
    if (changes.length > 0 && this.run.stateDir) {
      await saveChangeBatch(this.run.stateDir, this.run.passIso, changes).catch(() => {});
    }
    if (this.run.state && this.run.stateDir) {
      this.run.state.lastPassAt = new Date(this.now()).toISOString();
      await writeCrawlState(this.run.stateDir, this.run.state).catch((err) =>
        log.warn(`website ${this.binding.id}: could not save the crawl list: ${err}`),
      );
      await rm(this.stagingRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function signedOutMessage(site: string): string {
  return `Signed out of ${site}. Sign in again to keep refreshing these pages; the saved copies are unchanged.`;
}

/** One short line for the Connections row. */
export async function describeWebsiteStatus(ctx: {
  stateDir: string;
  binding: ConnectorBindingRef;
}): Promise<string | undefined> {
  const state = await readCrawlState(ctx.stateDir);
  const pages = Object.values(state.pages);
  if (pages.length === 0) return undefined;
  const saved = pages.filter((p) => p.path && p.state !== 'gone').length;
  const queued = pages.filter((p) => p.state === 'queued').length;
  const failed = pages.filter((p) => p.state === 'failed' || p.state === 'blocked').length;
  const parts = [saved === 1 ? 'Saved 1 page' : `Saved ${saved} pages`];
  if (queued > 0) parts.push(`${queued} waiting`);
  if (failed > 0) parts.push(`${failed} could not be saved`);
  return parts.join(' · ');
}

export function registerWebsiteAdapters(): void {
  registerNativeAdapter(
    WEBSITE_TYPE_ID,
    async (binding, deps) => new WebsiteAdapter(binding, deps),
    {
      validateConfig: (config) => parseWebsiteConfig(config).problems,
      describeStatus: describeWebsiteStatus,
    },
  );
}

/** True when an address sits inside one of the binding's sites. */
export function websiteBindingCovers(
  config: Record<string, unknown> | undefined,
  url: string,
): boolean {
  const { config: parsed } = parseWebsiteConfig(config);
  return (
    parsed.scopes.some((s) => sameSite(new URL(url).hostname, s)) &&
    Boolean(scopeOfUrl(url, parsed.scopes))
  );
}
