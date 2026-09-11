import {
  type ReadWorkspaceFilesResponse,
  WORKSPACE_READ_MAX_FILES,
  WORKSPACE_READ_MAX_RANGE_LINES,
  type WorkspaceReadFileRequest,
  type WorkspaceReadFileSuccess,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LinkedWorkspaceTarget } from './linked-workspace.js';
import { closestFileNames } from './near-miss.js';
import { withLineNumbers } from './reanchor.js';
import { errorResult } from './tool-contracts.js';
import { renderExactToolCall } from './workspace-grep-result.js';

type ConcreteWorkspaceTarget = Exclude<LinkedWorkspaceTarget, { kind: 'links-root' }>;

interface CrossDrawerReadDependencies {
  server: McpServer;
  api: GezelClient;
  projectId: string;
  readWorkspaceFile(path: string): Promise<{ content: string }>;
  readWorkspaceFiles(
    requests: readonly WorkspaceReadFileRequest[],
  ): Promise<ReadWorkspaceFilesResponse>;
  concreteWorkspaceTarget(path: string): Promise<ConcreteWorkspaceTarget>;
  workspaceClient(target: ConcreteWorkspaceTarget): GezelClient;
  normalizeArtifactPath(path: string): string;
  workspaceCollisionForArtifactPath(
    path: string,
  ): Promise<{ kind: 'file' | 'dir'; path: string } | null>;
  toolIsAuthorized(name: string): boolean;
  unwrapApiError(error: unknown): string;
}

type ArtifactSliceArgs = {
  startLine?: number;
  endLine?: number;
  lines?: { start: number; count: number };
  head?: number;
  tail?: number;
};

function workspaceReadRangeError(args: {
  startLine?: number;
  endLine?: number;
}): string | null {
  const start = args.startLine ?? 1;
  if (args.endLine !== undefined && args.endLine < start) {
    return `endLine (${args.endLine}) must be greater than or equal to startLine (${start})`;
  }
  if (args.endLine !== undefined && args.endLine - start + 1 > WORKSPACE_READ_MAX_RANGE_LINES) {
    return `a read range may contain at most ${WORKSPACE_READ_MAX_RANGE_LINES} lines`;
  }
  return null;
}

function formatWorkspaceRead(result: WorkspaceReadFileSuccess, raw: boolean): string {
  const body = raw ? result.content : withLineNumbers(result.content, result.startLine);
  if (raw) return body;
  return `[read_file path=${JSON.stringify(result.path)} ${workspaceReadRangeLabel(result)}${result.completeFile ? ' complete' : ''}]\n${body || '(no lines returned)'}${workspaceReadHint(result)}`;
}

function workspaceReadRangeLabel(result: WorkspaceReadFileSuccess): string {
  const total = result.totalLines === undefined ? '?' : String(result.totalLines);
  if (result.linesReturned === 0) return `lines=none totalLines=${total}`;
  return `lines=${result.startLine}-${result.endLine} totalLines=${total}`;
}

function workspaceReadHint(result: WorkspaceReadFileSuccess): string {
  if (result.nextStartLine === undefined && !result.truncated) return '';
  const parts: string[] = [];
  if (result.nextStartLine !== undefined) {
    const nextEnd = result.nextStartLine + WORKSPACE_READ_MAX_RANGE_LINES - 1;
    parts.push(
      `next: read_file({"path":${JSON.stringify(result.path)},"startLine":${result.nextStartLine},"endLine":${nextEnd}})`,
    );
  }
  if (result.truncationReason) parts.push(`truncated=${result.truncationReason}`);
  return `\n\n…[${parts.join('; ')}]`;
}

async function artifactCollisionForWorkspacePath(
  dependencies: CrossDrawerReadDependencies,
  path: string,
): Promise<string | null> {
  try {
    if ((await dependencies.concreteWorkspaceTarget(path)).kind === 'linked') return null;
    const cleanPath = dependencies.normalizeArtifactPath(path);
    const result = await dependencies.api.readProjectArtifactSlice(
      dependencies.projectId,
      cleanPath,
      { head: 0 },
    );
    return result.kind === 'found' && !result.fuzzy ? result.path : null;
  } catch {
    // Preserve the workspace read's ordinary near-match handling when the
    // artifact lookup itself is unavailable.
    return null;
  }
}

