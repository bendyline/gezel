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
  it('registers the single and batch readers for both drawers', () => {
    const tools = captureTools();
    const dependencies = createDependencies(tools.server);

    registerWorkspaceReadTools(dependencies);
    registerArtifactReadTools(dependencies);

    expect(tools.names()).toEqual(['read_file', 'read_files', 'read_artifact', 'read_artifacts']);
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
