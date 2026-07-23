/**
 * Deep-link handoff for jumping to a specific Settings section from a view
 * that is mounted BEFORE SettingsView (e.g. the first-run Home view's
 * "manage on-device models" link).
 *
 * A plain `gezel:navigate` event races here: when the event fires from Home,
 * SettingsView isn't mounted yet, so its own listener isn't registered and
 * the section detail is lost. Instead the requester stashes the target
 * section here, then navigates to the Settings area; SettingsView consumes
 * it as its initial section on mount. Kept as a tiny standalone module so
 * neither view has to import the other (no circular dependency).
 */

let pendingSection: string | null = null;

/** Ask SettingsView to open on `section` the next time it mounts. */
export function requestSettingsSection(section: string): void {
  pendingSection = section;
}

/** Consume the pending section (one-shot), or null when none was requested. */
export function takePendingSettingsSection(): string | null {
  const s = pendingSection;
  pendingSection = null;
  return s;
}
