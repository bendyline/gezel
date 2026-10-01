import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DocblocksRootResolver,
  allowReadDirs,
  docblocksRootId,
} from './docblocks-root-resolver.js';
import type { McpToolWrapperContext } from './types.js';

let home: string;
let workspace: string;
let artifacts: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-docblocks-roots-'));
  workspace = join(home, 'workspace');
  artifacts = join(home, 'artifacts');
  await mkdir(join(workspace, 'powerpoint', 'task-13'), { recursive: true });
  await mkdir(join(artifacts, 'tasks', '13'), { recursive: true });
  await writeFile(join(workspace, 'powerpoint', 'task-13', 'deck.pptx'), 'pptx');
  await writeFile(join(artifacts, 'tasks', '13', 'outline.md'), '# Outline');
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function contextFor(opts: { listedIds?: string[] } = {}) {
  const listed = opts.listedIds ?? [
    docblocksRootId(await realpath(workspace)),
    docblocksRootId(await realpath(artifacts)),
  ];
  let listRootsCalls = 0;
  const ctx: McpToolWrapperContext = {
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
    hasTool: () => true,
    callTool: async (name) => {
      expect(name).toBe('list_roots');
      listRootsCalls++;
      return {
        text: JSON.stringify({
          roots: listed.map((id, index) => ({
            id,
            label: index === 0 ? 'workspace' : 'artifacts',
            read: true,
            write: index === 1,
          })),
        }),
        images: [],
      };
    },
  };
  return { ctx, listRootsCalls: () => listRootsCalls };
}

describe('DocblocksRootResolver', () => {
  it('derives root ids the way DocBlocks does', () => {
    // The workspace id DocBlocks returned from list_roots on default/13.
    expect(docblocksRootId('C:\\Users\\party\\.gezel\\projects\\default\\workspace', 'win32')).toBe(
      'root-cc3be39dac974401',
    );
    expect(docblocksRootId('/srv/A', 'linux')).not.toBe(docblocksRootId('/srv/a', 'linux'));
  });

  it('reads the variadic --allow-read grant', () => {
    expect(allowReadDirs(['mcp', '--allow-read', '/w', '/a', '--allow-write', '/a'])).toEqual([
      '/w',
      '/a',
    ]);
    expect(allowReadDirs(['mcp', '--allow-read=/w'])).toEqual(['/w']);
  });

  it('only wraps the DocBlocks toolset', async () => {
    const { ctx } = await contextFor();
    expect(DocblocksRootResolver.matches(ctx.spec)).toBe(true);
    expect(DocblocksRootResolver.matches({ ...ctx.spec, toolsetId: 'playwright' })).toBe(false);
  });

  it('names the one root that holds the file', async () => {
    const { ctx, listRootsCalls } = await contextFor();
    const rootId = docblocksRootId(await realpath(workspace));
    const verdict = await DocblocksRootResolver.preProcess!(
      'inspect_document',
      { source: { kind: 'file', path: 'powerpoint/task-13/deck.pptx' } },
      ctx,
    );
    expect(verdict).toEqual({
      kind: 'allow',
      args: { source: { kind: 'file', path: 'powerpoint/task-13/deck.pptx', rootId } },
    });

    const flat = await DocblocksRootResolver.preProcess!(
      'compare_documents',
      { left: 'powerpoint/task-13/deck.pptx', right: 'tasks/13/outline.md' },
      ctx,
    );
    expect(flat).toEqual({
      kind: 'allow',
      args: {
        left: { kind: 'file', path: 'powerpoint/task-13/deck.pptx', rootId },
        right: {
          kind: 'file',
          path: 'tasks/13/outline.md',
          rootId: docblocksRootId(await realpath(artifacts)),
        },
      },
    });
    expect(listRootsCalls()).toBe(1);
  });

  it('refuses a path no root holds, naming the folders', async () => {
    const { ctx } = await contextFor();
    const verdict = await DocblocksRootResolver.preProcess!(
      'preview_document',
      { source: 'powerpoint/task-12/deck.pptx' },
      ctx,
    );
    expect(verdict).toEqual({
      kind: 'reject',
      error: expect.stringContaining('No file "powerpoint/task-12/deck.pptx" exists'),
    });
    expect(verdict.kind === 'reject' && verdict.error).toContain('(workspace, artifacts)');
  });

  it('asks which root when both hold the path', async () => {
    await mkdir(join(artifacts, 'powerpoint', 'task-13'), { recursive: true });
    await writeFile(join(artifacts, 'powerpoint', 'task-13', 'deck.pptx'), 'older');
    const { ctx } = await contextFor();
    const verdict = await DocblocksRootResolver.preProcess!(
      'inspect_document',
      { source: 'powerpoint/task-13/deck.pptx' },
      ctx,
    );
    expect(verdict.kind).toBe('reject');
    expect(verdict.kind === 'reject' && verdict.error).toContain(
      `workspace (rootId "${docblocksRootId(await realpath(workspace))}")`,
    );
  });

  it('leaves explicit roots, other tools, and artifact sources alone', async () => {
    const { ctx, listRootsCalls } = await contextFor();
    for (const [tool, args] of [
      ['inspect_document', { source: { kind: 'file', path: 'x.md', rootId: 'root-1' } }],
      ['inspect_document', { source: 'docblocks://artifacts/31076ba3' }],
      ['save_artifact', { artifactUri: 'docblocks://artifacts/1', destination: { path: 'a' } }],
      ['create_document_bundle', { source: 'powerpoint/task-13/deck.pptx' }],
    ] as const) {
      expect(await DocblocksRootResolver.preProcess!(tool, { ...args }, ctx)).toEqual({
        kind: 'allow',
      });
    }
    expect(listRootsCalls()).toBe(0);
  });

  it('trusts only the root ids DocBlocks lists', async () => {
    const { ctx } = await contextFor({
      listedIds: ['root-0000000000000000', 'root-1111111111111111'],
    });
    expect(
      await DocblocksRootResolver.preProcess!(
        'inspect_document',
        { source: 'powerpoint/task-13/deck.pptx' },
        ctx,
      ),
    ).toEqual({ kind: 'allow' });
  });
});
