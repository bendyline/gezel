import { describe, expect, it } from 'vitest';
import { contractLintProblems } from '../craftbook-contract-lint.js';
import { parseCraftbookMarkdown, serializeCraftbookMarkdown } from '../markdown/craftbook-md.js';
import {
  type CraftbookContract,
  CraftbookContractSchema,
  contractGateChecks,
  criterionEnforce,
  deliverableRole,
} from './craftbook-contract.js';
import { CraftbookDocSchema } from './craftbook-doc.js';

const DECK_CONTRACT: CraftbookContract = {
  goal: 'An editable PowerPoint whose figures are cited to, and present in, the supplied brief.',
  inputs: [{ path: '{{sourcePath}}', required: true }],
  deliverables: [
    {
      id: 'deck',
      path: '{{outputPath}}',
      kind: 'slide-deck',
      description: 'The saved deck',
      textSource: { path: '{{outputDir}}/deck.md' },
    },
    {
      id: 'deck-copy',
      path: '{{workPath}}/deck.pptx',
      artifact: true,
      kind: 'slide-deck',
      role: 'supporting',
      description: 'A retained copy',
    },
  ],
  grounding: { sources: ['{{sourcePath}}'], citationStyle: 'inline-path' },
  criteria: [
    {
      id: 'real-pptx',
      kind: 'acceptance',
      text: 'The deck is a real PowerPoint file',
      checks: [{ kind: 'minBytes', file: '{{outputPath}}', bytes: 1000 }],
    },
    {
      id: 'grounded',
      kind: 'quality',
      text: 'Every figure on a slide is cited and appears in the cited source',
      checks: [{ kind: 'claimsGrounded', file: '{{outputDir}}/deck.md' }],
    },
    {
      id: 'narrative',
      kind: 'quality',
      enforce: 'advisory',
      text: 'Opens with context and closes with next actions',
      judge: { rubric: 'Does the deck open with context and close with next actions?' },
    },
  ],
};

describe('CraftbookContractSchema', () => {
  it('accepts a research deck contract and reads its defaults', () => {
    const parsed = CraftbookContractSchema.parse(DECK_CONTRACT);
    expect(deliverableRole(parsed.deliverables[0]!)).toBe('primary');
    expect(deliverableRole(parsed.deliverables[1]!)).toBe('supporting');
    expect(criterionEnforce(parsed.criteria[0]!)).toBe('gate');
    expect(contractGateChecks(parsed).map((c) => c.kind)).toEqual(['minBytes', 'claimsGrounded']);
  });

  it('refuses a gate criterion with nothing to check', () => {
    const r = CraftbookContractSchema.safeParse({
      ...DECK_CONTRACT,
      criteria: [{ id: 'vague', kind: 'quality', text: 'It is good' }],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('has no checks');
  });

  it('refuses duplicate ids and a contract with no primary deliverable', () => {
    const duplicate = CraftbookContractSchema.safeParse({
      ...DECK_CONTRACT,
      criteria: [DECK_CONTRACT.criteria[0], DECK_CONTRACT.criteria[0]],
    });
    expect(JSON.stringify(duplicate.error?.issues)).toContain('duplicate criterion id');
    const supportingOnly = CraftbookContractSchema.safeParse({
      ...DECK_CONTRACT,
      deliverables: [DECK_CONTRACT.deliverables[1]],
    });
    expect(JSON.stringify(supportingOnly.error?.issues)).toContain('primary deliverable');
  });

  it('lints a check on a file the contract does not declare', () => {
    expect(contractLintProblems(DECK_CONTRACT)).toEqual([]);
    const processCheck: CraftbookContract = {
      ...DECK_CONTRACT,
      criteria: [
        ...DECK_CONTRACT.criteria,
        {
          id: 'outline',
          kind: 'quality',
          text: 'Has an outline',
          checks: [
            { kind: 'minBytes', file: '{{workPath}}/outline.md', bytes: 200, artifact: true },
          ],
        },
      ],
    };
    expect(contractLintProblems(processCheck)).toEqual([
      'criterion "outline" checks {{workPath}}/outline.md, which the contract does not declare as a deliverable, text source, input or grounding source',
    ]);
  });

  it('survives the markdown form of a craftbook document', () => {
    const doc = CraftbookDocSchema.parse({
      name: 'Deck',
      contract: DECK_CONTRACT,
      steps: [{ id: 'write', name: 'Write', prompt: 'Write the deck.' }],
    });
    const parsed = parseCraftbookMarkdown(serializeCraftbookMarkdown(doc));
    expect(parsed.ok).toBe(true);
    expect(parsed.doc?.contract).toEqual(DECK_CONTRACT);
  });
});
