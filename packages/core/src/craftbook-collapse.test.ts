import { describe, expect, it } from 'vitest';
import { collapseCraftbookForTier } from './craftbook-collapse.js';
import type { CraftbookStep } from './schemas/index.js';
import { normalizeStepGate, validateCraftbookGraph } from './schemas/index.js';

/**
 * A 6-step linear gallery-book shape: research (gateless) → draft
 * (gated) → illustrate (gateless) → build (gated) → verify (gated) →
 * finish (gateless, terminal).
 */
function sixStepBook(): { steps: CraftbookStep[]; entryStepId: string } {
  return {
    entryStepId: 'research',
    steps: [
      { id: 'research', name: 'Research', prompt: 'Gather the inputs.', next: 'draft' },
      {
        id: 'draft',
        name: 'Draft',
        description: 'Write the draft brief.',
        prompt: 'Write brief.md from the research.',
        advanceWhen: { file: 'brief.md' },
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'brief.md', bytes: 400 }],
          onReject: 'draft',
          maxAttempts: 3,
        },
        next: 'illustrate',
      },
      { id: 'illustrate', name: 'Illustrate', prompt: 'Add a diagram.', next: 'build' },
      {
        id: 'build',
        name: 'Build',
        prompt: 'Build index.html.',
        advanceWhen: { file: 'index.html', sniff: 'html-complete' },
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'index.html', bytes: 800 }],
          onReject: 'build',
          maxAttempts: 4,
        },
        next: 'verify',
      },
      {
        id: 'verify',
        name: 'Verify',
        prompt: 'Verify the page.',
        gate: {
          at: 'completion',
          checks: [
            { kind: 'contains', file: 'index.html', pattern: '<title>', flags: 'i' },
            { kind: 'minBytes', file: 'index.html', bytes: 800 },
          ],
          onReject: 'verify',
        },
        next: 'finish',
      },
      { id: 'finish', name: 'Finish', prompt: 'Summarize.', terminal: true },
    ],
  };
}

