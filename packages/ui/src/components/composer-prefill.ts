/**
 * Lightweight handoff between screens that prepare a chat draft and the
 * ChatComposer that eventually consumes it. Keep this module editor-free:
 * Home, Projects, and Knowledge all queue drafts before chat is mounted, and
 * importing the composer here would pull the full Squisq editor into those
 * navigation chunks.
 */

import type { PromptDraftTaskLaunch } from '@bendyline/gezel';

const pendingPrefills = new Map<string, string>();
/** A queued launch, or null: detach whatever task the draft has attached. */
const pendingLaunches = new Map<string, PromptDraftTaskLaunch | null>();
const replacing = new Set<string>();

/**
 * Fired right after a prefill is queued so a composer that is already mounted
 * for the matching project drains it immediately. The map covers the
 * navigate-then-mount case where no listener exists yet.
 */
export const COMPOSER_PREFILL_EVENT = 'gezel:composer-prefill';

/**
 * Queue a sentence for the composer, and optionally the task it launches: a
 * welcome first project that runs a craftbook arrives with the book attached,
 * so Send starts it with no meester turn. `replace` makes the sentence the
 * whole draft and its launch (or none) the only attached task, so picking a
 * second first project never sends the first one's book with both sentences.
 */
export function queueComposerPrefill(
  projectId: string,
  markdown: string,
  launch?: PromptDraftTaskLaunch,
  options: { replace?: boolean } = {},
): void {
  pendingPrefills.set(projectId, markdown);
  if (launch) pendingLaunches.set(projectId, launch);
  else if (options.replace) pendingLaunches.set(projectId, null);
  else pendingLaunches.delete(projectId);
  if (options.replace) replacing.add(projectId);
  else replacing.delete(projectId);
  window.dispatchEvent(
    new CustomEvent(COMPOSER_PREFILL_EVENT, {
      detail: { projectId },
    }),
  );
}

/** The queued launch; null means detach the attached one; undefined means leave it. */
export function takeComposerTaskLaunch(
  projectId: string,
): PromptDraftTaskLaunch | null | undefined {
  const queued = pendingLaunches.get(projectId);
  pendingLaunches.delete(projectId);
  return queued;
}

export function takeComposerPrefill(
  projectId: string,
): { markdown: string; replace: boolean } | undefined {
  const queued = pendingPrefills.get(projectId);
  pendingPrefills.delete(projectId);
  const replace = replacing.delete(projectId);
  return queued === undefined ? undefined : { markdown: queued, replace };
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
