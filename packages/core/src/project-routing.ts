/**
 * Where a message to another gezel should land when the caller did not say.
 *
 * The common case this rescues: a meester living in `default` spins up a
 * named project for the work, then forgets to pass the project on a
 * follow-up message. Without this the target gets a fresh default-scoped
 * session and its file tools miss the work it already did. The guard is
 * "unambiguous": exactly one distinct non-default project among the
 * target's active sessions. With several, the model has to be explicit.
 */
export interface RoutableSession {
  projectId?: string;
  archived?: boolean;
}

export function inferTargetProject(
  sessions: ReadonlyArray<RoutableSession>,
  requested: string | undefined,
  current: string | undefined,
  defaultProjectId = 'default',
): string {
  if (requested) return requested;
  const fallback = current ?? defaultProjectId;
  if (fallback !== defaultProjectId) return fallback;
  const distinct = new Set(
    sessions
      .filter((s) => !s.archived && s.projectId && s.projectId !== defaultProjectId)
      .map((s) => s.projectId as string),
  );
  return distinct.size === 1 ? [...distinct][0]! : fallback;
}
