import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../fs/store.js';
import { ContentIndex } from './content-index.js';
import { runWorkspaceContentIndex } from './content-indexer.js';
import type { EnrichDeps } from './enrich.js';
import { parseFileReviewReply, sanitizeMermaid } from './review.js';
import { type ResolvedRubric, resolveRubrics } from './rubrics.js';

/**
 * The boekwachter review pass end-to-end: rubric-gated batches through
 * ContentIndex.review, hash-keyed serving on fileContext/outlineFile, retry
 * semantics (empty replies burn no budget, unparseable ones burn a capped
 * attempt), rubric-change re-review, and the tolerant reply parser.
 */

let dir: string;
let home: string;
let artifacts: string;
let ci: ContentIndex;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-review-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-review-home-'));
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

const fakeEmbed = async (texts: string[]) => texts.map(() => [] as number[]);

function deps(review: (prompt: string) => Promise<string>): EnrichDeps {
  return { summarize: async () => '', embed: fakeEmbed, model: 'test-model', review };
}

const VALID_REPLY = JSON.stringify({
  notes_md: 'Counts characters in short strings and returns the length.',
  issues: [{ severity: 'minor', category: 'naming', message: 'foo is a vague name', line: 1 }],
  health: 6,
  health_reason: 'ordinary working code',
});

async function builtinRubrics(): Promise<Map<string, ResolvedRubric>> {
  return resolveRubrics({});
}

async function seedCode(): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(
    join(dir, 'src', 'a.ts'),
    'export function foo(x: string) {\n  return x.length;\n}\n',
  );
  await runWorkspaceContentIndex(dir, 'c', artifacts);
}

