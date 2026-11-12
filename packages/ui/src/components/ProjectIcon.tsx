import { type Project, resolveProjectIcon } from '@bendyline/gezel';
import { ProjectGlyph } from '../views/projects/new-project-meta.js';
import { ProjectDrawnMark, useProjectIconArt } from './project-icon-art.js';

/**
 * The icon for a project instance: its own art when it has some (a mark a
 * model drew for it, or a picture the person uploaded), else the shared
 * monochrome maker's mark. The mark is never a catalog logo, so it stays
 * recognizable in the smallest rails, and it is what shows while the art
 * loads or when it cannot be read.
 */
export function ProjectIcon({
  project,
  size = 18,
  className,
}: {
  project: Pick<
    Project,
    'icon' | 'projectType' | 'projectTypeId' | 'detectedProjectType' | 'github' | 'workingDir'
  > &
    Partial<Pick<Project, 'id' | 'customIcon'>>;
  size?: number;
  className?: string;
}) {
  const icon = resolveProjectIcon(project);
  const art = useProjectIconArt(project.id, project.customIcon);
  return (
    <span
      className={`project-icon${className ? ` ${className}` : ''}`}
      data-project-icon={art ? art.kind : icon}
      aria-hidden="true"
    >
      {art?.kind === 'drawn' ? (
        <ProjectDrawnMark url={art.url} size={size} />
      ) : art?.kind === 'image' ? (
        <img className="project-icon-image" src={art.url} alt="" width={size} height={size} />
      ) : (
        <ProjectGlyph glyph={icon} size={size} />
      )}
    </span>
  );
}
