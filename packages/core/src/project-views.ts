import { folderKindOf } from './folder-kind.js';
import { resolveProjectTypeId } from './schemas/project.js';

/**
 * The views a project's **Views** tab can show (the tab once called Village).
 * Ids are stored on project.json as plain strings, so an id a newer build
 * wrote survives an older one: it is never rewritten, only passed over by
 * {@link resolveProjectView} until the person picks something this build has.
 */
export const KNOWN_PROJECT_VIEWS = [
  'village',
  'diagram',
  'reports',
  'gallery',
  'timeline',
] as const;
export type ProjectViewId = (typeof KNOWN_PROJECT_VIEWS)[number];

export function isKnownProjectView(id: string | undefined | null): id is ProjectViewId {
  return (KNOWN_PROJECT_VIEWS as readonly string[]).includes(id ?? '');
}

export interface ProjectViewSubject {
  projectTypeId?: string;
  detectedProjectType?: { id: string };
  properties?: Record<string, string>;
  tabVisibility?: { map?: boolean };
}

/** Types whose files make a poor settlement: prose, media and design work. */
const NON_VILLAGE_TYPES = new Set(['content-writing', 'media-production', 'design-prototype']);

/**
 * Whether a settlement of files suits the project: code-ish and data types,
 * and projects not yet classified. The auto-detected type is recomputed on
 * every content-index scan, so this follows the file mix.
 */
export function isVillageProject(p: ProjectViewSubject): boolean {
  const typeId = resolveProjectTypeId(p);
  return !typeId || !NON_VILLAGE_TYPES.has(typeId);
}

/**
 * Whether a view fits this project at all, before asking whether this build
 * offers it. An explicit `tabVisibility.map` opt-in keeps offering the
 * Village on the types that hide it by default, as it did when the tab was
 * the Village alone.
 */
export function projectViewApplies(p: ProjectViewSubject, view: ProjectViewId): boolean {
  switch (view) {
    case 'village':
      return isVillageProject(p) || p.tabVisibility?.map === true;
    case 'diagram':
      return folderKindOf(p) !== 'pictures';
    default:
      return true;
  }
}

/** The views `offered` by this build that fit the project, in `offered` order. */
export function availableProjectViews(
  p: ProjectViewSubject,
  offered: readonly ProjectViewId[],
): ProjectViewId[] {
  return offered.filter((view) => projectViewApplies(p, view));
}

/** Where a project opens before the person has chosen: by what the folder mostly holds. */
export function defaultProjectView(p: ProjectViewSubject): ProjectViewId {
  switch (folderKindOf(p)) {
    case 'code':
      return 'village';
    case 'pictures':
    case 'documents':
    case 'mixed':
      return 'gallery';
    default:
      return isVillageProject(p) ? 'village' : 'gallery';
  }
}

/**
 * The view to show: the stored choice when this build offers it, else the
 * project's default, else the first available. Null only when nothing is
 * available. Never writes, so an unknown stored id is kept on disk.
 */
export function resolveProjectView(
  p: ProjectViewSubject & { selectedView?: string },
  available: readonly ProjectViewId[],
): ProjectViewId | null {
  const stored = p.selectedView;
  if (isKnownProjectView(stored) && available.includes(stored)) return stored;
  const fallback = defaultProjectView(p);
  if (available.includes(fallback)) return fallback;
  return available[0] ?? null;
}

/**
 * Whether the Views tab shows when the project carries no explicit
 * `tabVisibility.map`: whenever any view fits. While the Village is the only
 * view offered, that is the Village's historical rule.
 */
export function projectViewsTabDefault(
  p: ProjectViewSubject,
  offered: readonly ProjectViewId[],
): boolean {
  return availableProjectViews(p, offered).length > 0;
}
