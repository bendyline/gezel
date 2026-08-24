/**
 * Phase 3 enrichment + semantic search. Uses the real local embedder
 * (transformers.js) for both enrich and query so the vector path is exercised
 * end-to-end; self-skips if embeddings are unavailable in this environment.
 *
 * Pins the small MiniLM model regardless of the production default: this test
 * exercises the enrich→embed→search PLUMBING (model-agnostic), and MiniLM
 * (~23 MB) is already cached from prior runs, so we don't pay the bge default's
 * 130 MB cold download inside the test sandbox. Save/restore so the pin can't
 * leak into other files sharing the worker.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const priorEmbedModel = process.env.GEZEL_EMBED_MODEL;
beforeAll(() => {
  process.env.GEZEL_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
});
afterAll(() => {
  if (priorEmbedModel === undefined) delete process.env.GEZEL_EMBED_MODEL;
  else process.env.GEZEL_EMBED_MODEL = priorEmbedModel;
});
import { CompletionBlockedError } from '../chat/large-content.js';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import { type EnrichDeps, parseSymbolSummaryJson } from './enrich.js';

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-enrich-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-enrich-home-'));
  artifacts = join(home, 'artifacts');
  ci = new ContentIndex(
    {
      projectWorkspaceDir: async () => dir,
      projectArtifactsDir: () => artifacts,
    } as unknown as Store,
    home,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function realEmbed(): Promise<((texts: string[]) => Promise<number[][]>) | null> {
  try {
    const { embedBatch } = await import('../memory/embeddings.js');
    await embedBatch(['warmup']);
    return embedBatch;
  } catch {
    return null;
  }
}

describe('embed-only tier (semantic search without a Boekwachter)', () => {
  it('embeds with no LLM, leaves the summary gate open, and a later full pass still summarizes', async () => {
    const embed = await realEmbed();
    if (!embed) return;

    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'throttle.ts'),
      'export function guard(req: Request) { /* limits how many API requests per second a client may make */ return true; }\n',
    );
    await writeFile(join(dir, 'src', 'colors.ts'), 'export const palette = ["#fff", "#000"];\n');
    await runWorkspaceContentIndex(dir, 'c', artifacts);

    // Embed-only: vectors from signatures/windows alone — no summarizer runs.
    const r = await ci.embedOnly('c', 10);
    expect(r).not.toBeNull();
    expect(r!.embedded).toBe(2);
    const res = await ci.searchCode('c', 'how do we limit API request rate?', { mode: 'semantic' });
    expect(res.engine).toBe('semantic');
    expect(res.results[0]?.path).toBe('src/throttle.ts');

    // THE gate-collision regression this tier was designed around: the
    // summary work-list must be untouched, so a Boekwachter recruited later
    // still summarizes every file. embed_state is done; enrichments is not.
    const counts = await ci.enrichmentCounts('c');
    expect(counts!.embedOnlyPending).toBe(0);
    expect(counts!.pending).toBe(2);
    expect(counts!.summarized).toBe(0);

    const deps: EnrichDeps = {
      summarize: async (prompt: string) =>
        prompt.includes('palette')
          ? 'Defines a colour palette of hex swatches for theming.'
          : 'Implements rate limiting and throttling for incoming API requests.',
      embed,
      model: 'test',
    };
    const stats = await ci.enrich('c', deps, 10);
    expect(stats!.files).toBe(2);
    expect(stats!.summarized).toBe(2);

    // The full pass supersedes embed-only: nothing left for either tier.
    const again = await ci.embedOnly('c', 10);
    expect(again!.files).toBe(0);
    const settled = await ci.enrichmentCounts('c');
    expect(settled!.pending).toBe(0);
    expect(settled!.embedOnlyPending).toBe(0);

    // And the doc-gist guard held: a full pass over already-chunked files
    // must not stack duplicate summary chunks (search still ranks cleanly).
    const after = await ci.searchCode('c', 'how do we limit API request rate?', {
      mode: 'semantic',
    });
    expect(after.results[0]?.path).toBe('src/throttle.ts');
  }, 120_000);
});

