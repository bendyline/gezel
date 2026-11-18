/**
 * What changed on a followed site: one record per site per month under
 * `site-changes/`, refreshed in place each pass that changed something
 * (newest first), plus the same changes kept as JSON in the binding's private
 * folder for the website lookouts. Pages added, changed and removed; each
 * changed page with the lines that appeared and disappeared. A change
 * smaller than a few words updates the page but stays out of the log, so a
 * rotating date or counter does not fill it. While a site's first crawl is
 * still under way, the month's log carries one running "started following"
 * line instead of listing every page as new.
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import type { NormalizedRecord } from '../types.js';
import { orderedFrontmatter } from './social-shared.js';
import { WEBSITE_TYPE_ID } from './website-record.js';

export interface PageChange {
  url: string;
  title: string;
  kind: 'added' | 'changed' | 'removed';
  /** Lines that appeared (changed pages); what a `text-appears` lookout reads. */
  added?: string[];
  /** Lines that disappeared (changed pages). */
  removed?: string[];
  /** Artifact-relative path of the saved page, once written. */
  path?: string;
  /** Lines that appeared / disappeared in all, when the lists were cut for the log. */
  addedCount?: number;
  removedCount?: number;
}

/** A change as the monthly log keeps it: the lines it shows, and how many there were. */
export function changeForLog(change: PageChange): PageChange {
  const { added, removed, ...rest } = change;
  if (change.kind !== 'changed') return rest;
  return {
    ...rest,
    ...(added?.length
      ? { added: added.slice(0, LINES_SHOWN), addedCount: change.addedCount ?? added.length }
      : {}),
    ...(removed?.length
      ? {
          removed: removed.slice(0, LINES_SHOWN),
          removedCount: change.removedCount ?? removed.length,
        }
      : {}),
  };
}

/** One pass's entry in a site's monthly change log. */
export interface ChangeLogEntry {
  at: string;
  /** First crawl: pages saved so far (replaces itself until the crawl is done). */
  started?: number;
  changes: PageChange[];
}

/** Characters a change must touch to be logged. */
const MINOR_CHANGE_CHARS = 40;
/** Lines of each kind the log record shows per page. */
const LINES_SHOWN = 8;
/** Lines kept per page for lookouts. */
const LINES_KEPT = 200;
const LINE_CHARS = 300;
/** Entries one month's record keeps (newest). */
export const MONTH_ENTRIES_KEPT = 120;

function lines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('![') || /^#+\s*How the page looked/.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** A page saved for the first time, with its lines for `text-appears` lookouts. */
export function newPageChange(args: { url: string; title: string; text: string }): PageChange {
  return {
    url: args.url,
    title: args.title,
    kind: 'added',
    added: lines(args.text)
      .slice(0, LINES_KEPT)
      .map((l) => l.slice(0, LINE_CHARS)),
  };
}

/** The change between two captures of a page, or null when it is too small to log. */
export function summarizeChange(args: {
  url: string;
  title: string;
  before: string;
  after: string;
}): PageChange | null {
  const before = lines(args.before);
  const after = lines(args.after);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((l) => !beforeSet.has(l));
  const removed = before.filter((l) => !afterSet.has(l));
  const size = [...added, ...removed].reduce((n, l) => n + l.length, 0);
  if (size < MINOR_CHANGE_CHARS) return null;
  return {
    url: args.url,
    title: args.title,
    kind: 'changed',
    added: added.slice(0, LINES_KEPT).map((l) => l.slice(0, LINE_CHARS)),
    removed: removed.slice(0, LINES_KEPT).map((l) => l.slice(0, LINE_CHARS)),
  };
}

function quote(line: string): string {
  return `> ${line.replace(/\n/g, ' ')}`;
}

