import { describe, expect, it } from 'vitest';
import type { CraftbookStep } from './craftbook.js';
import {
  CraftbookStepSchema,
  applyStepPatch,
  assertCraftbookGraph,
  removeStepAndCleanEdges,
  reorderStepsArray,
  resolveSteps,
  stepInsertionIndex,
  validateCraftbookGraph,
} from './craftbook.js';

const steps = (): CraftbookStep[] => [
  { id: 'build', name: 'Build', next: 'review' },
  { id: 'review', name: 'Review', next: 'ship' },
  { id: 'ship', name: 'Ship', terminal: true },
];

describe('resolveSteps', () => {
  it('mints slugs from names and de-dupes id collisions', () => {
    const out = resolveSteps([{ name: 'Build It' }, { name: 'Build It' }, { id: 'x', name: 'Y' }]);
    expect(out.map((s) => s.id)).toEqual(['build-it', 'build-it-2', 'x']);
  });
  it('carries the full field surface, including suggestedRole', () => {
    const [s] = resolveSteps([{ name: 'Q', suggestedRole: 'reviewer', terminal: true }]);
    expect(s).toMatchObject({ name: 'Q', suggestedRole: 'reviewer', terminal: true });
  });
  it('carries capabilityFloor (silent-drop trap: this field list is explicit)', () => {
    const [s] = resolveSteps([{ name: 'Build', capabilityFloor: 'small' }]);
    expect(s!.capabilityFloor).toBe('small');
    const [bare] = resolveSteps([{ name: 'Build' }]);
    expect('capabilityFloor' in bare!).toBe(false);
  });
  it('carries declared file inputs (silent-drop trap: this field list is explicit)', () => {
    const [step] = resolveSteps([
      {
        name: 'Audit',
        prompt: 'First call `read_artifact`.',
        consumes: [{ file: 'security/scope.md', artifact: true }],
      },
    ]);
    expect(step?.consumes).toEqual([{ file: 'security/scope.md', artifact: true }]);
  });
});

describe('capabilityFloor schema', () => {
  it('accepts every tier and rejects an unknown one', () => {
    for (const tier of ['tiny', 'small', 'medium', 'large', 'cloud']) {
      expect(
        CraftbookStepSchema.safeParse({ id: 'a', name: 'A', capabilityFloor: tier }).success,
      ).toBe(true);
    }
    expect(
      CraftbookStepSchema.safeParse({ id: 'a', name: 'A', capabilityFloor: 'huge' }).success,
    ).toBe(false);
  });
});

describe('validateCraftbookGraph', () => {
  it('passes a well-formed graph', () => {
    expect(validateCraftbookGraph({ steps: steps(), entryStepId: 'build' })).toEqual([]);
  });
  it('flags a dangling next edge', () => {
    const s = steps();
    s[0]!.next = 'nope';
    expect(validateCraftbookGraph({ steps: s, entryStepId: 'build' })).toContain(
      'step "build".next "nope" missing from steps',
    );
  });
  it('flags a missing entry step', () => {
    expect(validateCraftbookGraph({ steps: steps(), entryStepId: 'ghost' })).toContain(
      'entryStepId "ghost" not in steps',
    );
  });
  it('flags terminal + outgoing edge', () => {
    const s = steps();
    s[2]!.next = 'build';
    expect(validateCraftbookGraph({ steps: s, entryStepId: 'build' })).toContain(
      'step "ship" is terminal but also has next/branches',
    );
  });
  it('requires artifact-consuming procedures to name read_artifact explicitly', () => {
    const artifactStep: CraftbookStep = {
      id: 'audit',
      name: 'Audit',
      prompt: 'Use security/scope.md, then write the report with `write_artifact`.',
      consumes: [{ file: 'security/scope.md', artifact: true }],
      terminal: true,
    };
    expect(validateCraftbookGraph({ steps: [artifactStep], entryStepId: 'audit' })).toContain(
      'step "audit" consumes artifact "security/scope.md" but its prompt does not explicitly call `read_artifact`',
    );
    artifactStep.prompt = 'First call `read_artifact({ path: "security/scope.md" })`.';
    expect(validateCraftbookGraph({ steps: [artifactStep], entryStepId: 'audit' })).toEqual([]);
  });
});

