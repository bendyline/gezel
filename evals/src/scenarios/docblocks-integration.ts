import { craftbookScenarioFromSpec } from '../craftbooks/scenario.ts';
import { craftbookEvalSpecMap } from '../craftbooks/specs.ts';
import type { CraftbookEvalSpec } from '../craftbooks/types.ts';
import type { EvalScenario } from '../types.ts';

export const DOCBLOCKS_CRAFTBOOK_IDS = [
  'research-to-document',
  'report-pdf',
  'powerpoint-deck',
  'narrated-slideshow',
] as const;

const OUTPUTS: Record<string, string[]> = {
  'research-to-document': ['report.docx'],
  'report-pdf': ['report.pdf'],
  'powerpoint-deck': ['deck.pptx'],
  'narrated-slideshow': ['slideshow.mp4', 'slideshow.gif'],
};

const BRIEFS: Record<string, string> = {
  'research-to-document':
    'Create an editable Word report from source/brief.md for operations leaders. Include a title, executive summary, compact metrics table, findings, and next actions.',
  'report-pdf':
    'Create a formatted PDF report from source/brief.md for operations leaders. Include a title, executive summary, compact metrics table, findings, and explicit recommendations.',
  'powerpoint-deck':
    'Create a PowerPoint from source/brief.md for operations leads. Use 6–8 slides and close with next actions. Deliver the editable deck at the requested outputPath.',
  'narrated-slideshow':
    'Create a seven-scene animated operations update from source/brief.md. Use short on-screen bullets and a final next-actions scene. Deliver both MP4 and animated GIF.',
};

/** Keep simulator scorecards reproducible; run the real production boundary separately. */
export function realDocblocksSpec(source: CraftbookEvalSpec): CraftbookEvalSpec {
  const outputs = OUTPUTS[source.craftbookId];
  if (!outputs) throw new Error(`No DocBlocks integration contract for ${source.craftbookId}`);
  const workPath = source.setup?.craftbookParams?.workPath ?? '{{task.dir}}';
  // Simulator prompts may mandate fake template names or even direct a save to
  // the workspace. Give the production workflow the brief, not mock instructions.
  const prompt = `${BRIEFS[source.craftbookId]} Preserve the supplied facts and do not invent other metrics. Follow the complete craftbook through publishing and review with the real DocBlocks tools. Keep the Markdown source and save the requested binary deliverables to the craftbook's declared paths. Report exactly what was verified and any preview limitations.`;
  return {
    ...source,
    scenarioId: `docblocks-${source.craftbookId}`,
    mode: 'workflow',
    repairPolicy: 'runtime',
    timeoutMs: 60 * 60_000,
    mocks: [],
    setup: { ...source.setup!, simulators: [], missionObjectives: prompt },
    prompt,
    success: {
      ...source.success,
      mocks: [],
      checks: [
        ...(source.success.checks ?? []),
        ...outputs.map((file) => ({
          kind: 'binaryDocument' as const,
          file: `${workPath}/${file}`,
          artifact: true,
          minBytes: 800,
        })),
      ],
      history: [
        ...(source.success.history ?? []),
        ...['convert_document', 'preview_document', 'save_artifact'].map((name) => ({
          kind: 'tool.called',
          details: { name, success: true },
        })),
      ],
    },
    coverage: {
      status: 'implemented',
      notes:
        'Real multi-role workflow, real DocBlocks CLI, saved binary and successful tool-history gates. Requires Chromium; slideshow also requires FFmpeg.',
    },
    gaps: ['Native PowerPoint/Word visual fidelity requires separate inspection.'],
  };
}

export function docblocksIntegrationScenarios(): EvalScenario[] {
  const specs = craftbookEvalSpecMap();
  return DOCBLOCKS_CRAFTBOOK_IDS.map((id) => {
    const source = specs.get(id);
    if (!source) throw new Error(`Missing DocBlocks craftbook ${id}`);
    const scenario = craftbookScenarioFromSpec(realDocblocksSpec(source));
    return {
      ...scenario,
      requiresDocblocks: true,
      async setup(ctx) {
        const { toolsets } = await ctx.client.listInstalledToolsets({ kind: 'shared' });
        if (process.env.GEZEL_EVAL_DOCBLOCKS_DIR) {
          const { realpath } = await import('node:fs/promises');
          const expected = await realpath(process.env.GEZEL_EVAL_DOCBLOCKS_DIR);
          const installed = toolsets.find((toolset) => toolset.toolsetId === 'docblocks');
          if (!installed?.installPath || (await realpath(installed.installPath)) !== expected) {
            throw new Error('The shared DocBlocks runtime does not match the requested local CLI');
          }
        }
        if (!toolsets.some((toolset) => toolset.toolsetId === 'docblocks')) {
          await ctx.client.installToolset('docblocks', {
            sourceId: 'bundled',
            scope: { kind: 'shared' },
          });
        }
        await scenario.setup?.(ctx);
      },
    };
  });
}