describe('ContentIndex.review end-to-end', () => {
  it('reviews eligible kinds, serves on fileContext/outline, and is hash-gated', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export const one = 1;\n');
    await writeFile(join(dir, 'README.md'), '# Readme\n\nSome docs.\n');
    await writeFile(join(dir, 'config.json'), '{"a": 1}\n');
    await runWorkspaceContentIndex(dir, 'c', artifacts);

    // Fenced + preamble on purpose: the parser must tolerate both.
    const review = vi.fn(async () => `Sure!\n\`\`\`json\n${VALID_REPLY}\n\`\`\`\nHope that helps.`);
    const rubrics = await builtinRubrics();
    const first = await ci.review('c', deps(review), 10, rubrics);
    expect(first).toEqual({ files: 3, reviewed: 3 });

    const ctx = await ci.fileContext('c', 'src/a.ts');
    expect(ctx.review?.notesMd).toContain('Counts characters');
    expect(ctx.review?.health).toBe(6);
    expect(ctx.review?.issues[0]).toMatchObject({ severity: 'minor', category: 'naming' });

    const outline = await ci.outlineFile('c', 'README.md');
    expect(outline.review?.health).toBe(6);

    // Hash-gated: a second sweep finds nothing to do.
    expect(await ci.review('c', deps(review), 10, rubrics)).toEqual({ files: 0, reviewed: 0 });

    const counts = await ci.reviewCounts('c');
    expect(counts).toMatchObject({ eligible: 3, reviewed: 3, stale: 0, pending: 0 });

    const issues = await ci.listFileIssues('c', {});
    expect(issues.counts.total).toBe(3);
    expect(issues.reviewedFiles).toBe(3);
    expect(issues.issues[0]).toMatchObject({ severity: 'minor', category: 'naming', line: 1 });

    const map = await ci.mapRepo('c');
    expect(map.health).toMatchObject({ reviewedFiles: 3, avgHealth: 6, minorIssues: 3 });
  });

  it('reviews large files whole via absolute-numbered windows and merges the parts', async () => {
    process.env.GEZEL_COMPLETION_BUDGET_CHARS = '4500';
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      const body = Array.from(
        { length: 120 },
        (_, i) => `export const v${String(i + 1).padStart(3, '0')} = ${'1'.repeat(24)};`,
      ).join('\n');
      await writeFile(join(dir, 'src', 'big.ts'), body);
      await runWorkspaceContentIndex(dir, 'c', artifacts);

      let call = 0;
      const review = vi.fn(async (prompt: string) => {
        call += 1;
        // Anchor each window's issue to the first line that window showed —
        // proving numbering is absolute, not per-window.
        const firstShown = Number(/\n(\d+): /.exec(prompt)?.[1] ?? 1);
        return JSON.stringify({
          notes_md: `part ${call} notes`,
          issues: [
            { severity: 'minor', category: 'naming', message: `issue ${call}`, line: firstShown },
          ],
          health: call === 2 ? 3 : 7,
          health_reason: call === 2 ? 'worst part' : 'fine',
        });
      });
      const result = await ci.review('c', deps(review), 10, await builtinRubrics());
      expect(result).toEqual({ files: 1, reviewed: 1 });
      expect(review.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(review.mock.calls[0]?.[0]).toContain('part 1 of');
      expect(review.mock.calls[0]?.[0]).toContain('\n1: ');

      const res = await ci.fileReview('c', 'src/big.ts');
      // Worst window wins the health; its reason travels with it.
      expect(res.review?.health).toBe(3);
      expect(res.review?.healthReason).toBe('worst part');
      expect(res.review?.notesMd).toContain('part 1 notes');
      expect(res.review?.notesMd).toMatch(/reviewed in \d+ parts/);
      // Issues merged from every window, each anchored past the first window.
      const lines = res.review?.issues.map((i) => i.line ?? 0) ?? [];
      expect(lines[0]).toBe(1);
      expect(Math.max(...lines)).toBeGreaterThan(40);
    } finally {
      delete process.env.GEZEL_COMPLETION_BUDGET_CHARS;
    }
  });

  it('terminally skips unreviewable files instead of wedging the queue', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'a.ts'), 'export const one = 1;\n');
    // Both unreviewable under their current hash: nothing to read for the
    // empty markdown, and the fake docx is refused by the conversion guards
    // so no shadow sidecar ever exists.
    await writeFile(join(dir, 'empty.md'), '');
    await writeFile(join(dir, 'report.docx'), 'not-a-real-docx');
    await runWorkspaceContentIndex(dir, 'c', artifacts);

    const review = vi.fn(async () => VALID_REPLY);
    const rubrics = await builtinRubrics();
    const first = await ci.review('c', deps(review), 10, rubrics);
    expect(review).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ files: 1, reviewed: 1 });

    // Second sweep: the unreviewable files no longer occupy batch slots and
    // the coverage counter honestly reaches zero pending.
    const second = await ci.review('c', deps(review), 10, rubrics);
    expect(second).toEqual({ files: 0, reviewed: 0 });
    expect(review).toHaveBeenCalledTimes(1);
    expect((await ci.reviewCounts('c'))?.pending).toBe(0);
  });

  it('reviews plain-text documents with the text rubric', async () => {
    await writeFile(join(dir, 'notes.txt'), 'Some plane text with a typo.\n');
    await runWorkspaceContentIndex(dir, 'c', artifacts);
    const review = vi.fn(async (_prompt: string) => VALID_REPLY);
    const result = await ci.review('c', deps(review), 10, await builtinRubrics());
    expect(result).toEqual({ files: 1, reviewed: 1 });
    expect(review.mock.calls[0]?.[0]).toContain('plain-text documents');
  });

  it('stamps and serves full provenance; bare deps degrade to NULLs', async () => {
    await seedCode();
    const rubrics = await builtinRubrics();
    const withProvenance = deps(async () => VALID_REPLY);
    withProvenance.provenance = {
      provider: 'llama-cpp',
      gezelId: 'noor',
      gezelName: 'Noor',
      appVersion: '1.2.3',
    };
    await ci.review('c', withProvenance, 10, rubrics);

    const res = await ci.fileReview('c', 'src/a.ts');
    expect(res.review).toMatchObject({
      model: 'test-model',
      provider: 'llama-cpp',
      gezelId: 'noor',
      gezelName: 'Noor',
      appVersion: '1.2.3',
    });

    const issues = await ci.listFileIssues('c', {});
    expect(issues.reviewers).toEqual([
      { model: 'test-model', provider: 'llama-cpp', gezelName: 'Noor', files: 1 },
    ]);

    // A re-review with bare deps (no provenance) overwrites to NULLs — the
    // row always reflects its LAST writer, never a stale identity.
    await writeFile(join(dir, 'src', 'a.ts'), 'export function foo() {\n  return 2;\n}\n');
    await runWorkspaceContentIndex(dir, 'c', artifacts);
    await ci.review(
      'c',
      deps(async () => VALID_REPLY),
      10,
      rubrics,
    );
    const bare = await ci.fileReview('c', 'src/a.ts');
    expect(bare.review).toMatchObject({ model: 'test-model', provider: null, gezelName: null });
  });

  it('never serves a stale review after an edit; re-review refills', async () => {
    await seedCode();
    const rubrics = await builtinRubrics();
    await ci.review(
      'c',
      deps(async () => VALID_REPLY),
      10,
      rubrics,
    );
    expect((await ci.fileContext('c', 'src/a.ts')).review).toBeDefined();

    await writeFile(
      join(dir, 'src', 'a.ts'),
      'export function foo(x: string) {\n  return x.length + 1;\n}\n',
    );
    await runWorkspaceContentIndex(dir, 'c', artifacts);
    expect((await ci.fileContext('c', 'src/a.ts')).review).toBeUndefined();

    await ci.review(
      'c',
      deps(async () => VALID_REPLY),
      10,
      rubrics,
    );
    expect((await ci.fileContext('c', 'src/a.ts')).review).toBeDefined();
  });

  it('unparseable replies burn a capped attempt; the third valid reply lands', async () => {
    await seedCode();
    const rubrics = await builtinRubrics();
    let calls = 0;
    const review = async () => {
      calls++;
      return calls <= 2 ? 'no json here at all' : VALID_REPLY;
    };
    expect(await ci.review('c', deps(review), 10, rubrics)).toEqual({ files: 1, reviewed: 0 });
    expect(await ci.review('c', deps(review), 10, rubrics)).toEqual({ files: 1, reviewed: 0 });
    expect(await ci.review('c', deps(review), 10, rubrics)).toEqual({ files: 1, reviewed: 1 });
    expect(await ci.review('c', deps(review), 10, rubrics)).toEqual({ files: 0, reviewed: 0 });
  });

  it('gives up after three unparseable attempts; pending reaches 0', async () => {
    await seedCode();
    const rubrics = await builtinRubrics();
    const review = async () => 'still not json';
    for (let i = 0; i < 3; i++) {
      expect(await ci.review('c', deps(review), 10, rubrics)).toEqual({ files: 1, reviewed: 0 });
    }
    expect(await ci.review('c', deps(review), 10, rubrics)).toEqual({ files: 0, reviewed: 0 });
    const counts = await ci.reviewCounts('c');
    expect(counts).toMatchObject({ reviewed: 0, pending: 0 });
  });

  it('empty replies burn no retry budget and trip the circuit breaker', async () => {
    await mkdir(join(dir, 'src'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await writeFile(join(dir, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    await runWorkspaceContentIndex(dir, 'c', artifacts);
    const rubrics = await builtinRubrics();

    const dead = vi.fn(async () => '');
    expect(await ci.review('c', deps(dead), 10, rubrics)).toEqual({ files: 0, reviewed: 0 });
    // Aborted after 3 consecutive empties — a dead engine must not chew the batch.
    expect(dead).toHaveBeenCalledTimes(3);

    // Engine back up → the same files are still listed (no budget was burned).
    const alive = vi.fn(async () => VALID_REPLY);
    expect(await ci.review('c', deps(alive), 10, rubrics)).toEqual({ files: 5, reviewed: 5 });
  });

  it('a rubric change lazily re-reviews while the old review keeps serving', async () => {
    await seedCode();
    const rubricA = new Map<string, ResolvedRubric>([
      ['code', { kind: 'code', text: 'rubric A', hash: 'hash-A', source: 'override' }],
    ]);
    await ci.review(
      'c',
      deps(async () => VALID_REPLY),
      10,
      rubricA,
    );
    expect((await ci.fileContext('c', 'src/a.ts')).review?.health).toBe(6);

    // Rubric edited → file re-listed; old review serves until the new one lands.
    const rubricB = new Map<string, ResolvedRubric>([
      ['code', { kind: 'code', text: 'rubric B', hash: 'hash-B', source: 'override' }],
    ]);
    expect((await ci.fileContext('c', 'src/a.ts')).review?.health).toBe(6);
    const updated = JSON.stringify({
      notes_md: 'Re-reviewed under rubric B.',
      issues: [],
      health: 8,
      health_reason: 'clean under the new rubric',
    });
    expect(
      await ci.review(
        'c',
        deps(async () => updated),
        10,
        rubricB,
      ),
    ).toEqual({
      files: 1,
      reviewed: 1,
    });
    expect((await ci.fileContext('c', 'src/a.ts')).review?.health).toBe(8);
  });

  it('drops hallucinated line refs past what the prompt showed', async () => {
    await seedCode();
    const reply = JSON.stringify({
      notes_md: 'Tiny file.',
      issues: [
        { severity: 'info', category: 'clarity', message: 'anchored fine', line: 2 },
        { severity: 'info', category: 'clarity', message: 'line is hallucinated', line: 9999 },
      ],
      health: 7,
      health_reason: 'fine',
    });
    await ci.review(
      'c',
      deps(async () => reply),
      10,
      await builtinRubrics(),
    );
    const ctx = await ci.fileContext('c', 'src/a.ts');
    const [anchored, dropped] = ctx.review!.issues;
    expect(anchored?.line).toBe(2);
    expect(dropped?.message).toBe('line is hallucinated');
    expect(dropped?.line).toBeUndefined();
  });

  it('no review dep or empty rubrics → no-op', async () => {
    await seedCode();
    const noReview: EnrichDeps = { summarize: async () => '', embed: fakeEmbed, model: 'm' };
    expect(await ci.review('c', noReview, 10, await builtinRubrics())).toEqual({
      files: 0,
      reviewed: 0,
    });
    expect(
      await ci.review(
        'c',
        deps(async () => VALID_REPLY),
        10,
        new Map(),
      ),
    ).toEqual({ files: 0, reviewed: 0 });
  });
});

describe('parseFileReviewReply', () => {
  it('parses fenced, preambled, and bare JSON', () => {
    for (const raw of [
      `\`\`\`json\n${VALID_REPLY}\n\`\`\``,
      `Here is my review:\n${VALID_REPLY}\nDone!`,
      VALID_REPLY,
    ]) {
      const reply = parseFileReviewReply(raw);
      expect(reply?.health).toBe(6);
      expect(reply?.issues).toHaveLength(1);
    }
  });

  it('returns null for garbage and non-objects', () => {
    expect(parseFileReviewReply('no json here')).toBeNull();
    expect(parseFileReviewReply('[1,2,3]')).toBeNull();
    expect(parseFileReviewReply('{broken')).toBeNull();
    expect(parseFileReviewReply('{"health": 5}')).toBeNull(); // missing notes/reason
  });

  it('coerces numeric-string health and clamps to 1..10', () => {
    const make = (health: unknown) =>
      parseFileReviewReply(
        JSON.stringify({ notes_md: 'n', issues: [], health, health_reason: 'r' }),
      );
    expect(make('7')?.health).toBe(7);
    expect(make(14)?.health).toBe(10);
    expect(make(0)?.health).toBe(1);
    expect(make(6.6)?.health).toBe(7);
    expect(make('not a number')).toBeNull();
  });

  it('normalizes issues: bad severity → info, blank category → general, caps at 10, drops empty messages and bad lines', () => {
    const issues = [
      { severity: 'catastrophic', category: '', message: 'kept', line: -3 },
      { severity: 'major', category: 'bug', message: '' },
      ...Array.from({ length: 15 }, (_, i) => ({
        severity: 'info',
        category: 'c',
        message: `issue ${i}`,
      })),
    ];
    const reply = parseFileReviewReply(
      JSON.stringify({ notes_md: 'n', issues, health: 5, health_reason: 'r' }),
    );
    expect(reply?.issues).toHaveLength(10);
    expect(reply?.issues[0]).toEqual({ severity: 'info', category: 'general', message: 'kept' });
  });

  it('caps notes_md and health_reason lengths', () => {
    const reply = parseFileReviewReply(
      JSON.stringify({
        notes_md: 'x'.repeat(9000),
        issues: [],
        health: 5,
        health_reason: 'y'.repeat(500),
      }),
    );
    expect(reply?.notes_md.length).toBe(4000);
    expect(reply?.health_reason.length).toBe(200);
  });
});

describe('sanitizeMermaid', () => {
  const wrap = (body: string) => `Notes first.\n\n\`\`\`mermaid\n${body}\n\`\`\`\n`;

  it('keeps a plausible flowchart on code files', () => {
    const md = wrap('flowchart TD\n  A["start"] --> B["end"]');
    expect(sanitizeMermaid(md, true)).toContain('```mermaid');
  });

  it('strips blocks with unbalanced brackets, unknown headers, or script tags', () => {
    for (const body of [
      'flowchart TD\n  A["start" --> B', // unbalanced
      'this is prose, not a diagram',
      'flowchart TD\n  A["<script>alert(1)</script>"] --> A',
    ]) {
      const out = sanitizeMermaid(wrap(body), true);
      expect(out).not.toContain('```mermaid');
      expect(out).toContain('Notes first.');
    }
  });

  it('strips oversized blocks', () => {
    const big = `flowchart TD\n${Array.from({ length: 50 }, (_, i) => `  N${i} --> N${i + 1}`).join('\n')}`;
    expect(sanitizeMermaid(wrap(big), true)).not.toContain('```mermaid');
  });

  it('strips every block for non-code kinds', () => {
    const md = wrap('flowchart TD\n  A["a"] --> B["b"]');
    expect(sanitizeMermaid(md, false)).not.toContain('```mermaid');
  });
});
