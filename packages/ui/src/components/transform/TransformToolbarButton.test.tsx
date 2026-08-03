import {
  type EditorContextValue,
  EditorShell,
  useEditorContext,
} from '@bendyline/squisq-editor-react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transformResult = vi.hoisted(() => ({ markdown: '' }));

vi.mock('./TransformDialog.js', () => ({
  TransformDialog: ({ onApply }: { onApply: (text: string) => void }) => (
    <button type="button" onClick={() => onApply(transformResult.markdown)}>
      Apply generated result
    </button>
  ),
}));

const { TransformToolbarButton } = await import('./TransformToolbarButton.js');

let editorContext: EditorContextValue | null = null;

function ContextProbe() {
  const context = useEditorContext();
  editorContext = context;
  return <output data-testid="markdown-source">{context.markdownSource}</output>;
}

function Harness({ initialMarkdown }: { initialMarkdown: string }) {
  return (
    <EditorShell
      initialMarkdown={initialMarkdown}
      initialView="wysiwyg"
      onChange={() => {}}
      allowRecording={false}
      allowNarrate={false}
      mentionProvider={null}
      showPlayTab={false}
      showStatusBar={false}
      toolbarSlotAfterActions={
        <>
          <ContextProbe />
          <TransformToolbarButton context="generic" />
        </>
      }
    />
  );
}

async function readyEditor() {
  await waitFor(() => expect(editorContext?.tiptapEditor).toBeTruthy(), { timeout: 1500 });
  const editor = editorContext?.tiptapEditor;
  if (!editor) throw new Error('WYSIWYG editor did not mount');
  return editor;
}

async function applyGeneratedResult() {
  fireEvent.click(screen.getByRole('button', { name: 'Transform with AI' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply generated result' }));
}

function undoOnce(editor: NonNullable<EditorContextValue['tiptapEditor']>) {
  const commands = editor.commands as typeof editor.commands & { undo: () => boolean };
  act(() => {
    commands.undo();
  });
}

describe('TransformToolbarButton WYSIWYG application', () => {
  beforeEach(() => {
    editorContext = null;
    transformResult.markdown = '';
  });

  it('parses a multi-block Markdown rewrite and restores it with one Undo', async () => {
    const original = '# Original\n\nKeep **this** paragraph.\n';
    transformResult.markdown =
      '## Replacement\n\nNew **bold** text with [a link](https://example.com).\n\n- One\n- Two';
    render(<Harness initialMarkdown={original} />);
    const editor = await readyEditor();

    act(() => {
      editor.commands.selectAll();
    });
    await applyGeneratedResult();

    await waitFor(() => expect(editor.getHTML()).toMatch(/<h2[^>]*>.*Replacement.*<\/h2>/), {
      timeout: 1500,
    });
    expect(editor.getHTML()).toContain('<strong>bold</strong>');
    expect(editor.getHTML()).toContain('<a target="_blank"');
    expect(editor.getHTML()).toContain('<ul>');
    expect(screen.getByTestId('markdown-source').textContent).toContain('## Replacement');
    expect(screen.getByTestId('markdown-source').textContent).toContain('**bold**');
    expect(screen.getByTestId('markdown-source').textContent).not.toContain('\\*\\*bold\\*\\*');

    undoOnce(editor);
    await waitFor(() => expect(editor.getHTML()).toMatch(/<h1[^>]*>.*Original.*<\/h1>/), {
      timeout: 1500,
    });
    expect(editor.getHTML()).toContain('<strong>this</strong>');
    expect(screen.getByTestId('markdown-source').textContent).toContain('# Original');
  });

  it('parses block Markdown inserted at an empty WYSIWYG selection', async () => {
    transformResult.markdown = '## Added\n\nText with *emphasis*.';
    render(<Harness initialMarkdown="# Original\n" />);
    const editor = await readyEditor();

    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size);
    });
    await applyGeneratedResult();

    await waitFor(() => expect(editor.getHTML()).toMatch(/<h2[^>]*>.*Added.*<\/h2>/), {
      timeout: 1500,
    });
    expect(editor.getHTML()).toContain('<em>emphasis</em>');
    expect(screen.getByTestId('markdown-source').textContent).toContain('## Added');

    undoOnce(editor);
    await waitFor(() => expect(editor.getHTML()).not.toMatch(/<h2[^>]*>.*Added.*<\/h2>/), {
      timeout: 1500,
    });
    expect(editor.getHTML()).toMatch(/<h1[^>]*>.*Original.*<\/h1>/);
  });
});
