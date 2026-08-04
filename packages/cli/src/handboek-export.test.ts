import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type HandboekExportResult,
  extractBody,
  resolveCssHref,
  rewriteSiteLinks,
  runHandboekExport,
  slugify,
  withHeadingIds,
  wrapTables,
} from './handboek-export.js';

describe('rewriteSiteLinks', () => {
  const ids = new Set(['welcome', 'the-crew', 'role/meester', 'craftbook/status-report']);
  const byStem = new Map([
    ['welcome', 'welcome'],
    ['the-crew', 'the-crew'],
    ['meester', 'role/meester'],
    ['status-report', 'craftbook/status-report'],
  ]);

  it('maps .md relative links and bare ids to nested site paths', () => {
    const out = rewriteSiteLinks(
      'See [crew](the-crew.md), [tech](../technical/the-crew.md), [book](craftbook/status-report).',
      'role/meester',
      ids,
      byStem,
    );
    expect(out).toContain('[crew](../../the-crew/)');
    expect(out).toContain('[tech](../../the-crew/)');
    expect(out).toContain('[book](../../craftbook/status-report/)');
  });

  it('leaves external and unresolved links alone', () => {
    const src = '[site](https://gezelgilde.com) [gone](no-such-page.md) [anchor](#here)';
    expect(rewriteSiteLinks(src, 'welcome', ids, byStem)).toBe(src);
  });
});

describe('extractBody', () => {
  it('takes the body and drops the standalone page chrome', () => {
    const page =
      '<!DOCTYPE html>\n<html><head><style>p{color:red}</style></head>\n<body>\n<p>hi</p>\n</body>\n</html>';
    expect(extractBody(page)).toBe('<p>hi</p>');
  });

  it('falls back to the input when there is no body element', () => {
    expect(extractBody('<p>bare</p>')).toBe('<p>bare</p>');
  });
});

describe('wrapTables', () => {
  it('wraps every table in its own scroll container', () => {
    const out = wrapTables(
      '<p>a</p><table><tr><td>1</td></tr></table><p>b</p><table><tr><td>2</td></tr></table>',
    );
    expect(out).toBe(
      '<p>a</p><div class="hb-table-scroll"><table><tr><td>1</td></tr></table></div>' +
        '<p>b</p><div class="hb-table-scroll"><table><tr><td>2</td></tr></table></div>',
    );
  });

  it('leaves table-free content untouched', () => {
    expect(wrapTables('<p>no tables here</p>')).toBe('<p>no tables here</p>');
  });
});

describe('slugify', () => {
  it('reduces heading text to an anchor', () => {
    expect(slugify('The Meester')).toBe('the-meester');
    expect(slugify('Tools & toolsets!')).toBe('tools-toolsets');
  });

  it('never yields an empty anchor', () => {
    expect(slugify('!!!')).toBe('section');
  });
});

describe('withHeadingIds', () => {
  it('adds anchors to h2/h3 and reports them in document order', () => {
    const { html, headings } = withHeadingIds(
      '<h1>Title</h1><h2>First up</h2><p>x</p><h3>Nested <em>bit</em></h3>',
    );
    expect(html).toContain('<h2 id="first-up">First up</h2>');
    expect(html).toContain('<h3 id="nested-bit">');
    expect(headings).toEqual([
      { id: 'first-up', text: 'First up', level: 2 },
      { id: 'nested-bit', text: 'Nested bit', level: 3 },
    ]);
  });

  it('disambiguates repeated headings so anchors stay unique', () => {
    const { headings } = withHeadingIds('<h2>Notes</h2><h2>Notes</h2><h2>Notes</h2>');
    expect(headings.map((h) => h.id)).toEqual(['notes', 'notes-2', 'notes-3']);
  });

  it('leaves h1 and already-anchored headings untouched', () => {
    const { html, headings } = withHeadingIds('<h1>Top</h1><h2 id="kept">Kept</h2>');
    expect(html).toBe('<h1>Top</h1><h2 id="kept">Kept</h2>');
    expect(headings).toEqual([]);
  });
});

describe('resolveCssHref', () => {
  it('passes absolute and root-relative hrefs through untouched', () => {
    expect(resolveCssHref('https://cdn.example/a.css', 3)).toBe('https://cdn.example/a.css');
    expect(resolveCssHref('//cdn.example/a.css', 3)).toBe('//cdn.example/a.css');
    expect(resolveCssHref('/handboek.css', 2)).toBe('/handboek.css');
  });

  it('resolves relative hrefs against the export root at each page depth', () => {
    expect(resolveCssHref('../handboek.css', 0)).toBe('../handboek.css');
    expect(resolveCssHref('../handboek.css', 1)).toBe('../../handboek.css');
    expect(resolveCssHref('../handboek.css', 2)).toBe('../../../handboek.css');
  });
});

