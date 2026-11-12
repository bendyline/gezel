import { PROJECT_ICON_BRIEF_MAX_CHARS, type ProjectDetail } from '@bendyline/gezel';
import { apiErrorMessage } from '@bendyline/gezel-client';
import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
import { ProjectDrawnMarkFromSvg } from './project-icon-art.js';

/**
 * Have a model draw a mark for a project. The description starts filled in
 * from the project's type and is the person's to change. Generate draws one;
 * pressing it again draws another, and every drawing made here stays in a
 * row to choose between. Nothing is saved until "Set this as the icon":
 * closing the dialog leaves the project's icon as it was.
 */
export function ProjectIconDrawDialog({
  open,
  project,
  defaultDescription,
  onClose,
  onSaved,
}: {
  open: boolean;
  project: Pick<ProjectDetail, 'id' | 'name'>;
  defaultDescription: string;
  onClose: () => void;
  onSaved: (project: ProjectDetail) => void;
}) {
  const [description, setDescription] = useState(defaultDescription);
  const [drawings, setDrawings] = useState<string[]>([]);
  const [chosen, setChosen] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const descriptionId = useId();

  // A fresh start each time it opens, and for another project.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open and project, not as the default text is recomputed.
  useEffect(() => {
    if (!open) return;
    setDescription(defaultDescription);
    setDrawings([]);
    setChosen(0);
    setError(null);
  }, [open, project.id]);

  // A drawing still on its way is dropped when the dialog goes.
  useEffect(() => {
    if (open) return;
    request.current?.abort();
    request.current = null;
    setDrawing(false);
  }, [open]);
  useEffect(() => () => request.current?.abort(), []);

  const brief = description.trim();
  const current = drawings[chosen];

  const generate = async () => {
    if (!brief || drawing) return;
    const controller = new AbortController();
    request.current = controller;
    setDrawing(true);
    setError(null);
    try {
      const { svg } = await api.drawProjectIcon(
        project.id,
        { description: brief },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      // One drawing at a time, so the list has not moved since the press.
      setDrawings([...drawings, svg]);
      setChosen(drawings.length);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(apiErrorMessage(err));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setDrawing(false);
      }
    }
  };

  const save = async () => {
    if (!current || saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.setProjectIconSvg(project.id, { svg: current }));
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="project-icon-draw-dialog">
          <Dialog.Title asChild>
            <h3>Draw an icon</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            A model draws a small one-color mark for “{project.name}”. Generate as many as you like
            and keep the one you want.
          </Dialog.Description>

          <label className="project-icon-draw-label" htmlFor={descriptionId}>
            What should it show?
          </label>
          <textarea
            id={descriptionId}
            className="project-icon-draw-brief"
            rows={3}
            maxLength={PROJECT_ICON_BRIEF_MAX_CHARS}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />

          <div className="project-icon-draw-stage">
            <div className="project-icon-draw-preview" data-testid="project-icon-draw-preview">
              {current ? (
                <ProjectDrawnMarkFromSvg svg={current} size={72} />
              ) : (
                <span className="muted small">{drawing ? 'Drawing…' : 'Nothing drawn yet.'}</span>
              )}
            </div>
            <div className="project-icon-draw-side">
              <button
                type="button"
                className="secondary"
                disabled={!brief || drawing || saving}
                onClick={() => void generate()}
              >
                {drawing ? 'Drawing…' : drawings.length > 0 ? 'Generate another' : 'Generate'}
              </button>
              <p className="muted small">
                {drawing ? 'This can take a minute.' : 'Each press draws a new one.'}
              </p>
              {current && (
                <p className="project-icon-draw-in-list">
                  <ProjectDrawnMarkFromSvg svg={current} size={18} />
                  <span>{project.name}</span>
                </p>
              )}
            </div>
          </div>

          {drawings.length > 1 && (
            <div
              className="gz-tray project-icon-draw-attempts"
              role="radiogroup"
              aria-label="Drawings so far"
              onKeyDown={onRadioKeyDown}
            >
              {drawings.map((svg, index) => (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: drawings are only ever appended.
                  key={index}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                  role="radio"
                  aria-checked={index === chosen}
                  tabIndex={index === chosen ? 0 : -1}
                  className={`gz-key gz-key--icon${index === chosen ? ' gz-key-active' : ''}`}
                  title={`Drawing ${index + 1}`}
                  aria-label={`Drawing ${index + 1}`}
                  onClick={() => setChosen(index)}
                >
                  <ProjectDrawnMarkFromSvg svg={svg} size={22} />
                </button>
              ))}
            </div>
          )}

          {error && (
            <p className="error small" role="alert">
              {error}
            </p>
          )}

          <Dialog.Actions>
            <button type="button" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!current || saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Set this as the icon'}
            </button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
