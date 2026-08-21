import { describe, expect, it } from 'vitest';
import {
  CraftbookInvocationParamsArgSchema,
  binaryDocumentCraftbookRequest,
  buildBinaryDocumentTaskDescription,
  inferCraftbookJobParams,
  normalizeCraftbookInvocationParams,
  suggestedCraftbookInvocation,
} from './craftbook-routing.js';

describe('invoke_craftbook params', () => {
  it('remains optional in the advertised tool schema', () => {
    expect(CraftbookInvocationParamsArgSchema.isOptional()).toBe(true);
    expect(CraftbookInvocationParamsArgSchema.parse(undefined)).toBeUndefined();
  });

  it('accepts a real string map', () => {
    expect(
      CraftbookInvocationParamsArgSchema.parse({
        topic: 'Battle of the Marne',
        outputPath: 'marne-battle.pptx',
      }),
    ).toEqual({ topic: 'Battle of the Marne', outputPath: 'marne-battle.pptx' });
  });

  it('accepts the JSON-stringified map emitted by Qwen 3.6', () => {
    const params = CraftbookInvocationParamsArgSchema.parse(
      '{"topic":"Battle of the Marne","outputPath":"artifacts/marne-battle.pptx"}',
    );
    expect(normalizeCraftbookInvocationParams(params, undefined)).toEqual({
      topic: 'Battle of the Marne',
      outputPath: 'marne-battle.pptx',
    });
    expect(CraftbookInvocationParamsArgSchema.parse('{}')).toEqual({});
  });

  it('lets the outputPath convenience alias override params and normalizes it', () => {
    expect(
      normalizeCraftbookInvocationParams(
        { outputPath: 'old.pptx', topic: 'Battle of the Marne' },
        'workspace/decks/marne.pptx',
      ),
    ).toEqual({ topic: 'Battle of the Marne', outputPath: 'decks/marne.pptx' });
  });

  it('preserves the free-text job as the topic when every source input was omitted', () => {
    const paramSchema = {
      type: 'object',
      properties: {
        sourcePath: { type: 'string' },
        topic: { type: 'string' },
        content: { type: 'string' },
      },
    };
    expect(
      inferCraftbookJobParams({
        paramSchema,
        params: { sourcePath: '', topic: '', content: '' },
        jobDescription: 'Create a PowerPoint about Ireland',
      }),
    ).toEqual({
      sourcePath: '',
      topic: 'Create a PowerPoint about Ireland',
      content: '',
    });
    expect(
      suggestedCraftbookInvocation({
        craftbookId: 'powerpoint-deck',
        query: 'Create a PowerPoint about Ireland',
        paramSchema,
      }),
    ).toEqual({
      craftbookId: 'powerpoint-deck',
      description: 'Create a PowerPoint about Ireland',
      params: { topic: 'Create a PowerPoint about Ireland' },
    });
  });

  it('never replaces an explicitly supplied source form or invents undeclared params', () => {
    expect(
      inferCraftbookJobParams({
        paramSchema: { properties: { topic: { type: 'string' } } },
        params: { sourcePath: 'source/brief.md' },
        jobDescription: 'Create a PowerPoint about Ireland',
      }),
    ).toEqual({ sourcePath: 'source/brief.md' });
    expect(
      inferCraftbookJobParams({
        paramSchema: { properties: { language: { type: 'string' } } },
        jobDescription: 'Translate this into Dutch',
      }),
    ).toEqual({});
  });
});

describe('start_project binary craftbook routing', () => {
  it('routes a named artifact PPTX to the exact PowerPoint craftbook', () => {
    const request = binaryDocumentCraftbookRequest({
      name: 'Battle of the Marne presentation',
      about: 'Create a clear history presentation for a general audience.',
      missionObjectives: 'Publish the finished deck at artifacts/marne-battle.pptx.',
      taskDescription:
        'Research the battle, author the deck in Markdown, and produce artifacts/marne-battle.pptx.',
    });
    expect(request).toEqual({
      requestedPath: 'artifacts/marne-battle.pptx',
      outputPath: 'marne-battle.pptx',
      route: { craftbookId: 'powerpoint-deck', label: 'PowerPoint' },
    });
    if (!request?.route) throw new Error('expected a PowerPoint route');
    const taskDescription = buildBinaryDocumentTaskDescription(
      {
        name: 'Battle of the Marne presentation',
        taskDescription:
          'Research the battle and produce artifacts/marne-battle.pptx for a general audience.',
      },
      { ...request, route: request.route },
    );
    expect(taskDescription).toContain('exact `powerpoint-deck` recipe');
    expect(taskDescription).toContain('Author its source in Markdown');
    expect(taskDescription).toContain('DocBlocks conversion, preview, and artifact-save tools');
    expect(taskDescription).not.toContain('index.html');
  });

  it('marks unsupported binary formats as blockers instead of generic builds', () => {
    expect(
      binaryDocumentCraftbookRequest({
        name: 'Workbook',
        about: 'Create a financial workbook for the operating plan.',
        missionObjectives: 'Save the final workbook as artifacts/plan.xlsx.',
      }),
    ).toEqual({
      requestedPath: 'artifacts/plan.xlsx',
      outputPath: 'plan.xlsx',
      route: null,
    });
  });

  it('leaves ordinary source builds on the normal kickoff path', () => {
    expect(
      binaryDocumentCraftbookRequest({
        name: 'Website',
        about: 'Build a small website with a polished landing page.',
        missionObjectives: 'Ship index.html in the workspace.',
      }),
    ).toBeNull();
  });
});
