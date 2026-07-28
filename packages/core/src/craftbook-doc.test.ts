import { describe, expect, it } from 'vitest';
import {
  craftbookFromDoc,
  docFromCraftbook,
  parseCraftbookDoc,
  serializeCraftbookDoc,
} from './craftbook-doc.js';
import type { CraftbookDoc } from './schemas/index.js';
import {
  CraftbookDocSchema,
  formatCraftbookDocErrors,
  sniffCraftbookDocFormat,
} from './schemas/index.js';

const SCRIPT_SOURCE = `import { gezel, defineScript } from '@bendyline/gezel-sdk';
export const meta = defineScript({
  name: 'checkPrices',
  description: 'gate: the prices file has plausible rows.',
  kind: 'gate',
});
gezel.output({ decision: 'approve' });`;

const FULL_DOC: CraftbookDoc = {
  id: 'scrape-prices',
  name: 'Scrape prices',
  description: 'Scrape competitor prices and produce a report.\n\nRuns unattended.',
  basedOn: { name: 'Upstream recipe', url: 'https://example.com/upstream-recipe' },
  entryStepId: 'fetch',
  triggers: ['scrape prices', 'price check'],
  command: 'scrape-prices',
  steps: [
    {
      id: 'fetch',
      name: 'Fetch data',
      prompt: 'Pull the raw price data.\n\nUse the seeded credentials.',
      capabilityFloor: 'small',
      deliverable: { path: 'prices.csv', kind: 'data-file', minBytes: 200 },
      next: 'report',
    },
    {
      id: 'report',
      name: 'Write report',
      prompt: 'Summarize prices.csv into report.md.',
      gate: {
        at: 'completion',
        scripts: [{ name: 'checkPrices', scope: 'craftbook' }],
        onReject: 'report',
      },
      terminal: true,
    },
  ],
  scripts: { checkPrices: SCRIPT_SOURCE },
};

const HOOKED_DOC: CraftbookDoc = {
  ...FULL_DOC,
  id: 'scrape-prices-guarded',
  hooks: [
    {
      phase: 'PreToolUse',
      matcher: '^(delete_path|write_file)$',
      script: { name: 'checkPrices', scope: 'craftbook' },
      label: 'destructive-write check',
    },
    { phase: 'PostToolUse', matcher: '.*', decision: 'allow' },
  ],
};

describe('craftbook-doc codecs — round trip', () => {
  it('requires basedOn links to use http or https', () => {
    const parsed = CraftbookDocSchema.safeParse({
      ...FULL_DOC,
      basedOn: { name: 'Unsafe upstream', url: 'javascript:alert(1)' },
    });
    expect(parsed.success).toBe(false);
  });

  for (const format of ['json', 'markdown'] as const) {
    it(`${format}: parse(serialize(doc)) deep-equals doc`, () => {
      const text = serializeCraftbookDoc(FULL_DOC, format);
      expect(sniffCraftbookDocFormat(text)).toBe(format);
      const back = parseCraftbookDoc(text, format);
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.doc).toEqual(FULL_DOC);
    });

    it(`${format}: hooks ride the round trip`, () => {
      const text = serializeCraftbookDoc(HOOKED_DOC, format);
      const back = parseCraftbookDoc(text, format);
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.doc.hooks).toEqual(HOOKED_DOC.hooks);
    });
  }

  it('markdown: a script source containing ``` fences survives (longer outer fence)', () => {
    const doc: CraftbookDoc = {
      ...FULL_DOC,
      scripts: {
        checkPrices: `${SCRIPT_SOURCE}\n// example:\n// \`\`\`ts\n// nested fence\n// \`\`\``,
      },
    };
    const text = serializeCraftbookDoc(doc, 'markdown');
    const back = parseCraftbookDoc(text, 'markdown');
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.doc.scripts).toEqual(doc.scripts);
  });

  it('markdown: prompt prose with a fenced code example does not break section splitting', () => {
    const doc: CraftbookDoc = {
      name: 'Fence test',
      steps: [
        {
          id: 'a',
          name: 'A',
          prompt: 'Example output:\n\n~~~\n## Step: not a real heading\n~~~\n\nDo it like that.',
          next: 'b',
        },
        { id: 'b', name: 'B', terminal: true },
      ],
    };
    const text = serializeCraftbookDoc(doc, 'markdown');
    const back = parseCraftbookDoc(text, 'markdown');
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.doc.steps).toHaveLength(2);
      expect(back.doc.steps[0]!.prompt).toContain('not a real heading');
    }
  });
});

