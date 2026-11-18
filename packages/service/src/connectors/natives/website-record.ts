/**
 * Records the website connector writes: one per saved page, and one site
 * overview per site listing every saved page. Both go through the shared
 * writer, which scans the body, labels it `trust: untrusted-external` and
 * quarantines anything that tries to instruct a gezel.
 */

import type { CapturedPage } from '../../page-capture/types.js';
import type { NormalizedRecord } from '../types.js';
import { orderedFrontmatter } from './social-shared.js';
import type { CrawlPage } from './website-crawl.js';

export const WEBSITE_TYPE_ID = 'website';

/** Frontmatter written fresh on every capture, left out of the content hash. */
const VOLATILE_KEYS = ['captured'];

function oneLine(s: string | undefined, max = 300): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
}

/** A screenshot's caption, by its position. */
function shotCaption(name: string, index: number): string {
  if (index === 0 || name === 'view-1.jpg')
    return 'The top of the page, as a visitor first sees it';
  return `Further down the page (${index + 1})`;
}

export function pageRecord(args: {
  page: CrawlPage;
  captured: CapturedPage;
  capturedAt: string;
  changedAt: string;
  signedIn: boolean;
}): NormalizedRecord {
  const { page, captured } = args;
  const title = oneLine(captured.metadata.title, 200) || page.url;
  let body = captured.markdown.trim();
  if (!/^#\s/.test(body)) body = `# ${title}\n\n${body}`;
  if (captured.screenshots.length > 0) {
    const shots = captured.screenshots
      .map((s, i) => `![${shotCaption(s.name, i)}](attachment:${s.name})`)
      .join('\n\n');
    body = `${body}\n\n## How the page looked\n\n${shots}`;
  }
  return {
    recordId: page.url,
    dirSegments: page.folder ?? [],
    fileStem: page.stem ?? 'page',
    frontmatter: orderedFrontmatter([
      ['kind', 'web-page'],
      ['title', title],
      ['url', page.url],
      ['site', page.site],
      ['description', oneLine(captured.metadata.description)],
      ['author', oneLine(captured.metadata.author, 120)],
      ['published', oneLine(captured.metadata.published, 40)],
      ['modified', oneLine(captured.metadata.modified, 40)],
      ['language', oneLine(captured.metadata.lang, 20)],
      ['captured', args.capturedAt],
      ['changed', args.changedAt],
      ['words', captured.words],
      ['render', captured.render],
      ['signed_in', args.signedIn ? 'yes' : 'no'],
      ['direction', 'inbound'],
    ]),
    bodyMarkdown: body,
    scanOrigin: 'web-page',
    quarantineNamespace: WEBSITE_TYPE_ID,
    quarantineLabel: `The page ${page.url}`,
    attachments: [...captured.screenshots, ...captured.images].map((f) => ({
      filename: f.name,
      sourcePath: f.path,
      sha256: f.sha256,
      size: f.size,
    })),
    volatileKeys: VOLATILE_KEYS,
  };
}

/** The record's path relative to its site folder (where the overview sits). */
function relativeToSite(page: CrawlPage): string | null {
  if (!page.path) return null;
  const parts = page.path.split('/');
  return parts.slice(-((page.folder?.length ?? 0) + 1)).join('/');
}

/**
 * One file per site that lists every saved page: title, address, when it
 * last changed, and a link to its record. Gives a gezel a map of the site
 * without listing folders, and a person a table of contents.
 */
export function siteOverviewRecord(args: {
  site: string;
  starts: string[];
  pages: CrawlPage[];
}): NormalizedRecord {
  const saved = args.pages
    .filter((p) => p.path && (p.state === 'saved' || p.state === 'failed' || p.state === 'blocked'))
    .sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url));
  const lines: string[] = [`# ${args.site}`, ''];
  lines.push(
    saved.length === 1
      ? 'One page of this site is saved.'
      : `${saved.length} pages of this site are saved.`,
    '',
  );
  for (const p of saved) {
    const rel = relativeToSite(p);
    const title = oneLine(p.title, 120) || p.url;
    const changed = p.changedAt ? ` (changed ${p.changedAt.slice(0, 10)})` : '';
    lines.push(
      rel
        ? `- [${title}](${encodeURI(rel)}) — ${p.url}${changed}`
        : `- ${title} — ${p.url}${changed}`,
    );
    if (p.summary) lines.push(`  ${oneLine(p.summary, 400)}`);
  }
  const notSaved = args.pages.filter(
    (p) => !p.path && (p.state === 'failed' || p.state === 'blocked'),
  );
  if (notSaved.length > 0) {
    lines.push('', '## Not saved', '');
    for (const p of notSaved.slice(0, 50)) lines.push(`- ${p.url} — ${p.reason ?? p.state}`);
  }
  return {
    recordId: `overview:${args.site}`,
    dirSegments: [],
    fileStem: 'site-overview',
    frontmatter: orderedFrontmatter([
      ['kind', 'web-site'],
      ['title', `${args.site}: saved pages`],
      ['site', args.site],
      ['start_addresses', args.starts.join(', ')],
      ['pages', saved.length],
      ['direction', 'inbound'],
    ]),
    bodyMarkdown: lines.join('\n'),
    scanOrigin: 'web-page',
    quarantineNamespace: WEBSITE_TYPE_ID,
    quarantineLabel: `The overview of ${args.site}`,
  };
}