describe('removeStepAndCleanEdges', () => {
  it('removes a step and strips edges that pointed at it', () => {
    const out = removeStepAndCleanEdges(steps(), 'review');
    expect(out.map((s) => s.id)).toEqual(['build', 'ship']);
    expect(out.find((s) => s.id === 'build')!.next).toBeUndefined();
  });
  it('drops a branch whose goto was removed', () => {
    const s: CraftbookStep[] = [
      { id: 'a', name: 'A', branches: [{ when: { op: 'ok' }, goto: 'b' }] },
      { id: 'b', name: 'B', terminal: true },
    ];
    const out = removeStepAndCleanEdges(s, 'b');
    expect(out).toHaveLength(1);
    expect(out[0]!.branches).toBeUndefined();
  });
  it('throws when removing the last step', () => {
    expect(() => removeStepAndCleanEdges([{ id: 'a', name: 'A' }], 'a')).toThrow();
  });
});

describe('reorderStepsArray', () => {
  it('reorders to the given permutation', () => {
    const out = reorderStepsArray(steps(), ['ship', 'build', 'review']);
    expect(out.map((s) => s.id)).toEqual(['ship', 'build', 'review']);
  });
  it('throws on a non-permutation', () => {
    expect(() => reorderStepsArray(steps(), ['build', 'review'])).toThrow();
    expect(() => reorderStepsArray(steps(), ['build', 'build', 'review'])).toThrow();
  });
});

describe('stepInsertionIndex', () => {
  const s = steps();
  it('appends by default', () => expect(stepInsertionIndex(s)).toBe(3));
  it('inserts after a step', () => expect(stepInsertionIndex(s, { after: 'build' })).toBe(1));
  it('inserts before a step', () => expect(stepInsertionIndex(s, { before: 'ship' })).toBe(2));
  it('clamps an explicit index', () => expect(stepInsertionIndex(s, { index: 99 })).toBe(3));
});

describe('applyStepPatch', () => {
  it('sets and clears fields, preserving extra (lifecycle) props', () => {
    const base = { id: 'a', name: 'A', next: 'b', createdAt: 'T' } as CraftbookStep & {
      createdAt: string;
    };
    const out = applyStepPatch(base, { name: 'A2', next: null, suggestedRole: 'dev' });
    expect(out).toMatchObject({ id: 'a', name: 'A2', suggestedRole: 'dev', createdAt: 'T' });
    expect(out.next).toBeUndefined();
  });
  it('sets, preserves, and clears capabilityFloor', () => {
    const base: CraftbookStep = { id: 'a', name: 'A' };
    const set = applyStepPatch(base, { capabilityFloor: 'medium' });
    expect(set.capabilityFloor).toBe('medium');
    const untouched = applyStepPatch(set, { name: 'A2' });
    expect(untouched.capabilityFloor).toBe('medium');
    const cleared = applyStepPatch(set, { capabilityFloor: null });
    expect('capabilityFloor' in cleared).toBe(false);
  });
  it('sets and clears declared inputs', () => {
    const base: CraftbookStep = { id: 'a', name: 'A', prompt: 'Call `read_artifact`.' };
    const set = applyStepPatch(base, {
      consumes: [{ file: 'security/scope.md', artifact: true }],
    });
    expect(set.consumes).toEqual([{ file: 'security/scope.md', artifact: true }]);
    const cleared = applyStepPatch(set, { consumes: null });
    expect('consumes' in cleared).toBe(false);
  });
});

describe('assertCraftbookGraph', () => {
  it('throws on an invalid graph', () => {
    expect(() => assertCraftbookGraph({ steps: steps(), entryStepId: 'ghost' })).toThrow(
      /invalid craftbook/,
    );
  });
});
