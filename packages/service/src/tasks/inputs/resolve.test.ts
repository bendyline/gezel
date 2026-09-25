import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TaskInputError,
  type TaskInputsStore,
  planTaskInputs,
  previewTaskInput,
} from './resolve.js';
import { InputStagingLimitError, InputStagingManager } from './staging.js';

let root: string;
let workspace: string;
let artifacts: string;
let store: TaskInputsStore;
let staging: InputStagingManager;

const schema = {
  type: 'object',
  required: ['source'],
  properties: {
    source: {
      type: 'string',
      title: 'Source content',
      input: { kind: 'folder', accept: ['.md', '.docx'] },
    },
    audience: { type: 'string' },
  },
};

async function put(base: string, rel: string, body = 'hello'): Promise<void> {
  await mkdir(dirname(join(base, rel)), { recursive: true });
  await writeFile(join(base, rel), body);
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Blob([text]).stream();
}

const plan = (args: Partial<Parameters<typeof planTaskInputs>[1]> = {}) =>
  planTaskInputs(
    { store, staging },
    {
      projectId: 'p',
      craftbookId: 'ebook-compile',
      paramSchema: schema,
      params: {},
      taskDir: 'tasks/7',
      recurring: false,
      ...args,
    },
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-task-inputs-'));
  workspace = join(root, 'workspace');
  artifacts = join(root, 'project', 'artifacts');
  await mkdir(workspace, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  store = {
    projectWorkspaceDir: async () => workspace,
    projectArtifactsDir: () => artifacts,
    writeProjectArtifact: async (_id, path, content) => {
      await mkdir(dirname(join(artifacts, path)), { recursive: true });
      await writeFile(join(artifacts, path), content);
    },
  };
  staging = new InputStagingManager(store);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('planTaskInputs — workspace sources', () => {
  it('reads a workspace folder in place and writes its manifest on commit', async () => {
    await put(workspace, 'notes/ch1.md', '# One');
    await put(workspace, 'notes/part/ch2.md', '# Two!');
    await put(workspace, 'notes/cover.png');
    await put(workspace, 'notes/.DS_Store');

    const result = await plan({ params: { source: './notes/' } });
    expect(result?.params).toEqual({ source: 'notes' });
    expect(result?.records.source).toMatchObject({
      kind: 'folder',
      drawer: 'workspace',
      path: 'notes',
      from: 'workspace',
      label: 'notes',
      manifest: 'tasks/7/inputs/source.json',
      fileCount: 2,
      totalBytes: 11,
      skippedCount: 1,
    });

    await result!.commit();
    const manifest = JSON.parse(
      await readFile(join(artifacts, 'tasks/7/inputs/source.json'), 'utf8'),
    );
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual([
      'notes/ch1.md',
      'notes/part/ch2.md',
    ]);
    expect(manifest.skipped).toEqual([{ path: 'notes/cover.png', reason: 'not-accepted' }]);
    // Nothing was copied: the files are read where they are.
    await expect(stat(join(artifacts, 'tasks/7/inputs/source'))).rejects.toThrow();

    await result!.rollback();
    await expect(stat(join(artifacts, 'tasks/7/inputs/source.json'))).rejects.toThrow();
  });

  it('uses `.` for the workspace root so the param is never empty', async () => {
    await put(workspace, 'a.md');
    const result = await plan({ sources: { source: { from: 'workspace', path: '' } } });
    expect(result?.params.source).toBe('.');
    expect(result?.records.source?.label).toBe('project workspace');
  });

  it('refuses a folder with nothing the book reads, naming the accepted types', async () => {
    await put(workspace, 'pics/cover.png');
    await expect(plan({ params: { source: 'pics' } })).rejects.toThrow(
      /no files this craftbook reads \(\.md, \.docx\)/,
    );
  });

  it('refuses paths outside the drawer and paths that do not exist', async () => {
    await expect(plan({ params: { source: '../escape' } })).rejects.toBeInstanceOf(TaskInputError);
    await expect(plan({ params: { source: 'missing' } })).rejects.toThrow(/does not exist/);
  });

  it('refuses a folder over the file limit instead of truncating it', async () => {
    const small = {
      ...schema,
      properties: {
        source: { type: 'string', input: { kind: 'folder', maxFiles: 2 } },
      },
    };
    for (const name of ['a', 'b', 'c']) await put(workspace, `many/${name}.md`);
    await expect(plan({ paramSchema: small, params: { source: 'many' } })).rejects.toThrow(
      /more than 2 files/,
    );
  });

  it('requires a required input and rejects sources for params that are not inputs', async () => {
    await expect(plan()).rejects.toThrow(/Choose the source content/);
    await expect(plan({ sources: { audience: { from: 'workspace', path: 'x' } } })).rejects.toThrow(
      /not an input/,
    );
  });

  it('returns null for a book without inputs', async () => {
    expect(await plan({ paramSchema: { properties: { topic: { type: 'string' } } } })).toBeNull();
  });
});

describe('planTaskInputs — artifacts sources', () => {
  it('reads an artifacts folder in place and leaves converted twins out', async () => {
    await put(artifacts, 'tasks/3/chapters/one.docx');
    await put(artifacts, 'tasks/3/chapters/one_files/one.md');
    await put(artifacts, 'tasks/3/chapters/two.md');
    const result = await plan({ params: { source: 'artifacts:tasks/3/chapters' } });
    expect(result?.records.source).toMatchObject({
      drawer: 'artifacts',
      path: 'tasks/3/chapters',
      fileCount: 2,
      hasOfficeDocuments: true,
    });
  });

  it('refuses gezel-maintained folders', async () => {
    await put(artifacts, 'shadow/x_files/x.md');
    await expect(plan({ params: { source: 'artifacts:shadow' } })).rejects.toThrow(
      /maintains for itself/,
    );
  });
});

describe('planTaskInputs — uploads', () => {
  async function stage(files: Record<string, string>) {
    const { stagingId } = await staging.create('p', {
      craftbookId: 'ebook-compile',
      param: 'source',
      label: 'Blog drafts',
      spec: { kind: 'folder', accept: ['.md', '.docx'] },
    });
    for (const [rel, body] of Object.entries(files)) {
      await staging.putFile('p', stagingId, rel, streamOf(body));
    }
    return stagingId;
  }

  it('adopts the upload into the task folder on commit, and returns it on rollback', async () => {
    const stagingId = await stage({ 'a.md': 'alpha', 'sub/b.md': 'beta' });
    const result = await plan({ sources: { source: { from: 'upload', stagingId } } });
    expect(result?.params.source).toBe('tasks/7/inputs/source');
    expect(result?.records.source).toMatchObject({
      drawer: 'artifacts',
      from: 'upload',
      label: 'Blog drafts',
      fileCount: 2,
    });

    await result!.commit();
    expect(await readFile(join(artifacts, 'tasks/7/inputs/source/sub/b.md'), 'utf8')).toBe('beta');
    const manifest = JSON.parse(
      await readFile(join(artifacts, 'tasks/7/inputs/source.json'), 'utf8'),
    );
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual([
      'tasks/7/inputs/source/a.md',
      'tasks/7/inputs/source/sub/b.md',
    ]);
    expect(await staging.readMeta('p', stagingId)).toBeNull();

    await result!.rollback();
    expect((await staging.readMeta('p', stagingId))?.fileCount).toBe(2);
    await expect(stat(join(artifacts, 'tasks/7/inputs/source'))).rejects.toThrow();
  });

  it('refuses an upload for a recurring task, and one picked for another input', async () => {
    const stagingId = await stage({ 'a.md': 'alpha' });
    await expect(
      plan({ recurring: true, sources: { source: { from: 'upload', stagingId } } }),
    ).rejects.toThrow(/recurring task/);
    await expect(
      plan({
        craftbookId: 'another-book',
        sources: { source: { from: 'upload', stagingId } },
      }),
    ).rejects.toThrow(/different input/);
  });

  it('reports an expired upload as something to pick again', async () => {
    await expect(
      plan({ sources: { source: { from: 'upload', stagingId: 'stg-000000000000' } } }),
    ).rejects.toThrow(/pick them again/);
  });
});

describe('InputStagingManager', () => {
  it('skips junk and unaccepted files without failing the upload', async () => {
    const { stagingId } = await staging.create('p', {
      craftbookId: 'b',
      param: 'source',
      spec: { kind: 'folder', accept: ['.md'] },
    });
    expect(await staging.putFile('p', stagingId, '.DS_Store', streamOf('x'))).toMatchObject({
      stored: false,
      reason: 'sync-junk',
    });
    expect(await staging.putFile('p', stagingId, 'a.png', streamOf('x'))).toMatchObject({
      stored: false,
      reason: 'not-accepted',
    });
    expect(await staging.putFile('p', stagingId, 'a.md', streamOf('x'))).toMatchObject({
      stored: true,
      fileCount: 1,
      totalBytes: 1,
    });
  });

  it('enforces the size and count limits while streaming, and refuses traversal', async () => {
    const { stagingId } = await staging.create('p', {
      craftbookId: 'b',
      param: 'source',
      spec: { kind: 'folder', maxFiles: 2, maxBytes: 8 },
    });
    await expect(
      staging.putFile('p', stagingId, 'big.md', streamOf('0123456789')),
    ).rejects.toBeInstanceOf(InputStagingLimitError);
    await staging.putFile('p', stagingId, 'a.md', streamOf('1234'));
    // Replacing a file frees its bytes and keeps the count.
    await staging.putFile('p', stagingId, 'a.md', streamOf('12'));
    await staging.putFile('p', stagingId, 'b.md', streamOf('12'));
    await expect(staging.putFile('p', stagingId, 'c.md', streamOf('1'))).rejects.toThrow(
      /at most 2 files/,
    );
    await expect(staging.putFile('p', stagingId, '../x.md', streamOf('1'))).rejects.toThrow(
      /not a usable file path/,
    );
    expect(await staging.readMeta('p', stagingId)).toMatchObject({ fileCount: 2, totalBytes: 4 });
  });

  it('sweeps areas older than the cutoff', async () => {
    const { stagingId } = await staging.create('p', {
      craftbookId: 'b',
      param: 'source',
      spec: { kind: 'folder' },
    });
    const projects = { listProjects: async () => [{ id: 'p' }] };
    expect(await staging.sweep(projects, Date.now(), 1000)).toBe(0);
    expect(await staging.sweep(projects, Date.now() + 5000, 1000)).toBe(1);
    expect(await staging.readMeta('p', stagingId)).toBeNull();
  });
});

describe('previewTaskInput', () => {
  it('answers with counts, or with the message a launch would fail with', async () => {
    await put(workspace, 'notes/a.md');
    const ok = await previewTaskInput(
      { store, staging },
      {
        projectId: 'p',
        craftbookId: 'ebook-compile',
        paramSchema: schema,
        param: 'source',
        source: { from: 'workspace', path: 'notes' },
      },
    );
    expect(ok).toMatchObject({ fileCount: 1, label: 'notes', drawer: 'workspace' });
    const bad = await previewTaskInput(
      { store, staging },
      {
        projectId: 'p',
        craftbookId: 'ebook-compile',
        paramSchema: schema,
        param: 'source',
        source: { from: 'workspace', path: 'nope' },
      },
    );
    expect(bad.error).toMatch(/does not exist/);
  });
});