describe('collapseCraftbookForTier', () => {
  it('merges gateless steps into anchors and folds the terminal tail (6 → 3)', () => {
    const result = collapseCraftbookForTier(sixStepBook(), { tier: 'tiny' });
    expect(result.changed).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map((s) => s.id)).toEqual(['draft', 'build', 'verify']);
    expect(result.entryStepId).toBe('draft');
    // Every group carries a completion gate.
    for (const step of result.steps) {
      expect(step.gate).toBeDefined();
      expect(normalizeStepGate(step.gate!).at).toBe('completion');
    }
    // The merged graph validates.
    expect(
      validateCraftbookGraph({ steps: result.steps, entryStepId: result.entryStepId }),
    ).toEqual([]);
  });

  it('stepIdMap routes merged-away ids to their anchor; anchors map to themselves', () => {
    const result = collapseCraftbookForTier(sixStepBook(), { tier: 'tiny' });
    expect(result.stepIdMap.get('research')).toBe('draft');
    expect(result.stepIdMap.get('draft')).toBe('draft');
    expect(result.stepIdMap.get('illustrate')).toBe('build');
    expect(result.stepIdMap.get('finish')).toBe('verify');
  });

  it('the terminal group keeps the completion gate, drops advanceWhen and next', () => {
    const result = collapseCraftbookForTier(sixStepBook(), { tier: 'tiny' });
    const last = result.steps[2]!;
    expect(last.terminal).toBe(true);
    expect(last.advanceWhen).toBeUndefined();
    expect(last.next).toBeUndefined();
    expect(last.gate).toBeDefined();
  });

  it("combined gates carry every merged member's checks (dedup) and max maxAttempts", () => {
    // Force a 2-group merge (maxSteps 2) so build+verify combine.
    const result = collapseCraftbookForTier(sixStepBook(), { tier: 'tiny', maxSteps: 2 });
    expect(result.changed).toBe(true);
    expect(result.steps).toHaveLength(2);
    const combined = normalizeStepGate(result.steps[1]!.gate!);
    const kinds = (combined.checks ?? []).map((c) => `${c.kind}:${'file' in c ? c.file : ''}`);
    // build's minBytes + verify's contains survive; the duplicate
    // index.html minBytes deduped to one.
    expect(kinds.filter((k) => k === 'minBytes:index.html')).toHaveLength(1);
    expect(kinds).toContain('contains:index.html');
    expect(combined.maxAttempts).toBe(4);
    expect(combined.onReject).toBe(result.steps[1]!.id);
  });

  it('carries and de-duplicates required inputs from every merged member', () => {
    const book = sixStepBook();
    book.steps[0]!.consumes = [{ file: 'inputs/brief.md' }];
    book.steps[1]!.consumes = [
      { file: 'inputs/brief.md' },
      { file: 'research/notes.md', artifact: true },
    ];
    book.steps[1]!.prompt =
      'First call `read_artifact({ path: "research/notes.md" })`, then write brief.md.';
    const result = collapseCraftbookForTier(book, { tier: 'tiny' });
    expect(result.steps[0]!.consumes).toEqual([
      { file: 'inputs/brief.md' },
      { file: 'research/notes.md', artifact: true },
    ]);
  });

  it('rewritten prompts are single-action imperatives with the gate bullets', () => {
    const result = collapseCraftbookForTier(sixStepBook(), { tier: 'tiny' });
    const draft = result.steps[0]!;
    expect(draft.prompt).toContain('your first tool call is `write_file({ path: "brief.md"');
    expect(draft.prompt).toContain('One tool call per turn');
    expect(draft.prompt).toContain('at least 400 bytes');
    expect(draft.prompt).toContain('fix exactly what the verdict names');
    // The anchor's authored procedure is preserved below the header.
    expect(draft.prompt).toContain('Write brief.md from the research.');
    // Merged-away step names are noted.
    expect(draft.prompt).toContain('also covers: Research');
  });

  it('lifecycle fields ride through on anchors (generic step type)', () => {
    const book = sixStepBook();
    type LifecycleStep = CraftbookStep & {
      createdAt: string;
      gateAttempts?: number;
      gateAttemptHistory?: Array<{ at: string }>;
    };
    const steps = book.steps.map((s) => ({
      ...s,
      createdAt: '2026-07-07T00:00:00Z',
      ...(s.id === 'build' ? { gateAttempts: 2, gateAttemptHistory: [{ at: 'T' }] } : {}),
    })) as LifecycleStep[];
    const result = collapseCraftbookForTier(
      { steps, entryStepId: book.entryStepId },
      {
        tier: 'tiny',
      },
    );
    const build = result.steps.find((s) => s.id === 'build')!;
    expect(build.createdAt).toBe('2026-07-07T00:00:00Z');
    expect(build.gateAttempts).toBe(2);
    expect(build.gateAttemptHistory).toHaveLength(1);
  });

  it('no-ops for non-tiny tiers and for books already at or under the cap', () => {
    expect(collapseCraftbookForTier(sixStepBook(), { tier: 'small' }).changed).toBe(false);
    expect(collapseCraftbookForTier(sixStepBook(), { tier: 'medium' }).changed).toBe(false);
    const threeStep = {
      entryStepId: 'a',
      steps: sixStepBook().steps.slice(1, 4),
    };
    threeStep.entryStepId = threeStep.steps[0]!.id;
    expect(collapseCraftbookForTier(threeStep, { tier: 'tiny' }).changed).toBe(false);
  });

  it('idempotence: collapsing a collapsed book is a no-op (≤3 steps)', () => {
    const once = collapseCraftbookForTier(sixStepBook(), { tier: 'tiny' });
    const twice = collapseCraftbookForTier(
      { steps: once.steps, entryStepId: once.entryStepId },
      { tier: 'tiny' },
    );
    expect(twice.changed).toBe(false);
  });

  describe('fail-open preconditions', () => {
    it('branches, activation gates, non-linear edges, and gateless books all skip', () => {
      const withBranches = sixStepBook();
      withBranches.steps[0]!.branches = [{ when: { op: 'ok' }, goto: 'build' }];
      expect(collapseCraftbookForTier(withBranches, { tier: 'tiny' }).skippedReason).toMatch(
        /branches/,
      );

      const withActivation = sixStepBook();
      withActivation.steps[2]!.gate = { at: 'activation', checks: [] } as never;
      expect(collapseCraftbookForTier(withActivation, { tier: 'tiny' }).skippedReason).toMatch(
        /activation gate/,
      );

      const nonLinear = sixStepBook();
      nonLinear.steps[0]!.next = 'verify';
      expect(collapseCraftbookForTier(nonLinear, { tier: 'tiny' }).skippedReason).toMatch(
        /non-linear/,
      );

      const gateless = {
        entryStepId: 's1',
        steps: [1, 2, 3, 4].map((i) => ({
          id: `s${i}`,
          name: `S${i}`,
          ...(i < 4 ? { next: `s${i + 1}` } : { terminal: true }),
        })) as CraftbookStep[],
      };
      expect(collapseCraftbookForTier(gateless, { tier: 'tiny' }).skippedReason).toMatch(
        /no completion-gated step/,
      );

      const rerouted = sixStepBook();
      (rerouted.steps[1]!.gate as { onReject?: string }).onReject = 'research';
      expect(collapseCraftbookForTier(rerouted, { tier: 'tiny' }).skippedReason).toMatch(
        /rejects to another step/,
      );
    });
  });
});

// The catalog-wide collapse sweep moved to
// packages/catalog/src/craftbook-collapse-sweep.test.ts — it reads the
// external gilde content package, which core cannot depend on.