function artifactSliceArgsError(args: ArtifactSliceArgs): string | null {
  const canonicalRange = args.startLine !== undefined || args.endLine !== undefined;
  const modes = [
    canonicalRange,
    args.lines !== undefined,
    args.head !== undefined,
    args.tail !== undefined,
  ];
  if (modes.filter(Boolean).length > 1) {
    return 'pass only one slice shape: startLine/endLine, lines, head, or tail';
  }
  if (canonicalRange) return workspaceReadRangeError(args);
  return null;
}

function artifactSliceOpts(args: ArtifactSliceArgs): {
  lines?: { start: number; count: number };
  head?: number;
  tail?: number;
} {
  if (args.startLine !== undefined || args.endLine !== undefined) {
    const start = args.startLine ?? 1;
    return {
      lines: {
        start,
        count:
          args.endLine === undefined ? WORKSPACE_READ_MAX_RANGE_LINES : args.endLine - start + 1,
      },
    };
  }
  if (args.lines) return { lines: args.lines };
  if (typeof args.head === 'number') return { head: args.head };
  if (typeof args.tail === 'number') return { tail: args.tail };
  return {};
}

function artifactSliceStart(
  args: ArtifactSliceArgs,
  totalLines: number,
  linesReturned: number,
): number {
  if (args.startLine !== undefined) return args.startLine;
  if (args.lines) return args.lines.start;
  if (typeof args.tail === 'number') return Math.max(1, totalLines - linesReturned + 1);
  return 1;
}

function reroutedReadNotice(
  requestedTool: 'read_file' | 'read_files' | 'read_artifact' | 'read_artifacts',
  resolvedTool: 'read_file' | 'read_artifact',
  surface: 'workspace' | 'artifact',
  path: string,
): string {
  return `[Rerouted ${requestedTool} → ${resolvedTool}]\nOpened ${surface} file ${JSON.stringify(path)}. Use ${
    surface === 'artifact' ? 'read_artifact/write_artifact' : 'read_file/workspace write tools'
  } for subsequent operations on this path.`;
}