describe('enrichment + search_code', () => {
  it('keyword search_code finds a symbol even before enrichment (FTS)', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'limiter.ts'),
      'export function rateLimit(n: number) { return n; }\n',
    );
    await runWorkspaceContentIndex(dir, 'c', artifacts);

    const res = await ci.searchCode('c', 'rateLimit', { mode: 'keyword' });
    expect(res.engine).toBe('fts');
    expect(res.results.some((r) => r.path === 'src/limiter.ts')).toBe(true);
  });

  // Generous timeout: this is the only test that loads the REAL
  // transformers.js embedder, whose model downloads (~23 MB) and
  // initializes on first use — well past vitest's 5s default on a
  // cold cache / slow box. The fake-embedder tests elsewhere stay
  // on the default.
  it('semantic search_code surfaces a file by meaning after enrichment', async () => {
    const embed = await realEmbed();
    if (!embed) return; // embeddings unavailable here — skip

    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'throttle.ts'),
      'export function guard(req: Request) { /* limits how many API requests per second a client may make */ return true; }\n',
    );
    await writeFile(join(dir, 'src', 'colors.ts'), 'export const palette = ["#fff", "#000"];\n');
    await runWorkspaceContentIndex(dir, 'c', artifacts);

    const deps: EnrichDeps = {
      // Content-aware so the two files get distinct vectors.
      summarize: async (prompt: string) =>
        prompt.includes('palette')
          ? 'Defines a colour palette of hex swatches for theming.'
          : 'Implements rate limiting and throttling for incoming API requests.',
      embed,
      model: 'test',
    };
    const stats = await ci.enrich('c', deps, 10);
    expect(stats).not.toBeNull();
    expect(stats!.summarized).toBeGreaterThanOrEqual(1);
    expect(stats!.embedded).toBeGreaterThanOrEqual(1);

    const res = await ci.searchCode('c', 'how do we limit API request rate?', { mode: 'semantic' });
    expect(res.engine).toBe('semantic');
    expect(res.results[0]?.path).toBe('src/throttle.ts');

    // Re-enriching is a no-op (hash-gated).
    const again = await ci.enrich('c', deps, 10);
    expect(again!.files).toBe(0);
  }, 120_000);

  it('windowed chunking (GEZEL_INDEX_WINDOW=1) surfaces a token buried deep in a large function', async () => {
    const embed = await realEmbed();
    if (!embed) return;
    // A >40-line function whose signature says nothing about the buried
    // feature; the distinctive token sits ~50 lines in, well past where the
    // gist chunk (summary + signature) would reach. Without windowing it lands
    // in no chunk at all, so FTS can't find it.
    const filler = Array.from({ length: 48 }, (_, i) => `  const step${i} = ${i} + 1;`).join('\n');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'bigfn.ts'),
      `export function processDocument(input: string): string {\n${filler}\n  const marker = "zqBuriedCaptionToken";\n  return marker + input;\n}\n`,
    );
    await runWorkspaceContentIndex(dir, 'c', artifacts);
    const deps: EnrichDeps = {
      summarize: async () => 'Processes a document and returns a transformed string.',
      embed,
      model: 'test',
    };

    const prior = process.env.GEZEL_INDEX_WINDOW;
    process.env.GEZEL_INDEX_WINDOW = '1';
    try {
      await ci.enrich('c', deps, 10);
    } finally {
      if (prior === undefined) delete process.env.GEZEL_INDEX_WINDOW;
      else process.env.GEZEL_INDEX_WINDOW = prior;
    }

    const res = await ci.searchCode('c', 'zqBuriedCaptionToken', { mode: 'keyword' });
    expect(res.results.some((r) => r.path === 'src/bigfn.ts')).toBe(true);
  }, 120_000);
});

describe('per-symbol summaries', () => {
  // Fake embedder: wrong-dim vectors are rejected inside enrichFile's guarded
  // embed step, which is fine — these tests exercise the summary path only.
  const fakeEmbed = async (texts: string[]) => texts.map(() => [] as number[]);

  const seed = async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'b.ts'),
      [
        'export function foo(x: string) {',
        '  return x.length;',
        '}',
        'export function bar() {',
        "  return foo('hi');",
        '}',
      ].join('\n'),
    );
    await runWorkspaceContentIndex(dir, 'c', artifacts);
  };

  const dispatchingDeps = (prompts: string[], activities: string[] = []): EnrichDeps => ({
    summarize: async (prompt: string, activity?: string) => {
      prompts.push(prompt);
      if (activity) activities.push(activity);
      if (prompt.startsWith('For each listed symbol')) {
        // Fenced + preamble on purpose: the parser must tolerate both.
        return 'Sure! ```json\n{"foo":"Counts characters.","bar":"Calls foo.","ghost":"ignored"}\n```';
      }
      return 'A file about foo and bar.';
    },
    embed: fakeEmbed,
    model: 'test-model',
  });

  it('stores one-liners from a single batched JSON reply and serves them via fileContext', async () => {
    await seed();
    const prompts: string[] = [];
    const activities: string[] = [];
    await ci.enrich('c', dispatchingDeps(prompts, activities), 10);

    // One file-summary call + one symbol-summary call for the code file.
    expect(prompts.filter((p) => p.startsWith('For each listed symbol')).length).toBe(1);
    expect(activities).toEqual(['Indexing src/b.ts', 'Indexing src/b.ts']);

    const ctx = await ci.fileContext('c', 'src/b.ts');
    expect(ctx.summary).toBe('A file about foo and bar.');
    expect(ctx.symbols.find((s) => s.name === 'foo')?.summary).toBe('Counts characters.');
    expect(ctx.symbols.find((s) => s.name === 'bar')?.summary).toBe('Calls foo.');
  });

  it('never serves stale summaries after an edit; re-enrich refills', async () => {
    await seed();
    await ci.enrich('c', dispatchingDeps([]), 10);

    await writeFile(
      join(dir, 'src', 'b.ts'),
      [
        'export function foo(x: string) {',
        '  return x.length + 1;',
        '}',
        'export function bar() {',
        "  return foo('hi');",
        '}',
      ].join('\n'),
    );
    await runWorkspaceContentIndex(dir, 'c', artifacts);

    const stale = await ci.fileContext('c', 'src/b.ts');
    for (const s of stale.symbols) expect(s.summary).toBeUndefined();

    await ci.enrich('c', dispatchingDeps([]), 10);
    const fresh = await ci.fileContext('c', 'src/b.ts');
    expect(fresh.symbols.find((s) => s.name === 'foo')?.summary).toBe('Counts characters.');
  });

  it('skips the symbol pass entirely when no model is configured', async () => {
    await seed();
    const prompts: string[] = [];
    const deps: EnrichDeps = {
      summarize: async (prompt: string) => {
        prompts.push(prompt);
        return '';
      },
      embed: fakeEmbed,
      // no `model` — mirrors buildEnrichDeps without a local LLM
    };
    await ci.enrich('c', deps, 10);
    expect(prompts.some((p) => p.startsWith('For each listed symbol'))).toBe(false);
    const ctx = await ci.fileContext('c', 'src/b.ts');
    for (const s of ctx.symbols) expect(s.summary).toBeUndefined();
  });
});

