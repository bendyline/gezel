import type { PromptDraftTaskLaunch } from '@bendyline/gezel';
import { catalogGroundFor, planDisplayName } from '@bendyline/gezel';
import { useRef } from 'react';
import { ProjectGlyph } from '../views/projects/new-project-meta.js';
import { craftbookGlyph } from '../views/tasks/new-task-meta.js';
import { CatalogArtwork } from './CatalogArtwork.js';
import {
  type LaunchReadiness,
  type PickableInput,
  formatTaskLaunchPreview,
} from './composer-task-launch.js';
import type { CraftbookCatalogArt } from './craftbook-catalog-art.js';
import {
  type PickedSet,
  pickFromDirectoryInput,
  pickFromFileInput,
} from './craftbook-input/pick-files.js';
import type { InputPickState } from './useComposerTaskLaunch.js';

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
 * drawn dashed so it reads as tentative. An input that a sample stands in
 * for, or that nothing fills yet, gets a key that opens the file picker.
 */
export function ComposerTaskBar({
  launch,
  art,
  readiness,
  stale,
  pickable = [],
  picking = null,
  onPickInput,
  onOpen,
  onDismiss,
  onToggleTonight,
}: {
  launch: PromptDraftTaskLaunch;
  art: CraftbookCatalogArt | null;
  readiness: LaunchReadiness;
  stale: string[];
  pickable?: PickableInput[];
  picking?: InputPickState | null;
  onPickInput?: (key: string, pick: PickedSet) => void;
  onOpen: () => void;
  onDismiss: () => void;
  /** Run the task in tonight's Night Shift instead of now. Absent where there is no night shift. */
  onToggleTonight?: () => void;
}) {
  const manifest = art?.manifest ?? null;
  const name = manifest ? planDisplayName(manifest) : (launch.craftbookName ?? launch.craftbookId);
  const preview = formatTaskLaunchPreview(launch, manifest);
  const suggested = launch.origin === 'suggested';
  const uploading = picking !== null && !picking.error;
  const note = uploading
    ? null
    : stale.length > 0
      ? 'files need re-picking'
      : readiness.ready || pickable.some((p) => !p.sample)
        ? null
        : 'needs setup';
  const pickError = picking?.error ? picking.error : null;
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
              ground={catalogGroundFor(manifest)}
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
          {pickError ? (
            <span
              className="chat-composer-task-bar-params chat-composer-task-bar-error"
              role="alert"
            >
              {pickError}
            </span>
          ) : (
            preview.short && (
              <span className="chat-composer-task-bar-params" title={preview.full}>
                {preview.short}
              </span>
            )
          )}
        </span>
        {note && <span className="chat-composer-task-bar-note">{note}</span>}
      </button>
      {onPickInput &&
        pickable.map((p) => (
          <InputPickKey
            key={p.input.key}
            pickable={p}
            picking={picking?.key === p.input.key ? picking : null}
            disabled={uploading && picking?.key !== p.input.key}
            onPick={(pick) => onPickInput(p.input.key, pick)}
          />
        ))}
      {onToggleTonight && (
        <button
          type="button"
          className={`gz-key chat-composer-task-bar-tonight${launch.tonight ? ' gz-key-active' : ''}`}
          aria-pressed={launch.tonight === true}
          onClick={onToggleTonight}
          title={
            launch.tonight
              ? "Runs in tonight's night shift. Click to run it now instead"
              : "Run it in tonight's night shift instead of now"
          }
        >
          Tonight
        </button>
      )}
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

/**
 * The strip's file key for one input: the system file picker (a folder
 * picker for a folder input), filtered to the types the plan reads. The pick
 * uploads into the task's input staging, the same place the New Task
 * dialog's "From your computer" puts it.
 */
function InputPickKey({
  pickable,
  picking,
  disabled,
  onPick,
}: {
  pickable: PickableInput;
  picking: InputPickState | null;
  disabled: boolean;
  onPick: (pick: PickedSet) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { input, sample } = pickable;
  const isFolder = input.spec.kind === 'folder';
  const noun = isFolder ? 'folder' : 'file';
  const uploading = picking !== null && !picking.error;
  const label = uploading
    ? picking.progress && picking.progress.total > 1
      ? `Uploading ${picking.progress.done} of ${picking.progress.total}…`
      : 'Uploading…'
    : sample
      ? `Use your own ${noun}…`
      : `Choose ${noun}…`;
  const title = sample
    ? `${input.title}: pick your own ${noun} instead of the sample`
    : `${input.title}: choose the ${noun} this plan works on`;
  return (
    <>
      <button
        type="button"
        className="gz-key chat-composer-task-bar-pick"
        onClick={() => inputRef.current?.click()}
        disabled={uploading || disabled}
        title={title}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        hidden
        {...(isFolder
          ? // React has no typed prop for these; both engines honor them.
            ({ webkitdirectory: '', directory: '' } as Record<string, string>)
          : input.spec.accept
            ? { accept: input.spec.accept.join(',') }
            : {})}
        onChange={(e) => {
          const files = e.target.files;
          if (files?.length) {
            onPick(isFolder ? pickFromDirectoryInput(files) : pickFromFileInput(files));
          }
          e.target.value = '';
        }}
      />
    </>
  );
}
