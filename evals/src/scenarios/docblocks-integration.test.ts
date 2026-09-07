import { describe, expect, it, vi } from 'vitest';
import { craftbookScenarioFromSpec } from '../craftbooks/scenario.ts';
import { craftbookEvalSpecMap } from '../craftbooks/specs.ts';
import type { EvalContext } from '../types.ts';
import {
  DOCBLOCKS_CRAFTBOOK_IDS,
  docblocksIntegrationScenarios,
  realDocblocksSpec,
} from './docblocks-integration.ts';

describe('real DocBlocks workflow coverage', () => {
  it('runs every DocBlocks craftbook without a simulator and gates publishing, not just source text', () => {
    const specs = craftbookEvalSpecMap();
    for (const id of DOCBLOCKS_CRAFTBOOK_IDS) {
      const source = specs.get(id)!;
      const spec = realDocblocksSpec(source);
      expect(spec.mode).toBe('workflow');
      expect(spec.repairPolicy).toBe('runtime');
      expect(spec.mocks).toEqual([]);
      expect(spec.success.mocks).toEqual([]);
      expect(spec.success.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'binaryDocument', artifact: true }),
        ]),
      );
      expect(spec.success.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ details: { name: 'convert_document', success: true } }),
          expect.objectContaining({ details: { name: 'preview_document', success: true } }),
          expect.objectContaining({ details: { name: 'save_artifact', success: true } }),
        ]),
      );
      expect(spec.success.deliverables).toEqual(source.success.deliverables);
      expect(spec.prompt).not.toContain('Call `list_templates`');
      expect(spec.prompt).not.toContain('`save_artifact` to write the deck to');
      expect(spec.setup?.missionObjectives).toBe(spec.prompt);
      // The existing hermetic scorecard must retain its own simulator.
      expect(spec.success).not.toBe(source.success);
    }
    const media = realDocblocksSpec(specs.get('narrated-slideshow')!);
    expect(media.success.checks?.map((check) => ('file' in check ? check.file : ''))).toEqual(
      expect.arrayContaining(['{{task.dir}}/slideshow.mp4', '{{task.dir}}/slideshow.gif']),
    );
  });

  it('observes an active workflow without pushing its researcher toward the finish step', async () => {
    const task = {
      ref: 'sample/1',
      projectId: 'sample',
      num: 1,
      status: 'active',
      activeStepId: 'research',
      craftbook: {
        id: 'sample',
        steps: [
          { id: 'research', name: 'Read sources' },
          { id: 'finish', name: 'Finish', terminal: true },
        ],
      },
    };
    const client = {
      listProjects: vi.fn().mockResolvedValue({ projects: [{ id: 'sample', name: 'Sample' }] }),
      listProjectTasks: vi.fn().mockResolvedValue({ tasks: [task] }),
      messageGezel: vi.fn(),
      sendChatMessage: vi.fn(),
    };
    const scenario = craftbookScenarioFromSpec({
      craftbookId: 'sample',
      scenarioId: 'sample',
      title: 'Sample',
      objective: 'Run the whole workflow',
      mode: 'workflow',
      repairPolicy: 'runtime',
      prompt: 'Read sources, then publish.',
      setup: { projectName: 'Sample' },
      success: { summary: 'Reach the completed workflow' },
      coverage: { status: 'implemented' },
      qualityFocus: [],
    });
    const ctx = {
      client,
      meesterId: 'meester',
      log: vi.fn(),
      logChanged: vi.fn(),
    } as unknown as EvalContext;
    for (let poll = 0; poll < 10; poll++) {
      expect(await scenario.successCheck(ctx)).toEqual({ done: false });
    }
    expect(client.messageGezel).not.toHaveBeenCalled();
    expect(client.sendChatMessage).not.toHaveBeenCalled();
    task.status = 'paused';
    expect(await scenario.successCheck(ctx)).toMatchObject({ done: true, success: false });
  });

  it('registers four distinct real-runtime scenarios with no media-model download', () => {
    const scenarios = docblocksIntegrationScenarios();
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(4);
    for (const scenario of scenarios) {
      expect(scenario.requiresDocblocks).toBe(true);
      expect(scenario.mockServices).toBeUndefined();
      expect(scenario.defaultImageModelId).toBeUndefined();
      expect(scenario.skipInitialPrompt).toBe(true);
    }
  });
});
