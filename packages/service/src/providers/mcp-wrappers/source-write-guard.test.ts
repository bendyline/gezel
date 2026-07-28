import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceWriteGuard } from './source-write-guard.js';
import type { McpToolWrapperContext } from './types.js';

function ctx(
  existing: string | null = null,
  modelTier: McpToolWrapperContext['modelTier'] = 'tiny',
): McpToolWrapperContext {
  return {
    spec: {
      command: 'node',
      args: ['/repo/packages/mcp/dist/server.js'],
      env: {},
    },
    cwd: '/tmp',
    modelTier,
    isMeester: false,
    hasTool: (name) => name === 'read_file',
    callTool: async () => {
      if (existing === null) throw new Error('not found');
      return { text: existing, images: [] };
    },
  };
}

// A substantial (>= 800 byte, >= 25 line) TypeScript source file with two
// independent functions — the shape where the same-file clobber bites.
function bigSource(opts: { greatCircle?: boolean; graceful?: boolean } = {}): string {
  const pathFn = opts.greatCircle
    ? '  // great-circle sampling\n  const A = Math.sin((1 - t) * d) / Math.sin(d);\n  const B = Math.sin(t * d) / Math.sin(d);\n  const x = A * Math.cos(f1) + B * Math.cos(f2);\n  return Math.atan2(x, B);'
    : '  // linear interpolation\n  const lat = a.lat + t * (b.lat - a.lat);\n  const lng = a.lng + t * (b.lng - a.lng);\n  return { lat, lng };';
  const guard = opts.graceful
    ? '  if (hash.length !== 4) {\n    return [];\n  }'
    : `  if (hash.length !== 4) {\n    throw new Error('bad geohash');\n  }`;
  return [
    "import { haversineDistance } from './Haversine.ts';",
    '',
    'const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";',
    '',
    'export function decodeGeohashCenter(hash: string): { lat: number; lng: number } {',
    '  let latLo = -90, latHi = 90, lngLo = -180, lngHi = 180, isLng = true;',
    '  for (const ch of hash) {',
    '    const idx = BASE32.indexOf(ch);',
    '    if (idx < 0) continue;',
    '    for (let bit = 4; bit >= 0; bit--) {',
    '      const b = (idx >> bit) & 1;',
    '      if (isLng) { const m = (lngLo + lngHi) / 2; if (b) lngLo = m; else lngHi = m; }',
    '      else { const m = (latLo + latHi) / 2; if (b) latLo = m; else latHi = m; }',
    '      isLng = !isLng;',
    '    }',
    '  }',
    '  return { lat: (latLo + latHi) / 2, lng: (lngLo + lngHi) / 2 };',
    '}',
    '',
    'export function getGeohashPath(from: string, to: string): unknown {',
    '  const a = decodeGeohashCenter(from);',
    '  const b = decodeGeohashCenter(to);',
    '  const d = haversineDistance(a.lat, a.lng, b.lat, b.lng);',
    '  const t = 0.5, f1 = a.lat, f2 = b.lat;',
    pathFn,
    '}',
    '',
    'export function getGeohash4Neighbors(hash: string): string[] {',
    guard,
    '  return [hash, hash, hash, hash];',
    '}',
    '',
  ].join('\n');
}