export function registerWorkspaceReadTools(dependencies: CrossDrawerReadDependencies): void {
  const {
    server,
    api,
    projectId,
    readWorkspaceFile,
    readWorkspaceFiles,
    concreteWorkspaceTarget,
    workspaceClient,
    toolIsAuthorized,
    unwrapApiError,
  } = dependencies;

  server.tool(
    'read_file',
    'Read one project-workspace file, optionally only an inclusive line range. This tool never reads the separate artifacts drawer; use read_artifact for artifact inputs. For files over ~200 lines, pass `startLine`/`endLine` from grep_files, outline_file, or an error instead of loading the whole file. Omit both range fields for the backward-compatible full read. Output uses `N→` line gutters for precise edits; the gutter is display-only and is never part of the file. Pass `raw: true` for text without gutters.',
    {
      path: z.string().min(1).max(4096).describe('File path relative to the project root.'),
      startLine: z
        .number()
        .int()
        .min(1)
        .max(10_000_000)
        .optional()
        .describe('1-based first line to return (inclusive). Defaults to 1.'),
      endLine: z
        .number()
        .int()
        .min(1)
        .max(10_000_000)
        .optional()
        .describe(
          `1-based last line to return (inclusive). Maximum ${WORKSPACE_READ_MAX_RANGE_LINES} lines per ranged read; omit to read the next bounded chunk.`,
        ),
      raw: z
        .boolean()
        .optional()
        .describe('Return the file content without `N→` line-number gutters. Default false.'),
    },
    async ({ path, startLine, endLine, raw }) => {
      try {
        const rangeError = workspaceReadRangeError({ startLine, endLine });
        if (rangeError) throw new Error(rangeError);
        if (raw && (startLine !== undefined || endLine !== undefined)) {
          throw new Error(
            '`raw: true` cannot be combined with a line range; omit `raw` for a numbered range',
          );
        }
        if (startLine === undefined && endLine === undefined) {
          const result = await readWorkspaceFile(path);
          return {
            content: [
              {
                type: 'text' as const,
                text: raw ? result.content : withLineNumbers(result.content),
              },
            ],
          };
        }

        const response = await readWorkspaceFiles([
          {
            path,
            ...(startLine !== undefined ? { startLine } : {}),
            ...(endLine !== undefined ? { endLine } : {}),
          },
        ]);
        const result = response.results[0];
        if (!result) throw new Error('ranged read returned no result');
        if (result.status === 'error') throw new Error(`[${result.code}] ${result.error}`);
        return {
          content: [{ type: 'text' as const, text: formatWorkspaceRead(result, raw === true) }],
        };
      } catch (error) {
        const base = unwrapApiError(error);
        let text = `read_file "${path}": ${base}`;
        if (/not found|404|no such file/i.test(base)) {
          const artifactCollision = await artifactCollisionForWorkspacePath(dependencies, path);
          if (artifactCollision) {
            const exactCall = renderExactToolCall('read_artifact', {
              path: artifactCollision,
              ...(startLine !== undefined ? { startLine } : {}),
              ...(endLine !== undefined ? { endLine } : {}),
            });
            if (!toolIsAuthorized('read_artifact')) {
              text += `. A project artifact exists at "${artifactCollision}", but read_artifact is not authorized for this session.`;
              return errorResult(text, {
                retryable: false,
                hint: `Delegate to a gezel with artifact read access to run ${exactCall}`,
              });
            }
            try {
              const artifact = await api.readProjectArtifactSlice(
                projectId,
                artifactCollision,
                artifactSliceOpts({ startLine, endLine }),
              );
              if (artifact.kind === 'found' && !artifact.fuzzy) {
                const sliceStart = artifactSliceStart(
                  { startLine, endLine },
                  artifact.totalLines,
                  artifact.linesReturned,
                );
                const body = raw
                  ? artifact.content
                  : withLineNumbers(artifact.content, sliceStart) || '(no lines returned)';
                const notice = reroutedReadNotice(
                  'read_file',
                  'read_artifact',
                  'artifact',
                  artifact.path,
                );
                return {
                  content: [{ type: 'text' as const, text: `${notice}\n\n${body}` }],
                  structuredContent: {
                    requestedTool: 'read_file',
                    requestedPath: path,
                    resolvedTool: 'read_artifact',
                    resolvedSurface: 'artifact',
                    resolvedPath: artifact.path,
                    rerouted: true,
                    content: artifact.content,
                    startLine: sliceStart,
                    endLine: sliceStart + Math.max(0, artifact.linesReturned - 1),
                    totalLines: artifact.totalLines,
                    hasMore: artifact.hasMore,
                  },
                };
              }
            } catch (fallbackError) {
              return errorResult(
                `${text}. The automatic artifact fallback failed: ${unwrapApiError(fallbackError)}`,
                { retryable: true, hint: exactCall },
              );
            }
            return errorResult(`${text}. The artifact disappeared before it could be opened.`, {
              retryable: true,
              hint: exactCall,
            });
          }
          try {
            const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            const targetDir = await concreteWorkspaceTarget(dir);
            const listing = await workspaceClient(targetDir).listProjectWorkspace(
              targetDir.projectId,
              targetDir.path,
              false,
            );
            const names = listing.files
              .filter((file) => !file.isDirectory)
              .map((file) => file.path.split('/').pop() ?? file.path);
            const target = path.split('/').pop() ?? path;
            const near = closestFileNames(target, names);
            const where = dir === '' ? 'the project root' : `${dir}/`;
            if (near.length > 0) {
              text += `. Nearest existing in ${where}: ${near.join(', ')}`;
            } else if (names.length > 0) {
              text += `. ${where} contains: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}`;
            }
          } catch {
            // Listing failed (the directory itself is missing); keep the base error.
          }
        }
        return { content: [{ type: 'text' as const, text }], isError: true };
      }
    },
  );

  server.tool(
    'read_files',
    `Read up to ${WORKSPACE_READ_MAX_FILES} known workspace files or line ranges in one call. Pass simple \`paths\` for whole-file first chunks, or richer \`files\` entries with inclusive startLine/endLine ranges; pass exactly one of those fields. Use this for independent files you already identified and grep_files/find_files first when paths are unknown. Results stay in request order and report item-level errors without discarding successful reads.`,
    {
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(4096).describe('Workspace-relative file path.'),
            startLine: z
              .number()
              .int()
              .min(1)
              .max(10_000_000)
              .optional()
              .describe('1-based first line to return (inclusive). Defaults to 1.'),
            endLine: z
              .number()
              .int()
              .min(1)
              .max(10_000_000)
              .optional()
              .describe(
                `1-based last line to return (inclusive); at most ${WORKSPACE_READ_MAX_RANGE_LINES} lines.`,
              ),
          }),
        )
        .min(1)
        .max(WORKSPACE_READ_MAX_FILES)
        .optional()
        .describe('Files/ranges to read, in the order their results should be returned.'),
      paths: z
        .array(z.string().min(1).max(4096))
        .min(1)
        .max(WORKSPACE_READ_MAX_FILES)
        .optional()
        .describe(
          'Simple workspace-relative paths. Use `files` instead when any path needs a range.',
        ),
    },
    async ({ files, paths }) => {
      try {
        if ((files === undefined) === (paths === undefined)) {
          throw new Error('pass exactly one of `paths` or `files`');
        }
        const requests: WorkspaceReadFileRequest[] =
          files ?? paths?.map((path) => ({ path })) ?? [];
        for (const request of requests) {
          const rangeError = workspaceReadRangeError(request);
          if (rangeError) throw new Error(`${request.path}: ${rangeError}`);
        }
        const response = await readWorkspaceFiles(requests);
        const results = await Promise.all(
          response.results.map(async (result, index) => {
            if (result.status !== 'error' || result.code !== 'path-not-found') {
              return { ...result, resolvedSurface: 'workspace' as const, rerouted: false as const };
            }
            const request = requests[index]!;
            const collision = await artifactCollisionForWorkspacePath(dependencies, request.path);
            if (!collision) {
              return { ...result, resolvedSurface: 'workspace' as const, rerouted: false as const };
            }
            if (!toolIsAuthorized('read_artifact')) {
              return {
                status: 'error' as const,
                path: request.path,
                code: 'artifact-read-unauthorized',
                error: `${result.error}. An artifact exists at "${collision}", but read_artifact is not authorized for this session.`,
                requestedPath: request.path,
                resolvedPath: collision,
                resolvedSurface: 'artifact' as const,
                rerouted: false as const,
              };
            }
            try {
              const artifact = await api.readProjectArtifactSlice(
                projectId,
                collision,
                artifactSliceOpts(request),
              );
              if (artifact.kind !== 'found' || artifact.fuzzy) {
                return {
                  ...result,
                  resolvedSurface: 'workspace' as const,
                  rerouted: false as const,
                };
              }
              const start = artifactSliceStart(
                request,
                artifact.totalLines,
                artifact.linesReturned,
              );
              const end = start + Math.max(0, artifact.linesReturned - 1);
              return {
                status: 'ok' as const,
                path: request.path,
                content: artifact.content,
                startLine: start,
                endLine: end,
                linesReturned: artifact.linesReturned,
                bytesReturned: artifact.bytesReturned,
                scannedBytes: artifact.totalBytes,
                totalLines: artifact.totalLines,
                totalBytes: artifact.totalBytes,
                eof: !artifact.hasMore,
                completeFile: artifact.linesReturned === artifact.totalLines,
                hasMore: artifact.hasMore,
                ...(artifact.hasMore ? { nextStartLine: end + 1 } : {}),
                truncated: artifact.hasMore,
                ...(artifact.hasMore ? { truncationReason: 'line-limit' as const } : {}),
                requestedPath: request.path,
                resolvedPath: artifact.path,
                resolvedSurface: 'artifact' as const,
                rerouted: true as const,
              };
            } catch (fallbackError) {
              return {
                ...result,
                error: `${result.error}. Automatic artifact fallback failed: ${unwrapApiError(fallbackError)}`,
                resolvedSurface: 'workspace' as const,
                rerouted: false as const,
              };
            }
          }),
        );
        const index = results.map((result, index) => {
          if (result.status === 'error') {
            return `${index + 1} ERROR ${result.path} [${result.code}] ${result.error}`;
          }
          const next = result.nextStartLine ? ` nextStartLine=${result.nextStartLine}` : '';
          const route = result.rerouted ? ` rerouted=artifact:${result.resolvedPath}` : '';
          return `${index + 1} OK ${result.path} ${workspaceReadRangeLabel(result)}${result.completeFile ? ' complete' : ''}${next}${route}`;
        });
        const sections = results.map((result) => {
          if (result.status === 'error') {
            return `--- ${result.path} [ERROR: ${result.code}] ---\n${result.error}`;
          }
          const range = workspaceReadRangeLabel(result);
          const body = withLineNumbers(result.content, result.startLine) || '(no lines returned)';
          const hint = workspaceReadHint(result);
          const notice = result.rerouted
            ? `${reroutedReadNotice('read_files', 'read_artifact', 'artifact', result.resolvedPath)}\n`
            : '';
          return `--- ${result.path} (${range}) ---\n${notice}${body}${hint}`;
        });
        const allFailed =
          results.length > 0 && results.every((result) => result.status === 'error');
        return {
          content: [
            {
              type: 'text' as const,
              text: `[read_files requested=${results.length} ok=${results.filter((result) => result.status === 'ok').length} errors=${results.filter((result) => result.status === 'error').length}]\n${index.join('\n')}\n\n${sections.join('\n\n')}`,
            },
          ],
          structuredContent: {
            results: results.map((result) =>
              result.status === 'ok'
                ? {
                    path: result.path,
                    status: result.status,
                    content: result.content,
                    startLine: result.startLine,
                    endLine: result.endLine,
                    completeFile: result.completeFile,
                    totalLines: result.totalLines,
                    hasMore: result.hasMore,
                    nextStartLine: result.nextStartLine,
                    resolvedSurface: result.resolvedSurface,
                    rerouted: result.rerouted,
                    ...('resolvedPath' in result ? { resolvedPath: result.resolvedPath } : {}),
                  }
                : {
                    path: result.path,
                    status: result.status,
                    code: result.code,
                    error: result.error,
                    ...('requestedPath' in result ? { requestedPath: result.requestedPath } : {}),
                    ...('resolvedPath' in result ? { resolvedPath: result.resolvedPath } : {}),
                    resolvedSurface: result.resolvedSurface,
                    rerouted: result.rerouted,
                  },
            ),
          },
          ...(allFailed ? { isError: true } : {}),
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `read_files failed: ${unwrapApiError(error)}` }],
          isError: true,
        };
      }
    },
  );
}

