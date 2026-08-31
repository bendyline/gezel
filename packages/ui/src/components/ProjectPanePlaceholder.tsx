/**
 * The structural stand-in for a whole project pane while its detail is
 * still being fetched.
 *
 * A single-project tab resolves `forceProjectId` by awaiting
 * `api.getProject`, so switching projects leaves the pane with no project
 * for a round-trip. It used to spend that window on a `Loading project…`
 * line — which meant the tab row vanished, a sentence appeared in the empty
 * top-left corner, and both reversed a moment later. Three visible states to
 * say one thing.
 *
 * This keeps the pane's shape instead: the tab strip holds its place (a real
 * `.gz-tabs-trigger`, hidden, so the row's height is computed by the same
 * rule rather than guessed), and the body below stays blank until there is
 * something true to draw in it. The composer frame is deliberately NOT drawn
 * here — that is {@link ProjectChatPlaceholder}'s job, and it can only be
 * positioned correctly once the pane's status bar exists.
 *
 * Renders as a fragment: `.two-col > section` is the flex column both this
 * and the hydrated pane lay out in.
 */
export function ProjectPanePlaceholder() {
  return (
    <>
      <span className="sr-only">Loading this project…</span>
      <div
        className="entity-tabs-row project-tabs-row project-pane-placeholder-tabs"
        aria-hidden="true"
      >
        <span className="gz-tabs-trigger">Chat</span>
      </div>
      <div className="project-pane-placeholder-body" aria-hidden="true" />
    </>
  );
}
