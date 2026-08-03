import { EditorProvider, WysiwygEditor, useEditorContext } from '@bendyline/squisq-editor-react';
import { useEffect, useRef } from 'react';
import { useEffectiveTheme } from '../../theme.js';

/**
 * Editable Squisq WYSIWYG pane for the transformation dialog's "after"
 * text. A nested `EditorProvider` hosts its own document — the React
 * context only shadows this subtree, so the host document's editor
 * (where the toolbar button lives) is untouched. `EditorProvider` has
 * no onChange prop, so a bridge child watches `markdownSource` and
 * mirrors edits out to the dialog's `afterText`; external updates (a
 * "Transform again" result landing while this view is up) flow back in
 * through `replaceAll`. The diff view is never mounted at the same
 * time, so the two never race — `lastSynced` guards the loop.
 */

export interface TransformAfterEditorProps {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}

function AfterEditorBridge({
  value,
  onChange,
}: { value: string; onChange: (next: string) => void }) {
  const { markdownSource, replaceAll } = useEditorContext();
  const lastSynced = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (markdownSource !== lastSynced.current) {
      lastSynced.current = markdownSource;
      onChangeRef.current(markdownSource);
    }
  }, [markdownSource]);

  useEffect(() => {
    if (value !== lastSynced.current) {
      lastSynced.current = value;
      replaceAll(value);
    }
  }, [value, replaceAll]);

  return null;
}

export function TransformAfterEditor({ value, onChange, ariaLabel }: TransformAfterEditorProps) {
  const theme = useEffectiveTheme();
  // Mount-time seed only — later external values flow through the bridge.
  const initialValueRef = useRef(value);

  return (
    <section className="gz-transform-after-editor" aria-label={ariaLabel}>
      <EditorProvider
        initialMarkdown={initialValueRef.current}
        articleId="transform-after"
        colorScheme={theme}
        allowRecording={false}
        allowNarrate={false}
        mentionProvider={null}
      >
        <AfterEditorBridge value={value} onChange={onChange} />
        <WysiwygEditor className="gz-transform-after-wysiwyg" />
      </EditorProvider>
    </section>
  );
}
