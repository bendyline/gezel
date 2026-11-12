import {
  type Project,
  type ProjectIconId,
  ProjectIconIdSchema,
  resolveProjectIcon,
} from '@bendyline/gezel';
import { useRef } from 'react';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
import { ProjectGlyph } from '../views/projects/new-project-meta.js';
import { ProjectIcon } from './ProjectIcon.js';
import { PROJECT_ICON_UPLOAD_TYPES } from './project-icon-art.js';

/** What each maker's mark is called, for its tooltip and for a screen reader. */
export const PROJECT_ICON_LABELS: Readonly<Record<ProjectIconId, string>> = {
  sheet: 'Sheet of paper',
  folder: 'Folder',
  code: 'Code',
  branch: 'Branch',
  envelope: 'Envelope',
  calendar: 'Calendar',
  bubbles: 'Speech bubbles',
  chart: 'Chart',
  frame: 'Picture frame',
  quill: 'Quill',
  sprout: 'Sprout',
  die: 'Die',
  house: 'House',
  coin: 'Coin',
  banner: 'Banner',
  terminal: 'Terminal',
  globe: 'Globe',
  server: 'Server',
  package: 'Package',
  book: 'Book',
  palette: 'Palette',
  camera: 'Camera',
  briefcase: 'Briefcase',
  heart: 'Heart',
  cards: 'Cards',
  meal: 'Meal',
  plane: 'Plane',
  people: 'People',
  dots: 'Dots',
};

type ProjectIconFields = Pick<
  Project,
  'icon' | 'projectType' | 'projectTypeId' | 'detectedProjectType' | 'github' | 'workingDir'
> &
  Partial<Pick<Project, 'id' | 'customIcon'>>;

/**
 * Choose the mark that stands beside a project's name. Two projects of one
 * type start with the same mark (two code folders are both braces), and this
 * is where a person tells them apart. Automatic is the mark the project's type
 * gives it: it clears the choice, so the mark follows the type again.
 *
 * A project may instead wear art of its own: a mark a model draws for it, or
 * a picture the person uploads. A host that keeps such art passes `onDraw`
 * and `onUpload`; the art then shows as one more key, latched, and choosing
 * any mark puts it away.
 */
export function ProjectIconPicker({
  project,
  disabled,
  onChange,
  onDraw,
  onUpload,
}: {
  project: ProjectIconFields;
  disabled?: boolean;
  /** `null` goes back to the type's own mark. */
  onChange: (icon: ProjectIconId | null) => void;
  /** Open the drawing dialog. */
  onDraw?: () => void;
  /** A picture the person picked from their computer. */
  onUpload?: (file: File) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { icon: chosen, customIcon: own, ...typeFields } = project;
  const inherited = resolveProjectIcon(typeFields);
  const automatic = !own && !chosen;
  return (
    <div className="project-icon-picker">
      <div
        className="gz-tray project-icon-tray"
        role="radiogroup"
        aria-label="Project icon"
        onKeyDown={onRadioKeyDown}
      >
        <button
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
          role="radio"
          aria-checked={automatic}
          tabIndex={automatic ? 0 : -1}
          disabled={disabled}
          className={`gz-key project-icon-key-auto${automatic ? ' gz-key-active' : ''}`}
          title={`Use the mark this project's type gives it (${PROJECT_ICON_LABELS[inherited]})`}
          onClick={() => {
            if (!automatic) onChange(null);
          }}
        >
          <ProjectGlyph glyph={inherited} size={18} />
          Automatic
        </button>
        {own && (
          <button
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked
            tabIndex={0}
            disabled={disabled}
            className="gz-key project-icon-key-own gz-key-active"
            title={
              own.kind === 'drawn'
                ? 'The mark drawn for this project'
                : 'The picture you gave this project'
            }
          >
            <ProjectIcon project={project} size={18} />
            Its own
          </button>
        )}
        {ProjectIconIdSchema.options.map((id) => {
          const selected = !own && chosen === id;
          return (
            <button
              key={id}
              type="button"
              // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              className={`gz-key gz-key--icon${selected ? ' gz-key-active' : ''}`}
              title={PROJECT_ICON_LABELS[id]}
              aria-label={PROJECT_ICON_LABELS[id]}
              data-project-icon-choice={id}
              onClick={() => {
                if (!selected) onChange(id);
              }}
            >
              <ProjectGlyph glyph={id} size={18} />
            </button>
          );
        })}
      </div>
      {(onDraw || onUpload) && (
        <div className="project-icon-own-actions">
          {onDraw && (
            <button type="button" className="secondary" disabled={disabled} onClick={onDraw}>
              Draw one…
            </button>
          )}
          {onUpload && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={disabled}
                onClick={() => fileInput.current?.click()}
              >
                Upload a picture…
              </button>
              <input
                ref={fileInput}
                type="file"
                hidden
                accept={PROJECT_ICON_UPLOAD_TYPES.join(',')}
                aria-label="Icon picture"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Cleared so picking the same file again is still a change.
                  event.target.value = '';
                  if (file) onUpload(file);
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
