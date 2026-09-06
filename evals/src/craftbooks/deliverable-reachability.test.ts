import { describe, expect, it } from 'vitest';
import { loadCraftbookTemplates } from './catalog.ts';
import {
  auditDeliverableReachability,
  classifyDeliverableReachability,
  craftbookGatedPaths,
} from './deliverable-reachability.ts';
import { CRAFTBOOK_EVAL_SPECS } from './specs.ts';
import type { CraftbookEvalSpec, CraftbookTemplateSummary } from './types.ts';

function template(steps: unknown[]): CraftbookTemplateSummary {
  return {
    id: 'sample-book',
    name: 'Sample',
    version: '1.0.0',
    triggers: [],
    entryStepId: 'build',
    steps,
  } as unknown as CraftbookTemplateSummary;
}

function spec(deliverables: unknown[], setup?: unknown): CraftbookEvalSpec {
  return {
    craftbookId: 'sample-book',
    scenarioId: 'craftbook-sample-book',
    title: 'Sample',
    mode: 'artifact-task',
    coverage: { status: 'implemented' },
    ...(setup ? { setup } : {}),
    success: { summary: '', deliverables },
  } as unknown as CraftbookEvalSpec;
}

describe('craftbookGatedPaths', () => {
  it('collects advanceWhen and gate-check files, including nested gate scripts', () => {
    const paths = craftbookGatedPaths(
      template([
        {
          id: 'build',
          advanceWhen: { file: 'Dockerfile' },
          gate: {
            at: 'completion',
            checks: [{ kind: 'minBytes', file: 'Dockerfile', bytes: 40 }],
            scripts: [{ name: 'checkX', inputs: { file: '{{workPath}}/verify.md' } }],
          },
        },
      ]),
    );
    expect(paths).toEqual(['Dockerfile', '{{workPath}}/verify.md']);
  });
});

describe('classifyDeliverableReachability', () => {
  const book = template([
    {
      id: 'build',
      prompt: 'Write the container definition to `Dockerfile`.',
      advanceWhen: { file: 'Dockerfile' },
      gate: { at: 'completion', checks: [{ kind: 'minBytes', file: 'Dockerfile', bytes: 40 }] },
    },
  ]);

  it('passes a deliverable the book names', () => {
    expect(classifyDeliverableReachability(spec([{ path: 'Dockerfile' }]), book)).toBeNull();
  });

  it('flags a deliverable the book never names as unreachable', () => {
    // dockerize-app: the book writes Dockerfile, the eval grades src/solution.mjs.
    const finding = classifyDeliverableReachability(spec([{ path: 'src/solution.mjs' }]), book);
    expect(finding?.verdict).toBe('unreachable');
    expect(finding?.paths).toEqual(['src/solution.mjs']);
    expect(finding?.bookGatedPaths).toContain('Dockerfile');
  });

  it('separates folder drift, whose repair is a workPath pin rather than a rewrite', () => {
    const workPathBook = template([
      {
        id: 'report',
        advanceWhen: { file: '{{workPath}}/report.md' },
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: '{{workPath}}/report.md', bytes: 200 }],
        },
      },
    ]);
    const finding = classifyDeliverableReachability(
      spec([{ path: 'tasks/eval/report.md' }]),
      workPathBook,
    );
    expect(finding?.verdict).toBe('folder-drift');
  });

  it('ignores a graded path the eval seeded itself', () => {
    // careful-mode / freeze-scope grade a fixture that must stay UNCHANGED;
    // the book is not supposed to write it.
    const finding = classifyDeliverableReachability(
      spec([{ path: 'source/protected.md' }], {
        projectName: 'x',
        files: [{ path: 'source/protected.md', content: 'do not touch' }],
      }),
      book,
    );
    expect(finding).toBeNull();
  });

  it('reports unreachable ahead of drift when a spec has both', () => {
    const mixed = template([
      { id: 'a', advanceWhen: { file: '{{workPath}}/report.md' } },
      { id: 'b', advanceWhen: { file: 'Dockerfile' } },
    ]);
    const finding = classifyDeliverableReachability(
      spec([{ path: 'tasks/eval/report.md' }, { path: 'analysis.md' }]),
      mixed,
    );
    expect(finding?.verdict).toBe('unreachable');
    expect(finding?.paths).toEqual(['analysis.md']);
  });
});

describe('against the bundled library', () => {
  it('measures how much of the library grades something its book never writes', async () => {
    const templates = await loadCraftbookTemplates();
    const summary = auditDeliverableReachability(CRAFTBOOK_EVAL_SPECS, templates);
    expect(summary.checked).toBeGreaterThan(200);
    expect(summary.reachable + summary.folderDrift + summary.unreachable).toBe(summary.checked);
    // A ratchet, not a target: this is the largest known gap in the craftbook
    // eval suite, and a content release that repairs specs should move it DOWN.
    // Raise this bound only with a deliberate reason.
    expect(summary.unreachable).toBeLessThanOrEqual(127);
  });

  it('names the wild-caught exemplars', async () => {
    const templates = await loadCraftbookTemplates();
    const { findings } = auditDeliverableReachability(CRAFTBOOK_EVAL_SPECS, templates);
    const byId = new Map(findings.map((f) => [f.craftbookId, f]));
    // The book writes migrations/add_indexes.sql; the eval grades analysis.md.
    expect(byId.get('db-index-tuning')?.verdict).toBe('unreachable');
    // The book writes email.html; the eval grades index.html.
    expect(byId.get('email-template')?.verdict).toBe('unreachable');
  });
});
