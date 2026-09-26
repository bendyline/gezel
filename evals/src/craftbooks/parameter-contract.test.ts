import { describe, expect, it } from 'vitest';
import { loadCraftbookTemplates } from './catalog.ts';
import { auditCraftbookParameterContracts } from './parameter-contract.ts';
import { CRAFTBOOK_EVAL_SPECS } from './specs.ts';
import type { CraftbookEvalSpec, CraftbookTemplateSummary } from './types.ts';

function template(
  paramSchema: Record<string, unknown> | undefined,
  extra: Partial<CraftbookTemplateSummary> = {},
): CraftbookTemplateSummary {
  return {
    id: 'sample-book',
    name: 'Sample book',
    version: '1.0.0',
    triggers: [],
    entryStepId: 'build',
    steps: [{ id: 'build', name: 'Build', terminal: true }],
    ...(paramSchema ? { paramSchema } : {}),
    ...extra,
  };
}

function spec(craftbookParams?: Record<string, string>): CraftbookEvalSpec {
  return {
    craftbookId: 'sample-book',
    scenarioId: 'craftbook-sample-book',
    title: 'Sample',
    objective: 'Exercise the sample.',
    mode: 'workflow',
    setup: {
      projectName: 'Sample',
      ...(craftbookParams ? { craftbookParams } : {}),
    },
    success: { summary: 'Done' },
    coverage: { status: 'implemented' },
    qualityFocus: [],
  };
}

function findings(book: CraftbookTemplateSummary, evalSpec: CraftbookEvalSpec = spec()) {
  return auditCraftbookParameterContracts([evalSpec], [book]).findings;
}

describe('craftbook parameter schemas', () => {
  it('accepts flat arrays and rejects structured objects the launcher cannot serialize', () => {
    const result = findings(
      template({
        type: 'object',
        properties: {
          tags: { type: 'array', title: 'Tags', description: 'Tags to use.' },
          settings: { type: 'object', title: 'Settings', description: 'Settings to use.' },
          limit: { type: 'integer', title: 'Limit', description: 'Maximum count.' },
        },
      }),
    );
    expect(
      result.filter((item) => item.code === 'param.unsupported-type').map((f) => f.param),
    ).toEqual(['settings']);
  });

  it('requires labels and help text only for fields the launch form shows', () => {
    const result = findings(
      template({
        type: 'object',
        properties: {
          topic: { type: 'string' },
          internal: { type: 'string', askUser: false },
          workPath: { type: 'string', default: '{{task.dir}}' },
        },
      }),
    );
    expect(result.filter((item) => item.code.includes('missing')).map((f) => f.param)).toEqual([
      'topic',
      'topic',
    ]);
  });

  it('keeps templated output choices visible while hiding the standard workPath', () => {
    const result = findings(
      template({
        type: 'object',
        properties: {
          workPath: { type: 'string', default: '{{task.dir}}' },
          outputPath: {
            type: 'string',
            title: 'Output path',
            description: 'May be overridden.',
            default: 'reports/task-{{task.num}}.md',
          },
          internalPath: {
            type: 'string',
            askUser: false,
            default: '{{task.dir}}/internal.json',
          },
        },
      }),
    );
    expect(
      result
        .filter((item) => item.code === 'param.unintended-hidden-template-default')
        .map((item) => item.param),
    ).toEqual([]);
  });
});

describe('craftbook eval fixtures', () => {
  it('flags undeclared fixture params and required params with no fixture/provider/default', () => {
    const result = findings(
      template({
        type: 'object',
        properties: {
          source: {
            type: 'string',
            title: 'Source',
            description: 'Input folder.',
            input: { kind: 'folder' },
          },
          language: {
            type: 'string',
            title: 'Language',
            description: 'Output language.',
          },
        },
        required: ['source', 'language'],
      }),
      spec({ stray: 'value' }),
    );
    expect(
      result.filter((item) => item.code === 'test.undeclared-param').map((f) => f.param),
    ).toEqual(['stray']);
    expect(
      result.filter((item) => item.code === 'test.missing-required-param').map((f) => f.param),
    ).toEqual(['language', 'source']);
  });

  it('recognizes defaults, connector preparation, and project properties as runtime providers', () => {
    const book = template(
      {
        type: 'object',
        properties: {
          limit: { type: 'integer', title: 'Limit', description: 'Count.', default: 5 },
          number: { type: 'string', title: 'PR', description: 'Pull request.' },
          language: {
            type: 'string',
            title: 'Language',
            description: 'Output language.',
            projectProperty: 'content.language',
          },
        },
        required: ['limit', 'number', 'language'],
      },
      { connectors: [{ typeId: 'github-pulls' }] },
    );
    expect(findings(book).filter((item) => item.code === 'test.missing-required-param')).toEqual(
      [],
    );
  });
});

