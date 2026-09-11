import type { SearchFilesRequest, SearchFilesResponse } from '@bendyline/gezel';
import { SearchToolOutputSchema, okResult } from './tool-contracts.js';

export function equivalentWorkspaceGrepArgs(
  path: string,
  pattern: string,
  options: {
    caseInsensitive?: boolean;
    contextLines?: number;
    maxMatches?: number;
  },
): SearchFilesRequest {
  return {
    path,
    pattern,
    // grep_artifact defaults to insensitive while grep_files defaults to
    // sensitive, so this must be explicit for a truly equivalent retry.
    caseInsensitive: options.caseInsensitive ?? true,
    contextLines: Math.min(options.contextLines ?? 0, 5),
    maxResults: options.maxMatches ?? 20,
  };
}

export function renderExactToolCall(name: string, args: Record<string, unknown>): string {
  return `${name}(${JSON.stringify(args)})`;
}

export function workspaceGrepResult(
  args: SearchFilesRequest,
  response: SearchFilesResponse,
  notice = '',
) {
  const prefix = notice ? `${notice}\n\n` : '';
  const truncation = response.truncated
    ? `\nResults truncated (${response.truncationReason ?? 'limit'}).${
        response.nextCursor !== undefined
          ? ` Continue with cursor=${response.nextCursor}, or narrow path/includeGlobs/pattern.`
          : ' Narrow path/includeGlobs/pattern.'
      }`
    : '';
  if (response.mode === 'count') {
    const qualifier = response.truncated ? 'at least ' : '';
    const summary = `${qualifier}${response.count} matching line${response.count === 1 ? '' : 's'} (engine=${response.engine}).`;
    return okResult(
      SearchToolOutputSchema,
      {
        summary,
        query: args.pattern,
        matches: [],
        count: response.count,
        truncated: response.truncated,
        engine: response.engine,
        mode: response.mode,
        ...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {}),
        ...(response.truncationReason ? { truncationReason: response.truncationReason } : {}),
      },
      { text: `${prefix}${summary}${truncation}` },
    );
  }
  if (response.mode === 'files') {
    const header = `${response.files.length} matching file${response.files.length === 1 ? '' : 's'} (engine=${response.engine})`;
    return okResult(
      SearchToolOutputSchema,
      {
        summary: `${header}.`,
        query: args.pattern,
        matches: response.files.map((path) => ({ path })),
        count: response.files.length,
        truncated: response.truncated,
        engine: response.engine,
        mode: response.mode,
        ...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {}),
        ...(response.truncationReason ? { truncationReason: response.truncationReason } : {}),
      },
      {
        text: `${prefix}${header}\n${response.files.join('\n') || '(none)'}${truncation}`,
      },
    );
  }
  const lines = response.matches.flatMap((match, index) => {
    const block = [
      ...(match.before ?? []).map((line) => `${match.path}-${line.line}-${line.text}`),
      `${match.path}:${match.line}:${match.text}`,
      ...(match.after ?? []).map((line) => `${match.path}-${line.line}-${line.text}`),
    ];
    if (index < response.matches.length - 1 && (match.before?.length || match.after?.length)) {
      block.push('--');
    }
    return block;
  });
  const header = `${response.matches.length} match${response.matches.length === 1 ? '' : 'es'} (engine=${response.engine})`;
  return okResult(
    SearchToolOutputSchema,
    {
      summary: `${header}.`,
      query: args.pattern,
      matches: response.matches,
      count: response.matches.length,
      truncated: response.truncated,
      engine: response.engine,
      mode: response.mode,
      ...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {}),
      ...(response.truncationReason ? { truncationReason: response.truncationReason } : {}),
    },
    { text: `${prefix}${header}\n${lines.join('\n') || '(no matches)'}${truncation}` },
  );
}
