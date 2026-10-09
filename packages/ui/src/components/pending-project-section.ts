/**
 * Which section a project should open on, once: an added folder lands on its
 * Overview, where the first look is. Same mailbox shape as pending-open-file:
 * queued before the project tab opens, consumed when it does.
 */
const pending = new Map<string, 'overview'>();

export function requestProjectSection(projectId: string, section: 'overview'): void {
  pending.set(projectId, section);
}

export function consumeProjectSection(projectId: string): 'overview' | null {
  const section = pending.get(projectId) ?? null;
  pending.delete(projectId);
  return section;
}
