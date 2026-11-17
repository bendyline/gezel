/**
 * The website connector's crawl list: every page a binding knows about, what
 * happened the last time it was visited, and where its record lives. Kept in
 * the binding's private state folder (`crawl.json`), never in project.json
 * (rewritten on every pass, so it must stay small) and never in the corpus
 * (gezels read it, and could write `_` files there).
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SiteScope, WebPageEntry, WebPageState } from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { sha8, slug } from '../writer.js';
import type { ChangeLogEntry } from './website-changes.js';

export interface CrawlPage {
  url: string;
  /** Host of the site scope this page belongs to (the engine scope). */
  site: string;
  /** Links from a start address; 0 for one the person typed. */
  depth: number;
  state: WebPageState;
  reason?: string;
  firstSeenAt: string;
  /** Last successful capture. */
  capturedAt?: string;
  /** Last time its text changed. */
  changedAt?: string;
  lastAttemptAt?: string;
  /** Earliest next attempt after a failure, a block, or a cool-down. */
  nextAttemptAt?: string;
  failures?: number;
  /** Consecutive "no longer exists" answers. */
  goneCount?: number;
  textHash?: string;
  words?: number;
  title?: string;
  /** Record folder under the scope, assigned once and kept. */
  folder?: string[];
  /** File stem, assigned once and kept. */
  stem?: string;
  /** Artifact-relative path of the record, once written. */
  path?: string;
  /** Artifact-relative screenshot paths. */
  screenshots?: string[];
  etag?: string;
  lastModified?: string;
  /** The page's text was in the HTML the server sent; a conditional GET can short-cut a refresh. */
  staticText?: boolean;
  render?: 'browser' | 'http';
  signedIn?: boolean;
  /** Asked for out of turn (a gezel's request, or Save page); captured first. */
  priority?: number;
  requestedBy?: 'gezel' | 'person';
  /** A short synopsis written by the enrichment pass (Stage 2). Untrusted. */
  summary?: string;
}

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelaySec?: number;
}

export interface CrawlState {
  version: 1;
  pages: Record<string, CrawlPage>;
  /** Records per folder key, for the 999-per-folder ordinal limit. */
  folders: Record<string, number>;
  /** robots.txt per host, refreshed daily; null when the site has none. */
  robots: Record<string, { fetchedAt: string; rules: RobotsRules | null }>;
  /** Host → ISO time before which it is not visited (it asked us to slow down). */
  hostCooldown: Record<string, string>;
  /** Per site: whether its first crawl finished, and the month's change-log entries. */
  sites: Record<string, SiteState>;
  /** Address a page landed on after redirecting → the page's own address. */
  aliases?: Record<string, string>;
  lastPassAt?: string;
}

/** The page saved for an address, whether it is the page's own address or one it redirected to. */
export function crawlPageFor(state: CrawlState, url: string): CrawlPage | undefined {
  const own = state.pages[url];
  if (own) return own;
  const target = state.aliases?.[url];
  return target ? state.pages[target] : undefined;
}

export interface SiteState {
  /** Every page found on the first crawl has been visited once. */
  initialCrawlDone?: boolean;
  firstSavedAt?: string;
  /** The change log's current month (`YYYY-MM`) and its entries. */
  logMonth?: string;
  logEntries?: ChangeLogEntry[];
  /** Every month a change log was written for, so removing the site removes them all. */
  loggedMonths?: string[];
  /** Start address → the folder it redirected to within the site. */
  redirectScopes?: Record<string, SiteScope>;
}

export function emptyCrawlState(): CrawlState {
  return { version: 1, pages: {}, folders: {}, robots: {}, hostCooldown: {}, sites: {} };
}

export function crawlFile(stateDir: string): string {
  return join(stateDir, 'crawl.json');
}

export async function readCrawlState(stateDir: string): Promise<CrawlState> {
  try {
    const raw = JSON.parse(await readFile(crawlFile(stateDir), 'utf8')) as Partial<CrawlState>;
    if (raw && raw.version === 1 && raw.pages && typeof raw.pages === 'object') {
      return {
        version: 1,
        pages: raw.pages,
        folders: raw.folders ?? {},
        robots: raw.robots ?? {},
        hostCooldown: raw.hostCooldown ?? {},
        sites: raw.sites ?? {},
        ...(raw.aliases && typeof raw.aliases === 'object' ? { aliases: raw.aliases } : {}),
        ...(raw.lastPassAt ? { lastPassAt: raw.lastPassAt } : {}),
      };
    }
  } catch {
    /* missing or unreadable: start over; the writer dedupes existing records */
  }
  return emptyCrawlState();
}

