import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HandboekArea, HandboekTocArea, HandboekTocEntry } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import {
  createHandboekEngine,
  findHandboekContent,
  siteDeviceInfo,
} from '@bendyline/gezel-service/handboek';
import { generateExternalHtml, markdownDocToPlainHtml } from '@bendyline/squisq-formats/html';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { BASELINE_CSS } from './handboek-site-css.js';

/**
 * Render the Handboek as a static HTML site — the same documentation
 * engine the app serves, in `site` mode (generic: no rosters, no
 * device-specific tables), for publishing on gezel.com or reading
 * offline. Runs entirely standalone: catalog content comes from the
 * installed `@bendyline/gilde` package, curated articles from the
 * shipped handboek content tree. No daemon, no `~/.gezel` state.
 *
 * Layout: `<out>/index.html` (a welcome landing page), `<out>/<article-id>/
 * index.html` (readable page), `<out>/<article-id>/watch.html`
 * (auto-playing slideshow with social captions), `<out>/assets/
 * handboek.css` (baseline styling), `<out>/assets/squisq-player.js` (the
 * player bundle, written once — the catalog generates hundreds of article
 * pages, and inlining the multi-MB player per page balloons the site a
 * thousandfold).
 *
 * Readable pages are semantic HTML, not player mounts. The player renders
 * client-side from a JSON blob, so any hiccup loading the bundle yields a
 * blank page with no content and nothing for a crawler to index. Only
 * `watch.html` — where the slideshow *is* the point — keeps the player.
 */
export interface HandboekExportResult {
  out: string;
  pages: number;
  skipped: string[];
}

export interface HandboekExportOptions {
  out: string;
  /**
   * Extra stylesheet hrefs linked after the baseline sheet, so a host site
   * can restyle the export without forking it. Absolute URLs and
   * root-relative paths pass through untouched; anything else resolves
   * against the export root and picks up the right `../` depth per page.
   */
  css?: string[];
  /**
   * URL of the surrounding site. When set, the masthead carries a `gezel`
   * wordmark linking there, so readers can get back out of the docs. Emitted
   * verbatim — a project-scoped GitHub Pages deploy wants `/<repo>/`, not `/`.
   * Omitted by default: a standalone export has nowhere to go.
   */
  siteUrl?: string;
}

/**
 * Above this many entries an area is summarized in the sidebar rather than
 * listed. The craftbook catalog alone is ~286 articles; inlining it into
 * every page would add megabytes of duplicated markup across the site.
 */
const NAV_INLINE_MAX = 40;

const AREA_BLURBS: Record<HandboekArea, string> = {
  conceptual: 'What gezel is, who your crew are, and how the pieces fit together.',
  'gezel-roles': 'The roles a gezel can take, and what each one is good at.',
  craftbooks: 'Step-by-step recipes your crew can run — one per job.',
  'project-types': 'Ready-made project setups, each with a crew and a bench.',
  technical: 'Architecture, file layout, providers, security, and the CLI.',
};

const START_HERE = ['welcome', 'the-crew', 'projects-and-threads', 'craftbooks-overview'];

/** Set lowercase and italic by the baseline sheet — the product name, not a title. */
const WORDMARK = 'gezel';

