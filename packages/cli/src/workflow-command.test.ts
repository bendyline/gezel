import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Craftbook, Task } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorkflow, validateWorkflowCraftbook } from './workflow-command.js';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('repository-owned workflow modules', () => {
  it('rejects invalid generated books with actionable errors before dispatch', () => {
    const book = {
      id: 'writer',
      name: 'Writer',
      steps: [
        {
          id: 'write',
          name: 'Write',
          terminal: true,
          consumes: [{ file: '{{input}}', artifact: true }],
          prompt: 'First call read_artifact with path "{{input}}".',
        },
      ],
    };
    expect(() => validateWorkflowCraftbook(book)).toThrow(/read_artifact/);
    book.steps[0]!.prompt = 'First call `read_artifact({ path: "{{input}}" })`.';
    expect(validateWorkflowCraftbook(book).entryStepId).toBe('write');
    expect(() => validateWorkflowCraftbook({ ...book, steps: [] })).toThrow();
  });
  it('runs named modules and lets them start or follow project craftbooks', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'gezel-cli-workflow-'));
    homes.push(workspace);
    const workflowDir = join(workspace, '.gezel', 'workflows');
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, 'batch.mjs'),
      [
        'export async function run(context) {',
        "  context.validateCraftbook({ id: 'valid', name: 'Valid', steps: [{ id: 'done', name: 'Done', terminal: true }] });",
        "  const created = await context.runCraftbook('book', { region: 'west' }, {",
        "    title: 'Custom batch',",
        "    parentTaskRef: 'project/parent',",
        "    onCreated: async (task) => context.log('created ' + task.ref),",
        '  });',
        "  const existing = await context.runCraftbook('unused', {}, { taskRef: 'project/9', timeoutMs: 50 });",
        '  return { created, existing, args: context.args, workspace: context.workspace };',
        '}',
      ].join('\n'),
    );

    const craftbook = {
      id: 'book',
      name: 'Batch Book',
      version: '1.0.0',
      paramSchema: {
        type: 'object',
        required: ['region'],
        properties: { region: { type: 'string' } },
      },
    } as unknown as Craftbook;
    const createdTask = {
      ref: 'project/1',
      projectId: 'project',
      num: 1,
      status: 'complete',
      craftbook: {},
    } as Task;
    const client = {
      getCraftbook: vi.fn().mockResolvedValue({ craftbook }),
      createTask: vi.fn().mockResolvedValue(createdTask),
      getTaskByRef: vi.fn().mockImplementation(async (ref: string) => ({
        ...createdTask,
        ref,
        num: ref === 'project/9' ? 9 : 1,
      })),
      listTaskChildren: vi.fn(),
    };
    const logs: string[] = [];

    const result = await runWorkflow(
      client as unknown as GezelClient,
      'project',
      workspace,
      'batch',
      ['west'],
      (message) => logs.push(message),
    );

    expect(result.created.outcome).toBe('complete');
    expect(result.existing.outcome).toBe('complete');
    expect(result.args).toEqual(['west']);
    expect(result.workspace).toBe(workspace);
    expect(client.getCraftbook).toHaveBeenCalledTimes(1);
    expect(client.createTask).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({
        title: 'Custom batch',
        craftbookId: 'book',
        craftbookParams: { region: 'west' },
        parentTaskRef: 'project/parent',
        trustScripts: true,
      }),
    );
    expect(logs).toContain('created project/1');
    expect(logs).toContain('Following project/1');
    expect(logs).toContain('Following project/9');
    expect(logs).toContain('project/1: complete (finished)');
  });
});