export async function writeCrawlState(stateDir: string, state: CrawlState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFileAtomic(crawlFile(stateDir), JSON.stringify(state));
}

/** Folder names the artifacts indexer skips, plus the change log's own. */
const RESERVED_FOLDERS = new Set(['attachments', 'shadow', 'tables', 'site-changes']);
/** Records per folder before an overflow folder starts (the writer's ordinal is 3 digits). */
export const FOLDER_RECORD_LIMIT = 900;

/**
 * Where a page's record lives under its site folder: the first two folders of
 * its address become folders, the rest joins the file name. Short paths
 * matter on Windows; stable ones matter everywhere, so a page keeps the
 * folder and stem it was given first.
 */
export function pageLocation(url: string): { folder: string[]; stem: string } {
  const u = new URL(url);
  const segs = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const trailingSlash = u.pathname.endsWith('/');
  const dirs = trailingSlash ? segs : segs.slice(0, -1);
  const page = trailingSlash ? (segs.length ? 'index' : 'home') : (segs.at(-1) ?? 'home');
  const folder = dirs.slice(0, 2).map((d) => {
    const s = slug(d, 40);
    return RESERVED_FOLDERS.has(s) ? `${s}-pages` : s;
  });
  const rest = [...dirs.slice(2), page.replace(/\.(html?|php|aspx?|jsp)$/i, '')];
  let stem = slug(rest.join('-'), 60);
  if (u.search) stem = `${stem.slice(0, 50)}-${sha8(u.search).slice(0, 6)}`;
  return { folder, stem };
}

/** Assign a folder, starting an overflow folder when this one is full. */
export function assignFolder(state: CrawlState, site: string, wanted: string[]): string[] {
  for (let n = 1; ; n++) {
    const folder = n === 1 ? wanted : [...wanted.slice(0, -1), `${wanted.at(-1) ?? 'pages'}-${n}`];
    const key = `${site}/${folder.join('/')}`;
    const count = state.folders[key] ?? 0;
    if (count < FOLDER_RECORD_LIMIT) {
      state.folders[key] = count + 1;
      return folder;
    }
  }
}

/** Parse robots.txt into the rules for us: our own group, else `*`. */
export function parseRobots(text: string): RobotsRules | null {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [] } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'disallow' && value) current.rules.disallow.push(value);
    else if (key === 'allow' && value) current.rules.allow.push(value);
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) current.rules.crawlDelaySec = Math.min(n, 60);
    }
  }
  const ours = groups.find((g) => g.agents.some((a) => a.includes('gezel')));
  const star = groups.find((g) => g.agents.includes('*'));
  return (ours ?? star)?.rules ?? null;
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

/** Whether robots rules allow a path (longest match wins; Allow wins a tie). */
export function robotsAllows(rules: RobotsRules | null, pathAndQuery: string): boolean {
  if (!rules) return true;
  let best = { len: -1, allow: true };
  for (const p of rules.disallow) {
    if (robotsPatternMatches(p, pathAndQuery) && p.length > best.len)
      best = { len: p.length, allow: false };
  }
  for (const p of rules.allow) {
    if (robotsPatternMatches(p, pathAndQuery) && p.length >= best.len)
      best = { len: p.length, allow: true };
  }
  return best.allow;
}

/** The listing the Web pages view and `list_web_pages` read. */
export function webPageEntries(state: CrawlState, bindingId: string): WebPageEntry[] {
  return Object.values(state.pages).map((p) => ({
    url: p.url,
    ...(p.title ? { title: p.title } : {}),
    site: p.site,
    bindingId,
    state: p.state,
    ...(p.reason ? { reason: p.reason } : {}),
    ...(p.path ? { path: p.path } : {}),
    screenshots: p.screenshots ?? [],
    ...(p.capturedAt ? { capturedAt: p.capturedAt } : {}),
    ...(p.changedAt ? { changedAt: p.changedAt } : {}),
    firstSeenAt: p.firstSeenAt,
    ...(p.words !== undefined ? { words: p.words } : {}),
    ...(p.render ? { render: p.render } : {}),
    ...(p.signedIn ? { signedIn: true } : {}),
    depth: p.depth,
    ...(p.summary ? { summary: p.summary } : {}),
  }));
}