describe('SourceWriteGuard — same-file clobber guard (flag-gated, off by default)', () => {
  // The guard ships disabled (it backfired on e4b — see the source comment).
  // Enable it for the behavior tests; verify the default-off path separately.
  beforeEach(() => {
    process.env.GEZEL_SAME_FILE_REWRITE_GUARD = '1';
  });
  afterEach(() => {
    delete process.env.GEZEL_SAME_FILE_REWRITE_GUARD;
  });

  it('is a no-op when the flag is unset (default), even for a small-change rewrite', async () => {
    delete process.env.GEZEL_SAME_FILE_REWRITE_GUARD; // simulate the shipped default
    const existing = bigSource({ greatCircle: true, graceful: false });
    const rewrite = bigSource({ greatCircle: false, graceful: true });
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'packages/core/src/spatial/Geohash.ts', content: rewrite },
      ctx(existing),
    );
    expect(verdict?.kind).toBe('allow');
  });

  it('redirects a full rewrite of a substantial file that only changes one region', async () => {
    const existing = bigSource({ greatCircle: true, graceful: false });
    // Model rewrites the whole file to fix the guard, but regenerates the
    // path function as the OLD linear version — clobbering the great-circle fix.
    const rewrite = bigSource({ greatCircle: false, graceful: true });
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'packages/core/src/spatial/Geohash.ts', content: rewrite },
      ctx(existing),
    );
    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({ error: expect.stringContaining('replace_in_file') });
    expect(verdict).toMatchObject({ error: expect.stringContaining('Refusing to rewrite') });
  });

  it('allows the SAME rewrite for large/cloud tiers (open surface)', async () => {
    const existing = bigSource({ greatCircle: true, graceful: false });
    const rewrite = bigSource({ greatCircle: false, graceful: true });
    for (const tier of ['large', 'cloud'] as const) {
      const verdict = await SourceWriteGuard.preProcess?.(
        'write_file',
        { path: 'packages/core/src/spatial/Geohash.ts', content: rewrite },
        ctx(existing, tier),
      );
      expect(verdict?.kind).toBe('allow');
    }
  });

  it('allows a genuine overhaul (most of the file changed)', async () => {
    const existing = bigSource({ greatCircle: true, graceful: false });
    const overhaul = [
      '// Completely rewritten module with a different design.',
      'export type Coord = readonly [number, number];',
      'export class SpatialIndex {',
      ...Array.from(
        { length: 30 },
        (_, i) => `  method${i}(x: number): number { return x * ${i} + 7; }`,
      ),
      '}',
    ].join('\n');
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'packages/core/src/spatial/Geohash.ts', content: overhaul },
      ctx(existing),
    );
    expect(verdict?.kind).toBe('allow');
  });

  it('allows a full rewrite of a NEW file (nothing on disk)', async () => {
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'packages/core/src/spatial/Geohash.ts', content: bigSource({ greatCircle: true }) },
      ctx(null),
    );
    expect(verdict?.kind).toBe('allow');
  });

  it('allows a no-op full rewrite (identical content)', async () => {
    const same = bigSource({ greatCircle: true, graceful: false });
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'packages/core/src/spatial/Geohash.ts', content: same },
      ctx(same),
    );
    expect(verdict?.kind).toBe('allow');
  });
});

