import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocblocksPreviewBrowser } from './docblocks-preview-browser.js';
import { docblocksRootId } from './docblocks-root-resolver.js';
import { DocblocksSaveArtifact } from './docblocks-save-artifact.js';
import type { McpToolWrapperContext } from './types.js';

let home: string;
let workspace: string;
let artifacts: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-docblocks-save-'));
  workspace = join(home, 'workspace');
  artifacts = join(home, 'artifacts');
  await mkdir(workspace, { recursive: true });
  await mkdir(join(artifacts, 'tasks', '1'), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function context(opts: { hasInspect?: boolean } = {}): Promise<McpToolWrapperContext> {
  const ids = {
    workspace: docblocksRootId(await realpath(workspace)),
    artifacts: docblocksRootId(await realpath(artifacts)),
  };
  return {
    spec: {
      kind: 'stdio',
      toolsetId: 'docblocks',
      command: 'node',
      args: ['bin.js', 'mcp', '--allow-read', workspace, artifacts, '--allow-write', artifacts],
      env: {},
    },
    cwd: home,
    modelTier: 'medium',
    isMeester: false,
    hasTool: (name) => name !== 'inspect_document' || opts.hasInspect !== false,
    callTool: async () => ({
      text: JSON.stringify({
        roots: [
          { id: ids.artifacts, label: 'artifacts', read: true, write: true },
          { id: ids.workspace, label: 'workspace', read: true, write: false },
        ],
      }),
      images: [],
    }),
  };
}

const URI = 'docblocks://artifacts/425df411-40ee-4389-aa66-3c2994dd132d';

describe('DocblocksSaveArtifact', () => {
  it('fills in the one write root a model misnamed or left out', async () => {
    const ctx = await context();
    const artifactsId = docblocksRootId(await realpath(artifacts));
    for (const rootId of ['project-artifacts', 'artifacts', undefined]) {
      const verdict = await DocblocksSaveArtifact.preProcess!(
        'save_artifact',
        {
          artifactUri: URI,
          destination: { rootId, path: 'tasks/1/deck.pptx', ifExists: 'error' },
        },
        ctx,
      );
      expect(verdict).toEqual({
        kind: 'allow',
        args: {
          artifactUri: URI,
          destination: { rootId: artifactsId, path: 'tasks/1/deck.pptx', ifExists: 'error' },
        },
      });
    }
  });

  it('creates the destination folder DocBlocks would refuse to create', async () => {
    const ctx = await context();
    await DocblocksSaveArtifact.preProcess!(
      'save_artifact',
      { artifactUri: URI, destination: { path: 'documents/eval/report.docx', ifExists: 'error' } },
      ctx,
    );
    expect((await stat(join(artifacts, 'documents', 'eval'))).isDirectory()).toBe(true);
  });

  it('strips a drawer prefix instead of nesting artifacts/artifacts', async () => {
    const ctx = await context();
    const verdict = await DocblocksSaveArtifact.preProcess!(
      'save_artifact',
      { artifactUri: URI, destination: { path: 'artifacts/tasks/1/deck.pptx', ifExists: 'error' } },
      ctx,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect((verdict.args?.destination as { path: string }).path).toBe('tasks/1/deck.pptx');
    }
  });

  it('points a save aimed at the read-only workspace at the drawer', async () => {
    const ctx = await context();
    const verdict = await DocblocksSaveArtifact.preProcess!(
      'save_artifact',
      {
        artifactUri: URI,
        destination: {
          rootId: docblocksRootId(await realpath(workspace)),
          path: 'deck.pptx',
          ifExists: 'error',
        },
      },
      ctx,
    );
    expect(verdict.kind).toBe('reject');
    if (verdict.kind === 'reject') {
      expect(verdict.error).toContain('workspace folder is read-only');
      expect(verdict.error).toContain(docblocksRootId(await realpath(artifacts)));
    }
  });

  it("refuses the drawer's reserved folders, as the artifact store does", async () => {
    const ctx = await context();
    for (const path of ['diffpacks/7/after/src/app.ts', 'shadow/x/report.md', 'data/crm/a.json']) {
      const verdict = await DocblocksSaveArtifact.preProcess!(
        'save_artifact',
        { artifactUri: URI, destination: { path, ifExists: 'error' } },
        ctx,
      );
      expect(verdict.kind, path).toBe('reject');
    }
  });

  it('names the sha256 to replace when the destination already exists', async () => {
    const ctx = await context();
    await writeFile(join(artifacts, 'tasks', '1', 'deck.pptx'), 'first deck');
    const sha = createHash('sha256').update('first deck').digest('hex');
    for (const error of ['MCP output already exists', 'MCP output hash precondition failed']) {
      const text = await DocblocksSaveArtifact.postProcessError!(
        'save_artifact',
        {
          artifactUri: URI,
          destination: {
            path: 'tasks/1/deck.pptx',
            ifExists: 'replace',
            expectedSha256: 'a'.repeat(64),
          },
        },
        `{"error":{"code":"conflict","message":"${error}"}}`,
        ctx,
      );
      expect(text).toContain(`destination.expectedSha256 "${sha}"`);
    }
  });

  it('leaves other errors and other tools alone', async () => {
    const ctx = await context();
    const args = {
      artifactUri: URI,
      destination: { path: 'tasks/1/deck.pptx', ifExists: 'error' },
    };
    expect(await DocblocksSaveArtifact.postProcessError!('save_artifact', args, 'boom', ctx)).toBe(
      'boom',
    );
    expect(
      await DocblocksSaveArtifact.preProcess!('convert_document', { source: 'x.md' }, ctx),
    ).toEqual({ kind: 'allow' });
  });
});

describe('DocblocksPreviewBrowser', () => {
  const missing =
    '{"error":{"message":"browserType.launch: Executable doesn\'t exist at /home/u/.cache/ms-playwright/chromium_headless_shell-1243/chrome"}}';

  it('turns a missing browser into one plain note, then stops further previews', async () => {
    const ctx = await context();
    expect(await DocblocksPreviewBrowser.preProcess!('preview_document', {}, ctx)).toEqual({
      kind: 'allow',
    });
    const note = await DocblocksPreviewBrowser.postProcessError!(
      'preview_document',
      {},
      missing,
      ctx,
    );
    expect(note).toContain('Do not call preview_document again');
    expect(note).toContain('inspect_document');
    expect(note).not.toContain('npx');
    const verdict = await DocblocksPreviewBrowser.preProcess!('preview_document', {}, ctx);
    expect(verdict).toEqual({ kind: 'reject', error: note });
  });

  it('names inspect_document only when the session has it', async () => {
    const ctx = await context({ hasInspect: false });
    const note = await DocblocksPreviewBrowser.postProcessError!(
      'preview_document',
      {},
      missing,
      ctx,
    );
    expect(note).not.toContain('inspect_document');
  });

  it('passes other preview errors through and keeps previewing', async () => {
    const ctx = await context();
    expect(
      await DocblocksPreviewBrowser.postProcessError!(
        'preview_document',
        {},
        'page 9 out of range',
        ctx,
      ),
    ).toBe('page 9 out of range');
    expect(await DocblocksPreviewBrowser.preProcess!('preview_document', {}, ctx)).toEqual({
      kind: 'allow',
    });
  });
});
