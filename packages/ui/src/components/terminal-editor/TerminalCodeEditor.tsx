import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useEffectiveTheme } from '../../theme.js';

/**
 * Lazy Monaco surface for the terminal composer. All monaco code lives in
 * `terminal-monaco-setup.ts` and loads via dynamic import on mount, keeping
 * monaco out of the static graph + jsdom (tests mock this whole module — see
 * the `ScriptEditorTabs` mock pattern).
 *
 * The parent (`TerminalComposer`) owns submit/history/queue/error state; this
 * surfaces edits via `onChange` and the few imperative ops (read value on
 * submit, set value on history recall / queued-command seed, focus).
 */

export interface TerminalCodeEditorHandle {
  getValue(): string;
  /** Replace the buffer (history recall + queued-command seed) and move the caret to the end. */
  setValue(text: string): void;
  focus(): void;
}

export interface TerminalCodeEditorProps {
  projectId: string;
  /** Buffer content at mount. Later changes flow through the handle. */
  initialValue: string;
  /** Hint shown (as a content widget) while the buffer is empty. */
  placeholder?: string;
  className?: string;
  onChange?(value: string): void;
  /** Enter (no shift) — the parent reads the value here, not from React state. */
  onSubmit(value: string): void;
  /** Up at the first line (suggest widget closed). */
  onHistoryPrev(): void;
  /** Down at the last line (suggest widget closed). */
  onHistoryNext(): void;
  /** Leading `@` on a fresh draft — hand control back to an empty chat composer. */
  onChatEscape?(): void;
  onReady?(): void;
}

type TerminalSetup = typeof import('./terminal-monaco-setup.js');
type Monaco = TerminalSetup['monaco'];
type StandaloneEditor = import('monaco-editor').editor.IStandaloneCodeEditor;
type TextModel = import('monaco-editor').editor.ITextModel;

/** Keep staged / recalled commands ready for the user to extend or run. */
function moveCaretToEnd(editor: StandaloneEditor, model: TextModel): void {
  const lastLine = model.getLineCount();
  const position = {
    lineNumber: lastLine,
    column: model.getLineMaxColumn(lastLine),
  };
  editor.setPosition(position);
  editor.revealPosition(position);
}

