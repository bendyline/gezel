import type { SerializedAutosave } from '../hooks/useSerializedAutosave.js';

export interface AutosaveStatusProps {
  autosave: Pick<SerializedAutosave<unknown>, 'phase' | 'error' | 'retry'>;
  /**
   * Show nothing until a save actually fails. For a surface where saving is
   * the assumption — the chat composer, where a draft is a debounce and a
   * local write away — the running commentary is noise beside the message
   * being written. The failure still has to speak, because that is the only
   * state where the user's words are somewhere they can be lost.
   */
  failuresOnly?: boolean;
}

/**
 * Save state for a Squisq-backed editor. Belongs in the shell's bottom
 * status bar (`statusBarSlotRight`), not its toolbar — it is ambient state
 * about the whole surface, so it takes the bar's quiet type rather than a
 * chip of its own. The chat composer is the one exception: it runs with no
 * status bar at all (`showStatusBar={false}`), so its prompt-draft state
 * sits at the quiet end of the toolbar row instead.
 *
 * A document being typed into is the normal case, so `dirty` is a bare dot
 * with no words. Only the transient saving/saved pair and the actionable
 * failure carry text — and `failuresOnly` drops everything but the failure,
 * for surfaces where "it is saved" needs no announcing.
 */
export function AutosaveStatus({ autosave, failuresOnly }: AutosaveStatusProps) {
  const { phase } = autosave;
  if (failuresOnly && phase !== 'error') return null;
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
