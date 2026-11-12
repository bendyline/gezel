import type { PaneFrameKind } from '../navigation/destinations.js';
import { ProjectPanePlaceholder } from './ProjectPanePlaceholder.js';

/**
 * What the main pane shows while a destination's code loads for the first
 * time: its frame, without words or motion, so the pane keeps its place and
 * the view fills it in one step (see "Loading states" in docs/ux.md).
 *
 * A frame never claims anything about the data. An empty state ("No tasks
 * yet") is shown only once the read behind it has answered.
 *
 * A project's frame is its own placeholder, which draws the tab row the
 * hydrated pane settles into; the others hold the pane's size.
 */
export function PaneFrame({ kind }: { kind: PaneFrameKind }) {
  if (kind === 'project') {
    return (
      <div className="two-col project-view detail-only pane-frame-project" aria-busy="true">
        <section>
          <ProjectPanePlaceholder />
        </section>
      </div>
    );
  }
  return (
    <div className={`pane-frame pane-frame-${kind}`} aria-busy="true">
      <span className="sr-only">Loading…</span>
    </div>
  );
}
