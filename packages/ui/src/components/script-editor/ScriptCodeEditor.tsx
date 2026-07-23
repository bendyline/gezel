import type { ScriptDiagnostic } from '@bendyline/gezel';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useEffectiveTheme } from '../../theme.js';

/**
 * Thin controlled wrapper around a raw monaco editor for a single script
 * file. All monaco code lives in `monaco-setup.ts` and loads via dynamic
 * import on mount, keeping the ~9MB language bundle out of the app's
 * static graph (and out of jsdom — tests mock this module).
 *
 * The parent owns persistence; this component surfaces edits via
 * `onChangeContent` and exposes an imperative handle for the few
 * operations that must reach into the buffer (conflict reload, jump to
 * line, server-side diagnostics as markers).
 */

/** One row for the problems strip: monaco's markers mapped to a plain shape. */
export interface EditorProblem {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  column: number;
}

export interface ScriptCodeEditorHandle {
  getValue(): string | null;
  /** Replace the whole buffer (conflict reload / make-a-copy detach). */
  setValue(text: string): void;
  revealLine(line: number): void;
  focus(): void;
  /** Render save-endpoint diagnostics as markers (owner "gezel-save"). */
  setServerDiagnostics(diagnostics: ScriptDiagnostic[]): void;
  /**
   * Collapse the "setup" region (imports + meta) into a folded section. The
   * Script tab feeds Monaco the whole file — so it type-checks against the real
   * `meta`/`gezel` types — but folds the setup away so the user edits only the
   * body, with one click to expand it. A folding-range provider in
   * `monaco-setup.ts` defines the region; this just collapses it.
   */
  collapsePreamble(): void;
}

export interface ScriptCodeEditorProps {
  projectId: string;
  scriptName: string;
  /** Buffer content at mount. Later changes flow through the handle. */
  initialSource: string;
  /**
   * Collapse the setup region (imports + meta) once mounted — the Script tab's
   * default so only the body shows. Re-collapse later via the handle's
   * `collapsePreamble`. Default false (Raw shows everything expanded).
   */
  collapsePreambleOnMount?: boolean;
  readOnly?: boolean;
  onChangeContent?: (source: string) => void;
  /** Cmd/Ctrl+S inside the editor. */
  onSave?: () => void;
  /** Fires whenever this model's marker set changes (all owners merged). */
  onProblems?: (problems: EditorProblem[]) => void;
  /** Fires once monaco has mounted and the imperative handle is usable. */
  onReady?: () => void;
}

type MonacoSetup = typeof import('./monaco-setup.js');
type Monaco = MonacoSetup['monaco'];
type StandaloneEditor = import('monaco-editor').editor.IStandaloneCodeEditor;
type TextModel = import('monaco-editor').editor.ITextModel;

/**
 * Collapse the preamble fold (the region a provider in monaco-setup defines
 * over the imports + meta). Uses the public fold action, which awaits the
 * folding model internally, so it works whether or not ranges are computed yet.
 */
function collapsePreambleFold(editor: StandaloneEditor): void {
  editor.trigger('gezel-preamble', 'editor.fold', { selectionLines: [1] });
}

