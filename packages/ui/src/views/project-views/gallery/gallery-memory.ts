import type { GalleryGroup } from '@bendyline/gezel';

/**
 * The grouping the person chose for a project's gallery. A convenience kept
 * in this browser only: losing it opens the gallery on the folder's default.
 */

const key = (projectId: string): string => `gezel.gallery.group.${projectId}`;
const GROUPS: readonly string[] = ['type', 'folder', 'event'];

export function readGalleryGroup(projectId: string): GalleryGroup | undefined {
  try {
    const raw = window.localStorage.getItem(key(projectId));
    return raw && GROUPS.includes(raw) ? (raw as GalleryGroup) : undefined;
  } catch {
    return undefined;
  }
}

export function writeGalleryGroup(projectId: string, group: GalleryGroup): void {
  try {
    window.localStorage.setItem(key(projectId), group);
  } catch {
    // Storage can be unavailable (private window, blocked site data).
  }
}
