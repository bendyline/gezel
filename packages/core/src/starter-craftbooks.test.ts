import { describe, expect, it } from 'vitest';
import type { CraftbookTemplateManifest } from './schemas/catalog.js';
import type { Task } from './schemas/task.js';
import {
  pathLikeLaunchFields,
  planDurationEstimates,
  planLaunchFormSchema,
  planOutputSummary,
  starterCraftbookIds,
} from './starter-craftbooks.js';

describe('starter selection', () => {
  it('uses legacy ids only when the entire catalog has no tags', () => {
    expect(starterCraftbookIds([{ id: 'research-report' }, { id: 'other' }])).toEqual([
      'research-report',
    ]);
    expect(
      starterCraftbookIds([{ id: 'research-report' }, { id: 'other', tags: ['starter'] }]),
    ).toEqual(['other']);
  });
  it('keeps the broad starting points in a stable order', () => {
    expect(
      starterCraftbookIds([
        { id: 'narrated-slideshow' },
        { id: 'research-report' },
        { id: 'powerpoint-deck' },
      ]),
    ).toEqual(['research-report', 'powerpoint-deck', 'narrated-slideshow']);
  });
});

describe('legacy launch forms', () => {
  const book = {
    id: 'powerpoint-deck',
    paramSchema: {
      properties: {
        outputDir: { default: 'decks/{{task.num}}' },
        sourcePath: { type: 'string', title: 'Source file', description: 'A file path' },
        topic: { type: 'string' },
      },
    },
  };
  it('never offers a raw optional source path from the old pin', () => {
    expect(Object.keys(planLaunchFormSchema(book)?.properties as object)).toEqual(['topic']);
    expect(pathLikeLaunchFields(planLaunchFormSchema(book))).toEqual([]);
  });
  it('does not silently hide a custom required input', () => {
    const required = { ...book, paramSchema: { ...book.paramSchema, required: ['sourcePath'] } };
    expect(pathLikeLaunchFields(planLaunchFormSchema(required))).toEqual(['sourcePath']);
  });
  it('leaves annotated inputs to the dedicated picker', () => {
    const input = {
      ...book,
      paramSchema: { properties: { sourcePath: { type: 'string', input: { kind: 'file' } } } },
    };
    expect(Object.keys(planLaunchFormSchema(input)?.properties as object)).toEqual([]);
  });
  it('preserves general-plan visibility and explicit starter opt-ins', () => {
    expect(
      Object.keys(planLaunchFormSchema({ ...book, id: 'custom-book' })?.properties as object),
    ).toEqual(['outputDir', 'sourcePath', 'topic']);
    const explicit = {
      ...book,
      paramSchema: { properties: { outputDir: { default: '{{task.dir}}', askUser: true } } },
    };
    expect(Object.keys(planLaunchFormSchema(explicit)?.properties as object)).toEqual([
      'outputDir',
    ]);
  });
});

describe('output summaries', () => {
  it('finds publishing outputs before Finish and resolves parameter defaults', () => {
    const book = {
      paramSchema: { properties: { outputPath: { default: '{{outputDir}}/deck.pptx' } } },
      steps: [
        { id: 'write', name: 'Write', advanceWhen: { file: 'outline.md' } },
        { id: 'publish', name: 'Publish', advanceWhen: { file: '{{outputPath}}' } },
        { id: 'finish', name: 'Finish', terminal: true },
      ],
    } as unknown as CraftbookTemplateManifest;
    expect(planOutputSummary(book)).toBe('A slide deck');
    expect(planOutputSummary({ ...book, steps: [] })).toBeNull();
  });
});

describe('local duration estimates', () => {
  const sample = (minutes: number, patch: Partial<Task> = {}): Task =>
    ({
      status: 'complete',
      createdAt: '2026-10-08T10:00:00Z',
      updatedAt: '2026-10-09T12:00:00Z',
      sourceCraftbookIds: [{ role: 'main', catalogId: 'research-report' }],
      craftbook: {
        steps: [
          {
            completedAt: new Date(
              Date.parse('2026-10-08T10:00:00Z') + minutes * 60_000,
            ).toISOString(),
          },
        ],
      },
      ...patch,
    }) as Task;
  it('takes the median of completed immediate tasks without counting later edits', () => {
    expect(planDurationEstimates([sample(1), sample(3), sample(20)])).toEqual({
      'research-report': 180_000,
    });
    expect(planDurationEstimates([sample(2), sample(4)])).toEqual({ 'research-report': 180_000 });
  });
  it('excludes failed, queued-night, child, and missing/invalid completion samples', () => {
    expect(
      planDurationEstimates([
        sample(4, { status: 'paused' }),
        sample(4, { nightShift: { enabled: true } }),
        sample(4, { parentTaskRef: 'default/1' }),
        sample(-1),
        sample(4, { craftbook: { steps: [] } as unknown as Task['craftbook'] }),
      ]),
    ).toEqual({});
  });
});
