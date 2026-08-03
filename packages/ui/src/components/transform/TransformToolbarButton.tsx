import type { RewriteTextContext } from '@bendyline/gezel';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { useCallback, useState } from 'react';
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

function WandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m2 14 8.5-8.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M12 1.8l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7.7-1.7Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
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

  return (
    <>
      <button
        type="button"
        className="ai-btn"
        onClick={() => setSnapshot(captureSnapshot())}
        disabled={!supported}
        title={
          supported
            ? 'AI: transform the selection, or add new content at the cursor'
            : 'AI transform is available in the editing views'
        }
        aria-label="Transform with AI"
      >
        <WandIcon />
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
