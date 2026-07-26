import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HandboekToc, HandboekTocEntry } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import {
  createHandboekEngine,
  findHandboekContent,
  siteDeviceInfo,
} from '@bendyline/gezel-service/handboek';
import { generateExternalHtml } from '@bendyline/squisq-formats/html';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';

/**
 * Render the Handboek as a static HTML site — the same documentation
 * engine the app serves, in `site` mode (generic: no rosters, no
 * device-specific tables), for publishing on gezel.com or reading
 * offline. Runs entirely standalone: catalog content comes from the
 * installed `@bendyline/gilde` package, curated articles from the
 * shipped handboek content tree. No daemon, no `~/.gezel` state.
 *
 * Layout: `<out>/index.html` (the TOC), `<out>/<article-id>/index.html`
 * (readable page), `<out>/<article-id>/watch.html` (auto-playing
 * slideshow with social captions), `<out>/assets/squisq-player.js`
 * (the player bundle, written once — the catalog generates hundreds of
 * article pages, and inlining the multi-MB player per page balloons
 * the site a thousandfold).
 */
export interface HandboekExportResult {
  out: string;
  pages: number;
  skipped: string[];
}

export async function runHandboekExport(opts: { out: string }): Promise<HandboekExportResult> {
  const out = resolve(opts.out);
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
  const entries = toc.areas.flatMap((a) => a.entries).filter((e) => e.siteVisible !== false);
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
    const markdown = rewriteSiteLinks(article.markdown, entry.id, ids, byStem);
    const doc = markdownToDoc(parseMarkdown(markdown), {
      articleId: article.id,
      defaultDuration: article.defaultDuration ?? 6,
    });
    const dir = join(out, ...entry.id.split('/'));
    const playerScriptPath = `${'../'.repeat(entry.id.split('/').length)}assets/squisq-player.js`;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'index.html'),
      generateExternalHtml(doc, { playerScriptPath, mode: 'static', title: article.title }),
      'utf8',
    );
    await writeFile(
      join(dir, 'watch.html'),
      generateExternalHtml(doc, {
        playerScriptPath,
        mode: 'slideshow',
        title: article.title,
        autoPlay: true,
        captionStyle: 'social',
      }),
      'utf8',
    );
    pages += 2;
  }

  await writeFile(join(out, 'index.html'), tocPage(toc, ids), 'utf8');
  pages += 1;

  const assetsSrc = join(contentDir, 'assets');
  if (existsSync(assetsSrc)) {
    await cp(assetsSrc, join(out, 'assets'), { recursive: true });
  }

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
  const up = '../'.repeat(pageId.split('/').length);
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
      return `](${up}${candidate}${suffix})`;
    }
    const target = ids.has(candidate) ? candidate : byStem.get(candidate.split('/').pop() ?? '');
    if (!target) return whole;
    return `](${up}${target}/${suffix})`;
  });
}

function splitLinkSuffix(raw: string): [string, string] {
  const idx = raw.search(/[?#]/);
  return idx === -1 ? [raw, ''] : [raw.slice(0, idx), raw.slice(idx)];
}

function tocPage(toc: HandboekToc, ids: Set<string>): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const areaSection = (title: string, entries: HandboekTocEntry[]): string => {
    const items = entries
      .filter((e) => ids.has(e.id))
      .map(
        (e) =>
          `<li><a href="${esc(e.id)}/">${esc(e.title)}</a>` +
          `${e.summary ? ` <span class="summary">— ${esc(e.summary)}</span>` : ''}` +
          ` <a class="watch" href="${esc(e.id)}/watch.html">watch</a></li>`,
      )
      .join('\n');
    return items ? `<section>\n<h2>${esc(title)}</h2>\n<ul>\n${items}\n</ul>\n</section>` : '';
  };
  const sections = toc.areas
    .map((a) => areaSection(a.title, a.entries))
    .filter(Boolean)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gezel Handboek</title>
<style>
body{margin:0 auto;max-width:46rem;padding:2rem 1.25rem 4rem;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#2b2620;background:#faf6ef}
h1{font-family:Georgia,'Times New Roman',serif}
h2{font-family:Georgia,'Times New Roman',serif;margin-top:2rem;border-bottom:1px solid #ddd3c2;padding-bottom:.25rem}
ul{list-style:none;padding:0}
li{margin:.45rem 0}
a{color:#7a4a21;text-decoration:none}
a:hover{text-decoration:underline}
.summary{color:#6b6257;font-size:.92rem}
.watch{font-size:.8rem;border:1px solid #ddd3c2;border-radius:6px;padding:.05rem .4rem;margin-left:.35rem}
</style>
</head>
<body>
<h1>Gezel Handboek</h1>
<p>The documentation for gezel — a crew of AI companions that works for you, from your own computer. Every article is readable as a page or playable as a captioned video ("watch").</p>
${sections}
</body>
</html>`;
}
