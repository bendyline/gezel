import type { RewriteTextContext } from '@bendyline/gezel';
import { type FormEvent, useEffect, useState } from 'react';
import { Dialog } from '../../primitives/index.js';
import { GezelIcon } from '../GezelIcon.js';
import { TransformAfterEditor } from './TransformAfterEditor.js';
import { TransformBeforeView } from './TransformBeforeView.js';
import { TransformDiffPane } from './TransformDiffPane.js';
import { TransformThinkingFeed } from './TransformThinkingFeed.js';
import type { SelectionSnapshot } from './types.js';
import { useKlerkInfo } from './useKlerkInfo.js';
import { useTransformStream } from './useTransformStream.js';

/**
 * The unified AI transformation dialog. Three areas, top to bottom:
 * the instruction textbox (required in insert mode), the "Transform
 * with {Klerk}" row with live metacommentary while the Klerk works,
 * and the transformation view — the captured selection before the run,
 * then an editable Before/After or Monaco-diff result with an explicit
 * Apply/Cancel. Cancel (or Escape / backdrop) commits nothing.
 */

export interface TransformDialogProps {
  snapshot: SelectionSnapshot;
  context: RewriteTextContext;
  subject?: string;
  parentContext?: string;
  onApply: (text: string) => void;
  onClose: () => void;
}

export function TransformDialog({
  snapshot,
  context,
  subject,
  parentContext,
  onApply,
  onClose,
}: TransformDialogProps) {
  const [instruction, setInstruction] = useState('');
  const [afterText, setAfterText] = useState('');
  const [view, setView] = useState<'edit' | 'diff'>('edit');
  const { state, start } = useTransformStream();
  const klerk = useKlerkInfo();

  const insertMode = snapshot.mode === 'insert';
  const running = state.phase === 'queued' || state.phase === 'streaming';
  const hasResult = state.phase === 'done';
  const canTransform = !running && (!insertMode || instruction.trim().length > 0);
  const canApply = hasResult && afterText.trim().length > 0;
  const klerkName = klerk?.name ?? 'AI';

  useEffect(() => {
    if (state.phase === 'done' && state.result !== null) setAfterText(state.result);
  }, [state.phase, state.result]);

  const runTransform = () => {
    if (!canTransform) return;
    const trimmed = instruction.trim();
    start({
      mode: snapshot.mode,
      text: snapshot.text,
      context,
      ...(trimmed ? { instruction: trimmed } : {}),
      ...(subject ? { subject } : {}),
      ...(parentContext ? { parentContext } : {}),
      ...(snapshot.textBefore ? { textBefore: snapshot.textBefore } : {}),
      ...(snapshot.textAfter ? { textAfter: snapshot.textAfter } : {}),
    });
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    runTransform();
  };

  const metacommentary = state.thinking || state.outputPreview;

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="gz-transform-dialog">
          <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
            <Dialog.Title asChild>
              <h3>{insertMode ? 'Add content with AI' : 'Edit with AI'}</h3>
            </Dialog.Title>
            <div className="gz-transform-top">
              <label className="gz-transform-instruction">
                {insertMode ? 'What should be written?' : 'How should the text change? (optional)'}
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={
                    insertMode
                      ? 'e.g. add a short summary of the goals, write an intro paragraph'
                      : 'e.g. make it more concise, convert to bullet points, add concrete examples'
                  }
                  rows={3}
                  // biome-ignore lint/a11y/noAutofocus: the instruction is the dialog's primary input
                  autoFocus
                  disabled={running}
                />
              </label>
              <div className="gz-transform-klerk-row">
                <GezelIcon
                  svg={klerk?.icon}
                  poppetje={klerk?.poppetje}
                  iconOverride={klerk?.iconOverride}
                  name={klerkName}
                  size={40}
                  pulsing={running}
                  title={`Transform with ${klerkName}`}
                  onClick={() => runTransform()}
                />
                <button
                  type="submit"
                  className="primary"
                  disabled={!canTransform}
                  aria-label={`Transform with ${klerkName}`}
                >
                  {running
                    ? 'Transforming…'
                    : hasResult
                      ? `Transform again with ${klerkName}`
                      : `Transform with ${klerkName}`}
                </button>
                {state.phase === 'queued' && <span className="muted small">Waiting in queue…</span>}
              </div>
            </div>
            {running &&
              (metacommentary ? (
                <TransformThinkingFeed markdown={metacommentary} />
              ) : (
                <div className="gz-transform-thinking" aria-live="polite">
                  {`${klerkName} is working…`}
                </div>
              ))}
            {state.phase === 'error' && (
              <p className="gz-transform-error" role="alert">
                {state.error}
              </p>
            )}

            <div className="gz-transform-view">
              {hasResult ? (
                <>
                  <div
                    className="gz-tray gz-transform-view-toggle"
                    role="radiogroup"
                    aria-label="Result view"
                  >
                    <button
                      type="button"
                      // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                      role="radio"
                      aria-checked={view === 'edit'}
                      className={`gz-key${view === 'edit' ? ' gz-key-active' : ''}`}
                      onClick={() => setView('edit')}
                    >
                      {insertMode ? 'New text' : 'Before / After'}
                    </button>
                    <button
                      type="button"
                      // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                      role="radio"
                      aria-checked={view === 'diff'}
                      className={`gz-key${view === 'diff' ? ' gz-key-active' : ''}`}
                      onClick={() => setView('diff')}
                    >
                      Diff
                    </button>
                  </div>
                  {view === 'edit' ? (
                    <div className="gz-transform-panes">
                      {!insertMode && (
                        <div className="gz-transform-before">
                          <span className="gz-transform-pane-label muted small">Before</span>
                          <TransformBeforeView markdown={snapshot.text} />
                        </div>
                      )}
                      <div className="gz-transform-after">
                        <span className="gz-transform-pane-label muted small">
                          {insertMode ? 'New text (editable)' : 'After (editable)'}
                        </span>
                        <TransformAfterEditor
                          value={afterText}
                          onChange={setAfterText}
                          ariaLabel={insertMode ? 'New text' : 'Rewritten text'}
                        />
                      </div>
                    </div>
                  ) : (
                    <TransformDiffPane
                      original={snapshot.text}
                      value={afterText}
                      onChange={setAfterText}
                    />
                  )}
                </>
              ) : insertMode ? (
                <p className="gz-transform-empty muted small">
                  New text will be inserted at the cursor.
                </p>
              ) : (
                <div className="gz-transform-before">
                  <span className="gz-transform-pane-label muted small">Selected text</span>
                  <TransformBeforeView markdown={snapshot.text} />
                </div>
              )}
            </div>

            <Dialog.Actions>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!canApply}
                onClick={() => onApply(afterText)}
              >
                {insertMode ? 'Insert' : 'Apply'}
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
