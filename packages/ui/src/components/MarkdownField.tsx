import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { type FocusEvent, useCallback, useEffect, useRef } from 'react';
import { useEffectiveTheme } from '../theme.js';

interface MarkdownFieldProps {
  /** Current markdown value. Read once at mount — remount via `key` to reset. */
  value: string;
  /** Renders the content as non-editable rendered markdown when true. */
  readOnly?: boolean;
  placeholder?: string;
  /** Auto-grow bounds for the editor surface. */
  minHeight?: string;
  maxHeight?: string;
  /**
   * Fired when focus leaves the editor and the markdown actually changed —
   * mirrors the save-on-blur pattern the plain `<textarea>` fields use, so a
   * keystroke doesn't fire a PATCH per character.
   */
  onCommit: (markdown: string) => void;
}

/**
 * A markdown-aware replacement for the plain `<textarea>` fields used for
 * craftbook/task step descriptions and prompts. These bodies are routinely
 * authored in markdown (bold, lists, fenced code, links), so a raw textarea
 * shows the source while a reader wants the rendered shape. This wraps the
 * Squisq `EditorShell` in its compact, chrome-light configuration (no Play
 * tab, no status bar, no Files toggle) and saves on blur.
 *
 * `EditorShell` reads `initialMarkdown` once at mount, matching the existing
 * `defaultValue` + remount-on-`key` behavior of the textareas it replaces —
 * callers pass a `key` keyed on the step id so switching steps loads fresh
 * content without clobbering an in-progress edit on the current step.
 */
export function MarkdownField({
  value,
  readOnly,
  placeholder,
  minHeight = '80px',
  maxHeight = '40vh',
  onCommit,
}: MarkdownFieldProps) {
  const theme = useEffectiveTheme();
  const draftRef = useRef(value);
  const committedRef = useRef(value);

  const handleChange = useCallback((source: string) => {
    draftRef.current = source;
  }, []);

  const commit = useCallback(() => {
    if (readOnly) return;
    if (draftRef.current === committedRef.current) return;
    committedRef.current = draftRef.current;
    onCommit(draftRef.current);
  }, [readOnly, onCommit]);

  // Commit only when focus leaves the wrapper entirely — moving between the
  // editor's own surfaces (Tiptap ↔ Monaco, toolbar buttons) keeps focus
  // inside and must not fire a save.
  const handleBlur = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      commit();
    },
    [commit],
  );

  // Catch the unmount path (step/tab switch via a control that doesn't blur
  // the editor first). The draft === committed guard makes this a no-op when
  // a blur already saved, so it never fires a stale PATCH.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);

  return (
    <div className="markdown-field" onBlur={handleBlur}>
      <EditorShell
        initialMarkdown={value}
        initialView="wysiwyg"
        onChange={handleChange}
        readOnly={readOnly ?? false}
        colorScheme={theme}
        uxFont="var(--font-ui)"
        {...(placeholder ? { placeholder } : {})}
        minHeight={minHeight}
        maxHeight={maxHeight}
        showPlayTab={false}
        showStatusBar={false}
        showFilesToggle={false}
        fullWidth
        thinMargins
      />
    </div>
  );
}
