import type { SerializedAutosave } from '../hooks/useSerializedAutosave.js';

export interface AutosaveStatusProps {
  autosave: Pick<SerializedAutosave<unknown>, 'phase' | 'error' | 'retry'>;
}

/**
 * Save state for a Squisq-backed editor. Belongs in the shell's bottom
 * status bar (`statusBarSlotRight`), not its toolbar — it is ambient state
 * about the whole surface, so it takes the bar's quiet type rather than a
 * chip of its own.
 *
 * A document being typed into is the normal case, so `dirty` is a bare dot
 * with no words. Only the transient saving/saved pair and the actionable
 * failure carry text.
 */
export function AutosaveStatus({ autosave }: AutosaveStatusProps) {
  const { phase } = autosave;
  return (
    <output className={`autosave-status autosave-status-${phase}`} aria-live="polite">
      {phase === 'dirty' && (
        <>
          <span className="autosave-status-dot" title="Unsaved changes" aria-hidden="true" />
          <span className="sr-only">Unsaved changes</span>
        </>
      )}
      {phase === 'saving' && 'Saving…'}
      {phase === 'saved' && 'Saved'}
      {phase === 'error' && (
        <>
          <span title={autosave.error?.message ?? 'unknown error'}>Save failed</span>
          <button
            type="button"
            className="link-btn"
            onClick={() => void autosave.retry().catch(() => {})}
          >
            Retry
          </button>
        </>
      )}
    </output>
  );
}
