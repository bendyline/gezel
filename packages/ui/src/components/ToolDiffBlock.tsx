import { useState } from 'react';

/**
 * Inline diff viewer for surgical-edit tools (`replace_in_file`,
 * `apply_patch`, `insert_at_marker`). Collapsed by default with a
 * "Show diff (+N −M)" toggle; expanded, renders the unified diff
 * with `+`/`-` line coloring. Self-contained: no external diff
 * library — the unified-diff format is simple enough that this
 * 40-line renderer is cheaper than a dep that brings `emotion`
 * along.
 *
 * Lives in its own file (not chat-bubbles.tsx) so the HistoryView
 * detail pane can import the diff renderer without pulling the
 * chat-bubbles module's transitive Squisq markdown deps.
 */
export function ToolDiffBlock({
  diff,
  addedLines,
  removedLines,
}: {
  diff: string;
  addedLines?: number;
  removedLines?: number;
}) {
  const [open, setOpen] = useState(false);
  const counts =
    addedLines !== undefined || removedLines !== undefined
      ? ` (+${addedLines ?? 0} −${removedLines ?? 0})`
      : '';
  // Drop the createPatch() preamble (Index:/===/---/+++ lines) — it
  // repeats the path the tool row already shows and costs four lines
  // of vertical space. A diff with no hunk markers renders unchanged.
  const lines = diff.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  const visibleLines = firstHunk === -1 ? lines : lines.slice(firstHunk);
  return (
    <div className="thinking-tool-diff">
      <button
        type="button"
        className="thinking-tool-diff-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▼ Hide diff' : '▶ Show diff'}
        {counts}
      </button>
      {open && (
        <pre className="thinking-tool-diff-body">
          {visibleLines.map((line, i) => {
            let cls = 'thinking-tool-diff-line-ctx';
            if (line.startsWith('+++') || line.startsWith('---')) {
              cls = 'thinking-tool-diff-line-header';
            } else if (line.startsWith('@@')) cls = 'thinking-tool-diff-line-hunk';
            else if (line.startsWith('+')) cls = 'thinking-tool-diff-line-add';
            else if (line.startsWith('-')) cls = 'thinking-tool-diff-line-rem';
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no stable id; position is the only key
              <span key={i} className={cls}>
                {line}
                {'\n'}
              </span>
            );
          })}
        </pre>
      )}
    </div>
  );
}
