/**
 * UI labels that flip on a project's `mode`. Centralized so a single
 * change ripples through every consumer (project detail header, project
 * settings, ProjectChat roster chips, etc.) instead of every site
 * reaching for its own ternary.
 *
 * The underlying data field stays `voormanGezelId` regardless of mode —
 * only the rendered label changes.
 */

type ProjectShape = { mode?: 'crew' | 'solo' | undefined; leadLabel?: string | undefined };

/**
 * The project lead's label. A project type can override it (`leadLabel`,
 * e.g. checkers → "Opponent"); otherwise "Crew Lead" for crew, "Builder"
 * for solo (jobs).
 */
export function crewLeadLabel(project: ProjectShape | null | undefined): string {
  if (project?.leadLabel) return project.leadLabel;
  return project?.mode === 'solo' ? 'Builder' : 'Crew Lead';
}

/** Lowercase form for inline prose ("the crew lead of…", "no opponent set"). */
export function crewLeadLabelLower(project: ProjectShape | null | undefined): string {
  if (project?.leadLabel) return project.leadLabel.toLowerCase();
  return project?.mode === 'solo' ? 'builder' : 'crew lead';
}

/** "Project" for crew shape, "Job" for solo shape — matches the create-button labels. */
export function projectKindLabel(project: ProjectShape | null | undefined): string {
  return project?.mode === 'solo' ? 'Job' : 'Project';
}
