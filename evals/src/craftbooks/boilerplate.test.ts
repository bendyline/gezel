import { describe, expect, it } from 'vitest';
import { findBoilerplateEvalSpecs } from './boilerplate.ts';
import { CRAFTBOOK_EVAL_SPECS } from './specs.ts';
import type { CraftbookEvalSpec } from './types.ts';

function spec(
  craftbookId: string,
  prompt: string,
  checks: Array<{ pattern?: string; label?: string; file?: string }> = [],
): CraftbookEvalSpec {
  return {
    craftbookId,
    scenarioId: `craftbook-${craftbookId}`,
    title: craftbookId,
    prompt,
    mode: 'artifact-task',
    coverage: { status: 'validated' },
    success: {
      summary: '',
      // The detector only reads pattern/label/file, so a partial check is
      // enough here and keeps the fixture readable.
      checks: checks as CraftbookEvalSpec['success']['checks'],
    },
  } as unknown as CraftbookEvalSpec;
}

describe('findBoilerplateEvalSpecs', () => {
  it('ignores a spec whose prompt is unique to it', () => {
    const found = findBoilerplateEvalSpecs([
      spec('db-index-tuning', 'Tune the indexes on the seeded schema.'),
      spec('cron-job', 'Write a scheduled batch job.'),
    ]);
    expect(found).toEqual([]);
  });

  it('flags books that share a prompt and whose gates never mention their subject', () => {
    const shared = 'I dropped our numbers in source/records.csv. Write analysis.md.';
    const found = findBoilerplateEvalSpecs([
      spec('db-index-tuning', shared, [{ file: 'analysis.md', pattern: 'summary' }]),
      spec('cron-job', shared, [{ file: 'analysis.md', pattern: 'summary' }]),
    ]);
    expect(found.map((f) => f.craftbookId)).toEqual(['cron-job', 'db-index-tuning']);
    expect(found[0]?.sharedWith).toEqual(['cron-job', 'db-index-tuning']);
    expect(found[1]?.unmatchedSubjectTerms).toEqual(['index', 'tuning']);
  });

  it('clears a shared-prompt book whose gates DO look for its own subject', () => {
    // The seven game books legitimately share one prompt; a shared ask is only
    // a defect when the gates cannot tell the books apart either.
    const shared = 'Make us a fun little browser game — one file, index.html.';
    const found = findBoilerplateEvalSpecs([
      spec('idle-clicker-game', shared, [{ pattern: 'idle|clicker', label: 'idle loop' }]),
      spec('physics-toy', shared, [{ pattern: 'canvas', label: 'renders' }]),
    ]);
    expect(found.map((f) => f.craftbookId)).toEqual(['physics-toy']);
  });

  it('does not flag on a stopword-only book id, where no subject term exists to match', () => {
    const shared = 'Do the generic thing.';
    const found = findBoilerplateEvalSpecs([
      spec('build-plan', shared),
      spec('run-report', shared),
    ]);
    expect(found).toEqual([]);
  });

  it('reads deliverable and task-note gates, not just top-level checks', () => {
    const shared = 'Do the generic thing with the seeded fixtures.';
    const withDeliverableGate = spec('db-index-tuning', shared);
    withDeliverableGate.success.deliverables = [
      { path: 'analysis.md', checks: [{ pattern: 'index tuning' }] },
    ] as CraftbookEvalSpec['success']['deliverables'];
    const found = findBoilerplateEvalSpecs([withDeliverableGate, spec('cron-job', shared)]);
    expect(found.map((f) => f.craftbookId)).toEqual(['cron-job']);
  });

  describe('against the bundled specs', () => {
    const found = findBoilerplateEvalSpecs(CRAFTBOOK_EVAL_SPECS);

    it('finds the generated family-template specs', () => {
      // Guards the ratio, not an exact count: the point is that a large slice
      // of the library is measured by a family smoke test rather than by its
      // own job. A content release that fixes them should move this DOWN.
      expect(found.length).toBeGreaterThan(50);
      expect(found.length).toBeLessThan(CRAFTBOOK_EVAL_SPECS.length / 2);
    });

    it('includes the wild-caught exemplars', () => {
      const ids = new Set(found.map((f) => f.craftbookId));
      // db-index-tuning is a query-plan recipe measured by "analyze
      // records.csv"; version-bump is a semver recipe measured by "write a
      // small Node helper". Both were recorded as validated.
      expect(ids.has('db-index-tuning')).toBe(true);
      expect(ids.has('version-bump')).toBe(true);
    });

    it('never flags a spec that has no prompt at all', () => {
      const promptless = new Set(
        CRAFTBOOK_EVAL_SPECS.filter((s) => !s.prompt?.trim()).map((s) => s.craftbookId),
      );
      for (const f of found) expect(promptless.has(f.craftbookId)).toBe(false);
    });
  });
});