describe('runtime interpolation surfaces', () => {
  it('resolves nested defaults, reserved tokens, fixture params, and connector output', () => {
    const book = template(
      {
        type: 'object',
        properties: {
          outputDir: {
            type: 'string',
            askUser: false,
            default: '{{task.dir}}/reports',
          },
          outputPath: {
            type: 'string',
            askUser: false,
            default: '{{outputDir}}/report.md',
          },
          suffix: { type: 'string', title: 'Suffix', description: 'File suffix.' },
        },
      },
      {
        connectors: [{ typeId: 'github-pulls' }],
        steps: [
          {
            id: 'build',
            name: 'Build',
            advanceWhen: { file: '{{outputPath}}' },
            gate: {
              at: 'completion',
              checks: [
                { kind: 'minBytes', file: '{{outputPath}}', bytes: 1 },
                { kind: 'corpusCoverage', corpusDir: '{{corpusScope}}', outFile: 'x-{{suffix}}' },
              ],
            },
            consumes: [{ file: '{{task.dir}}/input.md', artifact: true }],
            terminal: true,
          },
        ],
      },
    );
    expect(findings(book, spec({ suffix: 'done.json' }))).toEqual([]);
  });

  it('reports unresolved tokens in gates and path-bearing step fields', () => {
    const book = template(
      {
        type: 'object',
        properties: {
          reviewId: { type: 'string', askUser: false },
        },
      },
      {
        steps: [
          {
            id: 'build',
            name: 'Build',
            advanceWhen: { file: 'reviews/{{reviewId}}/report.md' },
            gate: {
              at: 'completion',
              checks: [{ kind: 'minBytes', file: 'reviews/{{reviewId}}/report.md', bytes: 1 }],
            },
            terminal: true,
          },
        ],
      },
    );
    const result = findings(book).filter((item) => item.code === 'path.unresolved-token');
    expect(result).toHaveLength(2);
    expect(result.every((item) => item.token === 'reviewId')).toBe(true);
  });

  it('allows arbitrary spawn item fields but still audits the host overFile', () => {
    const book = template(undefined, {
      spawn: {
        overFile: '{{missingHostParam}}/items.json',
        steps: [
          {
            id: 'child',
            name: 'Child',
            advanceWhen: { file: 'out/{{slug}}.md' },
            gate: {
              at: 'completion',
              checks: [{ kind: 'minBytes', file: 'out/{{slug}}.md', bytes: 1 }],
            },
            terminal: true,
          },
        ],
      },
    });
    const result = findings(book).filter((item) => item.code === 'path.unresolved-token');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: 'spawn.overFile', token: 'missingHostParam' });
  });
});

describe('against the bundled library', () => {
  it('covers every active craftbook and preserves the known parameter-contract exemplars', async () => {
    const templates = await loadCraftbookTemplates();
    const summary = auditCraftbookParameterContracts(CRAFTBOOK_EVAL_SPECS, templates);
    expect(summary.checked).toBeGreaterThan(280);
    expect(summary.clean + summary.withFindings).toBe(summary.checked);
    // Ratchets, not targets: content fixes should move these down. Raising
    // either bound requires reviewing the new launcher/runtime defect.
    expect(summary.failures).toBeLessThanOrEqual(3);
    expect(summary.warnings).toBeLessThanOrEqual(11);

    const byBook = new Map<string, Set<string>>();
    for (const item of summary.findings) {
      const codes = byBook.get(item.craftbookId) ?? new Set<string>();
      codes.add(item.code);
      byBook.set(item.craftbookId, codes);
    }
    expect(byBook.get('draft-social-post')).toBeUndefined();
    expect(byBook.get('executive-level-review')).toContain('test.undeclared-param');
    expect(byBook.get('security-architecture-review')).toContain('test.undeclared-param');
    expect(byBook.get('powerpoint-deck')).toBeUndefined();
    expect(byBook.get('pull-request-review')).toBeUndefined();
  });
});
