import type { RewriteTextContext } from '@bendyline/gezel';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { type FormEvent, useCallback, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';

interface AiToolbarButtonsProps {
  context: RewriteTextContext;
  /** Short subject hint (e.g. task title, gezel name). Used by the
   *  rewriter when the body is empty so it can synthesize a draft. */
  subject?: string;
  /** Longer parent-context blob (e.g. project description). Same
   *  purpose as `subject` — improves both rewrites and from-scratch
   *  drafts when relevant. */
  parentContext?: string;
}

/**
 * Two AI-powered buttons that get injected into the Squisq editor toolbar.
 * ✨ — rewrite the selected text (or whole document if none) using the
 *      context guidance alone.
 * 🪄 — same but asks the user for a custom instruction first.
 *
 * Must be rendered inside an <EditorShell/> so it can pull the live editor
 * context and operate on selections.
 */
export function AiToolbarButtons({ context, subject, parentContext }: AiToolbarButtonsProps) {
  const { tiptapEditor, monacoEditor, activeView, markdownSource, replaceAll } = useEditorContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const getSelection = useCallback((): { text: string; isSelection: boolean } => {
    if (activeView === 'wysiwyg' && tiptapEditor) {
      const { from, to } = tiptapEditor.state.selection;
      if (from !== to) {
        const text = tiptapEditor.state.doc.textBetween(from, to, '\n');
        if (text.trim()) return { text, isSelection: true };
      }
    } else if (activeView === 'raw' && monacoEditor) {
      const sel = monacoEditor.getSelection();
      const model = monacoEditor.getModel();
      if (sel && !sel.isEmpty() && model) {
        const text = model.getValueInRange(sel);
        if (text.trim()) return { text, isSelection: true };
      }
    }
    return { text: markdownSource, isSelection: false };
  }, [activeView, tiptapEditor, monacoEditor, markdownSource]);

  const applyReplacement = useCallback(
    (newText: string, wasSelection: boolean) => {
      if (!wasSelection) {
        replaceAll(newText);
        return;
      }
      if (activeView === 'wysiwyg' && tiptapEditor) {
        tiptapEditor.chain().focus().insertContent(newText).run();
      } else if (activeView === 'raw' && monacoEditor) {
        const sel = monacoEditor.getSelection();
        if (sel) {
          monacoEditor.executeEdits('ai-rewrite', [{ range: sel, text: newText }]);
          monacoEditor.focus();
        }
      }
    },
    [activeView, tiptapEditor, monacoEditor, replaceAll],
  );

  const doRewrite = useCallback(
    async (instruction?: string) => {
      const { text, isSelection } = getSelection();
      // Allow an empty body when the context + hints are enough to
      // synthesize a first draft (currently: task-description with a
      // subject, or any context with a user instruction).
      const canSynthesize =
        (context === 'task-description' && Boolean(subject?.trim())) ||
        Boolean(instruction?.trim());
      if (!text.trim() && !canSynthesize) {
        setError('Nothing to rewrite.');
        return;
      }
      setError(null);
      setBusy(true);
      try {
        const res = await api.rewriteText({
          text,
          context,
          ...(instruction ? { instruction } : {}),
          ...(subject ? { subject } : {}),
          ...(parentContext ? { parentContext } : {}),
          isSelection,
        });
        if (res.text.trim()) {
          applyReplacement(res.text, isSelection);
        } else {
          setError('Rewrite returned empty content.');
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [getSelection, applyReplacement, context, subject, parentContext],
  );

  return (
    <>
      <button
        type="button"
        className="ai-btn"
        onClick={() => void doRewrite()}
        disabled={busy}
        title="AI: improve this text (selection or whole document)"
        aria-label="Improve with AI"
      >
        {busy ? '…' : '✨'}
      </button>
      <button
        type="button"
        className="ai-btn"
        onClick={() => setShowPrompt(true)}
        disabled={busy}
        title="AI: improve with a custom instruction"
        aria-label="Improve with AI using instruction"
      >
        🪄
      </button>
      {error && (
        <span className="ai-error" title={error}>
          !
        </span>
      )}
      <RewritePromptDialog
        open={showPrompt}
        onSubmit={(instruction) => {
          setShowPrompt(false);
          void doRewrite(instruction);
        }}
        onCancel={() => setShowPrompt(false)}
      />
    </>
  );
}

function RewritePromptDialog({
  open,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  onSubmit: (instruction: string) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!instruction.trim()) return;
    onSubmit(instruction.trim());
    setInstruction('');
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel();
          setInstruction('');
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content>
          <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
            <Dialog.Title asChild>
              <h3>Rewrite with AI</h3>
            </Dialog.Title>
            <label>
              How should the text change?
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. make it more concise, convert to bullet points, add concrete examples"
                rows={3}
              />
            </label>
            <Dialog.Description className="muted small">
              Tip: if you select text first, only the selection will be rewritten.
            </Dialog.Description>
            <Dialog.Actions>
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!instruction.trim()}>
                Rewrite
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
