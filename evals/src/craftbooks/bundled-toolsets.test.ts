import type { MockService } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { powerpointSourceSpecs } from '../scenarios/powerpoint-sources.ts';
import { withRealBundledToolsets } from './bundled-toolsets.ts';
import { craftbookScenarioFromSpec } from './scenario.ts';
import { craftbookEvalSpecMap } from './specs.ts';
import type { CraftbookEvalSpec } from './types.ts';

const called = (name: string) => ({ kind: 'tool.called', details: { name, success: true } });

function mcpMock(id: string, toolsetId?: string): MockService {
  return {
    kind: 'mcp',
    id,
    ...(toolsetId ? { toolsetId } : {}),
    tools: [{ name: 'noop', resultTemplate: {} }],
  } as unknown as MockService;
}

describe('withRealBundledToolsets', () => {
  it('runs every DocBlocks book on the real tool, graded by its successful calls', () => {
    const spec = craftbookEvalSpecMap().get('powerpoint-deck')!;
    expect(spec.mocks ?? []).toEqual([]);
    expect(spec.success.mocks ?? []).toEqual([]);
    expect(spec.requiresDocblocks).toBe(true);
    for (const name of [
      'convert_document',
      'preview_document',
      'save_artifact',
      'inspect_document',
    ]) {
      expect(spec.success.history).toContainEqual(called(name));
    }
    expect(craftbookScenarioFromSpec(spec).requiresDocblocks).toBe(true);
  });

  it('keeps other mocks and their expectations, and adds no duplicate History check', () => {
    const base = {
      ...craftbookEvalSpecMap().get('research-to-document')!,
      mocks: [mcpMock('docblocks', 'docblocks'), mcpMock('crm')],
      success: {
        summary: 's',
        mocks: [
          { service: 'docblocks', requiredTools: ['convert_document', 'save_artifact'] },
          { service: 'crm', requiredTools: ['noop'] },
        ],
        history: [called('save_artifact')],
      },
    } as CraftbookEvalSpec;
    const spec = withRealBundledToolsets(base);
    expect(spec.mocks?.map((mock) => mock.id)).toEqual(['crm']);
    expect(spec.success.mocks).toEqual([{ service: 'crm', requiredTools: ['noop'] }]);
    expect(spec.success.history).toEqual([called('save_artifact'), called('convert_document')]);
  });

  it('leaves a spec with no bundled-toolset mock untouched', () => {
    const spec = {
      ...craftbookEvalSpecMap().get('research-to-document')!,
      mocks: [mcpMock('crm')],
    };
    expect(withRealBundledToolsets(spec)).toBe(spec);
  });

  it("keeps the book's real-tool checks on every PowerPoint source variant", () => {
    for (const spec of powerpointSourceSpecs()) {
      expect(spec.success.history, spec.scenarioId).toContainEqual(called('convert_document'));
    }
    const docx = powerpointSourceSpecs().find((spec) => spec.scenarioId === 'pptx-source-docx')!;
    expect(docx.success.history).toContainEqual(called('read_doc_as_markdown'));
  });
});
