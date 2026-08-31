/**
 * The structural stand-in shown while a project's chat pane is still
 * resolving its roster and default recipient.
 *
 * `ProjectChat` is keyed by project id in `ProjectsView`, so switching
 * projects remounts it with an empty gezel list — and the roster fetch is a
 * round-trip away. Rendering the genuine "no gezellen" empty state during
 * that window flashed a false claim on every switch: the project has a crew,
 * we just hadn't asked yet. This renders the *shape* the hydrated pane
 * settles into instead — a timeline area above the composer frame — so the
 * transition reads as the same surface filling in rather than a different
 * screen appearing and leaving.
 *
 * Deliberately wordless and motionless: it borrows the composer shell's own
 * classes (and therefore its metrics and palette) so nothing shifts when the
 * real composer replaces it.
 */
export function ProjectChatPlaceholder() {
  return (
    <div className="project-chat project-chat-placeholder" aria-busy="true">
      <span className="sr-only">Loading this project's chat…</span>
      <div className="project-chat-placeholder-timeline" aria-hidden="true" />
      <div className="project-chat-compose-shell" aria-hidden="true">
        <div className="project-chat-compose-main">
          <div className="project-chat-placeholder-band" />
          <div className="project-chat-placeholder-entry" />
        </div>
      </div>
    </div>
  );
}
