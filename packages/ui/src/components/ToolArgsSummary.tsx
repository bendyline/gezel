import { stripMcpPrefix } from '@bendyline/gezel';
import type { ToolActivity } from './chat-bubbles.js';
import type { OpenChatReference, OpenChatReferenceKind } from './chat-open-command.js';

/**
 * Resolve file-oriented tool names to the References viewer's three roots.
 * Keep this deliberately narrower than "has a path argument": a successful
 * delete or folder listing can carry a path that the file viewer cannot open.
 */
function toolReferenceKind(name: string): OpenChatReferenceKind | null {
  switch (stripMcpPrefix(name)) {
    case 'read_artifact':
    case 'write_artifact':
    case 'grep_artifact':
      return 'artifact';
    case 'read_document':
    case 'write_document':
      return 'document';
    case 'read_file':
    case 'read_files':
    case 'write_file':
    case 'append_to_file':
    case 'replace_in_file':
    case 'replace_lines':
    case 'apply_patch':
    case 'insert_at_marker':
    case 'validate':
    case 'outline_file':
    case 'read_symbol':
    case 'file_review':
      return 'workspace';
    default:
      return null;
  }
}

function toolReferencePaths(tool: ToolActivity): string[] {
  const paths = tool.paths?.length ? tool.paths : tool.path ? [tool.path] : [];
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

export function ToolArgsSummary({
  tool,
  onOpenReference,
}: {
  tool: ToolActivity;
  onOpenReference?: (reference: OpenChatReference) => void;
}) {
  const summary = tool.argsSummary ?? tool.path;
  if (!summary) return null;

  const kind = tool.success ? toolReferenceKind(tool.name) : null;
  const paths = kind && onOpenReference ? toolReferencePaths(tool) : [];
  if (!kind || !onOpenReference || paths.length === 0) {
    return (
      <span className={tool.argsSummary ? 'thinking-tool-args' : 'thinking-tool-path'}>
        {summary}
      </span>
    );
  }

  const open = (path: string) => {
    onOpenReference({
      key: `tool:${kind}:${tool.projectId ?? ''}:${path}`,
      kind,
      path,
      ...(tool.projectId ? { projectId: tool.projectId } : {}),
    });
  };

  // Link only exact paths supplied by the successful tool event. The summary
  // is human-written display text, so filename-looking prose that was not in
  // `path`/`paths` remains plain. Longest-first prevents `a.md` from taking
  // the prefix of `notes/a.md` when both happen to be present.
  const orderedPaths = [...paths].sort((left, right) => right.length - left.length);
  const parts: Array<{ text: string; at: number; path?: string }> = [];
  const matched = new Set<string>();
  let cursor = 0;
  while (cursor < summary.length) {
    let nextPath: string | undefined;
    let nextIndex = Number.POSITIVE_INFINITY;
    for (const path of orderedPaths) {
      const index = summary.indexOf(path, cursor);
      if (index < 0 || index > nextIndex) continue;
      if (index === nextIndex && nextPath && path.length <= nextPath.length) continue;
      nextPath = path;
      nextIndex = index;
    }
    if (!nextPath || !Number.isFinite(nextIndex)) {
      parts.push({ text: summary.slice(cursor), at: cursor });
      break;
    }
    if (nextIndex > cursor) {
      parts.push({ text: summary.slice(cursor, nextIndex), at: cursor });
    }
    parts.push({ text: nextPath, at: nextIndex, path: nextPath });
    matched.add(nextPath);
    cursor = nextIndex + nextPath.length;
  }

  // Batched reads summarize themselves as "Read N files" and otherwise hide
  // every path. Keep up to three verified paths reachable without letting a
  // large batch turn one compact breadcrumb into a transcript of its own.
  const unmatched = paths.filter((path) => !matched.has(path));
  const visibleUnmatched = unmatched.slice(0, 3);
  const hiddenCount = unmatched.length - visibleUnmatched.length;

  return (
    <span className={tool.argsSummary ? 'thinking-tool-args' : 'thinking-tool-path'}>
      {parts.map((part) =>
        part.path ? (
          <button
            key={`path-${part.at}-${part.path}`}
            type="button"
            className="thinking-tool-file-link"
            title={`Open ${part.path} in References`}
            onClick={() => open(part.path!)}
          >
            {part.text}
          </button>
        ) : (
          <span key={`text-${part.at}`}>{part.text}</span>
        ),
      )}
      {visibleUnmatched.map((path) => (
        <span key={`extra-${path}`}>
          {' · '}
          <button
            type="button"
            className="thinking-tool-file-link"
            title={`Open ${path} in References`}
            onClick={() => open(path)}
          >
            {path}
          </button>
        </span>
      ))}
      {hiddenCount > 0 && <span>{` · +${hiddenCount} more`}</span>}
    </span>
  );
}
