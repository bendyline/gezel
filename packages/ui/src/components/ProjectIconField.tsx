import {
  PROJECT_ICON_IMAGE_MAX_BYTES,
  type ProjectDetail,
  type ProjectIconId,
  resolveProjectIcon,
} from '@bendyline/gezel';
import { apiErrorMessage } from '@bendyline/gezel-client';
import { useState } from 'react';
import { api } from '../api.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { ProjectIconDrawDialog } from './ProjectIconDrawDialog.js';
import { ProjectIconPicker } from './ProjectIconPicker.js';
import {
  PROJECT_ICON_UPLOAD_TYPES,
  prepareProjectIconImage,
  projectIconBrief,
} from './project-icon-art.js';

/**
 * A project's Icon setting: the mark picker, plus "Draw one" and "Upload a
 * picture" where the host keeps a project's own art. Every change is saved
 * at once and handed to `onChanged`, which is also how the rail hears of it.
 */
export function ProjectIconField({
  project,
  typeLabel,
  onChanged,
}: {
  project: ProjectDetail;
  /** What kind of project this is, in a person's words, when known. */
  typeLabel?: string | undefined;
  onChanged: (project: ProjectDetail) => void;
}) {
  const [drawOpen, setDrawOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keepsArt = runtimeCapabilities().projectIconArt === true;

  const run = async (change: () => Promise<ProjectDetail>) => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await change());
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = (icon: ProjectIconId | null) =>
    // Saving a mark also puts the project's own art away, on the host.
    run(() => api.updateProject(project.id, { icon }));

  const upload = (file: File) =>
    run(async () => {
      if (!(PROJECT_ICON_UPLOAD_TYPES as readonly string[]).includes(file.type)) {
        throw new Error('An icon picture is a PNG, JPEG or WebP file.');
      }
      const image = await prepareProjectIconImage(file);
      if (image.size > PROJECT_ICON_IMAGE_MAX_BYTES) {
        throw new Error('That picture is too large for an icon.');
      }
      return api.uploadProjectIcon(project.id, image);
    });

  const { icon: _chosen, customIcon: _own, ...typeFields } = project;
  return (
    <>
      <ProjectIconPicker
        project={project}
        disabled={busy}
        onChange={(icon) => void choose(icon)}
        {...(keepsArt
          ? { onDraw: () => setDrawOpen(true), onUpload: (file: File) => void upload(file) }
          : {})}
      />
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      {keepsArt && (
        <ProjectIconDrawDialog
          open={drawOpen}
          project={project}
          defaultDescription={projectIconBrief({
            name: project.name,
            typeMark: resolveProjectIcon(typeFields),
            typeLabel,
          })}
          onClose={() => setDrawOpen(false)}
          onSaved={onChanged}
        />
      )}
    </>
  );
}
