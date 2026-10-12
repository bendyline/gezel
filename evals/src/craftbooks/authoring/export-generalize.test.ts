import { beforeEach, describe, expect, it, vi } from 'vitest';
import { postSniffFeedback } from '../../sniff-feedback.ts';
import type { EvalContext } from '../../types.ts';
import {
  SUPPLIERS_Q1_JSON,
  SUPPLIERS_Q2_JSON,
  exportGeneralizeScenario,
} from './export-generalize.ts';

vi.mock('../../sniff-feedback.ts', () => ({ postSniffFeedback: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

function context(
  opts: { status?: string; noTask?: boolean; copied?: boolean; missing?: boolean } = {},
): EvalContext {
  const q1 = JSON.parse(SUPPLIERS_Q1_JSON).filter(
    (row: { leadTimeDays: number }) => row.leadTimeDays > 0,
  );
  const q2 = JSON.parse(SUPPLIERS_Q2_JSON).filter(
    (row: { leadTimeDays: number }) => row.leadTimeDays > 0,
  );
  const outputs: Record<string, string> = {
    'out/q1-intake.md':
      'Q1 checked eight suppliers; removed Norrland Textiles and Alpine Cork Supply because their lead times were impossible.',
    'out/q1-clean.json': JSON.stringify(q1),
    'out/q2-intake.md':
      'Q2 checked eight suppliers; removed Trollhaugen Wool and Zagreb Enamel because their lead times were impossible.',
    'out/q2-clean.json': JSON.stringify(q2),
  };
  if (opts.copied) {
    outputs['out/q2-intake.md'] = outputs['out/q1-intake.md']!;
    outputs['out/q2-clean.json'] = outputs['out/q1-clean.json']!;
  }
  return {
    meesterId: 'coordinator',
    log: vi.fn(),
    logChanged: vi.fn(),
    recordSniff: vi.fn(),
    client: {
      listProjects: async () => ({
        projects: [{ id: 'supplier-intake', name: 'Supplier Intake' }],
      }),
      listCraftbooks: async () => ({
        craftbooks: [
          {
            id: 'supplier-intake-unused',
            name: 'Supplier intake draft',
            source: 'local',
            stepCount: 3,
          },
          {
            id: 'supplier-quarterly-intake',
            name: 'Quarterly intake',
            source: 'local',
            stepCount: 2,
          },
        ],
      }),
      getCraftbook: async (id: string) => ({
        craftbook: { id, steps: [{ id: 'clean' }, { id: 'write' }] },
      }),
      listProjectTasks: async () => ({
        tasks: opts.noTask
          ? []
          : [
              {
                ref: 'supplier-intake/1',
                status: 'paused',
                craftbook: { id: 'supplier-quarterly-intake' },
              },
              {
                ref: 'supplier-intake/2',
                status: opts.status ?? 'complete',
                craftbook: { id: 'supplier-quarterly-intake' },
              },
            ],
      }),
      fetchProjectWorkspaceBlob: async (_project: string, path: string) => {
        if (opts.missing || !outputs[path]) throw new Error('missing');
        return new Blob([outputs[path]!]);
      },
    },
  } as unknown as EvalContext;
}

describe('generalization recipe lineage', () => {
  it('grades the completed reusable recipe rather than a longer unused draft', async () => {
    const result = await exportGeneralizeScenario.successCheck(context());
    expect(result).toMatchObject({ done: true, success: true });
    expect(postSniffFeedback).not.toHaveBeenCalled();
  });

  it.each([{ status: 'paused' }, { noTask: true }, { copied: true }, { missing: true }])(
    'still requires completed recipe execution and distinct deliverables: %j',
    async (opts) => {
      expect(await exportGeneralizeScenario.successCheck(context(opts))).toEqual({ done: false });
    },
  );

  it('sends missing-recipe-launch feedback to the coordinator that can launch it', async () => {
    await exportGeneralizeScenario.successCheck(context({ noTask: true }));
    expect(postSniffFeedback).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ targetGezelId: 'coordinator' }),
    );
  });
});
