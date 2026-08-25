import { describe, expect, it } from 'vitest';
import { citationsResolve } from './grounding.js';
describe('citationsResolve — fenced code blocks', () => {
  const ws = (files: Record<string, string>) => ({
    read: async (f: string) => files[f] ?? null,
    list: async () => Object.keys(files),
  });

  it('never treats a fenced excerpt as a citation', async () => {
    const report = [
      'The defect lives in `src/pricing.js`.',
      '',
      '```js',
      'const discount = qty > BULK_THRESHOLD ? 0.15 : 0; // a / b excerpt',
      '```',
      '',
      'See also `tests/pricing.test.mjs`.',
    ].join('\n');
    const r = await citationsResolve(
      ws({ 'notes.md': report, 'src/pricing.js': 'x', 'tests/pricing.test.mjs': 'y' }),
      'notes.md',
      { minCitations: 2 },
    );
    expect(r.ok).toBe(true);
    expect(r.resolved.sort()).toEqual(['src/pricing.js', 'tests/pricing.test.mjs']);
    expect(r.unresolved).toEqual([]);
  });

  it('strips a dangling unclosed fence to end-of-text', async () => {
    const report = 'Cite `src/a.js` first.\n\n```js\nconst broken = a / b; // never closed\n';
    const r = await citationsResolve(ws({ 'notes.md': report, 'src/a.js': 'x' }), 'notes.md', {
      minCitations: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.unresolved).toEqual([]);
  });
});

describe('citationsResolve — unbalanced backticks', () => {
  it('an unclosed inline backtick cannot swallow prose as a citation', async () => {
    const report =
      'Cite `src/a.js` properly. A stray ` here, so there is no shared boundary to break. Untested: the mutant/edge sweep\nnext line `src/b.js` cited.';
    const ws = {
      read: async (f: string) =>
        f === 'notes.md' ? report : ['src/a.js', 'src/b.js'].includes(f) ? 'x' : null,
      list: async () => ['src/a.js', 'src/b.js'],
    };
    const r = await citationsResolve(ws, 'notes.md', { minCitations: 2 });
    expect(r.unresolved).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('citationsResolve — between-span capture', () => {
  it('prose between two legitimate inline spans is never a citation', async () => {
    const report =
      'The `>` pattern would recur anywhere a threshold is compared; only tests/pricing.test.mjs pins the boundary and guards a regression back to `>`. Cite `src/pricing.js` and `tests/pricing.test.mjs` properly.';
    const ws = {
      read: async (f: string) =>
        f === 'notes.md'
          ? report
          : ['src/pricing.js', 'tests/pricing.test.mjs'].includes(f)
            ? 'x'
            : null,
      list: async () => ['src/pricing.js', 'tests/pricing.test.mjs'],
    };
    const r = await citationsResolve(ws, 'notes.md', { minCitations: 2 });
    expect(r.unresolved).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
