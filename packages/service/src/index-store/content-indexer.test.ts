import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyFile } from './classify.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import { IndexStore } from './index-store.js';
import { extractCodeSymbols, extractMarkdownOutline } from './symbols.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-ci-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('classifyFile', () => {
  it('classifies code, markdown, docs, images, and trivia', () => {
    expect(classifyFile('src/a.ts', 100)).toMatchObject({
      lang: 'typescript',
      kind: 'code',
      modality: 'code',
      trivial: false,
    });
    expect(classifyFile('README.md', 100)).toMatchObject({ kind: 'markdown', modality: 'text' });
    expect(classifyFile('deck.pptx', 100)).toMatchObject({ modality: 'doc', trivial: false });
    expect(classifyFile('photo.jpg', 100)).toMatchObject({ modality: 'image', trivial: false });
    expect(classifyFile('pnpm-lock.yaml', 100).trivial).toBe(true);
    expect(classifyFile('app.min.js', 100).trivial).toBe(true);
    expect(classifyFile('huge.ts', 9_999_999).trivial).toBe(true);
  });
});

describe('isDenseBlob', () => {
  it('flags machine-generated blobs and spares normal files', async () => {
    const { isDenseBlob } = await import('./classify.js');
    expect(isDenseBlob(428 * 1024, 31)).toBe(true); // iconData.ts shape
    expect(isDenseBlob(400 * 1024, 8000)).toBe(false); // long but normal
    expect(isDenseBlob(50 * 1024, 3)).toBe(false); // dense but small
  });

  it('the indexer records a dense blob as trivial with no symbols or chunks', async () => {
    const bigLine = `export const data = "${'x'.repeat(200 * 1024)}";`;
    await writeFile(join(dir, 'iconData.ts'), `${bigLine}\nexport function decoy() {}\n`);
    await writeFile(join(dir, 'normal.ts'), 'export function fine() { return 1; }\n');
    await runWorkspaceContentIndex(dir, 'dense');
    const store = (await IndexStore.open(join(dir, '.gezel', 'index', 'index.db'), {
      collectionId: 'dense',
      kind: 'workspace',
      rootPath: dir,
    }))!;
    expect(store.getFile('iconData.ts')?.trivial).toBe(true);
    expect(store.searchSymbols({ name: 'decoy' })).toHaveLength(0);
    expect(store.getFile('normal.ts')?.trivial).toBe(false);
    expect(store.searchSymbols({ name: 'fine' })).toHaveLength(1);
    // The enrichment work-list must not include the blob.
    expect(store.filesNeedingEnrichment(50).map((f) => f.path)).toEqual(['normal.ts']);
    store.close();
  });
});

describe('extractCodeSymbols (web-tree-sitter)', () => {
  it('extracts functions, classes, methods, and arrow consts from TS', async () => {
    const code = [
      'export function alpha(a: number) { return a; }',
      'export const gamma = (x: number) => x * 2;',
      'class Beta {',
      '  doThing() { return 1; }',
      '}',
      'interface Shape { area(): number; }',
    ].join('\n');
    const syms = await extractCodeSymbols('typescript', code);
    // Null only if web-tree-sitter is unavailable in this env; we expect it here.
    expect(syms).not.toBeNull();
    const byName = new Map(syms!.map((s) => [s.name, s]));
    expect(byName.get('alpha')).toMatchObject({ kind: 'function', lineStart: 1 });
    expect(byName.get('gamma')).toMatchObject({ kind: 'function', lineStart: 2 });
    expect(byName.get('Beta')).toMatchObject({ kind: 'class', lineStart: 3, lineEnd: 5 });
    expect(byName.get('doThing')).toMatchObject({ kind: 'method', parent: 'Beta' });
    expect(byName.get('Shape')).toMatchObject({ kind: 'interface' });
  });

  it('extracts symbols from swift', async () => {
    const code = [
      'protocol Drawable {',
      '  func draw()',
      '}',
      'class Circle {',
      '  func draw() {}',
      '}',
      'func area(radius: Double) -> Double { return 3.14 * radius * radius }',
    ].join('\n');
    const syms = await extractCodeSymbols('swift', code);
    expect(syms).not.toBeNull();
    const kinds = new Map(syms!.map((s) => [s.name, s.kind]));
    expect(kinds.get('Circle')).toBe('class');
    expect(kinds.get('area')).toBe('function');
    expect(kinds.get('Drawable')).toBe('protocol');
  });

  it('extracts symbols from kotlin', async () => {
    const code = [
      'class Winkel(val name: String) {',
      '  fun open() {}',
      '}',
      'object Register {',
      '  fun total(): Int = 0',
      '}',
      'fun main() {}',
    ].join('\n');
    const syms = await extractCodeSymbols('kotlin', code);
    expect(syms).not.toBeNull();
    const kinds = new Map(syms!.map((s) => [s.name, s.kind]));
    expect(kinds.get('Winkel')).toBe('class');
    expect(kinds.get('Register')).toBe('object');
    expect(kinds.get('main')).toBe('function');
  });

  it('extracts symbols from scala', async () => {
    const code = [
      'trait Greeter {',
      '  def greet(name: String): String',
      '}',
      'object Main {',
      '  def run(): Unit = ()',
      '}',
      'class Shop(name: String)',
    ].join('\n');
    const syms = await extractCodeSymbols('scala', code);
    expect(syms).not.toBeNull();
    const kinds = new Map(syms!.map((s) => [s.name, s.kind]));
    expect(kinds.get('Greeter')).toBe('trait');
    expect(kinds.get('Main')).toBe('object');
    expect(kinds.get('Shop')).toBe('class');
  });
});

