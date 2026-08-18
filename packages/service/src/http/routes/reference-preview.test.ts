import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import { adjacentDocFilesPaths, shadowDocFilesPaths } from '../../index-store/docs.js';
import type { ServiceContext } from '../context.js';
import { referencePreviewRoutes } from './reference-preview.js';

let root: string;
let artifacts: string;
let workspace: string;
let documents: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-reference-preview-'));
  artifacts = join(root, 'artifacts');
  workspace = join(root, 'workspace');
  documents = join(root, 'documents');
  await Promise.all([
    mkdir(artifacts, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(documents, { recursive: true }),
  ]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function app() {
  const store = {
    projectArtifactsDir: () => artifacts,
    projectWorkspaceDir: async () => workspace,
    documentsDir: () => documents,
  } as unknown as Store;
  return referencePreviewRoutes({ store } as unknown as ServiceContext);
}

async function preview(kind: 'artifact' | 'workspace' | 'document', path: string) {
  return app().request(
    `/project-1/reference-preview?kind=${kind}&path=${encodeURIComponent(path)}`,
  );
}

describe('referencePreviewRoutes', () => {
  it('returns verified UTF-8 text without exposing a binary body', async () => {
    await writeFile(join(artifacts, 'notes.txt'), 'plain notes');
    const response = await preview('artifact', 'notes.txt');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mode: 'text', content: 'plain notes' });
  });

  it('resolves an artifact path that already carries the drawer prefix', async () => {
    const corpus = join(artifacts, 'data', 'github-pull-requests', 'pr-46', 'files');
    await mkdir(corpus, { recursive: true });
    await writeFile(join(corpus, '008--api.md'), '# PR file');

    const response = await preview(
      'artifact',
      'artifacts/data/github-pull-requests/pr-46/files/008--api.md',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mode: 'text', content: '# PR file' });
  });

  it('keeps a workspace artifacts/ folder addressable', async () => {
    await mkdir(join(workspace, 'artifacts'), { recursive: true });
    await writeFile(join(workspace, 'artifacts', 'build.txt'), 'workspace-owned');

    const response = await preview('workspace', 'artifacts/build.txt');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mode: 'text', content: 'workspace-owned' });
  });

  it('classifies unknown binary data as a machine file', async () => {
    await writeFile(join(artifacts, 'payload.bin'), Buffer.from([0, 1, 2, 255, 254]));
    const response = await preview('artifact', 'payload.bin');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mode: 'binary' });
  });

  it.each([
    ['poster.png', 'image'],
    ['clip.mp4', 'video'],
    ['voice.mp3', 'audio'],
  ] as const)('classifies %s as %s media', async (name, mediaKind) => {
    await writeFile(join(artifacts, name), 'test bytes');
    const response = await preview('artifact', name);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mode: 'media', mediaKind });
  });

  it('reads an adjacent artifact document companion using the foo_files/foo.md convention', async () => {
    const source = join(artifacts, 'decks', 'brief.pptx');
    const paths = adjacentDocFilesPaths(artifacts, 'decks/brief.pptx');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, 'cached conversion source');
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.mdPath, '# Brief\n\nConverted deck.');

    const response = await preview('artifact', 'decks/brief.pptx');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: 'markdown',
      content: '# Brief\n\nConverted deck.',
      sidecarPath: 'decks/brief_files/brief.md',
    });
  });

  it('serves workspace companions from the artifacts shadow tree', async () => {
    const source = join(workspace, 'brief.docx');
    const paths = shadowDocFilesPaths(artifacts, 'brief.docx')!;
    await writeFile(source, 'cached conversion source');
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.mdPath, '# Workspace brief');

    const response = await preview('workspace', 'brief.docx');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      mode: 'markdown',
      content: '# Workspace brief',
      sidecarPath: 'artifacts/shadow/brief.docx_files/brief.md',
    });
  });
});