export async function runHandboekExport(
  opts: HandboekExportOptions,
): Promise<HandboekExportResult> {
  const out = resolve(opts.out);
  const css = opts.css ?? [];
  const siteUrl = opts.siteUrl;
  const contentDir = findHandboekContent();
  if (!contentDir) {
    throw new Error(
      'no handboek content tree found — run from a gezel checkout or install, or set GEZEL_HANDBOEK_DIR',
    );
  }
  const engine = createHandboekEngine({
    catalog: new CatalogService(),
    device: siteDeviceInfo,
    contentDir,
  });

  const toc = await engine.toc();
  const areas = toc.areas
    .map((a) => ({ ...a, entries: a.entries.filter((e) => e.siteVisible !== false) }))
    .filter((a) => a.entries.length > 0);
  const entries = areas.flatMap((a) => a.entries);
  const ids = new Set(entries.map((e) => e.id));
  const byStem = new Map<string, string>();
  for (const e of entries) {
    const stem = e.id.split('/').pop();
    if (stem && !byStem.has(stem)) byStem.set(stem, e.id);
  }

  await mkdir(join(out, 'assets'), { recursive: true });
  await writeFile(join(out, 'assets', 'squisq-player.js'), PLAYER_BUNDLE, 'utf8');
  const skipped: string[] = [];
  let pages = 0;

  for (const entry of entries) {
    const article = await engine.article(entry.id, { mode: 'site' });
    if (!article) {
      skipped.push(entry.id);
      continue;
    }
    const depth = entry.id.split('/').length;
    const markdown = rewriteSiteLinks(article.markdown, entry.id, ids, byStem);
    const parsed = parseMarkdown(markdown);

    const { html: body, headings } = withHeadingIds(
      wrapTables(extractBody(markdownDocToPlainHtml(parsed, { title: article.title }))),
    );
    const dir = join(out, ...entry.id.split('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'index.html'),
      articlePage({ entry, body, headings, areas, depth, css, siteUrl }),
      'utf8',
    );

    const doc = markdownToDoc(parsed, {
      articleId: article.id,
      defaultDuration: article.defaultDuration ?? 6,
    });
    await writeFile(
      join(dir, 'watch.html'),
      generateExternalHtml(doc, {
        playerScriptPath: `${up(depth)}assets/squisq-player.js`,
        mode: 'slideshow',
        title: article.title,
        autoPlay: true,
        captionStyle: 'social',
      }),
      'utf8',
    );
    pages += 2;
  }

  await writeFile(join(out, 'index.html'), landingPage(areas, css, siteUrl), 'utf8');
  pages += 1;

  const assetsSrc = join(contentDir, 'assets');
  if (existsSync(assetsSrc)) {
    await cp(assetsSrc, join(out, 'assets'), { recursive: true });
  }
  await writeFile(join(out, 'assets', 'handboek.css'), BASELINE_CSS, 'utf8');

  return { out, pages, skipped };
}

/**
 * Rewrite intra-handboek links for the static layout. Articles link two
 * ways — relative `.md` paths in curated prose, bare article ids in
 * generated tables — and both must land on `<root>/<target-id>/` from a
 * page nested at `<root>/<page-id>/`.
 */
export function rewriteSiteLinks(
  markdown: string,
  pageId: string,
  ids: Set<string>,
  byStem: Map<string, string>,
): string {
  const prefix = up(pageId.split('/').length);
  return markdown.replace(/\]\(([^()\s]+)\)/g, (whole, rawTarget: string) => {
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(rawTarget) ||
      rawTarget.startsWith('//') ||
      rawTarget.startsWith('#')
    ) {
      return whole;
    }
    const [path, suffix = ''] = splitLinkSuffix(rawTarget);
    const candidate = path.replace(/\.md$/, '').replace(/^(\.\.?\/)+/, '');
    if (candidate.startsWith('assets/')) {
      return `](${prefix}${candidate}${suffix})`;
    }
    const target = ids.has(candidate) ? candidate : byStem.get(candidate.split('/').pop() ?? '');
    if (!target) return whole;
    return `](${prefix}${target}/${suffix})`;
  });
}

