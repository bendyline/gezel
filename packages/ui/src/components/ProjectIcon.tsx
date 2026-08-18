import { type Project, resolveProjectIcon } from '@bendyline/gezel';
import { ProjectGlyph } from '../views/projects/new-project-meta.js';

/**
 * The persisted/default icon for a project instance. This deliberately renders
 * the shared monochrome maker's mark, not a catalog logo: it stays recognizable
 * in the smallest rails and can later sit underneath generated instance art.
 */
export function ProjectIcon({
  project,
  size = 18,
  className,
}: {
  project: Pick<
    Project,
    'icon' | 'projectType' | 'projectTypeId' | 'detectedProjectType' | 'github' | 'workingDir'
  >;
  size?: number;
  className?: string;
}) {
  const icon = resolveProjectIcon(project);
  return (
    <span
      className={`project-icon${className ? ` ${className}` : ''}`}
      data-project-icon={icon}
      aria-hidden="true"
    >
      <ProjectGlyph glyph={icon} size={size} />
    </span>
  );
}