describe('runHandboekExport', () => {
  let out: string;
  let result: HandboekExportResult;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'gezel-handboek-site-'));
    result = await runHandboekExport({ out, css: ['../house.css'], siteUrl: '/' });
  }, 120_000);

  afterAll(async () => {
    await rm(out, { recursive: true, force: true }).catch(() => {});
  });

  it('writes the landing page, per-article pages, and the shared assets', async () => {
    expect(result.pages).toBeGreaterThan(20);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'welcome', 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'welcome', 'watch.html'))).toBe(true);
    expect(existsSync(join(out, 'role', 'meester', 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'assets', 'squisq-player.js'))).toBe(true);
    expect(existsSync(join(out, 'assets', 'handboek.css'))).toBe(true);
  });

  it('renders readable pages as semantic HTML, with no player dependency', async () => {
    const page = await readFile(join(out, 'the-crew', 'index.html'), 'utf8');
    expect(page).toContain('<article class="hb-article">');
    expect(page).toMatch(/<h1[^>]*>Your crew<\/h1>/);
    expect(page).not.toContain('squisq-player.js');
    expect(page).not.toContain('SquisqPlayer.mount');
  });

  it('gives every page an on-this-page list built from its own headings', async () => {
    const page = await readFile(join(out, 'the-crew', 'index.html'), 'utf8');
    expect(page).toContain('<aside class="hb-onthispage">');
    expect(page).toContain('>On this page<');
    const anchors = [...page.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(0);
    for (const id of anchors) expect(page).toContain(`href="#${id}"`);
  });

  it('links the masthead wordmark out to the surrounding site', async () => {
    for (const page of [
      'index.html',
      join('the-crew', 'index.html'),
      join('role', 'meester', 'index.html'),
    ]) {
      const html = await readFile(join(out, page), 'utf8');
      expect(html).toContain('<a class="hb-wordmark" href="/">gezel</a>');
    }
  });

  it('omits the wordmark entirely when no site url is given', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'gezel-handboek-bare-'));
    try {
      await runHandboekExport({ out: bare });
      const html = await readFile(join(bare, 'index.html'), 'utf8');
      expect(html).not.toContain('hb-wordmark');
      expect(html).toContain('class="hb-brand"');
    } finally {
      await rm(bare, { recursive: true, force: true }).catch(() => {});
    }
  }, 120_000);

  it('puts generated catalog tables in a scroll container and lets cells wrap', async () => {
    const page = await readFile(join(out, 'craftbooks-index', 'index.html'), 'utf8');
    expect(page).toContain('<div class="hb-table-scroll"><table>');
    const css = await readFile(join(out, 'assets', 'handboek.css'), 'utf8');
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/white-space:\s*nowrap/);
  });

  it('carries section navigation on every page', async () => {
    const page = await readFile(join(out, 'the-crew', 'index.html'), 'utf8');
    expect(page).toContain('<aside class="hb-sidebar">');
    expect(page).toContain('Craftbooks');
    expect(page).toContain('class="hb-breadcrumb"');
  });

  it('omits the on-this-page list when an article has too few headings', async () => {
    const sparse = await readFile(join(out, 'craftbook', 'status-report', 'index.html'), 'utf8');
    expect(sparse).not.toContain('hb-onthispage');
    const rich = await readFile(join(out, 'the-crew', 'index.html'), 'utf8');
    expect(rich).toContain('hb-onthispage');
    expect(sparse).toContain('class="hb-layout"');
    expect(rich).toContain('class="hb-layout"');
  });

  it('summarizes oversized areas in the sidebar instead of listing them', async () => {
    const page = await readFile(join(out, 'craftbook', 'status-report', 'index.html'), 'utf8');
    const links = [...page.matchAll(/href="\.\.\/\.\.\/craftbook\//g)];
    expect(links.length).toBeLessThan(10);
    expect(page).toMatch(/All \d+ craftbooks/);
  });

  it('links the baseline sheet then caller sheets, at the right depth', async () => {
    const home = await readFile(join(out, 'index.html'), 'utf8');
    expect(home).toContain('<link rel="stylesheet" href="assets/handboek.css">');
    expect(home).toContain('<link rel="stylesheet" href="../house.css">');
    const nested = await readFile(join(out, 'role', 'meester', 'index.html'), 'utf8');
    expect(nested).toContain('<link rel="stylesheet" href="../../assets/handboek.css">');
    expect(nested).toContain('<link rel="stylesheet" href="../../../house.css">');
    expect(nested.indexOf('assets/handboek.css')).toBeLessThan(nested.indexOf('house.css'));
  });

  it('makes the landing page a welcome, not a dump of every article', async () => {
    const home = await readFile(join(out, 'index.html'), 'utf8');
    expect(home).toContain('The Gezel Handboek');
    expect(home).toContain('Start here');
    expect(home).toContain('href="welcome/"');
    expect(home).toMatch(/Browse all \d+ craftbooks/);
    const craftbookLinks = [...home.matchAll(/href="craftbook\//g)];
    expect(craftbookLinks.length).toBeLessThan(10);
  });

  it('watch pages keep the player and autoplay with social captions', async () => {
    const page = await readFile(join(out, 'welcome', 'watch.html'), 'utf8');
    expect(page).toContain('<script src="../assets/squisq-player.js"></script>');
    expect(page).toContain('mode: "slideshow"');
    expect(page).toContain('autoPlay: true');
    expect(page).toContain('captionStyle: "social"');
    const nested = await readFile(join(out, 'role', 'meester', 'watch.html'), 'utf8');
    expect(nested).toContain('<script src="../../assets/squisq-player.js"></script>');
  });

  it('site mode keeps personal data out', async () => {
    const crew = await readFile(join(out, 'the-crew', 'index.html'), 'utf8');
    expect(crew).not.toContain('Your Meester is');
    expect(crew).not.toContain('poppetje/');
  });
});