function splitLinkSuffix(raw: string): [string, string] {
  const idx = raw.search(/[?#]/);
  return idx === -1 ? [raw, ''] : [raw.slice(0, idx), raw.slice(idx)];
}

const up = (depth: number): string => '../'.repeat(depth);

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface ArticleHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

/** Pull the rendered body out of squisq's standalone plain-HTML page. */
export function extractBody(page: string): string {
  const match = page.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return (match?.[1] ?? page).trim();
}

/**
 * Give each table its own horizontally-scrollable wrapper. Cells wrap, so
 * most tables never scroll — but the generated catalog tables can carry more
 * columns than a narrow viewport fits, and the overflow has to be contained
 * somewhere or the whole page scrolls sideways. Markdown tables cannot nest,
 * so a non-greedy match is sufficient here.
 */
export function wrapTables(body: string): string {
  return body.replace(
    /<table[\s>][\s\S]*?<\/table>/gi,
    (table) => `<div class="hb-table-scroll">${table}</div>`,
  );
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

/**
 * Add stable anchor ids to h2/h3 and report them, so each page can carry an
 * on-this-page list. squisq's plain renderer emits bare headings.
 */
export function withHeadingIds(body: string): { html: string; headings: ArticleHeading[] } {
  const headings: ArticleHeading[] = [];
  const used = new Map<string, number>();
  const html = body.replace(
    /<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi,
    (whole, lvl: string, attrs: string | undefined, inner: string) => {
      if (attrs && /\sid=/i.test(attrs)) return whole;
      const text = stripTags(inner).trim();
      if (!text) return whole;
      const base = slugify(text);
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      const id = seen === 0 ? base : `${base}-${seen + 1}`;
      headings.push({ id, text, level: Number(lvl) as 2 | 3 });
      return `<h${lvl}${attrs ?? ''} id="${esc(id)}">${inner}</h${lvl}>`;
    },
  );
  return { html, headings };
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

/**
 * Resolve a caller-supplied stylesheet href for a page nested `depth`
 * levels below the export root. Absolute URLs and root-relative paths are
 * left alone; a relative href is taken as relative to the export root.
 */
export function resolveCssHref(href: string, depth: number): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('/')) {
    return href;
  }
  return `${up(depth)}${href}`;
}

function cssLinks(css: string[], depth: number): string {
  return [`${up(depth)}assets/handboek.css`, ...css.map((h) => resolveCssHref(h, depth))]
    .map((href) => `<link rel="stylesheet" href="${esc(href)}">`)
    .join('\n');
}

function head(title: string, css: string[], depth: number, description?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>${
    description ? `\n<meta name="description" content="${esc(description)}">` : ''
  }
${cssLinks(css, depth)}
</head>`;
}

function masthead(
  areas: HandboekTocArea[],
  depth: number,
  siteUrl: string | undefined,
  currentArea?: HandboekArea,
): string {
  const links = areas
    .map((a) => {
      const target = areaLanding(a);
      const current = a.area === currentArea ? ' aria-current="true"' : '';
      return `<a${current} href="${up(depth)}${esc(target)}/">${esc(a.title)}</a>`;
    })
    .join('\n');
  const wordmark = siteUrl ? `<a class="hb-wordmark" href="${esc(siteUrl)}">${WORDMARK}</a>\n` : '';
  return `<header class="hb-masthead">
${wordmark}<a class="hb-brand" href="${up(depth)}">Gezel Handboek</a>
<nav class="hb-areanav">
${links}
</nav>
</header>`;
}

/** An area's own overview article when it has one, else its first entry. */
function areaLanding(area: HandboekTocArea): string {
  const index = area.entries.find((e) => e.id.endsWith('-index') || e.id.endsWith('-overview'));
  return (index ?? area.entries[0])?.id ?? '';
}

function sidebar(areas: HandboekTocArea[], entry: HandboekTocEntry, depth: number): string {
  const sections = areas.map((area) => {
    const isCurrent = area.area === entry.area;
    const items =
      isCurrent && area.entries.length <= NAV_INLINE_MAX
        ? area.entries
        : isCurrent
          ? dedupeById([...area.entries.filter((e) => e.id === areaLanding(area)), entry])
          : [];
    const list = items.length
      ? `<ul>\n${items
          .map((e) => {
            const current = e.id === entry.id ? ' class="hb-current" aria-current="page"' : '';
            return `<li><a${current} href="${up(depth)}${esc(e.id)}/">${esc(e.title)}</a></li>`;
          })
          .join('\n')}\n</ul>`
      : '';
    const more =
      isCurrent && area.entries.length > NAV_INLINE_MAX
        ? `<p class="hb-more"><a href="${up(depth)}${esc(areaLanding(area))}/">All ${area.entries.length} ${esc(area.title.toLowerCase())}</a></p>`
        : '';
    const heading = isCurrent
      ? `<h2 class="hb-current">${esc(area.title)}</h2>`
      : `<h2><a href="${up(depth)}${esc(areaLanding(area))}/">${esc(area.title)}</a></h2>`;
    return `<section>\n${heading}\n${list}\n${more}\n</section>`;
  });
  return `<aside class="hb-sidebar">
<nav aria-label="Handboek sections">
${sections.join('\n')}
</nav>
</aside>`;
}

function dedupeById(list: HandboekTocEntry[]): HandboekTocEntry[] {
  const seen = new Set<string>();
  return list.filter((e) => !seen.has(e.id) && seen.add(e.id));
}

function onThisPage(headings: ArticleHeading[]): string {
  if (headings.length < 2) return '';
  const items = headings
    .map((h) => `<li class="hb-h${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
    .join('\n');
  return `<aside class="hb-onthispage">
<nav aria-label="On this page">
<h2>On this page</h2>
<ul>
${items}
</ul>
</nav>
</aside>`;
}

function articlePage(args: {
  entry: HandboekTocEntry;
  body: string;
  headings: ArticleHeading[];
  areas: HandboekTocArea[];
  depth: number;
  css: string[];
  siteUrl: string | undefined;
}): string {
  const { entry, body, headings, areas, depth, css, siteUrl } = args;
  const area = areas.find((a) => a.area === entry.area);
  const aside = onThisPage(headings);
  return `${head(`${entry.title} — Gezel Handboek`, css, depth, entry.summary)}
<body class="hb hb-article-page">
${masthead(areas, depth, siteUrl, entry.area)}
<div class="hb-layout">
${sidebar(areas, entry, depth)}
<main class="hb-main">
<nav class="hb-breadcrumb" aria-label="Breadcrumb">
<a href="${up(depth)}">Handboek</a>${area ? ` <span>/</span> <a href="${up(depth)}${esc(areaLanding(area))}/">${esc(area.title)}</a>` : ''}
</nav>
<article class="hb-article">
${body}
</article>
<p class="hb-watch"><a href="watch.html">Watch this article as a slideshow</a></p>
</main>
${aside}
</div>
${footer(depth)}
</body>
</html>`;
}

function footer(depth: number): string {
  return `<footer class="hb-footer">
<p><a href="${up(depth)}">Gezel Handboek</a> — documentation for gezel, a crew of AI companions that works for you, from your own computer.</p>
</footer>`;
}

/**
 * The landing page is a welcome, not an index. Listing every article inline
 * buries the ten things a newcomer actually needs under ~300 catalog
 * entries, so generated areas link to their own index article instead.
 */
function landingPage(areas: HandboekTocArea[], css: string[], siteUrl: string | undefined): string {
  const byId = new Map(areas.flatMap((a) => a.entries).map((e) => [e.id, e]));
  const startHere = START_HERE.map((id) => byId.get(id)).filter(
    (e): e is HandboekTocEntry => e !== undefined,
  );

  const startBlock = startHere.length
    ? `<section class="hb-start">
<h2>Start here</h2>
<ul class="hb-cards">
${startHere
  .map(
    (e) =>
      `<li><a href="${esc(e.id)}/"><span class="hb-card-title">${esc(e.title)}</span>${
        e.summary ? `<span class="hb-card-summary">${esc(e.summary)}</span>` : ''
      }</a></li>`,
  )
  .join('\n')}
</ul>
</section>`
    : '';

  const areaBlocks = areas
    .map((area) => {
      const landing = areaLanding(area);
      const featured = area.entries.filter((e) => e.id !== landing);
      const listed = area.entries.length <= NAV_INLINE_MAX ? featured.slice(0, 8) : [];
      const list = listed.length
        ? `<ul class="hb-arealist">
${listed.map((e) => `<li><a href="${esc(e.id)}/">${esc(e.title)}</a></li>`).join('\n')}
</ul>`
        : '';
      return `<section class="hb-area">
<h2><a href="${esc(landing)}/">${esc(area.title)}</a></h2>
<p class="hb-area-blurb">${esc(AREA_BLURBS[area.area] ?? '')}</p>
${list}
<p class="hb-more"><a href="${esc(landing)}/">Browse all ${area.entries.length} ${esc(area.title.toLowerCase())}</a></p>
</section>`;
    })
    .join('\n');

  return `${head('Gezel Handboek', css, 0, 'Documentation for gezel — a crew of AI companions that works for you, from your own computer.')}
<body class="hb hb-home">
${masthead(areas, 0, siteUrl)}
<main class="hb-main hb-home-main">
<section class="hb-hero">
<h1>The Gezel Handboek</h1>
<p class="hb-lede">Gezel lets you assemble a crew of AI companions and put them to work — on your own computer, with your own files. This is their handboek: what they are, what they can do, and how to work with them.</p>
</section>
${startBlock}
<div class="hb-areas">
${areaBlocks}
</div>
</main>
${footer(0)}
</body>
</html>`;
}