const TerminalCodeEditor = forwardRef<TerminalCodeEditorHandle, TerminalCodeEditorProps>(
  function TerminalCodeEditor(
    {
      projectId,
      initialValue,
      placeholder,
      className,
      onChange,
      onSubmit,
      onHistoryPrev,
      onHistoryNext,
      onChatEscape,
      onReady,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const monacoRef = useRef<Monaco | null>(null);
    const editorRef = useRef<StandaloneEditor | null>(null);
    const modelRef = useRef<TextModel | null>(null);
    const [, setReady] = useState(false);
    const theme = useEffectiveTheme();

    // Latest-callback refs so handlers registered once at mount never go stale.
    const onChangeRef = useRef(onChange);
    const onSubmitRef = useRef(onSubmit);
    const onHistoryPrevRef = useRef(onHistoryPrev);
    const onHistoryNextRef = useRef(onHistoryNext);
    const onChatEscapeRef = useRef(onChatEscape);
    const onReadyRef = useRef(onReady);
    useEffect(() => {
      onChangeRef.current = onChange;
      onSubmitRef.current = onSubmit;
      onHistoryPrevRef.current = onHistoryPrev;
      onHistoryNextRef.current = onHistoryNext;
      onChatEscapeRef.current = onChatEscape;
      onReadyRef.current = onReady;
    });

    const initialValueRef = useRef(initialValue);
    const placeholderRef = useRef(placeholder);
    // Tracks previous buffer length to gate the `@` chat-escape to "user just
    // started typing a fresh command" (matches the old textarea's prevInputLen).
    const prevLenRef = useRef(initialValue.length);
    const themeRef = useRef(theme);
    themeRef.current = theme;

    useEffect(() => {
      let disposed = false;
      const disposables: Array<{ dispose(): void }> = [];
      void (async () => {
        let setup: TerminalSetup;
        try {
          setup = await import('./terminal-monaco-setup.js');
          await setup.ensureTerminalMonaco();
        } catch {
          return;
        }
        if (disposed || !containerRef.current) return;
        const monaco = setup.monaco;
        monacoRef.current = monaco;

        const uri = setup.terminalModelUri(projectId);
        // A stale model can survive an unclean unmount (hot reload); reuse-by-replace.
        monaco.editor.getModel(uri)?.dispose();
        const model = monaco.editor.createModel(initialValueRef.current, 'gezel-terminal', uri);
        modelRef.current = model;

        const editor = monaco.editor.create(containerRef.current, {
          model,
          automaticLayout: true,
          lineNumbers: 'off',
          glyphMargin: false,
          folding: false,
          minimap: { enabled: false },
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 0,
          renderLineHighlight: 'none',
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          scrollbar: {
            vertical: 'auto',
            horizontal: 'hidden',
            verticalScrollbarSize: 6,
            useShadows: false,
          },
          wordWrap: 'on',
          fontSize: 13.6,
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
          lineHeight: 21,
          padding: { top: 6, bottom: 6 },
          // The suggest widget must escape this ~84px host (it opens above the input).
          fixedOverflowWidgets: true,
          quickSuggestions: { other: true, comments: false, strings: true },
          suggestOnTriggerCharacters: true,
          // Enter submits the command; Tab accepts a suggestion. This is the core
          // terminal-vs-editor reconciliation.
          acceptSuggestionOnEnter: 'off',
          tabCompletion: 'on',
          contextmenu: false,
          roundedSelection: false,
          guides: { indentation: false },
          renderWhitespace: 'none',
          occurrencesHighlight: 'off',
          matchBrackets: 'never',
        });
        editorRef.current = editor;
        monaco.editor.setTheme(
          themeRef.current === 'dark' ? 'gezel-terminal-dark' : 'gezel-terminal-light',
        );

        // Enter → submit (unconditional; `acceptSuggestionOnEnter:'off'` means it
        // never steals a suggestion). Shift+Enter → newline.
        editor.addCommand(monaco.KeyCode.Enter, () => onSubmitRef.current(model.getValue()));
        editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () =>
          editor.trigger('keyboard', 'type', { text: '\n' }),
        );

        // History recall on Up/Down only at the first/last line and only when the
        // suggest widget is closed (so Up/Down navigate the suggestion list otherwise).
        const atFirst = editor.createContextKey<boolean>('terminalAtFirstLine', true);
        const atLast = editor.createContextKey<boolean>('terminalAtLastLine', true);
        const syncBoundaries = () => {
          const pos = editor.getPosition();
          atFirst.set(!pos || pos.lineNumber === 1);
          atLast.set(!pos || pos.lineNumber === model.getLineCount());
        };
        syncBoundaries();
        disposables.push(editor.onDidChangeCursorPosition(syncBoundaries));
        disposables.push(model.onDidChangeContent(syncBoundaries));
        editor.addCommand(
          monaco.KeyCode.UpArrow,
          () => onHistoryPrevRef.current(),
          'terminalAtFirstLine && !suggestWidgetVisible',
        );
        editor.addCommand(
          monaco.KeyCode.DownArrow,
          () => onHistoryNextRef.current(),
          'terminalAtLastLine && !suggestWidgetVisible',
        );

        disposables.push(
          model.onDidChangeContent(() => {
            const value = model.getValue();
            const prevLen = prevLenRef.current;
            prevLenRef.current = value.length;
            // Fresh draft starting with `@` → hand back to the chat composer.
            // The sigil is a mode switch here, not chat draft content.
            if (onChatEscapeRef.current && prevLen <= 1 && value.startsWith('@')) {
              onChatEscapeRef.current();
              return;
            }
            onChangeRef.current?.(value);
          }),
        );

        // Placeholder hint as a self-aligning content widget (monaco 0.50 has
        // no native `placeholder` option), shown only while the buffer is empty.
        const placeholderText = placeholderRef.current;
        if (placeholderText) {
          const node = document.createElement('div');
          node.className = 'terminal-editor-placeholder';
          node.textContent = placeholderText;
          const widget: import('monaco-editor').editor.IContentWidget = {
            getId: () => 'gezel.terminal.placeholder',
            getDomNode: () => node,
            getPosition: () => ({
              position: { lineNumber: 1, column: 1 },
              preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
            }),
          };
          let shown = false;
          const syncPlaceholder = () => {
            const empty = model.getValue() === '';
            if (empty && !shown) {
              editor.addContentWidget(widget);
              shown = true;
            } else if (!empty && shown) {
              editor.removeContentWidget(widget);
              shown = false;
            }
          };
          syncPlaceholder();
          disposables.push(model.onDidChangeContent(syncPlaceholder));
          disposables.push({
            dispose: () => {
              if (shown) editor.removeContentWidget(widget);
            },
          });
        }

        editor.focus();
        // Monaco's initial focus resets its insertion point to column 1.
        // Move it afterwards so a command staged from the Commands rail is
        // ready to extend or run, matching the imperative setValue path.
        moveCaretToEnd(editor, model);
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
    }, [projectId]);

    useEffect(() => {
      monacoRef.current?.editor.setTheme(
        theme === 'dark' ? 'gezel-terminal-dark' : 'gezel-terminal-light',
      );
    }, [theme]);

    useImperativeHandle(
      ref,
      (): TerminalCodeEditorHandle => ({
        getValue: () => modelRef.current?.getValue() ?? '',
        setValue: (text) => {
          const model = modelRef.current;
          const editor = editorRef.current;
          if (!model) return;
          model.setValue(text);
          // Keep the escape gate in sync so a programmatic set never trips it.
          prevLenRef.current = text.length;
          if (editor) moveCaretToEnd(editor, model);
        },
        focus: () => editorRef.current?.focus(),
      }),
      [],
    );

    return (
      <div
        ref={containerRef}
        className={className ?? 'terminal-editor-host'}
        data-testid="terminal-editor"
      />
    );
  },
);

export default TerminalCodeEditor;
