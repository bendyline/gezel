import { describe, expect, it } from 'vitest';
import { type CraftbookCheckupInput, craftbookCheckup } from './craftbook-checkup.js';

const wellMade: CraftbookCheckupInput = {
  description: 'Turns a topic into a short illustrated report.',
  triggers: ['write a report'],
  paramSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', fromMessage: true },
      workPath: { type: 'string', default: '{{task.dir}}' },
    },
  },
  steps: [
    {
      id: 'research',
      name: 'Research',
      suggestedRole: 'researcher',
      prompt: 'Collect sources for {{topic}} and write sources.md.',
      advanceWhen: { file: 'tasks/1/sources.md' },
    },
    {
      id: 'write',
      name: 'Write',
      suggestedRole: 'writer',
      prompt: 'Read sources.md and write report.md.',
      advanceWhen: { file: 'tasks/1/report.md' },
    },
  ],
};

function kinds(input: CraftbookCheckupInput): string[] {
  return craftbookCheckup(input).map((f) => (f.stepId ? `${f.kind}:${f.stepId}` : f.kind));
}

describe('craftbookCheckup', () => {
  it('has nothing to say about a well-made book', () => {
    expect(craftbookCheckup(wellMade)).toEqual([]);
  });

  it('flags a book that cannot be found or offered', () => {
    expect(kinds({ ...wellMade, description: ' ', triggers: [] })).toEqual([
      'description',
      'triggers',
    ]);
  });

  it('flags steps with no role, no prompt or no completion check', () => {
    const findings = kinds({
      ...wellMade,
      steps: [wellMade.steps[0]!, { id: 'polish', name: 'Polish' }],
    });
    expect(findings).toEqual(['step-role:polish', 'step-prompt:polish', 'step-check:polish']);
  });

  it('does not ask for a role on a one-step book, a defaulted book or a person step', () => {
    const bare = { id: 'only', name: 'Only', prompt: 'Do it.', advanceWhen: { file: 'a.md' } };
    expect(kinds({ ...wellMade, steps: [bare] })).toEqual([]);
    expect(
      kinds({
        ...wellMade,
        defaultAssignee: { kind: 'gezel', gezelId: 'g1' },
        steps: [bare, { ...bare, id: 'two' }],
      }),
    ).toEqual([]);
    expect(
      kinds({
        ...wellMade,
        steps: [wellMade.steps[0]!, { id: 'sign', name: 'Sign off', assignee: { kind: 'user' } }],
      }),
    ).toEqual([]);
  });

  it('asks for a request input only when a free-text input could be one', () => {
    const noMain = {
      type: 'object',
      properties: { brief: { type: 'string' }, tone: { type: 'string', enum: ['warm', 'dry'] } },
    };
    expect(kinds({ ...wellMade, paramSchema: noMain })).toEqual(['main-input']);
    const pickerOnly = {
      type: 'object',
      properties: { photos: { type: 'string', input: { kind: 'folder' } } },
    };
    expect(kinds({ ...wellMade, paramSchema: pickerOnly })).toEqual([]);
  });

  it('flags a path the person would have to type', () => {
    const schema = {
      type: 'object',
      properties: {
        topic: { type: 'string', fromMessage: true },
        outputDir: { type: 'string' },
        sourceFolder: { type: 'string', input: { kind: 'folder' } },
        hidden: { type: 'string', askUser: false },
      },
    };
    expect(kinds({ ...wellMade, paramSchema: schema })).toEqual(['path-input']);
    expect(craftbookCheckup({ ...wellMade, paramSchema: schema })[0]?.message).toContain(
      '`outputDir`',
    );
  });

  it('reports contract problems', () => {
    const findings = craftbookCheckup({
      ...wellMade,
      contract: {
        goal: 'A report',
        deliverables: [{ path: 'report.md' }],
        criteria: [
          {
            id: 'outline',
            text: 'Has an outline',
            checks: [{ kind: 'fileExists', file: 'outline.md' }],
          },
        ],
      } as unknown as CraftbookCheckupInput['contract'],
    });
    expect(findings.map((f) => f.kind)).toEqual(['contract']);
    expect(findings[0]?.message).toContain('outline.md');
  });
});
