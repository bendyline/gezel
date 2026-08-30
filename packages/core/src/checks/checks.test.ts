import { describe, expect, it } from 'vitest';
import {
  type WorkspaceLike,
  citationsResolve,
  containsPattern,
  countDistinctMatches,
  cssMinBytes,
  csvShape,
  dataTableSniff,
  detectTypeScriptOnlySyntax,
  detectUnclosedScript,
  esmImports,
  explainSniff,
  extractInlineScripts,
  fileCountByExt,
  fileMinBytes,
  fileMinLines,
  grepMatches,
  htmlCompleteSniff,
  htmlGameSniff,
  imageRefsResolve,
  inlineJsBytes,
  isRealIsoDate,
  jsonPathEquals,
  jsonValid,
  markdownHeadingsMatch,
  namedEntitiesConsistent,
  normalizeDigitGroups,
  notContainsPattern,
  parseCsv,
  parseMarkdownTable,
  readingLevel,
  recordSchema,
  requireOrderedSections,
  resolveRelative,
  tableShape,
  totalMinBytes,
  unsupportedClaims,
  validateScriptSyntax,
  valueGrounding,
  valuesSubsetOf,
  wordBand,
  wrapperReturnHint,
} from './index.js';

function ws(files: Record<string, string>): WorkspaceLike {
  return {
    read: async (f) => files[f] ?? null,
    list: async () => Object.keys(files),
  };
}

const GAME_HTML = `<!doctype html><html><body><canvas id="g"></canvas>
<script>${'const x = 1;'.repeat(50)}</script></body></html>`;

describe('html checks', () => {
  it('detects unclosed scripts (the truncation failure mode)', () => {
    expect(detectUnclosedScript('<script>let a = 1;')).toMatchObject({ unclosed: true });
    expect(detectUnclosedScript('<script>let a = 1;</script>')).toMatchObject({
      unclosed: false,
      opens: 1,
      closes: 1,
    });
  });

  it('extracts inline scripts, skipping src= and non-JS types', () => {
    const html = `<script src="x.js"></script>
<script type="application/ld+json">{}</script>
<script>const a = 1;</script>
<script type="module">import x from './y.js';</script>`;
    const scripts = extractInlineScripts(html);
    expect(scripts).toHaveLength(2);
    expect(scripts[0]?.body).toContain('const a');
  });

  it('validateScriptSyntax flags parse errors but skips modules', () => {
    const good = validateScriptSyntax([{ body: 'const a = 1;', attrs: '' }]);
    expect(good.allParse).toBe(true);
    const bad = validateScriptSyntax([{ body: 'const a = ;', attrs: '' }]);
    expect(bad.allParse).toBe(false);
    expect(bad.firstError).toBeTruthy();
    const mod = validateScriptSyntax([{ body: "import x from 'y';", attrs: ' type="module"' }]);
    expect(mod.allParse).toBe(true);
  });

  it('html sniffs: complete vs truncated vs game', () => {
    expect(htmlCompleteSniff(GAME_HTML)).toBe(true);
    expect(htmlCompleteSniff('<script>let a=1;')).toBe(false);
    expect(htmlGameSniff(GAME_HTML)).toBe(true);
    expect(htmlGameSniff('<html><body><p>hi</p></body></html>')).toBe(false);
    expect(inlineJsBytes(GAME_HTML)).toBeGreaterThan(400);
  });

  it('html-game accepts a canvas-less DOM game driven by a frame loop', () => {
    // gate-liveness regression: a multi-screen DOM arcade game
    // that animates via requestAnimationFrame (no <canvas>/<svg>) is a
    // real, eval-passing game; the canvas-only sniff held it at the build
    // gate. A frame loop + substantial closed script must qualify.
    const domGame = `<!doctype html><html><body>
<div id="screen"></div>
<script>${'let state = {x:0};\nfunction step(){ state.x++; document.getElementById("screen").textContent = state.x; requestAnimationFrame(step); }\n'.repeat(8)}requestAnimationFrame(step);</script>
</body></html>`;
    expect(htmlGameSniff(domGame)).toBe(true);
    // Still excludes a static page with a frame-loop keyword but no real JS.
    expect(htmlGameSniff('<html><body><script>requestAnimationFrame</script></body></html>')).toBe(
      false,
    );
  });
});