describe('SourceWriteGuard', () => {
  it('rejects visibly truncated HTML writes', async () => {
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content: '<!doctype html><html><head><meta charset=' },
      ctx(),
    );

    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({
      error: expect.stringContaining('looks truncated'),
    });
  });

  it('rejects destructive short overwrites of source files', async () => {
    const existing = `${'<!doctype html><html><body><script>'.padEnd(500, 'x')}</script></body></html>`;
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content: '<!doctype html><html><body>tiny</body></html>' },
      ctx(existing),
    );

    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({
      error: expect.stringContaining('much shorter source file'),
    });
  });

  it('rejects destructive whole-file replacements made through replace_lines', async () => {
    const existing = [
      '// Cursor-based pagination over an in-memory list.',
      ...Array.from({ length: 31 }, (_, index) => `export const value${index} = ${index};`),
    ].join('\n');
    const verdict = await SourceWriteGuard.preProcess?.(
      'replace_lines',
      {
        path: 'lib/paginate.mjs',
        startLine: 1,
        endLine: 100,
        content: "import { ITEMS } from './data.js';\n\n// ... (rest of the file content)",
      },
      ctx(existing),
    );

    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({
      error: expect.stringContaining('replace all of `lib/paginate.mjs`'),
    });
  });

  it('allows a short focused replace_lines edit', async () => {
    const existing = [
      '// Cursor-based pagination over an in-memory list.',
      ...Array.from({ length: 31 }, (_, index) => `export const value${index} = ${index};`),
    ].join('\n');
    const verdict = await SourceWriteGuard.preProcess?.(
      'replace_lines',
      {
        path: 'lib/paginate.mjs',
        startLine: 20,
        endLine: 20,
        content: 'export const value18 = 19;',
      },
      ctx(existing),
    );

    expect(verdict?.kind).toBe('allow');
  });

  it('compares short-overwrite candidates against raw existing source, not read_file gutters', async () => {
    const existing = `<!doctype html><html><body><h1>Launch Board</h1><script>${Array.from(
      { length: 260 },
      (_, i) => `function helper${i}(){return ${i};}`,
    ).join('\n')}</script></body></html>`;
    const content = `<!doctype html><html><head><title>Launch Board</title><style>${Array.from(
      { length: 50 },
      (_, i) => `.row-${i}{display:grid;grid-template-columns:1fr auto;gap:${i % 7}px;}`,
    ).join(
      '',
    )}</style></head><body><h1>Launch Board</h1><main id="board"></main><script type="module" src="./src/app.js"></script></body></html>`;
    const gutteredExisting = existing
      .split('\n')
      .map((line, index) => `${index + 1}→${line}`)
      .join('\n');
    let readArgs: unknown;
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      {
        ...ctx(),
        callTool: async (_name, args) => {
          readArgs = args;
          return {
            text:
              args &&
              typeof args === 'object' &&
              'raw' in args &&
              (args as { raw?: unknown }).raw === true
                ? existing
                : gutteredExisting,
            images: [],
          };
        },
      },
    );

    expect(content.length).toBeLessThan(4096);
    expect(content.length).toBeGreaterThanOrEqual(Math.floor(existing.length * 0.35));
    expect(content.length).toBeLessThan(Math.floor(gutteredExisting.length * 0.35));
    expect(readArgs).toMatchObject({ path: 'index.html', raw: true });
    expect(verdict).toEqual({ kind: 'allow' });
  });

  it('allows intentional short HTML module shells during refactors', async () => {
    const existing = `<!doctype html><html><body><h1>Launch Board</h1><main><section>Backlog</section><section>Doing</section><section>Done</section></main><script>${Array.from(
      { length: 360 },
      (_, i) => `function helper${i}(){return ${i};}`,
    ).join('\n')}</script></body></html>`;
    const content = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Launch Board</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; }
    .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
    .column { border: 1px solid #ddd; padding: 1rem; }
  </style>
</head>
<body>
  <h1>Launch Board</h1>
  <form id="taskForm">
    <input id="taskName" name="taskName">
    <input id="taskDueDate" type="date" name="dueDate">
    <button>Add Task</button>
  </form>
  <main class="board">
    <section class="column"><h2>Backlog</h2><div id="backlogTasks"></div></section>
    <section class="column"><h2>Doing</h2><div id="doingTasks"></div></section>
    <section class="column"><h2>Done</h2><div id="doneTasks"></div></section>
  </main>
  <script type="module" src="./src/app.js"></script>
</body>
</html>`;

    expect(content.length).toBeLessThan(Math.floor(existing.length * 0.35));

    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(existing),
    );

    expect(verdict).toEqual({ kind: 'allow' });
  });

  it('allows substantial concise rewrites of bloated HTML apps', async () => {
    const existing = `<!doctype html><html><body><main><h1>Launch Board</h1></main><script>${Array.from(
      { length: 800 },
      (_, i) => `function helper${i}(){return ${i};}`,
    ).join('\n')}</script></body></html>`;
    const content = `<!doctype html><html><body><main><h1>Launch Board</h1><section id="summary">Overdue <b>0</b> Today <b>0</b> Upcoming <b>0</b></section></main><script>${Array.from(
      { length: 170 },
      (_, i) => `const task${i}={title:"Task ${i}",priority:"High",dueDate:"2026-06-18"};`,
    ).join('\n')}</script></body></html>`;

    expect(content.length).toBeGreaterThanOrEqual(4096);
    expect(content.length).toBeLessThan(existing.length * 0.5);

    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(existing),
    );

    expect(verdict).toEqual({ kind: 'allow' });
  });

  it('allows concise repairs to small existing source files', async () => {
    const existing =
      '<!doctype html><html><body><button id="counter">0</button><script>' +
      'let count = 0; document.getElementById("counter").addEventListener("click", () => { count++; event.target.textContent = count; });' +
      '</script></body></html>';
    const content =
      '<!doctype html><html><body><button id="counter">0</button><script>let count=0;document.getElementById("counter").onclick=e=>{count++;e.target.textContent=count;};</script></body></html>';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(existing),
    );

    expect(verdict).toEqual({ kind: 'allow' });
  });

  it('allows a complete concise TypeScript module to replace verbose small source', async () => {
    const existing = `/**
 * @typedef {object} User
 * @property {string} id - Unique identifier for the user.
 * @property {string} firstName - The user's first name.
 * @property {string} lastName - The user's last name.
 * @property {string} email - The user's email address.
 */

/**
 * @typedef {object} CreateUserInput
 * @property {string} firstName - The user's first name (required).
 * @property {string} lastName - The user's last name (required).
 * @property {string} email - The user's email address (required).
 */`;
    const content = `export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  email: string;
}`;

    expect(existing.length).toBeLessThan(1024);
    expect(content.length).toBeGreaterThanOrEqual(120);
    expect(content.length).toBeLessThan(existing.length * 0.4);

    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'src/types.ts', content },
      ctx(existing),
    );

    expect(verdict).toEqual({ kind: 'allow' });
  });

  it('allows complete first HTML drafts', async () => {
    const content = '<!doctype html><html><body><script>console.log("ok");</script></body></html>';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(),
    );

    expect(verdict).toEqual({ kind: 'allow' });
  });

  it('normalizes accidental tag-openers before JavaScript declarations in script bodies', async () => {
    const content =
      '<!doctype html><html><body><script><function play() { return true; }</script></body></html>';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(),
    );

    expect(verdict?.kind).toBe('allow');
    expect(verdict).toMatchObject({
      args: {
        content:
          '<!doctype html><html><body><script>function play() { return true; }</script></body></html>',
      },
    });
  });

  it('normalizes one-line script comments that swallow closing braces', async () => {
    const content =
      '<!doctype html><html><body><script>function play() { // TODO fill this in }</script></body></html>';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(),
    );

    expect(verdict?.kind).toBe('allow');
    expect(verdict).toMatchObject({
      args: {
        content: '<!doctype html><html><body><script>function play() { }</script></body></html>',
      },
    });
  });

  it('normalizes an incomplete final html closing tag', async () => {
    const content = '<!doctype html><html><body><script>console.log("ok");</script></body></htm';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(),
    );

    expect(verdict?.kind).toBe('allow');
    expect(verdict).toMatchObject({
      args: {
        content: '<!doctype html><html><body><script>console.log("ok");</script></body></html>',
      },
    });
  });

  it('normalizes an incomplete final script closing tag', async () => {
    const content = '<div><script>console.log("ok");</scrip';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(),
    );

    expect(verdict?.kind).toBe('allow');
    expect(verdict).toMatchObject({
      args: {
        content: '<div><script>console.log("ok");</script>',
      },
    });
  });

  it('normalizes a missing html script/body/document tail', async () => {
    const content = '<!doctype html><html><body><script>console.log("ok");';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content },
      ctx(),
    );

    expect(verdict?.kind).toBe('allow');
    expect(verdict).toMatchObject({
      args: {
        content:
          '<!doctype html><html><body><script>console.log("ok");\n</script>\n</body>\n</html>',
      },
    });
  });

  it('repairs a JavaScript fragment write into an existing HTML script body', async () => {
    const existing = `<!doctype html>
<html><body>
<button id="incr">Click me</button>
<span id="count">0</span>
<script>
let count = 0;
function increment() {
  count = count + 1;
  const span = document.getElementById('count');
  span.textContent = count;
// missing function close
document.getElementById('incr').addEventListener('click', increment);
</script>
</body></html>`;
    const fragment = `<script>
let count = 0;
function increment() {
  count = count + 1;
  const span = document.getElementById('count');
  span.textContent = count;
}
document.getElementById('incr').addEventListener('click', increment);`;
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content: fragment },
      ctx(existing),
    );

    expect(verdict?.kind).toBe('allow');
    expect(verdict).toMatchObject({
      args: {
        content: expect.stringContaining(
          "document.getElementById('incr').addEventListener('click', increment);",
        ),
      },
    });
    expect((verdict as { args?: { content?: string } }).args?.content).toContain('</html>');
  });

  it('still rejects invalid JavaScript fragments for HTML writes', async () => {
    const existing = '<!doctype html><html><body><script>console.log("ok");</script></body></html>';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content: '<script>function broken() {' },
      ctx(existing),
    );

    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({
      error: expect.stringContaining('JavaScript fragment'),
    });
  });

  it('inserts a tiny JavaScript patch fragment only when it repairs existing invalid HTML', async () => {
    const existing = `<!doctype html>
<html><body>
<button id="incr">Click me</button>
<span id="count">0</span>
<script>
let count = 0;
function increment() {
  count = count + 1;
  const span = document.getElementById('count');
  span.textContent = count;
// missing close brace
document.getElementById('incr').addEventListener('click', increment);
</script>
</body></html>`;
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content: '}' },
      ctx(existing),
    );

    expect(verdict?.kind).toBe('allow');
    const repaired = (verdict as { args?: { content?: string } }).args?.content;
    expect(repaired).toContain('</html>');
    expect(repaired).toContain("document.getElementById('incr').addEventListener");
    expect(repaired).toContain('increment);\n}</script>');
  });

  it('rejects tiny patch fragments that do not repair existing invalid HTML', async () => {
    const existing =
      '<!doctype html><html><body><script>function broken() { const x = ;</script></body></html>';
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'index.html', content: '}' },
      ctx(existing),
    );

    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({
      error: expect.stringContaining('JavaScript fragment'),
    });
  });
});

describe('SourceWriteGuard — broken-JSON repair relaxation', () => {
  // The audiobook-master-pack shape: first write dropped the opening `{`,
  // leaving substantial-looking but unparseable JSON on disk.
  const brokenJson = `"status": "ok",\n  "chapters": [\n${Array.from(
    { length: 24 },
    (_, i) =>
      `    { "chapterId": "${String(i + 1).padStart(2, '0')}", "audioFile": "audio/chapter-${i + 1}.wav", "durationSeconds": ${100 + i} },`,
  ).join('\n')}\n  ]`;
  const validShortJson = JSON.stringify(
    { status: 'ok', chapters: [{ chapterId: '01', durationSeconds: 120.5 }] },
    null,
    2,
  );

  it('allows a much shorter valid-JSON rewrite when the existing .json fails JSON.parse', async () => {
    expect(brokenJson.length).toBeGreaterThan(1024);
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'master/assembly-log.json', content: validShortJson },
      ctx(brokenJson),
    );
    expect(verdict?.kind).toBe('allow');
  });

  it('still rejects a much shorter rewrite when the existing .json is valid', async () => {
    const validExisting = JSON.stringify(
      {
        status: 'ok',
        chapters: Array.from({ length: 24 }, (_, i) => ({
          chapterId: String(i + 1).padStart(2, '0'),
          audioFile: `audio/chapter-${i + 1}.wav`,
          durationSeconds: 100 + i,
        })),
      },
      null,
      2,
    );
    expect(validExisting.length).toBeGreaterThan(1024);
    expect(() => JSON.parse(validExisting)).not.toThrow();
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'master/assembly-log.json', content: validShortJson },
      ctx(validExisting),
    );
    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({
      error: expect.stringContaining('much shorter source file'),
    });
  });

  it('still rejects when the replacement is itself invalid JSON (no stub escape)', async () => {
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'master/assembly-log.json', content: 'I will rewrite the file with valid JSON now.' },
      ctx(brokenJson),
    );
    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({
      error: expect.stringContaining('much shorter source file'),
    });
  });

  it('does not extend the relaxation to non-JSON extensions', async () => {
    const brokenishJs = `${'x'.repeat(1100)} = ;`;
    const verdict = await SourceWriteGuard.preProcess?.(
      'write_file',
      { path: 'lib/log.js', content: 'export const log = [];' },
      ctx(brokenishJs),
    );
    expect(verdict?.kind).toBe('reject');
    expect(verdict).toMatchObject({
      error: expect.stringContaining('much shorter source file'),
    });
  });

  it('allows a whole-file replace_lines repair of a broken .json', async () => {
    const verdict = await SourceWriteGuard.preProcess?.(
      'replace_lines',
      { path: 'master/assembly-log.json', startLine: 1, endLine: 200, content: validShortJson },
      ctx(brokenJson),
    );
    expect(verdict?.kind).toBe('allow');
  });
});