export function registerArtifactReadTools(dependencies: CrossDrawerReadDependencies): void {
  const {
    server,
    api,
    projectId,
    readWorkspaceFile,
    readWorkspaceFiles,
    normalizeArtifactPath,
    workspaceCollisionForArtifactPath,
    toolIsAuthorized,
    unwrapApiError,
  } = dependencies;

  server.tool(
    'read_artifact',
    'Read one artifact, using a path returned by `list_artifacts`. Paths are relative to the artifact root: use "reports/summary.md", never add "artifacts/" (a legacy redundant prefix is still accepted). Use the same inclusive `startLine`/`endLine` range shape as `read_file`; the older `lines`/`head`/`tail` shapes remain accepted for compatibility. If the exact path is actually a workspace file and `read_file` is authorized, this read is safely rerouted and reports its resolved surface. Use `read_artifacts` for several known artifact paths.',
    {
      path: z
        .string()
        .describe(
          'File path or basename. A redundant "artifacts/" prefix is stripped automatically.',
        ),
      startLine: z
        .number()
        .int()
        .min(1)
        .max(10_000_000)
        .optional()
        .describe('Canonical 1-based first line to return (inclusive). Defaults to 1.'),
      endLine: z
        .number()
        .int()
        .min(1)
        .max(10_000_000)
        .optional()
        .describe(
          `Canonical 1-based last line to return (inclusive); at most ${WORKSPACE_READ_MAX_RANGE_LINES} lines.`,
        ),
      lines: z
        .object({
          start: z.number().int().min(1).describe('1-indexed first line to return.'),
          count: z.number().int().min(0).describe('Number of lines to return.'),
        })
        .optional()
        .describe('Legacy range shape; prefer `startLine` / `endLine`.'),
      head: z.number().int().min(0).optional().describe('Legacy: read just the first N lines.'),
      tail: z.number().int().min(0).optional().describe('Legacy: read just the last N lines.'),
    },
    async ({ path, startLine, endLine, lines, head, tail }) => {
      const sliceArgs = { startLine, endLine, lines, head, tail };
      const sliceError = artifactSliceArgsError(sliceArgs);
      if (sliceError) return errorResult(`read_artifact "${path}": ${sliceError}`);
      const opts = artifactSliceOpts(sliceArgs);
      const clean = normalizeArtifactPath(path);
      const result = await api.readProjectArtifactSlice(projectId, clean, opts);
      if (result.kind === 'missing') {
        const workspaceCollision = await workspaceCollisionForArtifactPath(clean);
        if (workspaceCollision) {
          const tool = workspaceCollision.kind === 'dir' ? 'list_dir' : 'read_file';
          const exactCall = renderExactToolCall(tool, { path: workspaceCollision.path });
          if (workspaceCollision.kind === 'dir' || !toolIsAuthorized('read_file')) {
            return errorResult(
              `Artifact "${path}" not found, but a workspace ${workspaceCollision.kind} exists at "${workspaceCollision.path}". ${tool} is not authorized for this session or cannot be safely substituted for this request.`,
              {
                retryable: false,
                hint: `Delegate to a gezel with workspace access to run ${exactCall}`,
              },
            );
          }
          try {
            let content: string;
            let firstLine = 1;
            let totalLines: number | undefined;
            let hasMore = false;
            const emptySliceRequested =
              head === 0 || tail === 0 || (lines !== undefined && lines.count === 0);
            if (emptySliceRequested) {
              const workspace = await readWorkspaceFile(workspaceCollision.path);
              totalLines = workspace.content.split('\n').length;
              content = '';
              firstLine = lines?.start ?? (tail === 0 ? totalLines + 1 : 1);
              hasMore = totalLines > 0;
            } else if (typeof tail === 'number') {
              const workspace = await readWorkspaceFile(workspaceCollision.path);
              const allLines = workspace.content.split('\n');
              const selected = allLines.slice(Math.max(0, allLines.length - tail));
              content = selected.join('\n');
              firstLine = Math.max(1, allLines.length - selected.length + 1);
              totalLines = allLines.length;
              hasMore = selected.length < allLines.length;
            } else {
              const request: WorkspaceReadFileRequest = lines
                ? {
                    path: workspaceCollision.path,
                    startLine: lines.start,
                    endLine: lines.start + Math.max(0, lines.count - 1),
                  }
                : typeof head === 'number'
                  ? { path: workspaceCollision.path, startLine: 1, endLine: Math.max(1, head) }
                  : startLine !== undefined || endLine !== undefined
                    ? {
                        path: workspaceCollision.path,
                        ...(startLine !== undefined ? { startLine } : {}),
                        ...(endLine !== undefined ? { endLine } : {}),
                      }
                    : { path: workspaceCollision.path };
              if (request.startLine === undefined && request.endLine === undefined) {
                const workspace = await readWorkspaceFile(workspaceCollision.path);
                content = workspace.content;
                totalLines = content.split('\n').length;
              } else {
                const workspace = (await readWorkspaceFiles([request])).results[0];
                if (!workspace || workspace.status === 'error') {
                  throw new Error(
                    workspace?.status === 'error'
                      ? workspace.error
                      : 'workspace read returned no result',
                  );
                }
                content = workspace.content;
                firstLine = workspace.startLine;
                totalLines = workspace.totalLines;
                hasMore = workspace.hasMore;
              }
            }
            const notice = reroutedReadNotice(
              'read_artifact',
              'read_file',
              'workspace',
              workspaceCollision.path,
            );
            return {
              content: [{ type: 'text' as const, text: `${notice}\n\n${content}` }],
              structuredContent: {
                requestedTool: 'read_artifact',
                requestedPath: path,
                resolvedTool: 'read_file',
                resolvedSurface: 'workspace',
                resolvedPath: workspaceCollision.path,
                rerouted: true,
                content,
                startLine: firstLine,
                ...(totalLines !== undefined ? { totalLines } : {}),
                hasMore,
              },
            };
          } catch (fallbackError) {
            return errorResult(
              `Artifact "${path}" was not found and its automatic workspace fallback failed: ${unwrapApiError(fallbackError)}`,
              { retryable: true, hint: exactCall },
            );
          }
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Artifact "${path}" not found. Call list_artifacts to see what's available.`,
            },
          ],
          isError: true,
        };
      }
      if (result.kind === 'ambiguous') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `"${path}" matches multiple artifacts. Call read_artifact again with a full path:\n${result.candidates.map((candidate) => `  • ${candidate}`).join('\n')}`,
            },
          ],
          isError: true,
        };
      }
      const header = result.fuzzy ? `(matched ${result.path} by basename)\n` : '';
      const sliceStart = artifactSliceStart(sliceArgs, result.totalLines, result.linesReturned);
      const sliceTail =
        result.hasMore || result.linesReturned !== result.totalLines
          ? `\n\n…[lines ${result.linesReturned} of ${result.totalLines}; ${result.hasMore ? 'more available' : 'this is the last slice'}. Re-call with \`startLine\` / \`endLine\` to read more.]`
          : '';
      return {
        content: [{ type: 'text' as const, text: header + result.content + sliceTail }],
        structuredContent: {
          requestedPath: clean,
          resolvedPath: result.path,
          fuzzy: result.fuzzy,
          content: result.content,
          startLine: sliceStart,
          endLine: sliceStart + Math.max(0, result.linesReturned - 1),
          linesReturned: result.linesReturned,
          totalLines: result.totalLines,
          hasMore: result.hasMore,
        },
      };
    },
  );

  server.tool(
    'read_artifacts',
    `Read up to ${WORKSPACE_READ_MAX_FILES} known artifact files or inclusive line ranges in one call. Paths must come from \`list_artifacts\` and stay relative to the artifact root. Pass simple \`paths\` for first chunks, or \`files\` entries with the same \`startLine\`/\`endLine\` shape as \`read_files\`; pass exactly one field. Exact workspace-file mistakes are safely rerouted only when \`read_file\` is authorized. Results stay in request order and preserve item-level errors.`,
    {
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(4096).describe('Artifact-root-relative path.'),
            startLine: z
              .number()
              .int()
              .min(1)
              .max(10_000_000)
              .optional()
              .describe('1-based first line to return (inclusive). Defaults to 1.'),
            endLine: z
              .number()
              .int()
              .min(1)
              .max(10_000_000)
              .optional()
              .describe(
                `1-based last line to return (inclusive); at most ${WORKSPACE_READ_MAX_RANGE_LINES} lines.`,
              ),
          }),
        )
        .min(1)
        .max(WORKSPACE_READ_MAX_FILES)
        .optional()
        .describe('Artifact files/ranges to read, in request order.'),
      paths: z
        .array(z.string().min(1).max(4096))
        .min(1)
        .max(WORKSPACE_READ_MAX_FILES)
        .optional()
        .describe('Simple artifact-root-relative paths. Use `files` for ranges.'),
    },
    async ({ files, paths }) => {
      if ((files === undefined) === (paths === undefined)) {
        return errorResult('read_artifacts failed: pass exactly one of `paths` or `files`');
      }
      const requests: WorkspaceReadFileRequest[] = files ?? paths?.map((path) => ({ path })) ?? [];
      for (const request of requests) {
        const rangeError = workspaceReadRangeError(request);
        if (rangeError) return errorResult(`read_artifacts failed: ${request.path}: ${rangeError}`);
      }

      const results = await Promise.all(
        requests.map(async (request) => {
          const clean = normalizeArtifactPath(request.path);
          try {
            const artifact = await api.readProjectArtifactSlice(
              projectId,
              clean,
              artifactSliceOpts(request),
            );
            if (artifact.kind === 'found') {
              const start = artifactSliceStart(
                request,
                artifact.totalLines,
                artifact.linesReturned,
              );
              const end = start + Math.max(0, artifact.linesReturned - 1);
              return {
                status: 'ok' as const,
                path: request.path,
                content: artifact.content,
                startLine: start,
                endLine: end,
                completeFile: artifact.linesReturned === artifact.totalLines,
                totalLines: artifact.totalLines,
                hasMore: artifact.hasMore,
                ...(artifact.hasMore ? { nextStartLine: end + 1 } : {}),
                resolvedSurface: 'artifact' as const,
                resolvedPath: artifact.path,
                rerouted: false,
                fuzzy: artifact.fuzzy,
              };
            }
            if (artifact.kind === 'ambiguous') {
              return {
                status: 'error' as const,
                path: request.path,
                code: 'ambiguous',
                error: `matches multiple artifacts: ${artifact.candidates.join(', ')}`,
                resolvedSurface: 'artifact' as const,
                rerouted: false,
              };
            }
            const workspace = await workspaceCollisionForArtifactPath(clean);
            if (!workspace || workspace.kind !== 'file') {
              return {
                status: 'error' as const,
                path: request.path,
                code: 'path-not-found',
                error: 'artifact not found',
                resolvedSurface: 'artifact' as const,
                rerouted: false,
              };
            }
            if (!toolIsAuthorized('read_file')) {
              return {
                status: 'error' as const,
                path: request.path,
                code: 'workspace-read-unauthorized',
                error: `a workspace file exists at "${workspace.path}", but read_file is not authorized for this session`,
                requestedPath: request.path,
                resolvedPath: workspace.path,
                resolvedSurface: 'workspace' as const,
                rerouted: false,
              };
            }
            const workspaceResult = (
              await readWorkspaceFiles([
                {
                  path: workspace.path,
                  ...(request.startLine !== undefined ? { startLine: request.startLine } : {}),
                  ...(request.endLine !== undefined ? { endLine: request.endLine } : {}),
                },
              ])
            ).results[0];
            if (!workspaceResult || workspaceResult.status === 'error') {
              return {
                status: 'error' as const,
                path: request.path,
                code: workspaceResult?.status === 'error' ? workspaceResult.code : 'read-failed',
                error:
                  workspaceResult?.status === 'error'
                    ? workspaceResult.error
                    : 'workspace fallback returned no result',
                resolvedSurface: 'artifact' as const,
                rerouted: false,
              };
            }
            return {
              status: 'ok' as const,
              path: request.path,
              content: workspaceResult.content,
              startLine: workspaceResult.startLine,
              endLine: workspaceResult.endLine,
              completeFile: workspaceResult.completeFile,
              totalLines: workspaceResult.totalLines,
              hasMore: workspaceResult.hasMore,
              nextStartLine: workspaceResult.nextStartLine,
              resolvedSurface: 'workspace' as const,
              resolvedPath: workspace.path,
              rerouted: true,
              fuzzy: false,
            };
          } catch (error) {
            return {
              status: 'error' as const,
              path: request.path,
              code: 'read-failed',
              error: unwrapApiError(error),
              resolvedSurface: 'artifact' as const,
              rerouted: false,
            };
          }
        }),
      );

      const index = results.map((result, index) => {
        if (result.status === 'error') {
          return `${index + 1} ERROR ${result.path} [${result.code}] ${result.error}`;
        }
        const route = result.rerouted ? ` rerouted=workspace:${result.resolvedPath}` : '';
        const next = result.nextStartLine ? ` nextStartLine=${result.nextStartLine}` : '';
        return `${index + 1} OK ${result.path} lines=${result.startLine}-${result.endLine}${result.totalLines !== undefined ? ` totalLines=${result.totalLines}` : ''}${result.completeFile ? ' complete' : ''}${next}${route}`;
      });
      const sections = results.map((result) => {
        if (result.status === 'error') {
          return `--- ${result.path} [ERROR: ${result.code}] ---\n${result.error}`;
        }
        const notice = result.rerouted
          ? `${reroutedReadNotice('read_artifacts', 'read_file', 'workspace', result.resolvedPath)}\n`
          : '';
        const fuzzy = result.fuzzy ? `(matched ${result.resolvedPath} by basename)\n` : '';
        return `--- ${result.path} (lines=${result.startLine}-${result.endLine}) ---\n${notice}${fuzzy}${result.content}`;
      });
      const allFailed = results.length > 0 && results.every((result) => result.status === 'error');
      return {
        content: [
          {
            type: 'text' as const,
            text: `[read_artifacts requested=${results.length} ok=${results.filter((result) => result.status === 'ok').length} errors=${results.filter((result) => result.status === 'error').length}]\n${index.join('\n')}\n\n${sections.join('\n\n')}`,
          },
        ],
        structuredContent: { results },
        ...(allFailed ? { isError: true } : {}),
      };
    },
  );
}