describe('parseCraftbookDoc — repair-grade errors', () => {
  it('bad JSON names the parse failure and the escape-newlines fix', () => {
    const res = parseCraftbookDoc('{ "name": "x", ', 'json');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]!.where).toBe('document');
      expect(res.errors[0]!.fix).toContain('truncated');
    }
  });

  it('a bad enum value lists the legal values with a closest match', () => {
    const res = parseCraftbookDoc(
      JSON.stringify({
        name: 'X',
        steps: [{ name: 'Build', deliverable: { path: 'x.html', kind: 'html-pge' } }],
      }),
      'json',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const msg = formatCraftbookDocErrors(res.errors);
      expect(msg).toContain('steps[0]');
      expect(msg).toContain('html-page');
      expect(msg).toContain('closest match');
    }
  });

  it('markdown with an unknown section heading points at the heading', () => {
    const res = parseCraftbookDoc('---\nname: X\n---\n\n## Stap: Build\n\ndo it\n', 'markdown');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.where.includes('Stap: Build'))).toBe(true);
      expect(res.errors.some((e) => e.fix?.includes('## Step:'))).toBe(true);
    }
  });
});

describe('craftbookFromDoc', () => {
  it('expands deliverables, defaults the entry step, and validates refs', () => {
    const res = craftbookFromDoc(
      {
        name: 'Simple',
        steps: [
          { name: 'Build', deliverable: { path: 'index.html' } },
          { name: 'Done', terminal: true },
        ],
      },
      { now: '2026-01-01T00:00:00.000Z' },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.craftbook.entryStepId).toBe('build');
      expect(res.craftbook.steps[0]!.gate).toMatchObject({ at: 'completion', onReject: 'build' });
    }
  });

  it('a dangling next gets valid ids + a did-you-mean fix', () => {
    const res = craftbookFromDoc(
      {
        name: 'Broken',
        steps: [
          { id: 'build', name: 'Build', next: 'reviw' },
          { id: 'review', name: 'Review', terminal: true },
        ],
      },
      { now: '2026-01-01T00:00:00.000Z' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const msg = formatCraftbookDocErrors(res.errors);
      expect(msg).toContain('did you mean "review"');
      expect(msg).toContain('valid step ids: build, review');
    }
  });

  it('carries hooks onto the runtime craftbook and validates their script refs', () => {
    const ok = craftbookFromDoc(HOOKED_DOC, { now: '2026-01-01T00:00:00.000Z' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.craftbook.hooks).toEqual(HOOKED_DOC.hooks);

    const broken = craftbookFromDoc(
      {
        ...HOOKED_DOC,
        hooks: [
          {
            phase: 'PreToolUse',
            matcher: '.*',
            script: { name: 'checkPrizes', scope: 'craftbook' },
            label: 'typo hook',
          },
        ],
      },
      { now: '2026-01-01T00:00:00.000Z' },
    );
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      const msg = formatCraftbookDocErrors(broken.errors);
      expect(msg).toContain('hooks[0] ("typo hook")');
      expect(msg).toContain('did you mean "checkPrices"');
    }
  });

  it('a craftbook-scope ref missing from the scripts map is rejected', () => {
    const res = craftbookFromDoc(
      {
        name: 'Missing script',
        steps: [
          {
            id: 'build',
            name: 'Build',
            gate: { at: 'completion', scripts: [{ name: 'nope', scope: 'craftbook' }] },
            terminal: true,
          },
        ],
        scripts: { other: 'export const meta = { name: "other", description: "unused here" };' },
      },
      { now: '2026-01-01T00:00:00.000Z' },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(formatCraftbookDocErrors(res.errors)).toContain('"nope"');
  });

  it('docFromCraftbook(book) is accepted back unchanged (read→write loop)', () => {
    const first = craftbookFromDoc(FULL_DOC, { now: '2026-01-01T00:00:00.000Z' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const doc = docFromCraftbook(first.craftbook);
    for (const format of ['json', 'markdown'] as const) {
      const reparsed = parseCraftbookDoc(serializeCraftbookDoc(doc, format), format);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) continue;
      const second = craftbookFromDoc(reparsed.doc, {
        now: '2026-01-02T00:00:00.000Z',
        createdAt: first.craftbook.createdAt,
      });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect({ ...second.craftbook, updatedAt: '' }).toEqual({
          ...first.craftbook,
          updatedAt: '',
        });
      }
    }
  });
});
