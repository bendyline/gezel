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

  it('passes concrete eval paths declared through authored path variables', () => {
    const dynamicBook = template([
      {
        id: 'build',
        prompt:
          'Write characters/<name>/sheet.json and posts/<created>-<slug>/variants/bluesky.md.',
      },
    ]);
    expect(
      classifyDeliverableReachability(
        spec([
          { path: 'characters/pip/sheet.json' },
          { path: 'posts/2026-08-12-returns-desk/variants/bluesky.md' },
        ]),
        dynamicBook,
      ),
    ).toBeNull();
  });

  it('passes named children under a separately declared symbolic destination folder', () => {
    const dynamicBook = template([
      {
        id: 'finalize',
        prompt:
          'Commit the draft to posts/<created>-<slug>/. Recreate post.md at the root and every variants/ file, including x.md.',
      },
    ]);
    expect(
      classifyDeliverableReachability(
        spec([
          { path: 'posts/2026-08-12-returns-desk/post.md' },
          { path: 'posts/2026-08-12-returns-desk/variants/x.md' },
        ]),
        dynamicBook,
      ),
    ).toBeNull();
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

  it('accepts user-directed outputs for a real terminal workflow with no static file contract', () => {
    const genericWorkflow = template([{ id: 'active', terminal: true }]);
    const workflowSpec = spec([{ path: 'brief.md' }]);
    workflowSpec.mode = 'workflow';
    workflowSpec.success.taskGraph = {
      requireCraftbookTask: true,
      requireTerminalStep: true,
    };
    expect(classifyDeliverableReachability(workflowSpec, genericWorkflow)).toBeNull();
  });

  it('does not excuse user-directed outputs without workflow attribution and terminal proof', () => {
    const genericWorkflow = template([{ id: 'active', terminal: true }]);
    const finding = classifyDeliverableReachability(spec([{ path: 'brief.md' }]), genericWorkflow);
    expect(finding?.verdict).toBe('unreachable');
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
    expect(summary.folderDrift).toBe(0);
    expect(summary.unreachable).toBe(0);
  });

  it('keeps the wild-caught inverted exemplars repaired', async () => {
    const templates = await loadCraftbookTemplates();
    const { findings } = auditDeliverableReachability(CRAFTBOOK_EVAL_SPECS, templates);
    const byId = new Map(findings.map((f) => [f.craftbookId, f]));
    expect(byId.has('db-index-tuning')).toBe(false);
    expect(byId.has('email-template')).toBe(false);
  });
});
