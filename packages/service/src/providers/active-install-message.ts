/**
 * The sentence a chat turn shows when no local model is installed yet.
 *
 * A first run pins a recommended model and the user starts a multi-gigabyte
 * download — then, quite reasonably, tries to chat while they wait. The turn
 * fails, because there is genuinely nothing to answer with. What it used to
 * say was "Download a model from the list above", which is written for the
 * Settings model list and is wrong twice over in a chat: there is no list
 * above, and the download they are being told to start is already running.
 *
 * Given the live install snapshot, say the true thing instead.
 */
export interface ActiveInstallLike {
  catalogId: string;
  bytesWritten: number;
  totalBytes: number;
  phase: 'downloading' | 'verifying' | 'extracting-metadata';
}

/** Whole-percent progress, or null when the total size isn't known yet. */
export function installPercent(install: ActiveInstallLike): number | null {
  if (!Number.isFinite(install.totalBytes) || install.totalBytes <= 0) return null;
  const pct = (install.bytesWritten / install.totalBytes) * 100;
  if (!Number.isFinite(pct)) return null;
  // Never round up to 100 while bytes are still arriving — "100% downloaded"
  // next to a turn that just failed reads as a contradiction.
  return Math.max(0, Math.min(99, Math.floor(pct)));
}

/**
 * Compose the user-facing message for a chat turn that found no model.
 *
 * `active` is whichever install is in flight for this engine, or null. The
 * caller supplies `engineLabel` ("Local model", "Apple MLX") so the message
 * keeps the prefix the rest of that provider's errors use.
 */
export function noModelYetMessage(engineLabel: string, active: ActiveInstallLike | null): string {
  if (!active) {
    return (
      `${engineLabel}: no model is installed yet. ` +
      'Download one from Settings → Artificial Intelligence, then try again.'
    );
  }
  if (active.phase !== 'downloading') {
    const verb = active.phase === 'verifying' ? 'being verified' : 'being prepared';
    return (
      `${engineLabel}: your model is ${verb} — hang tight, ` +
      'this message will work as soon as it finishes.'
    );
  }
  const pct = installPercent(active);
  const progress = pct === null ? 'still downloading' : `${pct}% downloaded`;
  return (
    `${engineLabel}: your model is ${progress} — hang tight. ` +
    'Send this again once it finishes and it will go through.'
  );
}