describe('summary retry gate (markEnrichAttempt)', () => {
  const fakeEmbed = async (texts: string[]) => texts.map(() => [] as number[]);

  const seed = async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export const one = 1;\n');
    await runWorkspaceContentIndex(dir, 'c', artifacts);
  };

  it('readmits a failed summarize on later sweeps until it succeeds', async () => {
    await seed();
    let fileSummaryCalls = 0;
    const deps: EnrichDeps = {
      summarize: async (prompt: string) => {
        if (prompt.startsWith('For each listed symbol')) return '';
        fileSummaryCalls++;
        return fileSummaryCalls <= 2 ? '' : 'Defines the number one.';
      },
      embed: fakeEmbed,
      model: 'test-model',
    };
    expect((await ci.enrich('c', deps, 10))!.summarized).toBe(0);
    expect((await ci.enrich('c', deps, 10))!.files).toBe(1); // readmitted, fails again
    const third = await ci.enrich('c', deps, 10);
    expect(third!.files).toBe(1);
    expect(third!.summarized).toBe(1);
    expect((await ci.enrich('c', deps, 10))!.files).toBe(0); // gate consumed on success
  });

  it('gives up after the attempt cap and keeps coverage counts honest', async () => {
    await seed();
    const deps: EnrichDeps = { summarize: async () => '', embed: fakeEmbed, model: 'test-model' };
    for (let i = 0; i < 3; i++) {
      expect((await ci.enrich('c', deps, 10))!.files).toBe(1);
    }
    expect((await ci.enrich('c', deps, 10))!.files).toBe(0); // capped out — off the list
    const counts = await ci.enrichmentCounts('c');
    expect(counts!.summarized).toBe(0);
    expect(counts!.embedded).toBe(0); // attempt rows are not "embedded"
    expect(counts!.pending).toBe(0); // gave-up is terminal until the content changes
  });

  it('consumes the gate immediately when no model is configured (embeddings-only)', async () => {
    await seed();
    const deps: EnrichDeps = { summarize: async () => '', embed: fakeEmbed };
    expect((await ci.enrich('c', deps, 10))!.files).toBe(1);
    expect((await ci.enrich('c', deps, 10))!.files).toBe(0);
  });

  it('a policy-blocked summarize consumes the whole attempt budget at once', async () => {
    await seed();
    let calls = 0;
    const deps: EnrichDeps = {
      summarize: async () => {
        calls++;
        throw new CompletionBlockedError('Request blocked.');
      },
      embed: fakeEmbed,
      model: 'test-model',
    };
    expect((await ci.enrich('c', deps, 10))!.files).toBe(1);
    // One file-summary call only: the symbol pass is skipped for blocked
    // content (same content, same deterministic refusal).
    expect(calls).toBe(1);
    expect((await ci.enrich('c', deps, 10))!.files).toBe(0); // off the list immediately
    const counts = await ci.enrichmentCounts('c');
    expect(counts!.summarized).toBe(0);
    expect(counts!.pending).toBe(0);
    expect(counts!.skipped).toBe(1);
  });

  it('a busy engine defers the file without spending an attempt', async () => {
    await seed();
    let calls = 0;
    const deps: EnrichDeps = {
      summarize: async () => {
        calls++;
        // What buildEnrichDeps returns when the pool refuses to evict a busy
        // engine: the call never reached a model. Charging these would retire
        // the file's budget after three sweeps of ordinary contention.
        return calls <= 5
          ? { text: '', model: 'test-model', deferred: true as const }
          : { text: 'Defines the number one.', model: 'test-model' };
      },
      embed: fakeEmbed,
      model: 'test-model',
    };
    // Well past MAX_ENRICH_ATTEMPTS — the file must still be readmitted.
    for (let i = 0; i < 5; i++) {
      expect((await ci.enrich('c', deps, 10))!.files).toBe(1);
    }
    const counts = await ci.enrichmentCounts('c');
    expect(counts!.pending).toBe(1); // still queued, not given up on
    expect(counts!.skipped).toBe(0);
    const done = await ci.enrich('c', deps, 10);
    expect(done!.summarized).toBe(1);
  });

  it('the symbol pass is skipped while the target is unavailable', async () => {
    await seed();
    const prompts: string[] = [];
    const deps: EnrichDeps = {
      summarize: async (prompt: string) => {
        prompts.push(prompt);
        return { text: '', model: 'test-model', deferred: true as const };
      },
      embed: fakeEmbed,
      model: 'test-model',
    };
    await ci.enrich('c', deps, 10);
    // One call: re-asking the same busy pool for symbol one-liners would just
    // burn the symbol budget for the same reason.
    expect(prompts.length).toBe(1);
    expect(prompts.some((p) => p.startsWith('For each listed symbol'))).toBe(false);
  });

  it('shutdown cancellation does not consume the file retry budget', async () => {
    await seed();
    const abort = new Error('service shutting down');
    abort.name = 'AbortError';
    const cancelled: EnrichDeps = {
      summarize: async () => {
        throw abort;
      },
      embed: fakeEmbed,
      model: 'test-model',
    };

    for (let i = 0; i < 3; i++) {
      await expect(ci.enrich('c', cancelled, 10)).rejects.toBe(abort);
    }

    const recovered = await ci.enrich(
      'c',
      { summarize: async () => 'Defines the number one.', embed: fakeEmbed, model: 'test-model' },
      10,
    );
    expect(recovered).toMatchObject({ files: 1, summarized: 1 });
  });

  it('a changed file re-queues after a policy-blocked skip', async () => {
    await seed();
    const blockedDeps: EnrichDeps = {
      summarize: async () => {
        throw new CompletionBlockedError('Request blocked.');
      },
      embed: fakeEmbed,
      model: 'test-model',
    };
    expect((await ci.enrich('c', blockedDeps, 10))!.files).toBe(1);
    expect((await ci.enrich('c', blockedDeps, 10))!.files).toBe(0);
    await writeFile(join(dir, 'src', 'a.ts'), 'export const one = 1; // now benign\n');
    await runWorkspaceContentIndex(dir, 'c', artifacts);
    const okDeps: EnrichDeps = {
      summarize: async () => 'Defines the number one.',
      embed: fakeEmbed,
      model: 'test-model',
    };
    const after = await ci.enrich('c', okDeps, 10);
    expect(after!.files).toBe(1);
    expect(after!.summarized).toBe(1);
    expect((await ci.enrichmentCounts('c'))!.skipped).toBe(0);
  });
});