describe('extractMarkdownOutline', () => {
  it('builds a heading outline with section line ranges', () => {
    const md = ['# Title', 'intro', '## A', 'a body', '## B', 'b body'].join('\n');
    const syms = extractMarkdownOutline(md);
    expect(syms.map((s) => s.name)).toEqual(['Title', 'A', 'B']);
    expect(syms[0]).toMatchObject({ kind: 'h1', lineStart: 1 });
    expect(syms[1]).toMatchObject({ kind: 'h2', lineStart: 3, lineEnd: 4 });
  });
});

describe('runWorkspaceContentIndex', () => {
  it('indexes a workspace, then a re-run is a no-op; deletes prune', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    await writeFile(join(dir, 'README.md'), '# Hello\nworld\n');

    const first = await runWorkspaceContentIndex(dir, 'col-1');
    expect(first).not.toBeNull();
    expect(first!.scanned).toBeGreaterThanOrEqual(2);
    expect(first!.changed).toBeGreaterThanOrEqual(2);
    expect(first!.symbols).toBeGreaterThanOrEqual(2);

    // find_symbol-style lookup works against the persisted store.
    const store = (await IndexStore.open(join(dir, '.gezel', 'index', 'index.db'), {
      collectionId: 'col-1',
      kind: 'workspace',
      rootPath: dir,
    }))!;
    expect(store.searchSymbols({ name: 'alpha' })[0]).toMatchObject({
      filePath: 'src/a.ts',
      kind: 'function',
    });
    store.close();

    // Re-run with no edits → nothing changes.
    const second = await runWorkspaceContentIndex(dir, 'col-1');
    expect(second!.changed).toBe(0);
    expect(second!.skipped).toBeGreaterThanOrEqual(2);

    // Delete a file → pruned on next run.
    await rm(join(dir, 'src', 'a.ts'));
    const third = await runWorkspaceContentIndex(dir, 'col-1');
    expect(third!.removed).toBe(1);
  });

  it('re-extracts when content changes but mtime-only touches do not', async () => {
    await writeFile(join(dir, 'a.ts'), 'export function one() {}\n');
    await runWorkspaceContentIndex(dir, 'c');

    // mtime-only touch: same content → no change.
    const future = new Date(Date.now() + 60_000);
    await utimes(join(dir, 'a.ts'), future, future);
    const touched = await runWorkspaceContentIndex(dir, 'c');
    expect(touched!.changed).toBe(0);

    // real edit → re-extract.
    await writeFile(join(dir, 'a.ts'), 'export function one() {}\nexport function two() {}\n');
    const edited = await runWorkspaceContentIndex(dir, 'c');
    expect(edited!.changed).toBe(1);
    expect(edited!.symbols).toBe(2);
  });

  it('an extractor-version bump forces one re-extract of code files only', async () => {
    await writeFile(join(dir, 'a.ts'), "import { x } from './b.js';\nexport const y = x;\n");
    await writeFile(join(dir, 'b.ts'), 'export const x = 1;\n');
    await writeFile(join(dir, 'README.md'), '# Hello\nworld\n');
    await runWorkspaceContentIndex(dir, 'c');

    const dbPath = join(dir, '.gezel', 'index', 'index.db');
    const openStore = async () =>
      (await IndexStore.open(dbPath, { collectionId: 'c', kind: 'workspace', rootPath: dir }))!;

    // Simulate a pre-bindings install: wipe the recorded bindings and roll the
    // stamp back, as if the rows were written by an older extractor.
    let store = await openStore();
    expect(store.allImportsWithBindings().find((i) => i.raw === './b.js')?.bindings).toEqual([
      { name: 'x', local: 'x', kind: 'named' },
    ]);
    store.putImports('a.ts', store.getFile('a.ts')!.hash, [{ raw: './b.js' }]);
    store.setMeta('extractor_version', '1');
    store.close();

    // Zero content changes — the version mismatch alone re-extracts code files.
    const forced = await runWorkspaceContentIndex(dir, 'c');
    expect(forced!.changed).toBeGreaterThanOrEqual(2); // a.ts + b.ts, not README
    expect(forced!.docsConverted).toBe(0);

    store = await openStore();
    expect(store.allImportsWithBindings().find((i) => i.raw === './b.js')?.bindings).toEqual([
      { name: 'x', local: 'x', kind: 'named' },
    ]);
    expect(store.getMeta('extractor_version')).toBeDefined();
    store.close();

    // Next run is a normal no-op again.
    const settled = await runWorkspaceContentIndex(dir, 'c');
    expect(settled!.changed).toBe(0);
  });
});