export const ScriptCodeEditor = forwardRef<ScriptCodeEditorHandle, ScriptCodeEditorProps>(
  function ScriptCodeEditor(
    {
      projectId,
      scriptName,
      initialSource,
      collapsePreambleOnMount,
      readOnly,
      onChangeContent,
      onSave,
      onProblems,
      onReady,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const editorRef = useRef<StandaloneEditor | null>(null);
    const modelRef = useRef<TextModel | null>(null);
    const [ready, setReady] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const theme = useEffectiveTheme();

    // Latest-callback refs so handlers registered once at mount never go stale.
    const onChangeRef = useRef(onChangeContent);
    const onSaveRef = useRef(onSave);
    const onProblemsRef = useRef(onProblems);
    const onReadyRef = useRef(onReady);
    useEffect(() => {
      onChangeRef.current = onChangeContent;
      onSaveRef.current = onSave;
      onProblemsRef.current = onProblems;
      onReadyRef.current = onReady;
    }, [onChangeContent, onSave, onProblems, onReady]);

    // Mount-time source only — the parent remounts (keyed) per script.
    const initialSourceRef = useRef(initialSource);
    // Whether to collapse the preamble fold once monaco is ready.
    const collapseOnMountRef = useRef(collapsePreambleOnMount ?? false);
    // Ref mirror so the async mount block can apply the current theme
    // without depending on it (theme changes must not remount monaco).
    const themeRef = useRef(theme);
    themeRef.current = theme;

    useEffect(() => {
      let disposed = false;
      const disposables: Array<{ dispose(): void }> = [];
      void (async () => {
        let setup: MonacoSetup;
        try {
          setup = await import('./monaco-setup.js');
          const { api } = await import('../../api.js');
          await setup.ensureScriptTypescript(() => api.getSdkTypes());
        } catch (err) {
          if (!disposed) setLoadError((err as Error).message);
          return;
        }
        if (disposed || !containerRef.current) return;
        const monaco = setup.monaco;
        monacoRef.current = monaco;

        const uri = setup.scriptModelUri(projectId, scriptName);
        // A stale model can survive an unclean unmount (hot reload); reuse-by-replace.
        const existing = monaco.editor.getModel(uri);
        existing?.dispose();
        const model = monaco.editor.createModel(initialSourceRef.current, 'typescript', uri);
        modelRef.current = model;

        const editor = monaco.editor.create(containerRef.current, {
          model,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 13,
          tabSize: 2,
          fixedOverflowWidgets: true,
          readOnly: readOnly ?? false,
        });
        editorRef.current = editor;
        monaco.editor.setTheme(themeRef.current === 'dark' ? 'gezel-dark' : 'gezel-light');
        if (collapseOnMountRef.current) collapsePreambleFold(editor);

        disposables.push(model.onDidChangeContent(() => onChangeRef.current?.(model.getValue())));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current?.());
        disposables.push(
          monaco.editor.onDidChangeMarkers((uris) => {
            if (!uris.some((u) => u.toString() === uri.toString())) return;
            const markers = monaco.editor.getModelMarkers({ resource: uri });
            onProblemsRef.current?.(
              markers.map((m) => ({
                severity:
                  m.severity === monaco.MarkerSeverity.Error
                    ? ('error' as const)
                    : m.severity === monaco.MarkerSeverity.Warning
                      ? ('warning' as const)
                      : ('info' as const),
                message: m.message,
                line: m.startLineNumber,
                column: m.startColumn,
              })),
            );
          }),
        );
        setReady(true);
        onReadyRef.current?.();
      })();
      return () => {
        disposed = true;
        for (const d of disposables) d.dispose();
        editorRef.current?.dispose();
        editorRef.current = null;
        modelRef.current?.dispose();
        modelRef.current = null;
      };
    }, [projectId, scriptName, readOnly]);

    useEffect(() => {
      monacoRef.current?.editor.setTheme(theme === 'dark' ? 'gezel-dark' : 'gezel-light');
    }, [theme]);

    useImperativeHandle(
      ref,
      (): ScriptCodeEditorHandle => ({
        getValue: () => modelRef.current?.getValue() ?? null,
        setValue: (text) => modelRef.current?.setValue(text),
        revealLine: (line) => {
          editorRef.current?.revealLineInCenter(line);
          editorRef.current?.setPosition({ lineNumber: line, column: 1 });
          editorRef.current?.focus();
        },
        focus: () => editorRef.current?.focus(),
        collapsePreamble: () => {
          if (editorRef.current) collapsePreambleFold(editorRef.current);
        },
        setServerDiagnostics: (diagnostics) => {
          const monaco = monacoRef.current;
          const model = modelRef.current;
          if (!monaco || !model) return;
          monaco.editor.setModelMarkers(
            model,
            'gezel-save',
            diagnostics.map((d) => ({
              severity:
                d.severity === 'error'
                  ? monaco.MarkerSeverity.Error
                  : d.severity === 'warning'
                    ? monaco.MarkerSeverity.Warning
                    : monaco.MarkerSeverity.Info,
              message: d.message,
              startLineNumber: d.line ?? 1,
              startColumn: d.column ?? 1,
              endLineNumber: d.line ?? 1,
              endColumn: d.column ? d.column + 1 : 1,
            })),
          );
        },
      }),
      [],
    );

    return (
      <div className="script-code-editor">
        {!ready && !loadError && <p className="muted small">Loading editor…</p>}
        {loadError && (
          <p className="script-code-editor__error">Editor failed to load: {loadError}</p>
        )}
        <div ref={containerRef} className="script-code-editor__host" />
      </div>
    );
  },
);
