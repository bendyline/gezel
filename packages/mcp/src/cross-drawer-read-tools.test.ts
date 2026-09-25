import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import {
  registerArtifactReadTools,
  registerWorkspaceReadTools,
} from './cross-drawer-read-tools.js';

type Dependencies = Parameters<typeof registerWorkspaceReadTools>[0];
type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureTools(): {
  server: McpServer;
  handler(name: string): ToolHandler;
  names(): string[];
} {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool(name: string, ...definition: unknown[]) {
      const handler = definition.at(-1);
      if (typeof handler !== 'function') throw new Error(`Tool ${name} has no handler`);
      handlers.set(name, handler as ToolHandler);
    },
  } as unknown as McpServer;
  return {
    server,
    handler(name) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool ${name} was not registered`);
      return handler;
    },
    names: () => [...handlers.keys()],
  };
}

function createDependencies(
  server: McpServer,
  overrides: Partial<Dependencies> = {},
): Dependencies {
  const workspaceApi = {
    listProjectWorkspace: vi.fn(async () => ({ files: [], truncated: false })),
  } as unknown as Dependencies['api'];
  return {
    server,
    api: {
      readProjectArtifactSlice: vi.fn(async () => ({ kind: 'missing' })),
    } as unknown as Dependencies['api'],
    projectId: 'project-a',
    readWorkspaceFile: vi.fn(async () => ({ content: 'workspace content' })),
    readWorkspaceFiles: vi.fn(async () => ({
      results: [],
      truncated: false,
      totalBytesReturned: 0,
      totalScannedBytes: 0,
    })),
    concreteWorkspaceTarget: vi.fn(async (path: string) => ({
      kind: 'current' as const,
      projectId: 'project-a',
      path,
      displayPath: path,
    })),
    workspaceClient: vi.fn(() => workspaceApi),
    normalizeArtifactPath: (path: string) => path.replace(/^artifacts\//, ''),
    workspaceCollisionForArtifactPath: vi.fn(async () => null),
    toolIsAuthorized: vi.fn(() => true),
    unwrapApiError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

function resultText(result: ToolResult): string {
  return result.content.map((item) => item.text ?? '').join('\n');
}

describe('cross-drawer read tools', () => {
  describe('artifact pagination', () => {
    function artifactTools(
      content: string,
      totalLines: number,
      linesReturned: number,
      hasMore: boolean,
    ) {
      const tools = captureTools();
      registerArtifactReadTools(
        createDependencies(tools.server, {
          api: {
            readProjectArtifactSlice: vi.fn(async () => ({
              kind: 'found',
              path: 'sources.json',
              fuzzy: false,
              content,
              totalLines,
              linesReturned,
              hasMore,
              totalBytes: 1000,
              bytesReturned: content.length,
            })),
          } as unknown as Dependencies['api'],
        }),
      );
      return tools;
    }

    it('stops forward paging beyond EOF even when a legacy service reports omitted earlier lines', async () => {
      const tools = artifactTools('', 172, 0, true);
      const result = await tools.handler('read_artifact')({
        path: 'sources.json',
        startLine: 1201,
        endLine: 1600,
      });
      expect(resultText(result)).toContain('End of file: 172 total lines');
      expect(resultText(result)).toContain('No lines exist at or after requested startLine 1201');
      expect(resultText(result)).not.toMatch(/Next:|more available|Re-call/);
      expect(result.structuredContent).toMatchObject({
        linesReturned: 0,
        hasMore: false,
        totalLines: 172,
      });
      expect(result.isError).not.toBe(true);
    });

    it.each([
      { startLine: 101, endLine: 500 },
      { tail: 72 },
      { lines: { start: 101, count: 400 } },
    ])('distinguishes the last slice from a complete file for %j', async (args) => {
      const tools = artifactTools('last slice', 172, 72, true);
      const result = await tools.handler('read_artifact')({ path: 'sources.json', ...args });
      expect(resultText(result)).toContain('lines 101-172 of 172');
      expect(resultText(result)).toContain('Earlier lines are not included');
      expect(resultText(result)).toContain('End of file; no later lines');
      expect(resultText(result)).not.toMatch(/Next:|more available|Re-call/);
      expect(result.structuredContent).toMatchObject({ hasMore: false });
    });

    it('gives the next valid bounded range instead of making the model guess', async () => {
      const tools = artifactTools('middle slice', 650, 100, true);
      const result = await tools.handler('read_artifact')({
        path: 'sources.json',
        startLine: 101,
        endLine: 200,
      });
      expect(resultText(result)).toContain('lines 101-200 of 650');
      expect(resultText(result)).toContain(
        'read_artifact({"path":"sources.json","startLine":201,"endLine":600})',
      );
      expect(result.structuredContent).toMatchObject({
        startLine: 101,
        endLine: 200,
        hasMore: true,
      });
    });

    it('clamps the final suggested range to EOF', async () => {
      const tools = artifactTools('near the end', 650, 50, true);
      const result = await tools.handler('read_artifact')({
        path: 'sources.json',
        startLine: 501,
        endLine: 550,
      });
      expect(resultText(result)).toContain(
        'read_artifact({"path":"sources.json","startLine":551,"endLine":650})',
      );
    });

    it('reports an empty file without suggesting another read', async () => {
      const tools = artifactTools('', 0, 0, false);
      const result = await tools.handler('read_artifact')({ path: 'sources.json' });
      expect(resultText(result)).toContain('End of file: 0 total lines');
      expect(resultText(result)).not.toContain('Next:');
      expect(result.structuredContent).toMatchObject({ linesReturned: 0, hasMore: false });
    });

    it.each([{ head: 0 }, { tail: 0 }, { lines: { start: 1, count: 0 } }])(
      'keeps intentional zero-line metadata probes distinct from EOF for %j',
      async (args) => {
        const tools = artifactTools('', 172, 0, true);
        const result = await tools.handler('read_artifact')({ path: 'sources.json', ...args });
        expect(resultText(result)).toContain('No lines requested; file has 172 total lines');
        expect(resultText(result)).not.toContain('End of file');
        expect(result.structuredContent).toMatchObject({ hasMore: true });
      },
    );

    it('preserves whole JSON reads byte for byte', async () => {
      const content = '{"value":1}';
      const tools = artifactTools(content, 1, 1, false);
      const result = await tools.handler('read_artifact')({ path: 'sources.json' });
      expect(resultText(result)).toBe(content);
      expect(JSON.parse(resultText(result))).toEqual({ value: 1 });
    });
  });

  it('registers the single and batch readers for both drawers', () => {
    const tools = captureTools();
    const dependencies = createDependencies(tools.server);

    registerWorkspaceReadTools(dependencies);
    registerArtifactReadTools(dependencies);

    expect(tools.names()).toEqual(['read_file', 'read_files', 'read_artifact', 'read_artifacts']);
  });

  describe('binary office documents', () => {
    // Wild-caught on the first binary-source PowerPoint trial: read_file on a
    // .docx returned `1→PK\x03\x04…[Content_Types].xml…`, two gezels each
    // believed they had read the brief, and the run shipped no deck.
    function docxDependencies(tools: ReturnType<typeof captureTools>, overrides = {}) {
      return createDependencies(tools.server, {
        api: {
          readProjectArtifactSlice: vi.fn(async () => ({ kind: 'missing' })),
          toolReadDocAsMarkdown: vi.fn(async () => ({
            found: true,
            sourcePath: 'source/brief.docx',
            markdownPath: 'shadow/source/brief.docx_files/brief.md',
            markdown: '# Halvard Terminal\n\nMean boarding time fell from 21.4 to 12.8 minutes.',
            truncated: false,
          })),
        } as unknown as Dependencies['api'],
        ...overrides,
      });
    }

    it('reroutes a DOCX read to the document converter instead of decoding bytes', async () => {
      const tools = captureTools();
      const dependencies = docxDependencies(tools);
      registerWorkspaceReadTools(dependencies);

      const result = await tools.handler('read_file')({ path: 'source/brief.docx' });
      const text = resultText(result);

      expect(text).toContain('Rerouted read_file → read_doc_as_markdown');
      expect(text).toContain('Mean boarding time fell from 21.4 to 12.8 minutes.');
      expect(text).not.toContain('[Content_Types]');
      expect(dependencies.readWorkspaceFile).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        requestedTool: 'read_file',
        resolvedTool: 'read_doc_as_markdown',
        rerouted: true,
      });
    });

    it('reroutes every container extension, not just DOCX', async () => {
      for (const path of ['a.pdf', 'b.pptx', 'c.xlsx', 'd.DOCX']) {
        const tools = captureTools();
        const dependencies = docxDependencies(tools);
        registerWorkspaceReadTools(dependencies);
        const text = resultText(await tools.handler('read_file')({ path }));
        expect(text, path).toContain('read_doc_as_markdown');
      }
    });

    it('names the right tool when the converter is not on this roster', async () => {
      const tools = captureTools();
      const dependencies = docxDependencies(tools, {
        toolIsAuthorized: vi.fn((name: string) => name !== 'read_doc_as_markdown'),
      });
      registerWorkspaceReadTools(dependencies);

      const text = resultText(await tools.handler('read_file')({ path: 'source/brief.docx' }));
      expect(text).toContain('binary DOCX document');
      expect(text).toContain('not authorized');
      expect(text).not.toContain('[Content_Types]');
    });

    it('falls through to the ordinary read when conversion fails', async () => {
      const tools = captureTools();
      const dependencies = createDependencies(tools.server, {
        api: {
          readProjectArtifactSlice: vi.fn(async () => ({ kind: 'missing' })),
          toolReadDocAsMarkdown: vi.fn(async () => ({ found: false })),
        } as unknown as Dependencies['api'],
      });
      registerWorkspaceReadTools(dependencies);

      await tools.handler('read_file')({ path: 'source/corrupt.docx' });
      // The real error belongs to the real read path, not to a swallowed reroute.
      expect(dependencies.readWorkspaceFile).toHaveBeenCalledWith('source/corrupt.docx');
    });

    it('reroutes an artifact DOCX — an uploaded craftbook input — the same way', async () => {
      const tools = captureTools();
      const dependencies = docxDependencies(tools);
      registerArtifactReadTools(dependencies);

      const result = await tools.handler('read_artifact')({
        path: 'tasks/7/inputs/source/brief.docx',
      });
      expect(resultText(result)).toContain('Rerouted read_artifact → read_doc_as_markdown');
      expect(dependencies.api.toolReadDocAsMarkdown).toHaveBeenCalledWith('project-a', {
        path: 'tasks/7/inputs/source/brief.docx',
        artifact: true,
      });
      expect(dependencies.api.readProjectArtifactSlice).not.toHaveBeenCalled();
      expect(result.structuredContent).toMatchObject({
        requestedTool: 'read_artifact',
        resolvedSurface: 'artifact',
      });
    });

    it('leaves ordinary text files alone', async () => {
      const tools = captureTools();
      const dependencies = docxDependencies(tools);
      registerWorkspaceReadTools(dependencies);

      const text = resultText(await tools.handler('read_file')({ path: 'notes/brief.md' }));
      expect(text).toContain('workspace content');
      expect(text).not.toContain('Rerouted');
    });
  });

  it('preserves inclusive workspace ranges and returns navigation metadata', async () => {
    const tools = captureTools();
    const readWorkspaceFiles = vi.fn(async () => ({
      results: [
        {
          status: 'ok' as const,
          path: 'src/app.ts',
          content: 'const one = 1;\nconst two = 2;',
          startLine: 4,
          endLine: 5,
          linesReturned: 2,
          bytesReturned: 28,
          scannedBytes: 56,
          totalLines: 12,
          totalBytes: 112,
          eof: false,
          completeFile: false,
          hasMore: true,
          nextStartLine: 6,
          truncated: true,
          truncationReason: 'line-limit' as const,
        },
      ],
      truncated: false,
      totalBytesReturned: 28,
      totalScannedBytes: 56,
    }));
    const dependencies = createDependencies(tools.server, {
      readWorkspaceFiles,
    });
    registerWorkspaceReadTools(dependencies);

    const result = await tools.handler('read_file')({
      path: 'src/app.ts',
      startLine: 4,
      endLine: 5,
    });

    expect(readWorkspaceFiles).toHaveBeenCalledWith([
      { path: 'src/app.ts', startLine: 4, endLine: 5 },
    ]);
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('[read_file path="src/app.ts" lines=4-5 totalLines=12]');
    expect(resultText(result)).toContain('4→const one = 1;');
    expect(resultText(result)).toContain('next: read_file({"path":"src/app.ts","startLine":6');
  });

  it('does not cross into artifacts when the artifact reader is unauthorized', async () => {
    const tools = captureTools();
    const readProjectArtifactSlice = vi.fn(async () => ({
      kind: 'found' as const,
      content: 'must not be returned',
      path: 'reports/private.md',
      fuzzy: false,
      linesReturned: 1,
      totalLines: 1,
      bytesReturned: 20,
      totalBytes: 20,
      hasMore: false,
    }));
    const dependencies = createDependencies(tools.server, {
      api: { readProjectArtifactSlice } as unknown as Dependencies['api'],
      readWorkspaceFile: vi.fn(async () => {
        throw new Error('404 file not found');
      }),
      toolIsAuthorized: vi.fn(() => false),
    });
    registerWorkspaceReadTools(dependencies);

    const result = await tools.handler('read_file')({ path: 'reports/private.md' });

    expect(result.isError).toBe(true);
    expect(readProjectArtifactSlice).toHaveBeenCalledTimes(1);
    expect(readProjectArtifactSlice).toHaveBeenCalledWith('project-a', 'reports/private.md', {
      head: 0,
    });
    expect(resultText(result)).toContain('read_artifact is not authorized for this session');
    expect(resultText(result)).not.toContain('must not be returned');
  });

  it('reroutes a missing artifact to an authorized workspace file', async () => {
    const tools = captureTools();
    const readWorkspaceFile = vi.fn(async () => ({ content: 'first\nsecond' }));
    const dependencies = createDependencies(tools.server, {
      api: {
        readProjectArtifactSlice: vi.fn(async () => ({ kind: 'missing' as const })),
      } as unknown as Dependencies['api'],
      readWorkspaceFile,
      workspaceCollisionForArtifactPath: vi.fn(async () => ({
        kind: 'file' as const,
        path: 'docs/guide.md',
      })),
    });
    registerArtifactReadTools(dependencies);

    const result = await tools.handler('read_artifact')({ path: 'artifacts/docs/guide.md' });

    expect(readWorkspaceFile).toHaveBeenCalledWith('docs/guide.md');
    expect(result.isError).toBeUndefined();
    expect(resultText(result)).toContain('[Rerouted read_artifact → read_file]');
    expect(result.structuredContent).toMatchObject({
      requestedPath: 'artifacts/docs/guide.md',
      resolvedSurface: 'workspace',
      resolvedPath: 'docs/guide.md',
      rerouted: true,
      content: 'first\nsecond',
      startLine: 1,
      totalLines: 2,
      hasMore: false,
    });
  });
});
