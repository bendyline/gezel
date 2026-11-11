/**
 * Pure rules for moving an existing project to a newer version of its app
 * (project type), shared by the desktop daemon (`service/src/project-type/
 * upgrade.ts`) and the phone runtime (`runtime/project-types.ts`).
 *
 * A project runs one version of its app as a unit: the page, the tool
 * declarations and the scripts move together, while the person's data, edits
 * and settings stay. Updates stay inside one major version, because nothing
 * migrates app data yet and a store refuses a format stamp it does not know.
 */
import { compareSemver, isSemver } from '../schemas/catalog-semver.js';
import type { ProjectTypeManifest } from '../schemas/catalog.js';
import type { Project, ProjectTabVisibility } from '../schemas/project.js';

function parts(version: string): { major: number; pre: boolean } | null {
  if (!isSemver(version)) return null;
  const core = version.split('+', 1)[0] ?? version;
  const major = Number.parseInt(core.split('.', 1)[0] ?? '', 10);
  if (!Number.isFinite(major)) return null;
  return { major, pre: core.includes('-') };
}

/**
 * The version a project stamped `stamp` should move to, or null to stay.
 *
 * `available` is the versions the project's own catalog source offers for new
 * work (not yanked, not gated by a newer Gezel), in any order. The target is
 * the newest of them in the stamp's major version. It must be newer than the
 * stamp unless the stamp no longer resolves at all (a reverted catalog
 * update), when any same-major version is better than a page that 404s.
 * A pre-release is only a target for a project already on one.
 */
export function pickProjectTypeUpgradeTarget(args: {
  stamp: string;
  available: readonly string[];
  stampResolves: boolean;
}): string | null {
  const stamp = parts(args.stamp);
  if (!stamp) return null;
  let newest: string | null = null;
  for (const candidate of args.available) {
    const info = parts(candidate);
    if (!info || info.major !== stamp.major) continue;
    if (info.pre && !stamp.pre) continue;
    if (newest === null || compareSemver(candidate, newest) > 0) newest = candidate;
  }
  if (newest === null || newest === args.stamp) return null;
  if (args.stampResolves && compareSemver(newest, args.stamp) <= 0) return null;
  return newest;
}

/**
 * Params a newer version added that would render as `{{placeholder}}` for a
 * project created before it: declared now, absent from the older schema, no
 * default, and no stored value. An update with any of these is not offered.
 */
export function projectTypeParamsWithoutValue(args: {
  previousSchema: Record<string, unknown> | undefined;
  nextSchema: Record<string, unknown> | undefined;
  params: Record<string, unknown> | undefined;
}): string[] {
  const props = (schema: Record<string, unknown> | undefined) =>
    (schema?.properties ?? {}) as Record<string, { default?: unknown } | undefined>;
  const before = props(args.previousSchema);
  const after = props(args.nextSchema);
  return Object.keys(after).filter(
    (key) =>
      !(key in before) &&
      after[key]?.default === undefined &&
      (args.params === undefined || !(key in args.params)),
  );
}

/** The project settings a project type manages, by the manifest's names. */
export interface ProjectTypeSettings {
  mode?: 'crew' | 'solo';
  leadLabel?: string;
  leanProfile?: boolean;
  indexingEnabled?: boolean;
  meesterManaged?: boolean;
  tabVisibility?: ProjectTabVisibility;
}

const SCALAR_SETTINGS = [
  'mode',
  'leadLabel',
  'leanProfile',
  'indexingEnabled',
  'meesterManaged',
] as const;

/** The settings a version of a type declares. */
export function projectTypeDeclaredSettings(
  manifest: Pick<
    ProjectTypeManifest,
    'mode' | 'leadLabel' | 'leanProfile' | 'indexingEnabled' | 'meesterManaged' | 'tabVisibility'
  >,
): ProjectTypeSettings {
  return {
    ...(manifest.mode !== undefined ? { mode: manifest.mode } : {}),
    ...(manifest.leadLabel !== undefined ? { leadLabel: manifest.leadLabel } : {}),
    ...(manifest.leanProfile !== undefined ? { leanProfile: manifest.leanProfile } : {}),
    ...(manifest.indexingEnabled !== undefined
      ? { indexingEnabled: manifest.indexingEnabled }
      : {}),
    ...(manifest.meesterManaged !== undefined ? { meesterManaged: manifest.meesterManaged } : {}),
    ...(manifest.tabVisibility !== undefined ? { tabVisibility: manifest.tabVisibility } : {}),
  };
}

/** A project's current values of the settings a type manages. */
export function projectTypeCurrentSettings(
  project: Pick<
    Project,
    'mode' | 'leadLabel' | 'leanProfile' | 'indexingEnabled' | 'nudgeConfig' | 'tabVisibility'
  >,
): ProjectTypeSettings {
  return {
    ...(project.mode !== undefined ? { mode: project.mode } : {}),
    ...(project.leadLabel !== undefined ? { leadLabel: project.leadLabel } : {}),
    ...(project.leanProfile !== undefined ? { leanProfile: project.leanProfile } : {}),
    ...(project.indexingEnabled !== undefined ? { indexingEnabled: project.indexingEnabled } : {}),
    ...(project.nudgeConfig?.enabled !== undefined
      ? { meesterManaged: project.nudgeConfig.enabled }
      : {}),
    ...(project.tabVisibility !== undefined ? { tabVisibility: project.tabVisibility } : {}),
  };
}

/**
 * Which app-managed settings an update may change. A setting takes the new
 * version's value only while the project still holds the old version's value:
 * a choice the person made since stands. With no old version to compare
 * against, nothing changes. A setting the new version stops declaring is left
 * as it is.
 */
export function upgradeProjectTypeSettings(args: {
  previous: ProjectTypeSettings | null;
  next: ProjectTypeSettings;
  current: ProjectTypeSettings;
}): { values: ProjectTypeSettings; changed: string[] } {
  const values: ProjectTypeSettings = {};
  const changed: string[] = [];
  const { previous, next, current } = args;
  if (!previous) return { values, changed };

  for (const key of SCALAR_SETTINGS) {
    const nextValue = next[key];
    if (nextValue === undefined || nextValue === previous[key]) continue;
    if (current[key] !== previous[key]) continue;
    (values as Record<string, unknown>)[key] = nextValue;
    changed.push(key);
  }

  if (next.tabVisibility) {
    const before = previous.tabVisibility ?? {};
    const now = current.tabVisibility ?? {};
    const merged: Record<string, boolean | undefined> = { ...now };
    let tabsChanged = false;
    for (const [tab, nextValue] of Object.entries(next.tabVisibility) as [
      keyof ProjectTabVisibility,
      boolean | undefined,
    ][]) {
      if (nextValue === undefined || nextValue === before[tab]) continue;
      if (now[tab] !== before[tab]) continue;
      merged[tab] = nextValue;
      tabsChanged = true;
    }
    if (tabsChanged) {
      values.tabVisibility = merged as ProjectTabVisibility;
      changed.push('tabVisibility');
    }
  }
  return { values, changed };
}