describe('markdownHeadingsMatch', () => {
  const outline = [
    '# Deck outline',
    '## Slide 1 — Battle of Trafalgar',
    '## Slide 2 — Strategic stakes',
    '## Slide 3 — What Trafalgar teaches us',
  ].join('\n');

  it('approves an exact H1 title/order projection of the numbered outline', async () => {
    const deck = [
      '# Battle of Trafalgar',
      '- Context',
      '# Strategic stakes',
      '- Why it mattered',
      '# What Trafalgar teaches us',
      '- Closing lesson',
    ].join('\n');
    const result = await markdownHeadingsMatch(
      ws({ 'notes/outline.md': outline, 'deck.md': deck }),
      'deck.md',
      'notes/outline.md',
    );
    expect(result.ok).toBe(true);
    expect(result.documentHeadings).toHaveLength(3);
  });

  it('names the heading LEVEL when the deck uses a title plus ## sections', async () => {
    // The deck converts with slideBreak h1, so ## slides render as one
    // slide. A bare "has 1, locks 3" reads as "add two slides" and models
    // re-emit the same shape until the repair budget is gone.
    const result = await markdownHeadingsMatch(
      ws({
        'notes/outline.md': outline,
        'deck.md': [
          '# Trafalgar deck',
          '## Battle of Trafalgar',
          '## Strategic stakes',
          '## What Trafalgar teaches us',
        ].join('\n'),
      }),
      'deck.md',
      'notes/outline.md',
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('slides are split on H1');
    expect(result.detail).toContain('single slide');
  });

  it('keeps the plain count message when the level is right but the count is not', async () => {
    const result = await markdownHeadingsMatch(
      ws({
        'notes/outline.md': outline,
        'deck.md': '# Battle of Trafalgar\n# Strategic stakes',
      }),
      'deck.md',
      'notes/outline.md',
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('2 H1 slide headings');
    expect(result.detail).not.toContain('single slide');
  });

  it('rejects merged/missing slides and title reordering', async () => {
    const missing = await markdownHeadingsMatch(
      ws({
        'notes/outline.md': outline,
        'deck.md': '# Battle of Trafalgar\n# What Trafalgar teaches us',
      }),
      'deck.md',
      'notes/outline.md',
    );
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('2 H1 slide headings');

    const reordered = await markdownHeadingsMatch(
      ws({
        'notes/outline.md': outline,
        'deck.md': [
          '# Battle of Trafalgar',
          '# What Trafalgar teaches us',
          '# Strategic stakes',
        ].join('\n'),
      }),
      'deck.md',
      'notes/outline.md',
    );
    expect(reordered.ok).toBe(false);
    expect(reordered.mismatchIndex).toBe(1);
  });

  it('does not mistake a bare multi-digit slide number for a titled slide', async () => {
    const result = await markdownHeadingsMatch(
      ws({ 'notes/outline.md': '## Slide 10', 'deck.md': '# 0' }),
      'deck.md',
      'notes/outline.md',
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no numbered slide headings');
  });
});

describe('file checks', () => {
  it('fileMinBytes with and without trim', async () => {
    const w = ws({ 'a.txt': '   x   ' });
    expect((await fileMinBytes(w, 'a.txt', 5)).ok).toBe(true);
    expect((await fileMinBytes(w, 'a.txt', 5, true)).ok).toBe(false);
    const missing = await fileMinBytes(w, 'nope.txt', 1);
    expect(missing).toEqual({ ok: false, detail: 'nope.txt is 0 bytes, need ≥ 1' });
  });

  it('fileMinLines counts non-blank lines', async () => {
    const w = ws({ 'a.md': 'one\n\ntwo\n   \nthree\n' });
    expect((await fileMinLines(w, 'a.md', 3)).ok).toBe(true);
    expect((await fileMinLines(w, 'a.md', 4)).ok).toBe(false);
  });

  it('totalMinBytes and fileCountByExt match gate-eval prose', async () => {
    const w = ws({ 'a.png': 'xx', 'img/b.PNG': 'yy', 'c.txt': 'zz' });
    expect((await totalMinBytes(w, ['a.png', 'c.txt'], 4)).ok).toBe(true);
    const count = await fileCountByExt(w, ['png'], 2);
    expect(count.ok).toBe(true);
    expect(count.matched).toHaveLength(2);
    const scoped = await fileCountByExt(w, ['png'], 2, 'img');
    expect(scoped.ok).toBe(false);
    // The directory is named in the verdict so a repairing model (and the
    // repair-loop's target picker) knows WHERE the missing files go.
    expect(scoped.detail).toBe(
      'found 1 png file(s) in img/, need ≥ 2 — create the missing png file(s) under img/.',
    );
  });

  it('fileCountByExt with verifyImageBytes rejects text stubs and counts real images', async () => {
    // The gameable case this closes: raster books ask for N .png files and
    // a model satisfies the count by writing text placeholders with image
    // names (wild-caught, tileset-batch: "placeholder" bytes in
    // tile-stone-01.png cleared an extension-only count).
    const png = (kb: number): Uint8Array => {
      const body = new Uint8Array(Math.max(1024, kb * 1024));
      body.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      body.set(
        [...'IHDR'].map((c) => c.charCodeAt(0)),
        12,
      );
      body.set(
        [...'IDAT'].map((c) => c.charCodeAt(0)),
        40,
      );
      body.set(
        [...'IEND'].map((c) => c.charCodeAt(0)),
        80,
      );
      return body;
    };
    const bytesByPath: Record<string, Uint8Array> = {
      'tiles/real-1.png': png(2),
      'tiles/real-2.png': png(2),
      'tiles/stub.png': new TextEncoder().encode('placeholder'),
      'tiles/diagram.svg': new TextEncoder().encode('<svg/>'),
    };
    const w: WorkspaceLike = {
      read: async (f) => (f in bytesByPath ? 'x' : null),
      list: async () => Object.keys(bytesByPath),
      readBytes: async (f) => bytesByPath[f] ?? null,
    };
    // Extension-only: the stub counts, so 3 pngs "exist".
    expect((await fileCountByExt(w, ['png'], 3)).ok).toBe(true);
    // Byte-verified: only the two real ones count.
    const verified = await fileCountByExt(w, ['png'], 3, undefined, { verifyImageBytes: true });
    expect(verified.ok).toBe(false);
    expect(verified.matched).toEqual(['tiles/real-1.png', 'tiles/real-2.png']);
    expect(verified.detail).toContain('placeholder/text bytes does not count');
    expect((await fileCountByExt(w, ['png'], 2, undefined, { verifyImageBytes: true })).ok).toBe(
      true,
    );
    // Vector assets are text by nature and must pass through unverified.
    expect((await fileCountByExt(w, ['svg'], 1, undefined, { verifyImageBytes: true })).ok).toBe(
      true,
    );
  });

  it('fileCountByExt refuses rather than degrades when the surface serves no bytes', async () => {
    // Failing closed matters: silently ignoring `verifyImageBytes` on a
    // text-only workspace view would restore the exact gameable behavior
    // the flag exists to remove.
    const textOnly: WorkspaceLike = {
      read: async () => 'x',
      list: async () => ['a.png', 'b.png', 'c.png'],
    };
    const r = await fileCountByExt(textOnly, ['png'], 2, undefined, { verifyImageBytes: true });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('cannot verify image bytes');
  });

  it('cssMinBytes sums inline style + linked local stylesheets', async () => {
    const w = ws({
      'index.html': '<style>body{color:red}</style><link rel="stylesheet" href="./main.css">',
      'main.css': 'h1 { font-size: 2rem; }',
    });
    expect((await cssMinBytes(w, 30)).ok).toBe(true);
    expect((await cssMinBytes(w, 500)).ok).toBe(false);
  });

  it('cssMinBytes counts inline style attributes (fully-inline-styled pages)', async () => {
    const w = ws({
      'index.html':
        '<div style="display:flex; gap:8px; padding:12px">' +
        "<span style='color: #dfe6ff; font-weight: bold'>hi</span></div>",
    });
    // 35 (double-quoted) + 33 (single-quoted) attribute bytes, no <style> block.
    expect((await cssMinBytes(w, 60)).ok).toBe(true);
    expect((await cssMinBytes(w, 200)).ok).toBe(false);
    // The <style> tag itself is not miscounted as an attribute.
    const blockOnly = ws({ 'index.html': '<style>p{margin:0}</style>' });
    const r = await cssMinBytes(blockOnly, 1);
    expect(r.detail).toContain('CSS is 11 bytes');
  });

  it('containsPattern and grepMatches', async () => {
    const w = ws({ 'a.md': 'Game Over', 'b.md': 'nothing', 'src/c.ts': 'Game Over again' });
    expect((await containsPattern(w, 'a.md', 'game over', 'i')).ok).toBe(true);
    expect((await containsPattern(w, 'b.md', 'game over', 'i')).ok).toBe(false);
    expect((await notContainsPattern(w, 'b.md', 'game over', 'i')).ok).toBe(true);
    const forbidden = await notContainsPattern(w, 'a.md', 'game over', 'i');
    expect(forbidden.ok).toBe(false);
    expect(forbidden.detail).toContain('forbidden content');
    const labeledMissing = await containsPattern(
      w,
      'b.md',
      'game over',
      'i',
      'include the game over heading',
    );
    expect(labeledMissing.ok).toBe(false);
    // Quotes the requirement AND the observation (byte count + pattern).
    expect(labeledMissing.detail).toBe(
      'b.md is missing required content: include the game over heading — nothing in its 7 bytes matches /game over/. Add that content.',
    );
    const labeledForbidden = await notContainsPattern(
      w,
      'a.md',
      'game over',
      'i',
      'remove game-over wording',
    );
    expect(labeledForbidden.detail).toBe(
      'a.md contains forbidden content: remove game-over wording (matched "Game Over")',
    );
    const grep = await grepMatches(w, 'game over', { flags: 'i', minMatches: 2 });
    expect(grep.ok).toBe(true);
    expect(grep.matched.sort()).toEqual(['a.md', 'src/c.ts']);
    expect((await grepMatches(w, 'absent')).ok).toBe(false);
  });
});

describe('ref checks', () => {
  it('resolveRelative handles ../, root, and external refs', () => {
    expect(resolveRelative('site/index.html', 'img/logo.png')).toBe('site/img/logo.png');
    expect(resolveRelative('site/index.html', '../logo.png')).toBe('logo.png');
    expect(resolveRelative('index.html', '/assets/a.png')).toBe('assets/a.png');
    expect(resolveRelative('index.html', 'https://x.com/a.png')).toBeNull();
    expect(resolveRelative('index.html', 'data:image/png;base64,xx')).toBeNull();
  });

  it('imageRefsResolve: working vs broken refs', () => {
    const html = '<img src="logo.png"><img src="missing.png">';
    const some = imageRefsResolve(html, 'index.html', ['logo.png']);
    expect(some.ok).toBe(true);
    expect(some.working).toBe(1);
    const all = imageRefsResolve(html, 'index.html', ['logo.png'], true);
    expect(all.ok).toBe(false);
    expect(all.broken).toEqual(['missing.png']);
    expect(imageRefsResolve('<p>no images</p>', 'index.html', []).ok).toBe(false);
  });
});

describe('text checks', () => {
  it('countDistinctMatches dedupes by capture group', () => {
    const text = 'see timeline.md and timeline.md and alerts.md';
    expect(countDistinctMatches(text, /(\w+\.md)/)).toBe(2);
  });

  it('requireOrderedSections enforces order', () => {
    const doc = '# Summary\nstuff\n## Impact\nmore\n# Timeline\n';
    expect(requireOrderedSections(doc, ['Summary', 'Impact', 'Timeline']).ok).toBe(true);
    const out = requireOrderedSections(doc, ['Impact', 'Summary']);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.missing).toBe('Summary');
  });

  it('jsonValid', () => {
    expect(jsonValid('{"a": 1}').ok).toBe(true);
    expect(jsonValid('{nope').ok).toBe(false);
  });

  it('jsonPathEquals checks exact scalar values', async () => {
    const w = ws({
      'audit.json': JSON.stringify({
        summary: { total_records: 6, ready: true },
        rows: [{ id: 'C-001' }],
      }),
    });
    expect((await jsonPathEquals(w, 'audit.json', 'summary.total_records', 6)).ok).toBe(true);
    expect((await jsonPathEquals(w, 'audit.json', '$.rows[0].id', 'C-001')).ok).toBe(true);
    const mismatch = await jsonPathEquals(
      w,
      'audit.json',
      'summary.total_records',
      7,
      'use the CSV row count',
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.detail).toBe(
      'audit.json summary.total_records should equal 7 but was 6: use the CSV row count',
    );
  });
});

describe('grounding checks', () => {
  it('normalizeDigitGroups collapses grouping but spares list punctuation', () => {
    expect(normalizeDigitGroups('$4,217,300')).toContain('4217300');
    expect(normalizeDigitGroups('items 1, 2, 3')).toBe('items 1, 2, 3');
  });

  it('valueGrounding requires the authoritative value and rejects the decoy', () => {
    const facts = [
      { id: 'revenue', label: 'Q3 revenue', required: ['4217300'], forbidden: ['4271300'] },
    ];
    // digit-grouping tolerant: "$4,217,300" matches /4217300/ after normalize
    const good = valueGrounding('Q3 revenue was $4,217,300 (source: signed/q3.md)', facts);
    expect(good.ok).toBe(true);
    expect(good.signals).toEqual(['revenue']);

    const decoy = valueGrounding('Q3 revenue was $4,271,300', facts);
    expect(decoy.ok).toBe(false);
    expect(decoy.decoysDetected).toEqual(['4271300']);
    expect(decoy.detail).toContain('forbidden value');

    const missing = valueGrounding('Q3 revenue was strong', facts);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('no authorized value');
  });

  it('citationsResolve flags fabricated paths and counts resolvable ones', async () => {
    const w = ws({
      'brief.md': 'Revenue per (source: signed/q3.md) and outage per (source: signed/made-up.md).',
      'signed/q3.md': '...',
    });
    const r = await citationsResolve(w, 'brief.md');
    expect(r.ok).toBe(false);
    expect(r.resolved).toEqual(['signed/q3.md']);
    expect(r.unresolved).toEqual(['signed/made-up.md']);

    const okWs = ws({ 'brief.md': 'See (source: signed/q3.md).', 'signed/q3.md': '...' });
    expect((await citationsResolve(okWs, 'brief.md')).ok).toBe(true);
  });

  it('citationsResolve resolves citations the capped listing dropped', async () => {
    const files: Record<string, string> = {
      'brief.md': 'Per (source: signed/q3.md) and (source: signed/fake.md).',
      'signed/q3.md': '...',
    };
    const cappedListing: WorkspaceLike = {
      read: async (f) => files[f] ?? null,
      list: async () => ['brief.md'],
    };
    const r = await citationsResolve(cappedListing, 'brief.md');
    expect(r.resolved).toEqual(['signed/q3.md']);
    expect(r.unresolved).toEqual(['signed/fake.md']);
  });

  it('citationsResolve tolerates trailing bracketed labels but not free prose', async () => {
    // Regression: `(Source: path [Citation 1])` zeroed the citation count
    // because the old regex demanded `)` immediately after the path.
    const w = ws({
      'brief.md':
        'Per (Source: signed/q3.md [Citation 1]) and (source: feeds/status.md, [2]). ' +
        'We should (source: double check the numbers) later.',
      'signed/q3.md': '...',
      'feeds/status.md': '...',
    });
    const r = await citationsResolve(w, 'brief.md', { minCitations: 2 });
    expect(r.ok).toBe(true);
    expect(r.resolved.sort()).toEqual(['feeds/status.md', 'signed/q3.md']);
    // Prose in a source:-prefixed paren is still not mistaken for a path.
    expect(r.unresolved).toEqual([]);

    const annotatedUrl = ws({ 'brief.md': 'Per (source: https://example.com/feed [1]).' });
    const u = await citationsResolve(annotatedUrl, 'brief.md');
    expect(u.ok).toBe(true);
    expect(u.urls).toEqual(['https://example.com/feed']);
  });

  it('citationsResolve fails open on URLs but enforces a corpus allowlist', async () => {
    const w = ws({ 'brief.md': 'Per [the spec](https://example.com/a) we proceed.' });
    expect((await citationsResolve(w, 'brief.md')).ok).toBe(true);
    const gated = await citationsResolve(w, 'brief.md', { corpus: ['https://allowed.com/x'] });
    expect(gated.ok).toBe(false);
    expect(gated.unresolved).toEqual(['https://example.com/a']);
  });
});

describe('record + table checks', () => {
  it('isRealIsoDate rejects fake calendar dates', () => {
    expect(isRealIsoDate('2024-02-29')).toBe(true);
    expect(isRealIsoDate('2025-02-29')).toBe(false);
    expect(isRealIsoDate('2024-13-01')).toBe(false);
    expect(isRealIsoDate('03/14/2024')).toBe(false);
  });

  it('parseCsv handles quoted commas, escaped quotes, and a BOM', () => {
    const grid = parseCsv('\uFEFFid,name\n1,"Smith, Jr."\n2,"a""b"\n');
    expect(grid).toEqual([
      ['id', 'name'],
      ['1', 'Smith, Jr.'],
      ['2', 'a"b'],
    ]);
  });

  it('parseMarkdownTable extracts headers and rows', () => {
    const md = 'intro\n\n| Item | Owner |\n|---|---|\n| Fix | Ana |\n| Ship | Bo |\n\nmore';
    const t = parseMarkdownTable(md);
    expect(t?.headers).toEqual(['Item', 'Owner']);
    expect(t?.rows).toEqual([
      ['Fix', 'Ana'],
      ['Ship', 'Bo'],
    ]);
  });

  it('tableShape enforces required columns, row floor, and column types', () => {
    const md =
      '| Task | Owner | Due |\n|---|---|---|\n| A | Ana | 2025-01-02 |\n| B | Bo | 2025-03-04 |';
    expect(
      tableShape(md, {
        requiredColumns: ['Task', 'Owner', 'Due'],
        minRows: 2,
        columnTypes: { Due: 'iso-date' },
      }).ok,
    ).toBe(true);
    expect(tableShape(md, { requiredColumns: ['Status'] }).detail).toContain('missing required');
    expect(tableShape(md, { minRows: 3 }).detail).toContain('need ≥ 3');
    expect(tableShape(md, { columnTypes: { Due: 'number' } }).ok).toBe(false);
    expect(tableShape('no table here', {}).ok).toBe(false);
  });

  it('recordSchema validates JSON rows and stops at the first gap', () => {
    const spec = {
      fields: [
        { name: 'id', type: 'string' as const },
        { name: 'email', type: 'email' as const },
        { name: 'signupDate', type: 'iso-date' as const },
      ],
      uniqueBy: 'email',
      minRows: 2,
    };
    const good = JSON.stringify([
      { id: 'A', email: 'a@x.com', signupDate: '2024-01-01' },
      { id: 'B', email: 'b@x.com', signupDate: '2024-02-02' },
    ]);
    expect(recordSchema(good, spec).ok).toBe(true);

    const badEmail = JSON.stringify([{ id: 'A', email: 'nope', signupDate: '2024-01-01' }]);
    expect(recordSchema(badEmail, spec).detail).toContain('field "email"');

    const extra = JSON.stringify([
      { id: 'A', email: 'a@x.com', signupDate: '2024-01-01', extra: 1 },
    ]);
    expect(recordSchema(extra, spec).detail).toContain('unexpected field');

    const dup = JSON.stringify([
      { id: 'A', email: 'a@x.com', signupDate: '2024-01-01' },
      { id: 'B', email: 'a@x.com', signupDate: '2024-02-02' },
    ]);
    expect(recordSchema(dup, spec).detail).toContain('duplicate email');

    expect(recordSchema(null, spec).ok).toBe(false);
    expect(recordSchema('{nope', spec).detail).toContain('not valid JSON');
  });

  it('recordSchema validates a CSV deliverable too', () => {
    const csv = 'id,email\n1,a@x.com\n2,b@x.com\n';
    const r = recordSchema(csv, {
      fields: [{ name: 'id' }, { name: 'email', type: 'email' }],
      format: 'csv',
    });
    expect(r.ok).toBe(true);
    expect(r.rowCount).toBe(2);
  });

  it('csvShape validates headers, row count, ragged rows, and allowed values', () => {
    const spec = {
      exactColumns: ['object_type', 'email', 'status'],
      minRows: 2,
      allowedValues: { status: ['Active', 'Renewal Risk', 'Expansion', 'UNMATCHED'] },
    };
    expect(
      csvShape(
        'object_type,email,status\nContact,a@example.com,Expansion\nContact,b@example.com,Renewal Risk\n',
        spec,
      ).ok,
    ).toBe(true);
    expect(
      csvShape(
        'object_type,email,status\nContact,a@example.com,Bad\nContact,b@example.com,Active\n',
        spec,
      ).detail,
    ).toContain('expected one of');
    const ragged = csvShape(
      'object_type,email,status\nContact,a@example.com\nContact,b@example.com,Active\n',
      spec,
    );
    expect(ragged.detail).toContain('column(s), expected');
    expect(ragged.detail).toContain('Keep empty placeholders as adjacent commas');
    expect(ragged.detail).toContain('Header order: object_type | email | status');
    expect(ragged.detail).toContain('Contact | a@example.com');
    expect(csvShape('object_type,email\nContact,a@example.com\n', spec).detail).toContain(
      'header should be exactly',
    );
  });
});

describe('prose checks', () => {
  it('wordBand enforces floors and ceilings, ignoring Markdown by default', () => {
    expect(wordBand('one two three four five', { min: 3, max: 10 }).ok).toBe(true);
    expect(wordBand('one two', { min: 3 }).detail).toContain('need ≥ 3');
    expect(wordBand('one two three four', { max: 2 }).detail).toContain('need ≤ 2');
    // fenced code is excluded from the count
    const md = 'hello world\n```\nlots of code tokens here that should not count\n```';
    expect(wordBand(md, { max: 3 }).words).toBe(2);
  });

  it('readingLevel computes a grade band', () => {
    const simple = readingLevel('The cat sat on the mat. The dog ran fast.', { maxGrade: 6 });
    expect(simple.ok).toBe(true);
    const dense = readingLevel(
      'Notwithstanding the aforementioned contractual indemnification provisions, the counterparties subsequently renegotiated obligations.',
      { maxGrade: 8 },
    );
    expect(dense.ok).toBe(false);
    expect(dense.detail).toContain('grade');
  });

  it('namedEntitiesConsistent flags drifted spellings', () => {
    const entities = [{ canonical: 'Acme Corp', variants: ['ACME Corporation', 'Acme Inc'] }];
    expect(namedEntitiesConsistent('We met Acme Corp twice.', entities).ok).toBe(true);
    const bad = namedEntitiesConsistent('Acme Corp in §1, ACME Corporation in §5.', entities);
    expect(bad.ok).toBe(false);
    expect(bad.violations[0]?.variant).toBe('ACME Corporation');
  });

  it('unsupportedClaims rejects risky claim wording not present in source files', async () => {
    const result = await unsupportedClaims(
      ws({
        'source/brief.md': 'Boreal Desk is launching guided returns intake for Pro accounts.',
        'press-release.md':
          'Boreal Desk fundamentally changes the customer experience for high-volume clients.',
      }),
      'press-release.md',
      ['source/brief.md'],
      [
        { pattern: 'fundamentally(?: changes?)?', label: 'avoid sweeping overclaims' },
        { pattern: 'customer experience', label: 'avoid invented benefit claims' },
        { pattern: 'high-volume clients?', label: 'avoid invented audience claims' },
      ],
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      match: 'fundamentally changes',
      label: 'avoid sweeping overclaims',
    });
    expect(result.detail).toContain('matched "fundamentally changes"');
    expect(result.detail).toContain('source/brief.md');
  });

  it('unsupportedClaims allows risky wording when the source authorizes the exact phrase', async () => {
    const result = await unsupportedClaims(
      ws({
        'source/brief.md': 'Target audience: professional, high-volume clients.',
        'press-release.md':
          'The launch is built for professional, high-volume clients who need intake context.',
      }),
      'press-release.md',
      ['source/brief.md'],
      [{ pattern: 'professional,? high-volume clients?', label: 'avoid invented audience claims' }],
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('unsupportedClaims reports missing sources and invalid patterns as repairable failures', async () => {
    const missing = await unsupportedClaims(
      ws({ 'press-release.md': 'A major step forward.' }),
      'press-release.md',
      ['source/brief.md'],
      [{ pattern: 'major step' }],
    );
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('source/brief.md not found');

    const invalid = await unsupportedClaims(
      ws({ 'source/brief.md': 'brief', 'press-release.md': 'draft' }),
      'press-release.md',
      ['source/brief.md'],
      [{ pattern: '[' }],
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.detail).toBe('invalid unsupported-claims pattern /[/');
  });

  describe('dataTableSniff (data-class deliverable floor)', () => {
    it('accepts a non-empty JSON array of records', () => {
      expect(dataTableSniff('[{"email":"a@b.com","name":"A"}]')).toBe(true);
      expect(dataTableSniff('[1, 2, 3]')).toBe(true);
    });

    it('accepts a comma-delimited table (header + ≥1 row) and a Markdown table', () => {
      expect(dataTableSniff('email,name\na@b.com,A\nc@d.com,C')).toBe(true);
      expect(dataTableSniff('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
    });

    it('strips a leading BOM before parsing', () => {
      expect(dataTableSniff('\uFEFF[{"x":1}]')).toBe(true);
    });

    it('rejects empty input and an empty JSON array', () => {
      expect(dataTableSniff('')).toBe(false);
      expect(dataTableSniff('   \n  ')).toBe(false);
      expect(dataTableSniff('[]')).toBe(false);
    });

    it('rejects a single non-array JSON object (not a record set)', () => {
      expect(dataTableSniff('{"email":"a@b.com"}')).toBe(false);
    });

    it("rejects the transform SCRIPT left in the output's place (the data-wrangle failure)", () => {
      const script = [
        "import fs from 'node:fs';",
        "const rows = JSON.parse(fs.readFileSync('in.json', 'utf8'));",
        'for (const r of rows) { r.email = r.email.toLowerCase(); }',
        "fs.writeFileSync('out.json', JSON.stringify(rows));",
      ].join('\n');
      expect(dataTableSniff(script)).toBe(false);
    });
  });

  describe('esmImports (wrong-source node: imports + require-in-ESM)', () => {
    it('flags a name imported from the wrong builtin, naming the right one', () => {
      const r = esmImports("import { dirname } from 'node:url';", 'a.mjs');
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('dirname');
      expect(r.detail).toContain('node:path');
    });

    it('flags the bookstore double-import (dirname + fileURLToPath both from node:url)', () => {
      const r = esmImports("import { dirname, fileURLToPath } from 'node:url';", 'contract.mjs');
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('dirname');
    });

    it('passes correct sources, including the fixed contract-test split', () => {
      expect(esmImports("import { dirname } from 'node:path';").ok).toBe(true);
      expect(esmImports("import { fileURLToPath } from 'node:url';").ok).toBe(true);
      expect(
        esmImports(
          "import { fileURLToPath } from 'node:url';\nimport { dirname } from 'node:path';",
        ).ok,
      ).toBe(true);
    });

    it('never flags an ambiguous name exported by both builtins (format/parse/resolve)', () => {
      expect(esmImports("import { format } from 'node:url';").ok).toBe(true);
      expect(esmImports("import { parse } from 'node:path';").ok).toBe(true);
    });

    it('handles aliases and a leading default import', () => {
      expect(esmImports("import { dirname as d } from 'node:url';").ok).toBe(false);
      expect(esmImports("import path, { dirname } from 'node:path';").ok).toBe(true);
    });

    it('flags require() in a .mjs file, but not in a .js (which may be CommonJS)', () => {
      expect(esmImports("const x = require('node:fs');", 'tool.mjs').ok).toBe(false);
      expect(esmImports("const x = require('node:fs');", 'tool.js').ok).toBe(true);
    });

    it('passes a file with no node: named imports', () => {
      expect(esmImports("import { foo } from './local.js';\nexport const x = 1;", 'a.js').ok).toBe(
        true,
      );
    });
  });

  describe('explainSniff', () => {
    it('names the truncated-script gap for html-complete', () => {
      const html = '<html><body><script>const a = 1;';
      expect(explainSniff('html-complete', html)).toContain('truncated mid-script');
    });

    it('names the missing closing tag when scripts balance', () => {
      const html = '<html><body><script>x()</script><p>hi</p>';
      expect(explainSniff('html-complete', html)).toContain('</body>');
    });

    it('names the first failed game floor: surface, then script, then JS bytes', () => {
      expect(explainSniff('html-game', '<html><body><p>hi</p></body></html>')).toContain(
        'no render surface',
      );
      expect(explainSniff('html-game', '<canvas></canvas>')).toContain('no <script>');
      const tiny = '<canvas></canvas><script>tick()</script></body></html>';
      expect(explainSniff('html-game', tiny)).toMatch(/inline JavaScript is \d+ bytes/);
    });

    it('quotes the JSON parse error verbatim for json-valid', () => {
      const msg = explainSniff('json-valid', '{"a": 1,}');
      expect(msg).toContain('not valid JSON:');
      expect(msg.length).toBeGreaterThan('not valid JSON: '.length);
    });

    it('has imperative lines for nonempty and data-table', () => {
      expect(explainSniff('nonempty', '')).toContain('empty');
      expect(explainSniff('data-table', 'blah')).toContain('parseable data');
    });
  });

  describe('wrapperReturnHint', () => {
    it('names the wrapper key on an expected-array/got-object mismatch', () => {
      const hint = wrapperReturnHint([
        'CASE dedupe-basic: expected [{"id":"a"}], got {"deduplicatedItems":[{"id":"a"}]}',
      ]);
      expect(hint).toContain('OBJECT');
      expect(hint).toContain('"deduplicatedItems"');
    });

    it('returns null for array-vs-array mismatches (wrong contents, not a wrapper)', () => {
      expect(wrapperReturnHint(['CASE x: expected [{"id":"a"}], got [{"id":"b"}]'])).toBeNull();
      expect(wrapperReturnHint(['some unrelated stderr line'])).toBeNull();
      expect(wrapperReturnHint([])).toBeNull();
    });

    it('falls back to a generic wrapper example when the key is unparseable', () => {
      const hint = wrapperReturnHint(['CASE x: expected [1,2], got {  }']);
      expect(hint).toContain('{ ... }');
    });
  });
});

describe('valuesSubsetOf (transform value conservation)', () => {
  const ID = String.raw`\b([A-Z]-\d{3})\b`;
  const sources = ['id,email\nA-001,x@a.com\nA-002,y@a.com', 'id\nB-003'];

  it('passes when every output id appears in a source', () => {
    const r = valuesSubsetOf('[{"id":"A-001"},{"id":"B-003"}]', sources, { pattern: ID });
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(2);
  });

  it('names renumbered/invented ids concretely (the ETL failure)', () => {
    const r = valuesSubsetOf('[{"id":"C-001"},{"id":"A-002"},{"id":"C-009"}]', sources, {
      pattern: ID,
    });
    expect(r.ok).toBe(false);
    expect(r.invented).toEqual(['C-001', 'C-009']);
    expect(r.detail).toContain('C-001');
    expect(r.detail).toContain('never renumber');
  });

  it('a value-free output passes the subset check but fails a minMatches floor', () => {
    expect(valuesSubsetOf('no ids here', sources, { pattern: ID }).ok).toBe(true);
    const floored = valuesSubsetOf('no ids here', sources, { pattern: ID, minMatches: 1 });
    expect(floored.ok).toBe(false);
    expect(floored.detail).toContain('need ≥ 1');
  });

  it('deduplicates repeated output values and rejects an invalid pattern loudly', () => {
    const r = valuesSubsetOf('A-001 A-001 A-001', sources, { pattern: ID });
    expect(r.checked).toBe(1);
    expect(valuesSubsetOf('x', sources, { pattern: '(' }).ok).toBe(false);
  });

  // Membership is value-level: the output-shaped pattern must NOT be
  // required to match inside the sources. Four wild-caught shapes from the
  // 2026-07-24 craftbook matrix, where the old pattern-level allowed-set
  // came back empty and every grounded value was misflagged as invented.
  it('grounds values whose source encoding differs from the output syntax (JSON key rename)', () => {
    const r = valuesSubsetOf(
      '[{"clip":"c01-intro"},{"clip":"c04-demo"}]',
      ['{"clips":[{"id":"c01-intro","file":"a.mp4"},{"id":"c04-demo","file":"b.mp4"}]}'],
      { pattern: String.raw`"clip"\s*:\s*"([^"]+)"` },
    );
    expect(r.ok).toBe(true);
    expect(r.invented).toEqual([]);
  });

  it('grounds salutation names against a roster that never says Dear', () => {
    const r = valuesSubsetOf(
      'Dear Ruth,\n…\nDear Tomas,\n…\nDear Zephyrine,',
      ['{"people":[{"name":"Ruth Okafor"},{"name":"Tomas Herrera"}]}'],
      { pattern: String.raw`Dear\s+([A-Z][A-Za-z'-]+)` },
    );
    expect(r.ok).toBe(false);
    expect(r.invented).toEqual(['Zephyrine']);
    expect(r.checked).toBe(3);
  });

  it('grounds quoted timecodes against bracketed source timestamps', () => {
    const r = valuesSubsetOf(
      '{"clips":[{"timecode":"00:02:10"},{"timecode":"00:19:44"}]}',
      ['# tape\n[00:02:10] intro begins\n[00:19:44] the demo'],
      { pattern: String.raw`"(\d{2}:\d{2}:\d{2})"` },
    );
    expect(r.ok).toBe(true);
  });

  it('still catches true fabrication under value-level membership', () => {
    const r = valuesSubsetOf(
      '[{"clip":"c01-intro"},{"clip":"c99-invented"}]',
      ['{"clips":[{"id":"c01-intro"}]}'],
      { pattern: String.raw`"clip"\s*:\s*"([^"]+)"` },
    );
    expect(r.ok).toBe(false);
    expect(r.invented).toEqual(['c99-invented']);
  });

  it('honors the i flag for case-insensitive membership', () => {
    const r = valuesSubsetOf('ref RUTH', ['roster: Ruth Okafor'], {
      pattern: String.raw`ref\s+([A-Za-z]+)`,
      flags: 'i',
    });
    expect(r.ok).toBe(true);
  });
});

describe('detectTypeScriptOnlySyntax (TS-in-plain-script diagnosis)', () => {
  it('names the wild-caught non-null assertion (gemma4-31b tankcombat)', () => {
    const js = 'this.y = Math.max(this.radius!, Math.min(h - this.radius, this.y));';
    expect(detectTypeScriptOnlySyntax(js)).toContain('non-null assertion');
    const v = validateScriptSyntax([{ body: js, attrs: '' }]);
    expect(v.allParse).toBe(false);
    expect(v.firstError).toContain('TypeScript-only syntax');
    expect(v.firstError).toContain('plain JavaScript');
  });

  it('catches annotations, casts, and interface declarations', () => {
    expect(detectTypeScriptOnlySyntax('function f(x: number, y: number) {}')).toContain(
      'parameter type annotation',
    );
    expect(detectTypeScriptOnlySyntax('const a = (b) as Thing;')).toContain('`as Type` cast');
    expect(detectTypeScriptOnlySyntax('interface Tank { hp: number }')).toContain('interface');
  });

  it('stays silent on plain JavaScript (negation, !=, regex literals)', () => {
    expect(detectTypeScriptOnlySyntax('if (!ready && a != b) { go(/fast!/); }')).toBeNull();
    expect(detectTypeScriptOnlySyntax('const ok = !!value;')).toBeNull();
  });
});

describe('recordSchema allowExtraFields', () => {
  const spec = {
    fields: [
      { name: 'file', type: 'nonempty', required: true },
      { name: 'severity', type: 'nonempty', required: true },
    ],
  };
  const enriched = JSON.stringify([
    { file: 'src/a.ts', severity: 'high', cwe: 'CWE-89', title: 'SQL injection' },
  ]);

  // Strict is right for a locked-schema data deliverable. It is wrong for a
  // REGISTER: a security review that also records a cwe and a title has
  // produced a better artifact, and failing it grades schema-guessing rather
  // than the review. Wild-caught when claude-sonnet-4-6 was rejected for
  // exactly that on craftbook-deep-security-review.
  it('rejects extra fields by default', () => {
    expect(recordSchema(enriched, spec).ok).toBe(false);
    expect(recordSchema(enriched, spec).detail).toContain('unexpected field');
  });

  it('accepts them when the check opts in', () => {
    expect(recordSchema(enriched, { ...spec, allowExtraFields: true }).ok).toBe(true);
  });

  it('still enforces the required fields when extras are allowed', () => {
    const missing = JSON.stringify([{ file: 'src/a.ts', cwe: 'CWE-89' }]);
    const result = recordSchema(missing, { ...spec, allowExtraFields: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('severity');
  });
});
