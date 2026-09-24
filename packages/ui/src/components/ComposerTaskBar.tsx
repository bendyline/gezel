import type { PromptDraftTaskLaunch } from '@bendyline/gezel';
import { ProjectGlyph } from '../views/projects/new-project-meta.js';
import { craftbookGlyph } from '../views/tasks/new-task-meta.js';
import { CatalogArtwork } from './CatalogArtwork.js';
import { type LaunchReadiness, formatTaskLaunchPreview } from './composer-task-launch.js';
import type { CraftbookCatalogArt } from './craftbook-catalog-art.js';

/** A quiet routing spark — the daemon proposed this task from the text. */
export function TurnIntentGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 1.75c.3 2.55 1.7 3.95 4.25 4.25C8.7 6.3 7.3 7.7 7 10.25 6.7 7.7 5.3 6.3 2.75 6 5.3 5.7 6.7 4.3 7 1.75Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10.75" cy="10.75" r="0.75" fill="currentColor" />
    </svg>
  );
}

/**
 * The strip above the To line that shows the task Send will start: the
 * craftbook's artwork and name, a one-line readout of its parameters, and
 * one dismiss key. Clicking the strip reopens the New Task dialog on that
 * craftbook's configuration. A daemon suggestion uses the same strip,
 * drawn dashed so it reads as tentative.
 */
export function ComposerTaskBar({
  launch,
  art,
  readiness,
  stale,
  onOpen,
  onDismiss,
}: {
  launch: PromptDraftTaskLaunch;
  art: CraftbookCatalogArt | null;
  readiness: LaunchReadiness;
  stale: string[];
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const manifest = art?.manifest ?? null;
  const name = manifest?.name ?? launch.craftbookName ?? launch.craftbookId;
  const preview = formatTaskLaunchPreview(launch, manifest);
  const suggested = launch.origin === 'suggested';
  const note = stale.length > 0 ? 'files need re-picking' : readiness.ready ? null : 'needs setup';
  const summary = [name, preview.full].filter(Boolean).join(' — ');
  return (
    <fieldset
      className="chat-composer-task-bar"
      data-origin={launch.origin}
      aria-label={`Attached task: ${name}`}
    >
      <button
        type="button"
        className="chat-composer-task-bar-main"
        onClick={onOpen}
        title={`${summary}. Change the task's settings`}
        aria-label={`${suggested ? 'Suggested task' : 'Task'} ${name}.${
          preview.short ? ` ${preview.short}.` : ''
        } Change settings`}
      >
        <span className="chat-composer-task-bar-art" aria-hidden="true">
          {manifest ? (
            <CatalogArtwork
              {...(art?.item.iconSvg ? { iconSvg: art.item.iconSvg } : {})}
              {...(art?.item.logoUrl ? { logoUrl: art.item.logoUrl } : {})}
              svgClassName="chat-composer-task-bar-art-svg"
              fallback={<ProjectGlyph glyph={craftbookGlyph(manifest)} size={16} />}
            />
          ) : (
            <ProjectGlyph glyph="sheet" size={16} />
          )}
        </span>
        <span className="chat-composer-task-bar-text">
          <span className="chat-composer-task-bar-eyebrow">
            {suggested ? (
              <>
                <TurnIntentGlyph /> Suggested task
              </>
            ) : (
              'Task'
            )}
          </span>
          <span className="chat-composer-task-bar-name">{name}</span>
          {preview.short && (
            <span className="chat-composer-task-bar-params" title={preview.full}>
              {preview.short}
            </span>
          )}
        </span>
        {note && <span className="chat-composer-task-bar-note">{note}</span>}
      </button>
      <button
        type="button"
        className="chat-composer-task-bar-dismiss"
        onClick={onDismiss}
        aria-label="Remove the attached task"
        title="Remove the task"
      >
        ×
      </button>
    </fieldset>
  );
}
