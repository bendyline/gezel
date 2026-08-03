/**
 * Selection state captured synchronously when the transform dialog opens,
 * before focus moves into the modal. The modal blocks all editor
 * interaction, so the stored positions cannot go stale while it is up;
 * Apply commits against these, never the live selection.
 */
export interface SelectionSnapshot {
  /** `rewrite` transforms the selection; `insert` adds content at the cursor. */
  mode: 'rewrite' | 'insert';
  view: 'wysiwyg' | 'raw';
  /** The selected text. Empty in insert mode. */
  text: string;
  /** WYSIWYG (tiptap) document positions. */
  tiptapRange?: { from: number; to: number };
  /** Preserve ProseMirror's node-spanning Select All semantics on Apply. */
  tiptapAll?: boolean;
  /** Raw (monaco) selection range, copied to a plain object. */
  monacoRange?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  /** Insert mode: bounded document context around the insertion point. */
  textBefore?: string;
  textAfter?: string;
}