function renderEntry(entry: ChangeLogEntry, site: string): string[] {
  const out: string[] = [`## ${entry.at.slice(0, 16).replace('T', ' ')} UTC`, ''];
  if (entry.started !== undefined) {
    out.push(
      entry.started === 1
        ? `Started following ${site}: 1 page saved so far.`
        : `Started following ${site}: ${entry.started} pages saved so far.`,
      '',
    );
  }
  const added = entry.changes.filter((c) => c.kind === 'added');
  const changed = entry.changes.filter((c) => c.kind === 'changed');
  const removed = entry.changes.filter((c) => c.kind === 'removed');
  if (added.length) {
    out.push('New pages:', '');
    for (const c of added) out.push(`- [${c.title}](${c.url})`);
    out.push('');
  }
  for (const c of changed) {
    out.push(`Changed: [${c.title}](${c.url})`, '');
    for (const [label, list, total] of [
      ['Added', c.added, c.addedCount],
      ['Removed', c.removed, c.removedCount],
    ] as const) {
      if (!list?.length) continue;
      out.push(`${label}:`, '', ...list.slice(0, LINES_SHOWN).map(quote));
      const all = total ?? list.length;
      if (all > LINES_SHOWN) {
        const more = all - LINES_SHOWN;
        out.push('', more === 1 ? '…and 1 more line.' : `…and ${more} more lines.`);
      }
      out.push('');
    }
  }
  if (removed.length) {
    out.push('No longer on the site:', '');
    for (const c of removed) out.push(`- ${c.title} — ${c.url}`);
    out.push('');
  }
  return out;
}

/** The month's change log for a site, newest entry first. */
export function changeLogRecord(args: {
  site: string;
  month: string;
  entries: ChangeLogEntry[];
}): NormalizedRecord {
  const { site, month } = args;
  const entries = [...args.entries].sort((a, b) => b.at.localeCompare(a.at));
  const count = (kind: PageChange['kind']) =>
    entries.reduce((n, e) => n + e.changes.filter((c) => c.kind === kind).length, 0);
  const body: string[] = [`# Changes on ${site}, ${month}`, ''];
  for (const entry of entries) body.push(...renderEntry(entry, site));
  return {
    recordId: `changes:${site}:${month}`,
    dirSegments: ['site-changes'],
    fileStem: `${month}--changes`,
    frontmatter: orderedFrontmatter([
      ['kind', 'web-site-changes'],
      ['title', `Changes on ${site}, ${month}`],
      ['site', site],
      ['month', month],
      ['added', count('added')],
      ['changed', count('changed')],
      ['removed', count('removed')],
      ['direction', 'inbound'],
    ]),
    bodyMarkdown: body.join('\n').trimEnd(),
    scanOrigin: 'web-page',
    quarantineNamespace: WEBSITE_TYPE_ID,
    quarantineLabel: `The change log for ${site}`,
  };
}

const CHANGES_DIR = 'changes';
const KEEP_PASSES = 20;

/** Keep a pass's changes where the website lookouts read them. */
export async function saveChangeBatch(
  stateDir: string,
  passIso: string,
  changes: PageChange[],
): Promise<string> {
  const dir = join(stateDir, CHANGES_DIR);
  await mkdir(dir, { recursive: true });
  const name = `${passIso.replace(/[:.]/g, '-')}.json`;
  await writeFileAtomic(join(dir, name), JSON.stringify({ at: passIso, changes }));
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_PASSES))) {
    await rm(join(dir, old), { force: true }).catch(() => {});
  }
  return name;
}

/** Changes from passes newer than `sinceIso`, oldest first. */
export async function readChangeBatches(
  stateDir: string,
  sinceIso?: string,
): Promise<{ at: string; changes: PageChange[] }[]> {
  const dir = join(stateDir, CHANGES_DIR);
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  const out: { at: string; changes: PageChange[] }[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, f), 'utf8')) as {
        at: string;
        changes: PageChange[];
      };
      if (!sinceIso || parsed.at > sinceIso) out.push(parsed);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}
