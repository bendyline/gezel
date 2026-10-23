/**
 * Which section a project should open on, once: an added folder lands on its
 * Overview, where the first look is; a report's file link lands on the Views
 * tab with that file selected. Same mailbox shape as pending-open-file:
 * queued before the project tab opens, consumed when it does.
 */
export type ProjectSectionRequest =
  | 'overview'
  | {
      section: 'views';
      /** A view id; one this build doesn't offer falls back to the project's default. */
      view?: string;
      /** A workspace-relative file to select in that view. */
      path?: string;
    };

/** Live companion for a project that is already open (no remount to consume the mailbox). */
export const OPEN_PROJECT_VIEW_EVENT = 'gezel:open-project-view';

export interface OpenProjectViewDetail {
  projectId: string;
  view?: string;
  path?: string;
}

const pending = new Map<string, ProjectSectionRequest>();

export function requestProjectSection(projectId: string, section: ProjectSectionRequest): void {
  pending.set(projectId, section);
}

export function consumeProjectSection(projectId: string): ProjectSectionRequest | null {
  const section = pending.get(projectId) ?? null;
  pending.delete(projectId);
  return section;
}
