import { isProjectMainGezel, plainRoleTitle, roleForMatching } from '@bendyline/gezel';

/**
 * Words for a project's main crew member. Every project is assigned one
 * (`voormanGezelId`, whatever the project's shape), and the star marks them.
 * What they are called depends on what they do there:
 *
 * - In a crew project they lead the crew and hand the work out: a crew lead.
 * - In a solo project they do the work themselves, in their own role (a
 *   Builder, a Writer), so there is no lead to name.
 * - A project type can give them its own title (`leadLabel`, e.g. checkers →
 *   "Opponent").
 *
 * Centralized so a single change ripples through every consumer (project
 * settings, the crew roster, chat headers) instead of every site reaching
 * for its own ternary.
 */

type ProjectShape = { mode?: 'crew' | 'solo' | undefined; leadLabel?: string | undefined };

/** The name of the place a project's main crew member holds, as a field label. */
export function crewLeadLabel(project: ProjectShape | null | undefined): string {
  if (project?.leadLabel) return project.leadLabel;
  return project?.mode === 'solo' ? 'Main crew member' : 'Crew Lead';
}

/** Lowercase form for inline prose ("the crew lead of…", "no opponent set"). */
export function crewLeadLabelLower(project: ProjectShape | null | undefined): string {
  if (project?.leadLabel) return project.leadLabel.toLowerCase();
  return project?.mode === 'solo' ? 'main crew member' : 'crew lead';
}

/**
 * What a roster says under the main crew member's name, after the star. A
 * crew lead is named for what they do here; someone working alone keeps
 * their own role, because "builder" under a Writer's name was wrong.
 */
export function mainCrewMemberSubtitle(
  project: ProjectShape | null | undefined,
  role: string | undefined,
): string {
  if (project?.leadLabel || project?.mode !== 'solo') return crewLeadLabelLower(project);
  return role?.trim() ? plainRoleTitle(role) : crewLeadLabelLower(project);
}

/**
 * Whether a speaker carries the star in the project they are speaking in.
 * Until that project is known, a crew lead's role stands in for it, so the
 * star does not arrive a moment after the name.
 */
export function speaksAsMainCrewMember(
  project: { voormanGezelId?: string | undefined } | null | undefined,
  gezelId: string | undefined,
  role: string | undefined,
): boolean {
  if (project) return isProjectMainGezel(project, gezelId);
  return roleForMatching(role)?.toLowerCase().trim() === 'voorman';
}

/** "Project" for crew shape, "Job" for solo shape — matches the create-button labels. */
export function projectKindLabel(project: ProjectShape | null | undefined): string {
  return project?.mode === 'solo' ? 'Job' : 'Project';
}
