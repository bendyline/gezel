/**
 * Which folders the person opened, per project and graph kind. A convenience
 * kept in this browser only: losing it just returns the Diagram to its
 * default opening.
 */

const key = (projectId: string, kind: string): string => `gezel.diagram.open.${projectId}.${kind}`;

export function readDiagramExpansion(projectId: string, kind: string): Set<string> | null {
  try {
    const raw = window.localStorage.getItem(key(projectId, kind));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((p): p is string => typeof p === 'string'))
      : null;
  } catch {
    return null;
  }
}

/** Null forgets the choice, so the Diagram opens by default again. */
export function writeDiagramExpansion(
  projectId: string,
  kind: string,
  open: ReadonlySet<string> | null,
): void {
  try {
    if (open === null) window.localStorage.removeItem(key(projectId, kind));
    else window.localStorage.setItem(key(projectId, kind), JSON.stringify([...open].sort()));
  } catch {
    // Storage can be unavailable (private window, blocked site data).
  }
}
