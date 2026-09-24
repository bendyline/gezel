import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Craftbook } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskInputPathWriteDeniedError } from '../fs/project-artifacts-store.js';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { TaskInputError } from './inputs/resolve.js';
import { InputStagingManager } from './inputs/staging.js';
import { TaskManager } from './manager.js';

let home: string;
let store: Store;
let tasks: TaskManager;
let staging: InputStagingManager;

const ebook = (extra: Partial<Craftbook> = {}): Craftbook => ({
  id: 'ebook-compile',
  name: 'Ebook Compile',
  paramSchema: {
    type: 'object',
    required: ['source'],
    properties: {
      source: {
        type: 'string',
        title: 'Source content',
        input: { kind: 'folder', accept: ['.md'] },
      },
    },
  },
  steps: [
    {
      id: 'outline',
      name: 'Outline',
      prompt: 'Survey every file in `{{source}}` and outline the book.',
      consumes: [{ file: '{{task.dir}}/inputs/source.json', artifact: true }],
    },
  ],
  entryStepId: 'outline',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  ...extra,
});

async function putWorkspace(rel: string, body = 'text'): Promise<void> {
  const abs = join(await store.projectWorkspaceDir('website'), rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body);
}

function useBook(book: Craftbook): void {
  tasks.setCraftbookResolver({
    resolve: async () => ({ craftbook: book, sourceId: 'bundled', version: '1.0.0' }),
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-task-inputs-mgr-'));
  const history = new HistoryManager(home);
  store = new Store({ home, history });
  await store.ensureLayout();
  await store.createProject({ name: 'Website' });
  tasks = new TaskManager(store, history);
  staging = new InputStagingManager(store);
  tasks.setInputStaging(staging);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('TaskManager.create — craftbook inputs', () => {
  it('resolves a workspace folder in place and bakes its path into the recipe', async () => {
    useBook(ebook());
    await putWorkspace('notes/ch1.md');
    await putWorkspace('notes/ch2.md');

    const task = await tasks.create('website', {
      title: 'Compile my notes',
      assignee: { kind: 'user' },
      craftbookId: 'ebook-compile',
      craftbookParams: { source: 'notes/' },
    });

    expect(task.craftbookParams?.source).toBe('notes');
    expect(task.inputs?.source).toMatchObject({
      drawer: 'workspace',
      path: 'notes',
      from: 'workspace',
      fileCount: 2,
      manifest: `tasks/${task.num}/inputs/source.json`,
    });
    const step = task.craftbook.steps[0]!;
    expect(step.prompt).toBe('Survey every file in `notes` and outline the book.');
    expect(step.consumes?.[0]?.file).toBe(`tasks/${task.num}/inputs/source.json`);
    const manifest = JSON.parse(
      (await store.readProjectArtifact('website', `tasks/${task.num}/inputs/source.json`)) ?? '{}',
    );
    expect(manifest.files).toHaveLength(2);
  });

  it('adopts an upload into the task folder', async () => {
    useBook(ebook());
    const { stagingId } = await staging.create('website', {
      craftbookId: 'ebook-compile',
      param: 'source',
      label: 'Blog drafts',
      spec: { kind: 'folder', accept: ['.md'] },
    });
    await staging.putFile('website', stagingId, 'intro.md', new Blob(['# Intro']).stream());

    const task = await tasks.create('website', {
      title: 'Compile my drafts',
      assignee: { kind: 'user' },
      craftbookId: 'ebook-compile',
      inputs: { source: { from: 'upload', stagingId } },
    });

    const dir = `tasks/${task.num}/inputs/source`;
    expect(task.craftbookParams?.source).toBe(dir);
    expect(task.inputs?.source).toMatchObject({
      drawer: 'artifacts',
      from: 'upload',
      label: 'Blog drafts',
    });
    expect(await store.readProjectArtifact('website', `${dir}/intro.md`)).toBe('# Intro');
    expect(await staging.readMeta('website', stagingId)).toBeNull();
  });

  it('fails the launch with a message the user can act on', async () => {
    useBook(ebook());
    await expect(
      tasks.create('website', {
        title: 'Compile',
        assignee: { kind: 'user' },
        craftbookId: 'ebook-compile',
      }),
    ).rejects.toBeInstanceOf(TaskInputError);
    await putWorkspace('pics/cover.png');
    await expect(
      tasks.create('website', {
        title: 'Compile',
        assignee: { kind: 'user' },
        craftbookId: 'ebook-compile',
        craftbookParams: { source: 'pics' },
      }),
    ).rejects.toThrow(/no files this craftbook reads/);
  });

  it('keeps a gezel from rewriting the files a task was launched on', async () => {
    useBook(ebook());
    const { stagingId } = await staging.create('website', {
      craftbookId: 'ebook-compile',
      param: 'source',
      spec: { kind: 'folder', accept: ['.md'] },
    });
    await staging.putFile('website', stagingId, 'a.md', new Blob(['a']).stream());
    const task = await tasks.create('website', {
      title: 'Compile',
      assignee: { kind: 'user' },
      craftbookId: 'ebook-compile',
      inputs: { source: { from: 'upload', stagingId } },
    });
    const path = `tasks/${task.num}/inputs/source/a.md`;
    await expect(
      store.writeProjectArtifact('website', path, 'rewritten', { initiatedByGezel: true }),
    ).rejects.toBeInstanceOf(TaskInputPathWriteDeniedError);
    await expect(
      store.deleteProjectArtifact('website', `tasks/${task.num}`, { initiatedByGezel: true }),
    ).rejects.toBeInstanceOf(TaskInputPathWriteDeniedError);
    // The person who supplied the files may still change them.
    await store.writeProjectArtifact('website', path, 'edited by the user');
    // And the rest of the task folder stays the gezel's to write.
    await store.writeProjectArtifact('website', `tasks/${task.num}/outline.md`, '# Outline', {
      initiatedByGezel: true,
    });
  });

  it('fans out one child per input file, each inheriting the input', async () => {
    useBook(
      ebook({
        steps: [
          { id: 'split', name: 'Split', spawnFanout: true, next: 'collect' },
          { id: 'collect', name: 'Collect' },
        ],
        entryStepId: 'split',
        spawn: {
          overFile: '{{task.dir}}/inputs/source.json',
          overArtifact: true,
          itemsPath: 'files',
          steps: [{ id: 'narrate', name: 'Narrate {{name}}', prompt: 'Read `{{path}}`.' }],
        },
      }),
    );
    await putWorkspace('notes/one.md');
    await putWorkspace('notes/two.md');
    const host = await tasks.create('website', {
      title: 'Narrate my notes',
      assignee: { kind: 'user' },
      craftbookId: 'ebook-compile',
      craftbookParams: { source: 'notes' },
    });
    // What the step-activated hook does for a `spawnFanout` step: read the
    // (interpolated) overFile on its surface and spawn one child per item.
    const spawn = host.craftbook.spawn!;
    expect(spawn.overFile).toBe(`tasks/${host.num}/inputs/source.json`);
    const manifest = JSON.parse(
      (await store.readProjectArtifact('website', spawn.overFile)) ?? '{}',
    ) as { files: Array<Record<string, unknown>> };
    for (const item of manifest.files) {
      await tasks.spawnChild(host.ref, {
        context: Object.fromEntries(Object.entries(item).map(([k, v]) => [k, String(v)])),
      });
    }
    const children = (await store.listProjectTasks('website')).filter(
      (t) => t.parentTaskRef === host.ref,
    );
    expect(children.map((c) => c.craftbook.steps[0]?.prompt).sort()).toEqual([
      'Read `notes/one.md`.',
      'Read `notes/two.md`.',
    ]);
    for (const child of children) expect(child.inputs?.source?.path).toBe('notes');
  });
});
