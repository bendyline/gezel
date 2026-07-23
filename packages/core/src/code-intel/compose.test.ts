import { describe, expect, it } from 'vitest';
import type { FileContextResponse, SymbolContext } from '../schemas/api.js';
import {
  composeFileContext,
  escapeMd,
  gezelLineHref,
  gezelNavHref,
  parseGezelHref,
  rewriteGezelHrefs,
} from './compose.js';

const sym = (over: Partial<SymbolContext> = {}): SymbolContext => ({
  name: 'foo',
  kind: 'function',
  lineStart: 10,
  lineEnd: 20,
  importedBy: [],
  importedByTruncated: false,
  uses: [],
  usedInFileBy: [],
  findings: [],
  ...over,
});

const res = (over: Partial<FileContextResponse> = {}): FileContextResponse => ({
  path: 'src/b.ts',
  lang: 'typescript',
  totalLines: 40,
  summary: null,
  importedBy: [],
  importedByTruncated: false,
  imports: [],
  fileFindings: [],
  symbols: [],
  symbolsTruncated: false,
  engine: 'index',
  ...over,
});

describe('gezel href grammar', () => {
  it('round-trips paths with spaces, #, and unicode', () => {
    for (const path of ['src/a.ts', 'my dir/file #2.ts', 'ünïcode/ß.py']) {
      expect(parseGezelHref(gezelNavHref(path))).toEqual({ kind: 'file', path });
      expect(parseGezelHref(gezelNavHref(path, 7))).toEqual({ kind: 'file', path, line: 7 });
    }
    expect(parseGezelHref(gezelLineHref(42))).toEqual({ kind: 'line', line: 42 });
  });

  it('rejects everything outside the grammar', () => {
    expect(parseGezelHref('https://example.com')).toBeNull();
    expect(parseGezelHref('javascript:alert(1)')).toBeNull();
    expect(parseGezelHref('#foo')).toBeNull();
    expect(parseGezelHref('#L12x')).toBeNull();
    expect(parseGezelHref('gezel-nav:')).toBeNull();
    expect(parseGezelHref('gezel-nav:a%2Fb#Lnope')).toBeNull();
  });

  it('rewriteGezelHrefs rewrites both forms and leaves other links alone', () => {
    const md = 'See [`a`](gezel-nav:src%2Fa.ts#L3), [line 9](#L9), and [web](https://x.dev).';
    const out = rewriteGezelHrefs(md, (h) =>
      h.kind === 'file' ? `cmd:open?${h.path}:${h.line ?? 0}` : `cmd:line?${h.line}`,
    );
    expect(out).toBe(
      'See [`a`](cmd:open?src/a.ts:3), [line 9](cmd:line?9), and [web](https://x.dev).',
    );
  });
});

