import { describe, expect, it } from 'vitest';
import {
  assertCraftbookParamRequirements,
  craftbookParamDefaults,
  interpolateContextDeep,
  interpolateStepsContext,
  resolveCraftbookParamDefaults,
  resolveRuntimeTokensInParams,
  taskInterpolationContext,
} from './craftbook-params.js';
import type { TaskCraftbookStep } from './schemas/task.js';

describe('craftbook parameter defaults', () => {
  it('retains scalar defaults and ignores structured values', () => {
    expect(
      craftbookParamDefaults({
        properties: {
          text: { default: 'hello' },
          count: { default: 3 },
          enabled: { default: false },
          object: { default: { nested: true } },
          missing: {},
        },
      }),
    ).toEqual({ text: 'hello', count: '3', enabled: 'false' });
    expect(craftbookParamDefaults(undefined)).toEqual({});
  });

  it('resolves chained defaults while keeping explicit overrides authoritative', () => {
    expect(
      resolveCraftbookParamDefaults(
        {
          root: '{{task.dir}}',
          report: '{{root}}/report.md',
          unresolved: '{{missing}}',
        },
        { root: 'custom' },
        { 'task.dir': 'tasks/7' },
      ),
    ).toEqual({
      root: 'tasks/7',
      report: 'custom/report.md',
      unresolved: '{{missing}}',
    });
  });

  it('resolves only available runtime tokens in explicit parameters', () => {
    expect(
      resolveRuntimeTokensInParams(
        { workPath: '{{task.dir}}', template: '{{client}}/{{task.ref}}' },
        { 'task.dir': 'tasks/9', 'task.ref': 'TASK-9' },
      ),
    ).toEqual({ workPath: 'tasks/9', template: '{{client}}/TASK-9' });
  });
});

describe('craftbook parameter requirements', () => {
  const choiceSchema = {
    anyOf: [
      {
        required: ['projectUrl'],
        properties: { projectUrl: { type: 'string', minLength: 1 } },
      },
      {
        required: ['issueText'],
        properties: { issueText: { type: 'string', minLength: 2 } },
      },
    ],
  };

  it('reports missing top-level required parameters', () => {
    expect(() =>
      assertCraftbookParamRequirements('review', { required: ['repo', 'branch'] }, { repo: 'x' }),
    ).toThrow('Craftbook "review" requires invocation parameter: branch');
  });

  it('requires one complete non-empty anyOf branch', () => {
    expect(() =>
      assertCraftbookParamRequirements('review', choiceSchema, {
        projectUrl: '   ',
        issueText: 'x',
      }),
    ).toThrow(
      'Craftbook "review" requires at least one non-empty invocation parameter: projectUrl, issueText',
    );
    expect(() =>
      assertCraftbookParamRequirements('review', choiceSchema, { issueText: '42' }),
    ).not.toThrow();
  });

  it('leaves unsupported general JSON Schema alternatives to the full validator', () => {
    expect(() =>
      assertCraftbookParamRequirements(
        'review',
        { anyOf: [{ required: ['count'], properties: { count: { type: 'number' } } }] },
        {},
      ),
    ).not.toThrow();
  });
});

describe('craftbook step interpolation', () => {
  it('walks nested gate and hook data without mutating the source containers', () => {
    const gate = {
      at: 'completion' as const,
      checks: [
        {
          kind: 'textIncludes' as const,
          file: 'reports/{{client}}.md',
          text: '{{phrase}}',
        },
      ],
    };
    const steps = [
      {
        id: 'write',
        name: 'Write for {{client}}',
        gate,
        onExit: {
          name: 'publish',
          inputs: { files: ['reports/{{client}}.md'] },
        },
      },
    ] as unknown as TaskCraftbookStep[];

    interpolateStepsContext(steps, { client: 'acme', phrase: 'approved' });

    expect(steps[0]?.name).toBe('Write for acme');
    expect(steps[0]?.gate).toMatchObject({
      checks: [{ file: 'reports/acme.md', text: 'approved' }],
    });
    expect(steps[0]?.onExit).toMatchObject({ inputs: { files: ['reports/acme.md'] } });
    expect(gate.checks[0]?.file).toBe('reports/{{client}}.md');
  });

  it('returns fresh nested containers and preserves non-string leaves', () => {
    const source = { files: ['{{root}}/a.md'], nested: { enabled: true, count: 2 } };
    const result = interpolateContextDeep(source, { root: 'reports' });

    expect(result).toEqual({ files: ['reports/a.md'], nested: { enabled: true, count: 2 } });
    expect(result).not.toBe(source);
    expect(result.files).not.toBe(source.files);
    expect(result.nested).not.toBe(source.nested);
  });

  it('builds a reserved-wins context for existing tasks', () => {
    const context = taskInterpolationContext({
      num: 12,
      ref: 'TASK-12',
      projectId: 'project-a',
      artifactDir: 'tasks/12-custom',
      diffpackId: 'diff-1',
      craftbookParams: {
        'task.dir': 'malicious',
        workPath: '{{task.dir}}/work',
      },
    } as never);

    expect(context).toMatchObject({
      'task.num': '12',
      'task.ref': 'TASK-12',
      'task.projectId': 'project-a',
      'task.dir': 'tasks/12-custom',
      'diffpack.id': 'diff-1',
      'diffpack.dir': 'diffpacks/diff-1',
      workPath: 'tasks/12-custom/work',
    });
  });
});
