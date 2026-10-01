/**
 * Which tier a path under a gezel home belongs to.
 *
 * **Work** is the person's own: crew, projects, conversations, the shared
 * library, and the audit log. It can live where the person keeps their files
 * (iCloud Drive, a folder they picked) and outlive an app install.
 *
 * **Device** is everything else: settings, engines, models, search indexes,
 * transaction journals, logs, caches. It stays in the app's own storage.
 *
 * Data derived from Work (memory indexes, shadow conversions, workspace
 * tables, unlaunched uploads, per-folder `.gezel` index directories) is
 * Device, so a synced folder never carries a cache that can be rebuilt, the
 * same rule the shared document library follows.
 *
 * One classifier for the phone's routed product storage and the desktop
 * Store's Work root, so the two never disagree about what is the person's.
 */
export type StorageTier = 'work' | 'device';

const WORK_ROOTS = new Set(['gezels', 'projects', 'documents', 'tasks', 'history.jsonl']);

const DERIVED_IN_WORK: readonly RegExp[] = [
  /^gezels\/[^/]+\/memories\/index(?:\/|$)/,
  /^projects\/[^/]+\/artifacts\/(?:shadow|tabular)(?:\/|$)/,
  /^projects\/[^/]+\/input-staging(?:\/|$)/,
  /^projects\/[^/]+\/digest-state\.json$/,
  /(?:^|\/)\.gezel(?:\/|$)/,
];

/** The tier of a home-relative, `/`-separated path. The root itself is Device. */
export function storageTierFor(path: string): StorageTier {
  const first = path.split('/', 1)[0] ?? '';
  if (!WORK_ROOTS.has(first)) return 'device';
  return DERIVED_IN_WORK.some((rule) => rule.test(path)) ? 'device' : 'work';
}
