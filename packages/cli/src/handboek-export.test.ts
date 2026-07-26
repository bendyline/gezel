import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type HandboekExportResult,
  rewriteSiteLinks,
  runHandboekExport,
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

describe('runHandboekExport', () => {
  let out: string;
  let result: HandboekExportResult;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), 'gezel-handboek-site-'));
    result = await runHandboekExport({ out });
  }, 120_000);

  afterAll(async () => {
    await rm(out, { recursive: true, force: true }).catch(() => {});
  });

  it('writes the TOC, per-article pages, and one shared player bundle', async () => {
    expect(result.pages).toBeGreaterThan(20);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'welcome', 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'welcome', 'watch.html'))).toBe(true);
    expect(existsSync(join(out, 'role', 'meester', 'index.html'))).toBe(true);
    expect(existsSync(join(out, 'assets', 'squisq-player.js'))).toBe(true);
    const toc = await readFile(join(out, 'index.html'), 'utf8');
    expect(toc).toContain('Gezel Handboek');
    expect(toc).toContain('href="welcome/"');
  });

  it('static pages reference the shared player at the right depth', async () => {
    const page = await readFile(join(out, 'welcome', 'index.html'), 'utf8');
    expect(page).toContain('What is gezel?');
    expect(page).toContain('<script src="../assets/squisq-player.js"></script>');
    expect(page).toContain('mode: "static"');
    const nested = await readFile(join(out, 'role', 'meester', 'index.html'), 'utf8');
    expect(nested).toContain('<script src="../../assets/squisq-player.js"></script>');
  });

  it('watch pages autoplay with social captions', async () => {
    const page = await readFile(join(out, 'welcome', 'watch.html'), 'utf8');
    expect(page).toContain('mode: "slideshow"');
    expect(page).toContain('autoPlay: true');
    expect(page).toContain('captionStyle: "social"');
  });

  it('site mode keeps personal data out', async () => {
    const crew = await readFile(join(out, 'the-crew', 'index.html'), 'utf8');
    expect(crew).not.toContain('Your Meester is');
    expect(crew).not.toContain('poppetje/');
  });
});
