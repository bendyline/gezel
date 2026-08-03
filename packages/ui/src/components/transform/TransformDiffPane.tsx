import { useEffect, useRef, useState } from 'react';
import { useEffectiveTheme } from '../../theme.js';

/**
 * Monaco diff view for the transformation dialog: frozen "before" on the
 * left, editable "after" on the right, bound to the dialog's single
 * `afterText` state so hand edits survive toggling back to the
 * before/after view. Monaco loads via dynamic import on mount (see
 * monaco-base.ts — it must never enter the static graph; tests mock
 * this module the way script-editor tests mock monaco-setup).
 */

export interface TransformDiffPaneProps {
  original: string;
  value: string;
  onChange: (next: string) => void;
}

type MonacoBase = typeof import('../monaco-base.js');
type Monaco = MonacoBase['monaco'];
type DiffEditor = import('monaco-editor').editor.IStandaloneDiffEditor;
type TextModel = import('monaco-editor').editor.ITextModel;

export function TransformDiffPane({ original, value, onChange }: TransformDiffPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<DiffEditor | null>(null);
  const modifiedModelRef = useRef<TextModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const theme = useEffectiveTheme();

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Mount-time values only — later external updates flow through the
  // sync effect below; `original` is frozen for the dialog's lifetime.
  const originalRef = useRef(original);
  const initialValueRef = useRef(value);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    let disposed = false;
    const disposables: Array<{ dispose(): void }> = [];
    void (async () => {
      let base: MonacoBase;
      try {
        base = await import('../monaco-base.js');
      } catch (err) {
        if (!disposed) setLoadError((err as Error).message);
        return;
      }
      if (disposed || !containerRef.current) return;
      const monaco = base.monaco;
      monacoRef.current = monaco;

      const originalModel = monaco.editor.createModel(originalRef.current, 'markdown');
      const modifiedModel = monaco.editor.createModel(initialValueRef.current, 'markdown');
      modifiedModelRef.current = modifiedModel;
      disposables.push(originalModel, modifiedModel);

      const editor = monaco.editor.createDiffEditor(containerRef.current, {
        automaticLayout: true,
        originalEditable: false,
        readOnly: false,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        fixedOverflowWidgets: true,
        // Prose, not code — soft-wrap both panes.
        wordWrap: 'on',
      });
      editorRef.current = editor;
      editor.setModel({ original: originalModel, modified: modifiedModel });
      monaco.editor.setTheme(themeRef.current === 'dark' ? 'gezel-dark' : 'gezel-light');

      disposables.push(
        modifiedModel.onDidChangeContent(() => onChangeRef.current(modifiedModel.getValue())),
      );
      setReady(true);
    })();
    return () => {
      disposed = true;
      editorRef.current?.dispose();
      editorRef.current = null;
      for (const d of disposables) d.dispose();
      modifiedModelRef.current = null;
    };
  }, []);

  // External `value` updates (edits made in the before/after textarea)
  // sync into the modified model; the guard breaks the onChange loop.
  useEffect(() => {
    const model = modifiedModelRef.current;
    if (ready && model && model.getValue() !== value) model.setValue(value);
  }, [value, ready]);

  useEffect(() => {
    monacoRef.current?.editor.setTheme(theme === 'dark' ? 'gezel-dark' : 'gezel-light');
  }, [theme]);

  return (
    <div className="gz-transform-diff">
      {!ready && !loadError && <p className="muted small">Loading diff view…</p>}
      {loadError && (
        <p className="gz-transform-diff-error">Diff view failed to load: {loadError}</p>
      )}
      <div ref={containerRef} className="gz-transform-diff-host" />
    </div>
  );
}
