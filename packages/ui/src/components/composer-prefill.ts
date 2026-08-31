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
