/**
 * Deep-link handoff for jumping to a specific Settings section from a view
 * that is mounted BEFORE SettingsView (e.g. the first-run Home view's
 * "manage on-device models" link).
 *
 * A plain `gezel:navigate` event races here: when the event fires from Home,
 * SettingsView isn't mounted yet, so its own listener isn't registered and
 * the section detail is lost. Instead the requester stashes the target
 * section here, then navigates to the Settings area; SettingsView reads it
 * as its initial section on mount. Kept as a tiny standalone module so
 * neither view has to import the other (no circular dependency).
 *
 * **Peek from the render initializer, clear from an effect.** SettingsView is
 * `lazy()`, so React may render it, discard that render, and render again. A
 * destructive read in the initializer consumed the section during the
 * discarded pass, and the committed render opened on General — the chat's
 * "Choose a model" button landed there instead of on the models page. See
 * [nav-intents.ts](./components/nav-intents.ts) for the same trap.
 */

/** A request older than this was abandoned and must not steer a later visit. */
const PENDING_TTL_MS = 10_000;

let pending: { section: string; at: number } | null = null;

/** Ask SettingsView to open on `section` the next time it mounts. */
export function requestSettingsSection(section: string): void {
  pending = { section, at: Date.now() };
}

/** Read the pending section without consuming it. */
export function peekPendingSettingsSection(): string | null {
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_TTL_MS) {
    pending = null;
    return null;
  }
  return pending.section;
}

/** Drop the pending section once a mounted view has committed to it. */
export function clearPendingSettingsSection(): void {
  pending = null;
}

/** Consume the pending section (one-shot), or null when none was requested. */
export function takePendingSettingsSection(): string | null {
  const section = peekPendingSettingsSection();
  pending = null;
  return section;
}
