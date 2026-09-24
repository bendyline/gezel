import type {
  CatalogItemSummary,
  CraftbookTemplateManifest,
  PromptDraftTaskLaunch,
  TurnIntentPlan,
} from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  formatTaskLaunchPreview,
  inputValuesFromLaunch,
  launchReadiness,
  launchRequestBody,
  mergeSuggestedLaunch,
  taskLaunchFromDialog,
  uploadStagingIds,
} from './composer-task-launch.js';

const deck = {
  kind: 'craftbook-template',
  id: 'powerpoint-deck',
  name: 'PowerPoint from Content',
  paramSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string' },
      audience: { type: 'string' },
      slides: { type: 'number' },
    },
  },
  steps: [{ id: 'write', name: 'Write' }],
  entryStepId: 'write',
} as unknown as CraftbookTemplateManifest;

const compile = {
  kind: 'craftbook-template',
  id: 'ebook-compile',
  name: 'Ebook Compile',
  paramSchema: {
    type: 'object',
    required: ['source', 'title'],
    properties: {
      source: { type: 'string', title: 'Source notes', input: { kind: 'folder' } },
      title: { type: 'string' },
    },
  },
  steps: [{ id: 'compile', name: 'Compile' }],
  entryStepId: 'compile',
} as unknown as CraftbookTemplateManifest;

const item = { sourceId: 'bundled', kind: 'craftbook-template' } as unknown as CatalogItemSummary;

function plan(params?: Record<string, unknown>): TurnIntentPlan {
  return {
    schemaVersion: 1,
    intent: 'artifact',
    route: 'craftbook',
    confidence: 'high',
    reason: 'exact-output-format',
    visible: true,
    display: { label: 'Planned: PowerPoint (.pptx)', badges: [] },
    output: { format: 'pptx', label: 'PowerPoint (.pptx)' },
    craftbook: {
      id: 'powerpoint-deck',
      name: 'PowerPoint from Content',
      invocation: { description: 'A deck about France', ...(params ? { params } : {}) },
    },
    requiredTools: ['invoke_craftbook'],
  };
}

describe('taskLaunchFromDialog / inputValuesFromLaunch', () => {
  it('keeps sources and labels, drops transient upload state, and round-trips', () => {
    const launch = taskLaunchFromDialog({
      manifest: compile,
      item,
      params: { title: 'Field notes' },
      inputValues: {
        source: {
          source: { from: 'upload', stagingId: 'stg-abcdefgh' },
          label: 'Notes',
          fileCount: 3,
          busy: false,
          progress: { done: 3, total: 3 },
        },
      },
      title: 'Ebook Compile',
      assignee: null,
      origin: 'user',
    });
    expect(launch).toEqual({
      craftbookId: 'ebook-compile',
      craftbookSourceId: 'bundled',
      craftbookName: 'Ebook Compile',
      params: { title: 'Field notes' },
      inputs: { source: { from: 'upload', stagingId: 'stg-abcdefgh' } },
      inputLabels: { source: { label: 'Notes', fileCount: 3 } },
      origin: 'user',
    });
    expect(inputValuesFromLaunch(launch)).toEqual({
      source: {
        source: { from: 'upload', stagingId: 'stg-abcdefgh' },
        label: 'Notes',
        fileCount: 3,
      },
    });
    expect(uploadStagingIds(launch)).toEqual(['stg-abcdefgh']);
  });

  it('records a title only when it differs from the book name', () => {
    const base = { manifest: deck, item, params: {}, inputValues: {}, assignee: null } as const;
    expect(
      taskLaunchFromDialog({ ...base, title: 'PowerPoint from Content', origin: 'user' }).title,
    ).toBeUndefined();
    expect(taskLaunchFromDialog({ ...base, title: 'Delft deck', origin: 'user' }).title).toBe(
      'Delft deck',
    );
  });
});

describe('launchReadiness', () => {
  it('waits for the manifest, then requires declared inputs and params', () => {
    const launch: PromptDraftTaskLaunch = {
      craftbookId: 'ebook-compile',
      params: {},
      origin: 'user',
    };
    expect(launchReadiness(launch, null)).toMatchObject({ ready: false });
    expect(launchReadiness(launch, compile).reason).toMatch(/source notes/i);
    const withSource: PromptDraftTaskLaunch = {
      ...launch,
      inputs: { source: { from: 'workspace', path: 'notes' } },
    };
    expect(launchReadiness(withSource, compile).reason).toBe('"title" is required.');
    expect(launchReadiness({ ...withSource, params: { title: 'x' } }, compile)).toEqual({
      ready: true,
    });
  });
});