describe('parseSymbolSummaryJson', () => {
  const known = new Set(['foo', 'bar']);

  it('slices the outermost JSON object out of fences and preamble', () => {
    const raw = 'Here you go:\n```json\n{"foo":"Does x.","bar":"Does y."}\n```\nHope that helps!';
    expect(parseSymbolSummaryJson(raw, known)).toEqual([
      { name: 'foo', summary: 'Does x.' },
      { name: 'bar', summary: 'Does y.' },
    ]);
  });

  it('drops unknown names, non-string values, and empty strings', () => {
    const raw = '{"foo":"ok","ghost":"nope","bar":42,"baz":"","foo2":null}';
    expect(parseSymbolSummaryJson(raw, known)).toEqual([{ name: 'foo', summary: 'ok' }]);
  });

  it('returns [] for garbage', () => {
    expect(parseSymbolSummaryJson('no json here', known)).toEqual([]);
    expect(parseSymbolSummaryJson('[1,2,3]', known)).toEqual([]);
    expect(parseSymbolSummaryJson('{broken', known)).toEqual([]);
  });

  it('caps each line at 200 chars', () => {
    const long = 'x'.repeat(500);
    const out = parseSymbolSummaryJson(`{"foo":"${long}"}`, known);
    expect(out[0]!.summary.length).toBe(200);
  });
});