describe('composeFileContext', () => {
  it('returns no sections for unavailable or empty responses', () => {
    expect(composeFileContext(res({ engine: 'unavailable' })).sections).toEqual([]);
    expect(composeFileContext(res()).sections).toEqual([]);
  });

  it('composes the strip with kind fallback and zero-count omission', () => {
    const ctx = composeFileContext(res({ symbols: [sym()] }));
    expect(ctx.sections.length).toBe(1);
    const s = ctx.sections[0]!;
    expect(s.id).toBe('foo@10');
    expect(s.line).toBe(10);
    expect(s.summaryMarkdown).toBe('**foo** — function');
    expect(s.summaryText).toBe('foo — function');
    expect(s.defaultExpanded).toBe(false);
  });

  it('composes the full strip with counts and the LLM gist', () => {
    const ctx = composeFileContext(
      res({
        symbols: [
          sym({
            summary: 'Counts characters in a string.',
            importedBy: [{ path: 'src/a.ts', viaBinding: true }],
            uses: [
              { name: 'x', from: 'src/c.ts', inRepo: true },
              { name: 'y', from: 'zod', inRepo: false },
            ],
            usedInFileBy: ['bar'],
            findings: [
              {
                ruleId: 'sink.eval',
                category: 'injection',
                severity: 'high',
                line: 12,
                title: 'Dynamic code execution via eval()',
                source: 'builtin',
              },
            ],
          }),
          sym({ name: 'bar', lineStart: 30, lineEnd: 35 }),
        ],
      }),
    );
    const s = ctx.sections[0]!;
    expect(s.summaryMarkdown).toBe(
      '**foo** — Counts characters in a string. · ↓1 imported-by · ↑2 uses · ○1 in-file · ⚠ 1 finding',
    );
    // body: importer link, in-repo use link, external use plain, in-file line link, finding
    expect(s.markdown).toContain('[`src/a.ts`](gezel-nav:src%2Fa.ts)');
    expect(s.markdown).toContain('[`x`](gezel-nav:src%2Fc.ts)');
    expect(s.markdown).toContain('- `y` — `zod`');
    expect(s.markdown).toContain('[`bar`](#L30) — line 30');
    expect(s.markdown).toContain(
      '⚠ **high** — Dynamic code execution via eval() ([line 12](#L12))',
    );
  });

  it('marks whole-file importers and truncated lists', () => {
    const importedBy = Array.from({ length: 12 }, (_, i) => ({
      path: `src/u${i}.ts`,
      viaBinding: i % 2 === 0,
    }));
    const ctx = composeFileContext(res({ symbols: [sym({ importedBy })] }));
    const md = ctx.sections[0]!.markdown;
    expect(md).toContain('whole-file import');
    expect(md).toContain('… and 4 more');
    expect(ctx.sections[0]!.summaryMarkdown).toContain('↓12 imported-by');
  });

  it('escapes markdown-hostile names', () => {
    const ctx = composeFileContext(res({ symbols: [sym({ name: 'a*b[c]' })] }));
    expect(ctx.sections[0]!.summaryMarkdown).toBe('**a\\*b\\[c\\]** — function');
    expect(ctx.sections[0]!.summaryText).toBe('a*b[c] — function');
  });

  it('labels methods with their parent', () => {
    const ctx = composeFileContext(res({ symbols: [sym({ name: 'go', parent: 'Beta' })] }));
    expect(ctx.sections[0]!.summaryMarkdown).toBe('**Beta.go** — function');
  });

  it('builds a fileTop with imports/imported-by/finding chips', () => {
    const ctx = composeFileContext(
      res({
        summary: 'Helpers for parsing config.',
        importedBy: [{ path: 'src/a.ts', names: ['foo'] }],
        imports: [
          {
            specifier: './c.js',
            resolvedPath: 'src/c.ts',
            names: ['x'],
            default: false,
            namespace: false,
          },
          { specifier: 'zod', resolvedPath: null, names: ['z'], default: false, namespace: false },
        ],
        fileFindings: [
          {
            ruleId: 'secret.generic',
            category: 'secret',
            severity: 'medium',
            line: null,
            title: 'Possible hardcoded secret',
            source: 'builtin',
          },
        ],
        symbols: [sym()],
      }),
    );
    expect(ctx.fileTop).toBeDefined();
    expect(ctx.fileTop!.summaryMarkdown).toBe(
      '`b.ts` — Helpers for parsing config. · ↓1 imported-by · ↑2 imports · ⚠ 1 finding',
    );
    expect(ctx.fileTop!.markdown).toContain('[`src/c.ts`](gezel-nav:src%2Fc.ts) — `x`');
    expect(ctx.fileTop!.markdown).toContain('- `zod` — `z`');
    expect(ctx.fileTop!.markdown).toContain('[`src/a.ts`](gezel-nav:src%2Fa.ts) — `foo`');
    expect(ctx.fileTop!.markdown).toContain('⚠ **medium** — Possible hardcoded secret');
  });

  it('word-truncates long summaries in the strip', () => {
    const long = `${'word '.repeat(40)}end`;
    const ctx = composeFileContext(res({ symbols: [sym({ summary: long })] }));
    const strip = ctx.sections[0]!.summaryMarkdown;
    expect(strip.length).toBeLessThan(140);
    expect(strip).toContain('…');
  });

  it('signature fences survive embedded backticks', () => {
    const ctx = composeFileContext(
      res({ symbols: [sym({ signature: 'const tpl = ```weird```' })] }),
    );
    expect(ctx.sections[0]!.markdown).toContain('````');
  });
});

describe('escapeMd', () => {
  it('escapes the markdown special set', () => {
    expect(escapeMd('a`b*c_d[e]f<g>h\\i')).toBe('a\\`b\\*c\\_d\\[e\\]f\\<g\\>h\\\\i');
  });
});