describe('formatTaskLaunchPreview', () => {
  it('orders by the schema, clips values, caps entries, and lists inputs first', () => {
    const launch: PromptDraftTaskLaunch = {
      craftbookId: 'powerpoint-deck',
      params: {
        slides: 8,
        audience: 'executives',
        topic: 'The history of the Delft canals and their role in the city',
        extra: '',
      },
      origin: 'user',
    };
    const preview = formatTaskLaunchPreview(launch, deck);
    const clipped = `${'The history of the Delft canals and their role in the city'.slice(0, 31)}…`;
    expect(preview.short).toBe(`topic: ${clipped} · audience: executives · slides: 8`);
    expect(preview.full).toBe(
      'topic: The history of the Delft canals and their role in the city · audience: executives · slides: 8',
    );
    const many = formatTaskLaunchPreview(
      {
        craftbookId: 'x',
        params: { a: 1, b: 2, c: 3, d: 4, e: 5 },
        inputs: { src: { from: 'upload', stagingId: 'stg-abcdefgh' } },
        inputLabels: { src: { label: 'Notes', fileCount: 2 } },
        origin: 'user',
      },
      null,
    );
    expect(many.short).toBe('src: Notes (2 files) · a: 1 · b: 2 · +3 more');
  });
});

describe('mergeSuggestedLaunch', () => {
  const current = null;
  it('attaches a ready suggestion and keeps it while the plan holds', () => {
    const merged = mergeSuggestedLaunch({
      current,
      plan: plan({ topic: 'France' }),
      text: 'A deck about France',
      suppressed: null,
      manifest: deck,
    });
    expect(merged).toMatchObject({
      craftbookId: 'powerpoint-deck',
      origin: 'suggested',
      params: { topic: 'France' },
    });
    expect(
      mergeSuggestedLaunch({
        current: merged,
        plan: plan({ topic: 'France' }),
        text: 'A deck about France',
        suppressed: null,
        manifest: deck,
      }),
    ).toBe(merged);
  });

  it('never overwrites the person’s own pick', () => {
    const own: PromptDraftTaskLaunch = { craftbookId: 'ebook-compile', params: {}, origin: 'user' };
    expect(
      mergeSuggestedLaunch({
        current: own,
        plan: plan(),
        text: 'x',
        suppressed: null,
        manifest: deck,
      }),
    ).toBe(own);
    expect(
      mergeSuggestedLaunch({
        current: own,
        plan: null,
        text: 'x',
        suppressed: null,
        manifest: deck,
      }),
    ).toBe(own);
  });

  it('clears a suggestion when the plan goes quiet or the text was dismissed', () => {
    const suggested: PromptDraftTaskLaunch = {
      craftbookId: 'powerpoint-deck',
      params: { topic: 'France' },
      origin: 'suggested',
    };
    expect(
      mergeSuggestedLaunch({
        current: suggested,
        plan: null,
        text: 'A deck about France',
        suppressed: null,
        manifest: deck,
      }),
    ).toBeNull();
    expect(
      mergeSuggestedLaunch({
        current: suggested,
        plan: plan({ topic: 'France' }),
        text: 'A deck about France',
        suppressed: { craftbookId: 'powerpoint-deck', text: 'A deck about France' },
        manifest: deck,
      }),
    ).toBeNull();
    expect(
      mergeSuggestedLaunch({
        current: null,
        plan: plan({ topic: 'Spain' }),
        text: 'A deck about Spain',
        suppressed: { craftbookId: 'powerpoint-deck', text: 'A deck about France' },
        manifest: deck,
      }),
    ).toMatchObject({ params: { topic: 'Spain' } });
  });

  it('attaches nothing the book would refuse, and waits for the manifest', () => {
    expect(
      mergeSuggestedLaunch({
        current: null,
        plan: {
          ...plan(),
          craftbook: { id: 'ebook-compile', name: 'Ebook', invocation: { description: 'x' } },
        },
        text: 'x',
        suppressed: null,
        manifest: compile,
      }),
    ).toBeNull();
    expect(
      mergeSuggestedLaunch({
        current: null,
        plan: plan(),
        text: 'x',
        suppressed: null,
        manifest: null,
      }),
    ).toBeNull();
  });
});

describe('launchRequestBody', () => {
  it('drops the display-only fields', () => {
    expect(
      launchRequestBody({
        craftbookId: 'powerpoint-deck',
        craftbookName: 'PowerPoint',
        params: { topic: 'France' },
        inputLabels: { x: { label: 'y' } },
        origin: 'suggested',
      }),
    ).toEqual({ craftbookId: 'powerpoint-deck', params: { topic: 'France' } });
  });
});
