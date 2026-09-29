import { CraftbookDocSchema, CraftbookTestSpecSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { declaredWorkflowOutputs, rebuildWorkflowTestSpec } from './rebuild-workflow-spec.ts';

const doc = CraftbookDocSchema.parse({
  id: 'sample-book',
  name: 'Sample Book',
  description: 'Analyze the local fixture and publish a grounded report.',
  version: '1.0.0',
  releasedAt: '2026-09-26T00:00:00Z',
  entryStepId: 'analyze',
  paramSchema: {
    type: 'object',
    properties: {
      workPath: { type: 'string', default: '{{task.dir}}' },
    },
  },
  steps: [
    {
      id: 'analyze',
      name: 'Analyze',
      next: 'finish',
      advanceWhen: { file: '{{workPath}}/report.md', minBytes: 240, artifact: true },
      gate: {
        at: 'completion',
        checks: [
          {
            kind: 'contains',
            file: '{{workPath}}/report.md',
            pattern: 'Finding',
            artifact: true,
          },
        ],
      },
    },
    { id: 'finish', name: 'Finish', terminal: true },
  ],
});

const original = CraftbookTestSpecSchema.parse({
  schemaVersion: 1,
  title: 'Generic family smoke',
  objective: 'Write an unrelated placeholder.',
  tags: ['corpus'],
  prompt: 'Read records.csv and write analysis.md.',
  setup: {
    projectName: 'Old Eval',
    files: [{ path: 'source/records.csv', content: 'id,value\n1,2\n' }],
  },
  mocks: [],
  success: {
    summary: 'analysis.md exists',
    deliverables: [{ path: 'analysis.md', kind: 'markdown-report', minBytes: 20 }],
  },
  rubric: {
    artifact: { path: 'analysis.md', kind: 'markdown' },
    axes: [{ name: 'clarity', description: 'The placeholder is clear.' }],
  },
  qualityFocus: ['generic output'],
});

describe('rebuildWorkflowTestSpec', () => {
  it('derives task-relative drawer outputs from the craftbook gates', () => {
    expect(declaredWorkflowOutputs(doc, original)).toEqual([
      { path: '{{task.dir}}/report.md', artifact: true, minBytes: 240 },
    ]);
  });

  it('replaces the inverted artifact smoke with a terminal workflow contract', () => {
    const rebuilt = rebuildWorkflowTestSpec(doc, original).spec;
    expect(CraftbookTestSpecSchema.safeParse(rebuilt).success).toBe(true);
    expect(rebuilt.mode).toBe('workflow');
    expect(rebuilt.prompt).toContain('sample-book');
    expect(rebuilt.success.deliverables).toEqual([
      {
        path: '{{task.dir}}/report.md',
        kind: 'markdown-report',
        artifact: true,
        minBytes: 240,
      },
    ]);
    expect(rebuilt.success.taskGraph).toEqual({
      requireCraftbookTask: true,
      requireTerminalStep: true,
    });
    expect(rebuilt.setup.files.map((file) => file.path)).toContain(
      'source/craftbook-eval-brief.md',
    );
  });

  it('retains hook evidence when a workflow has no static output path', () => {
    const guardrail = CraftbookDocSchema.parse({
      id: 'guardrail',
      name: 'Guardrail',
      description: 'Install a local safety hook.',
      version: '1.0.0',
      releasedAt: '2026-09-26T00:00:00Z',
      entryStepId: 'active',
      steps: [{ id: 'active', name: 'Active', terminal: true }],
    });
    const withHistory = CraftbookTestSpecSchema.parse({
      ...original,
      success: {
        ...original.success,
        history: [{ kind: 'tool.gated', minEntries: 1 }],
        unchangedFixtures: ['source/records.csv'],
      },
    });
    const rebuilt = rebuildWorkflowTestSpec(guardrail, withHistory).spec;
    expect(rebuilt.success.history).toEqual(withHistory.success.history);
    expect(rebuilt.success.unchangedFixtures).toEqual(['source/records.csv']);
    expect(rebuilt.success.deliverables).toEqual(original.success.deliverables);
  });
});
