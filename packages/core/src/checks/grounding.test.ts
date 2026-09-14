import { describe, expect, it } from 'vitest';
import { citationsResolve, valueGrounding } from './grounding.js';
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

describe('citationsResolve — knownPaths (task-supplied metadata)', () => {
  const ws = (files: Record<string, string>) => ({
    read: async (f: string) => files[f] ?? null,
    list: async () => Object.keys(files),
  });

  // The powerpoint-deck wild catch: the procedure requires the packet to
  // record the invocation inputs, and the backticked directory tokens /
  // future output path read as fabricated citations.
  it('forgives unresolvable cited paths the task itself supplied', async () => {
    const packet = [
      'Working folder: `tasks/8/` in the artifacts drawer.',
      'Deck folder `powerpoint/task-8`; requested file `powerpoint/task-8/deck.pptx`.',
      'Research status: skipped — no external tooling this session.',
    ].join('\n');
    const r = await citationsResolve(ws({ 'sources.md': packet }), 'sources.md', {
      minCitations: 0,
      knownPaths: ['tasks/8', 'powerpoint/task-8', 'powerpoint/task-8/deck.pptx'],
    });
    expect(r.ok).toBe(true);
    expect(r.unresolved).toEqual([]);
    expect(r.forgiven?.sort()).toEqual(['powerpoint/task-8', 'powerpoint/task-8/deck.pptx']);
  });

  it('forgiven paths do not count toward minCitations', async () => {
    const packet = 'Only metadata here: `tasks/8/` and `powerpoint/task-8/deck.pptx`.';
    const r = await citationsResolve(ws({ 'sources.md': packet }), 'sources.md', {
      minCitations: 1,
      knownPaths: ['tasks/8', 'powerpoint/task-8/deck.pptx'],
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('has 0 recognizable citation(s)');
  });

  it('a knownPath that resolves stays an ordinary counted citation', async () => {
    const review = 'Verified against `tasks/8/sources.md`.';
    const r = await citationsResolve(
      ws({ 'review.md': review, 'tasks/8/sources.md': 'packet' }),
      'review.md',
      { minCitations: 1, knownPaths: ['tasks/8/sources.md'] },
    );
    expect(r.ok).toBe(true);
    expect(r.resolved).toEqual(['tasks/8/sources.md']);
    expect(r.forgiven).toBeUndefined();
  });

  it('genuinely fabricated citations are still caught alongside forgiven ones', async () => {
    const packet = 'Metadata `tasks/8/`; evidence from `data/market-sizes.csv`.';
    const r = await citationsResolve(ws({ 'sources.md': packet }), 'sources.md', {
      minCitations: 0,
      knownPaths: ['tasks/8'],
    });
    expect(r.ok).toBe(false);
    expect(r.unresolved).toEqual(['data/market-sizes.csv']);
    expect(r.forgiven).toBeUndefined();
  });

  it('marks a truncated unresolved list with an ellipsis', async () => {
    const packet = Array.from({ length: 7 }, (_, i) => `See \`fake/path-${i}.md\`.`).join('\n');
    const r = await citationsResolve(ws({ 'notes.md': packet }), 'notes.md', {});
    expect(r.ok).toBe(false);
    expect(r.unresolved).toHaveLength(7);
    expect(r.detail).toContain('cites 7 source(s) that do not exist');
    expect(r.detail).toContain(', …');
  });
});

describe('citationsResolve — directory context', () => {
  const ws = (files: Record<string, string>) => ({
    read: async (f: string) => files[f] ?? null,
    list: async () => Object.keys(files),
  });

  it('does not treat backticked trailing-slash exclusion directories as citations', async () => {
    const packet = [
      'Excluded prior output directories: `powerpoint/task-7/` and `powerpoint/task-8/`.',
      'Primary source: [Gezel documentation](https://example.test/gezel/).',
    ].join('\n');
    const r = await citationsResolve(ws({ 'sources.md': packet }), 'sources.md');
    expect(r.ok).toBe(true);
    expect(r.urls).toEqual(['https://example.test/gezel/']);
    expect(r.unresolved).toEqual([]);
  });
});

describe('valueGrounding — inline emphasis', () => {
  // Wild-caught on the powerpoint-deck eval: a correct, correctly-cited slide
  // ("Original wait: **14** minutes") failed for /14 minutes/ because the
  // model had bolded the figure. A grounding gate judges values, not markup.
  it('sees through inline emphasis around a value', () => {
    const facts = [{ id: 'assist', required: ['14 minutes'] }];
    expect(valueGrounding('Original wait: **14** minutes.', facts).ok).toBe(true);
    expect(valueGrounding('Original wait: `14` minutes.', facts).ok).toBe(true);
    expect(valueGrounding('Original wait: __14__ minutes.', facts).ok).toBe(true);
  });

  it('still catches a forbidden value that was merely bolded', () => {
    // Emphasis must not become a way to smuggle a decoy past the check.
    const result = valueGrounding('Kelby reported **33.9** minutes.', [
      { id: 'boarding', required: ['21.4'], forbidden: ['33.9'] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.decoysDetected).toContain('33.9');
  });

  it('leaves underscores inside identifiers alone', () => {
    // `_` is a word character in every identifier a fact might require, so a
    // single underscore is deliberately NOT stripped.
    expect(valueGrounding('call read_file next', [{ id: 't', required: ['read_file'] }]).ok).toBe(
      true,
    );
  });

  it('keeps digit-group normalization working alongside it', () => {
    expect(
      valueGrounding('covered **1,180** sailings', [{ id: 's', required: ['1180'] }]).ok,
    ).toBe(true);
  });
});

describe('citationsResolve — task refs are not citations', () => {
  const ws = (files: Record<string, string>) => ({
    read: async (f: string) => files[f] ?? null,
    list: async () => Object.keys(files),
  });

  // Wild-caught on the powerpoint-deck topic-only run: the reviewer cited the
  // workflow's real artifacts AND its own task ref; one non-resolving citation
  // failed the whole check, the review step plateaued 3x, and the task paused
  // with no deck produced.
  it('ignores a backticked task ref beside real citations', async () => {
    const report = [
      'Reviewed `tasks/1/sources.md` for task `powerpoint-sources-pptx-topic-only/1`.',
      'Deck checked: `powerpoint/eval/deck.md`. PASS.',
    ].join('\n');
    const r = await citationsResolve(
      ws({
        'review.md': report,
        'tasks/1/sources.md': 'x',
        'powerpoint/eval/deck.md': 'y',
      }),
      'review.md',
      { minCitations: 1 },
    );
    expect(r.ok).toBe(true);
    expect(r.unresolved).toEqual([]);
  });

  it('still fails a genuinely fabricated path', async () => {
    const r = await citationsResolve(
      ws({ 'review.md': 'See `docs/does-not-exist.md` for details.', 'real.md': 'x' }),
      'review.md',
      { minCitations: 1 },
    );
    expect(r.ok).toBe(false);
    expect(r.unresolved).toContain('docs/does-not-exist.md');
  });

  it('does not excuse a real file whose name merely ends in digits', async () => {
    // Only a BARE numeric final segment is a task ref; `report-2024.md` is a file.
    const r = await citationsResolve(
      ws({ 'review.md': 'See `docs/report-2024.md`.', 'other.md': 'x' }),
      'review.md',
      { minCitations: 1 },
    );
    expect(r.ok).toBe(false);
  });
});
