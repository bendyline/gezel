import type { RewriteTextContext } from '@bendyline/gezel';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { useCallback, useState } from 'react';
import { runtimeCapabilities } from '../../runtime-capabilities.js';
import { TransformDialog } from './TransformDialog.js';
import type { SelectionSnapshot } from './types.js';

/**
 * The single AI toolbar button for the Squisq editor: opens the
 * transformation dialog on the current selection (rewrite mode) or the
 * cursor position (insert mode — no selection). Whole-document rewrite
 * is deliberately gone: select all to rewrite everything. Must be
 * rendered inside an <EditorShell/> so it can pull the live editor
 * context and capture the selection synchronously before the dialog
 * steals focus.
 */

interface TransformToolbarButtonProps {
  context: RewriteTextContext;
  /** Short subject hint (e.g. task title, gezel name). */
  subject?: string;
  /** Longer parent-context blob (e.g. project description). */
  parentContext?: string;
}

/** How much surrounding document insert mode sends as advisory context. */
const BEFORE_CONTEXT_CHARS = 2000;
const AFTER_CONTEXT_CHARS = 1000;

/**
 * DocBlocks' AI sparkles (`SparklesGlyph` in its AiEditorAssistant), path
 * for path. Only the viewBox differs: the two stars span x 3.25-15.7 and
 * y 2.2-14.4, so DocBlocks' `0 0 18 18` draws them right of center and
 * high; this box is centered on them.
 */
function SparklesGlyph() {
  return (
    <svg
      viewBox="0.475 -0.7 18 18"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.2 2.2c.45 2.2 1.75 3.5 3.95 3.95-2.2.45-3.5 1.75-3.95 3.95-.45-2.2-1.75-3.5-3.95-3.95C5.45 5.7 6.75 4.4 7.2 2.2Z" />
      <path d="M13.1 9.2c.3 1.45 1.15 2.3 2.6 2.6-1.45.3-2.3 1.15-2.6 2.6-.3-1.45-1.15-2.3-2.6-2.6 1.45-.3 2.3-1.15 2.6-2.6Z" />
    </svg>
  );
}

export function TransformToolbarButton({
  context,
  subject,
  parentContext,
}: TransformToolbarButtonProps) {
  const { tiptapEditor, monacoEditor, activeView, insertAtCursor } = useEditorContext();
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null);

  const supported =
    (activeView === 'wysiwyg' && !!tiptapEditor) || (activeView === 'raw' && !!monacoEditor);

  const captureSnapshot = useCallback((): SelectionSnapshot | null => {
    if (activeView === 'wysiwyg' && tiptapEditor) {
      const { from, to } = tiptapEditor.state.selection;
      const doc = tiptapEditor.state.doc;
      if (from !== to) {
        const text = doc.textBetween(from, to, '\n');
        if (text.trim()) {
          return {
            mode: 'rewrite',
            view: 'wysiwyg',
            text,
            tiptapRange: { from, to },
            tiptapAll: from === 0 && to === doc.content.size,
          };
        }
      }
      return {
        mode: 'insert',
        view: 'wysiwyg',
        text: '',
        tiptapRange: { from, to },
        textBefore: doc.textBetween(0, from, '\n').slice(-BEFORE_CONTEXT_CHARS),
        textAfter: doc.textBetween(to, doc.content.size, '\n').slice(0, AFTER_CONTEXT_CHARS),
      };
    }
    if (activeView === 'raw' && monacoEditor) {
      const sel = monacoEditor.getSelection();
      const model = monacoEditor.getModel();
      if (!sel || !model) return null;
      const monacoRange = {
        startLineNumber: sel.startLineNumber,
        startColumn: sel.startColumn,
        endLineNumber: sel.endLineNumber,
        endColumn: sel.endColumn,
      };
      if (!sel.isEmpty()) {
        const text = model.getValueInRange(sel);
        if (text.trim()) return { mode: 'rewrite', view: 'raw', text, monacoRange };
      }
      const full = model.getValue();
      const startOffset = model.getOffsetAt({
        lineNumber: sel.startLineNumber,
        column: sel.startColumn,
      });
      const endOffset = model.getOffsetAt({
        lineNumber: sel.endLineNumber,
        column: sel.endColumn,
      });
      return {
        mode: 'insert',
        view: 'raw',
        text: '',
        monacoRange,
        textBefore: full.slice(Math.max(0, startOffset - BEFORE_CONTEXT_CHARS), startOffset),
        textAfter: full.slice(endOffset, endOffset + AFTER_CONTEXT_CHARS),
      };
    }
    return null;
  }, [activeView, tiptapEditor, monacoEditor]);

  const applyResult = useCallback(
    (snap: SelectionSnapshot, text: string) => {
      if (snap.view === 'wysiwyg' && tiptapEditor && snap.tiptapRange) {
        const { from, to } = snap.tiptapRange;
        // The dialog owns focus while the result is reviewed, so first restore
        // the exact captured selection. Then delegate the insertion to
        // Squisq: its public action runs Markdown through the same
        // markdownToTiptap bridge as paste/drop. Passing the Markdown string
        // directly to Tiptap's insertContentAt() treats it as literal text,
        // escaping marks and nesting headings inside the selected block.
        // insertContent replaces a non-empty selection in one history event,
        // which also keeps the whole transform reversible with one Undo.
        if (snap.tiptapAll) {
          tiptapEditor.chain().focus().selectAll().run();
        } else {
          tiptapEditor.chain().focus().setTextSelection({ from, to }).run();
        }
        insertAtCursor(text);
      } else if (snap.view === 'raw' && monacoEditor && snap.monacoRange) {
        monacoEditor.executeEdits('ai-transform', [
          { range: snap.monacoRange, text, forceMoveMarkers: true },
        ]);
        monacoEditor.focus();
      }
    },
    [tiptapEditor, monacoEditor, insertAtCursor],
  );

  if (!runtimeCapabilities().textTransforms) return null;

  return (
    <>
      <button
        type="button"
        className="squisq-toolbar-button gezel-ai-transform-btn"
        onClick={() => setSnapshot(captureSnapshot())}
        disabled={!supported}
        title={
          supported
            ? 'AI: transform the selection, or add new content at the cursor'
            : 'AI transform is available in the editing views'
        }
        aria-label="Transform with AI"
      >
        <SparklesGlyph />
      </button>
      {snapshot && (
        <TransformDialog
          snapshot={snapshot}
          context={context}
          subject={subject}
          parentContext={parentContext}
          onApply={(text) => {
            applyResult(snapshot, text);
            setSnapshot(null);
          }}
          onClose={() => setSnapshot(null)}
        />
      )}
    </>
  );
}
