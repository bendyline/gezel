/**
 * Lightweight handoff between screens that prepare a chat draft and the
 * ChatComposer that eventually consumes it. Keep this module editor-free:
 * Home, Projects, and Knowledge all queue drafts before chat is mounted, and
 * importing the composer here would pull the full Squisq editor into those
 * navigation chunks.
 */

const pendingPrefills = new Map<string, string>();

/**
 * Fired right after a prefill is queued so a composer that is already mounted
 * for the matching project drains it immediately. The map covers the
 * navigate-then-mount case where no listener exists yet.
 */
export const COMPOSER_PREFILL_EVENT = 'gezel:composer-prefill';

export function queueComposerPrefill(projectId: string, markdown: string): void {
  pendingPrefills.set(projectId, markdown);
  window.dispatchEvent(
    new CustomEvent(COMPOSER_PREFILL_EVENT, {
      detail: { projectId },
    }),
  );
}

export function takeComposerPrefill(projectId: string): string | undefined {
  const queued = pendingPrefills.get(projectId);
  pendingPrefills.delete(projectId);
  return queued;
}

/**
 * The draft after a prefill lands: below what is already written, or the
 * whole draft when it is empty. Null when the draft already holds that exact
 * block. A second tap on one of the meester's openers sent the same sentence
 * twice in one message (Galaxy S26+, 2026-10-02).
 */
export function mergeComposerPrefill(existing: string, queued: string): string | null {
  const draft = existing.trim();
  const block = queued.trim();
  if (!draft) return queued;
  if (`\n\n${draft}\n\n`.includes(`\n\n${block}\n\n`)) return null;
  return `${draft}\n\n${queued}`;
}
