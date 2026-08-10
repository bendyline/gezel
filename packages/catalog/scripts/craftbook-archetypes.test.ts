import { describe, expect, it } from 'vitest';
import { archetypeToCraftbook } from '../src/archetype.js';
import { SEED_ARCHETYPES } from './craftbook-archetypes.js';

describe('revised seed craftbooks', () => {
  it('keeps every phase observable and uses the matching storage surface', () => {
    const revisedIds = new Set([
      'branding-website',
      'content-deck',
      'corpus-email-digest',
      'html-arcade-game',
      'image-set-index',
    ]);
    const revised = SEED_ARCHETYPES.filter((spec) => revisedIds.has(spec.id));
    expect(revised).toHaveLength(revisedIds.size);

    const expectedVersions = new Map([
      ['branding-website', '1.1.0'],
      ['content-deck', '1.2.0'],
      ['corpus-email-digest', '1.2.0'],
      ['html-arcade-game', '1.2.0'],
      ['image-set-index', '1.2.0'],
    ]);

    for (const spec of revised) {
      expect(spec.release?.version).toBe(expectedVersions.get(spec.id));
      expect(spec.phases.every((phase) => phase.produces !== undefined)).toBe(true);
      const byId = new Map(archetypeToCraftbook(spec).steps.map((step) => [step.id, step]));
      for (const phase of spec.phases) {
        const step = byId.get(phase.id);
        expect(step?.advanceWhen, `${spec.id}:${phase.id} advanceWhen`).toBeDefined();
        expect(step?.gate, `${spec.id}:${phase.id} gate`).toBeDefined();
        const artifact =
          phase.produces?.artifact === true ||
          (phase.produces?.artifact === undefined &&
            (phase.produces?.kind === 'markdown-notes' ||
              phase.produces?.kind === 'markdown-report'));
        expect((step?.advanceWhen as { artifact?: boolean } | undefined)?.artifact).toBe(
          artifact ? true : undefined,
        );
        expect(step?.prompt).toContain(artifact ? 'write_artifact' : 'write_file');
      }
    }
  });
});
