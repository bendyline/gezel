import type {
  BackupPlan,
  RestoreReview,
  StorageCategoryId,
  StorageJob,
  StorageSummary,
} from '@bendyline/gezel';

/**
 * Renders `gezel cleanup` — the terminal view of what Gezel is storing.
 *
 * Uninstalling does not reclaim any of this, so the split that matters is
 * "Gezel can download this again" versus "only you can replace this". The
 * first group is what someone about to uninstall should clear; the second is
 * what they should back up first.
 */

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function formatStorageSummary(summary: StorageSummary): string {
  const lines: string[] = [`Gezel storage in ${summary.home}`, ''];

  lines.push(...group('Can be downloaded again', summary, 'redownloadable'));
  lines.push(...group('Your content', summary, 'user-content'));
  lines.push(
    ...group('Program files (the uninstaller removes these)', summary, 'uninstaller-owned'),
  );

  lines.push(
    `Total: ${formatBytes(summary.redownloadableBytes)} re-downloadable, ` +
      `${formatBytes(summary.userContentBytes)} your content`,
  );

  const external = summary.categories
    .flatMap((c) => c.external)
    .sort((a, b) => a.path.localeCompare(b.path));
  if (external.length > 0) {
    lines.push('', 'Outside the Gezel folder — not measured or removed by Gezel:');
    for (const entry of external) {
      lines.push(`  ${entry.path}`);
    }
  }

  return lines.join('\n');
}

function group(
  heading: string,
  summary: StorageSummary,
  cls: StorageSummary['categories'][number]['class'],
): string[] {
  const categories = summary.categories
    .filter((c) => c.class === cls && c.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  if (categories.length === 0) return [];
  const lines = [`${heading}:`];
  for (const c of categories) {
    lines.push(`  ${pad(formatBytes(c.bytes), 10)} ${c.label}`);
  }
  lines.push('');
  return lines;
}

/** Right-align sizes so the column scans as a column. */
function pad(text: string, width: number): string {
  return text.padStart(width, ' ');
}

/**
 * Maps `gezel cleanup` flags onto category ids.
 *
 * `--redownloadable` is the flag someone about to uninstall wants: it clears
 * everything Gezel can fetch again and touches nothing they would have to
 * recreate by hand.
 */
export const CLEANUP_FLAG_CATEGORIES = {
  models: ['models'],
  engines: ['native-engines', 'engine-caches'],
  toolsets: ['toolsets'],
  caches: ['gilde-cache', 'derived-caches'],
  redownloadable: [
    'models',
    'native-engines',
    'engine-caches',
    'toolsets',
    'gilde-cache',
    'derived-caches',
  ],
} as const satisfies Record<string, readonly StorageCategoryId[]>;

export const CLEANUP_CONTENT_CATEGORIES = {
  gezels: ['gezels'],
  projects: ['projects'],
  documents: ['documents'],
  settings: ['settings'],
  all: ['gezels', 'projects', 'documents', 'settings'],
} as const satisfies Record<string, readonly StorageCategoryId[]>;

export type CleanupContentChoice = keyof typeof CLEANUP_CONTENT_CATEGORIES;

export interface CleanupFlags {
  models?: boolean;
  engines?: boolean;
  toolsets?: boolean;
  caches?: boolean;
  redownloadable?: boolean;
  content?: string;
}

export interface ResolvedCleanupSelection {
  categories: StorageCategoryId[];
  /** True when the selection destroys something only the user has. */
  destroysUserContent: boolean;
}

/**
 * Resolves flags into the category list, or throws a message meant for a
 * person's eyes. Returns an empty selection when no flag was passed — the
 * caller shows the storage summary instead of guessing what to delete.
 */
export function resolveCleanupSelection(flags: CleanupFlags): ResolvedCleanupSelection {
  const categories = new Set<StorageCategoryId>();

  for (const [flag, ids] of Object.entries(CLEANUP_FLAG_CATEGORIES)) {
    if (flags[flag as keyof CleanupFlags] === true) for (const id of ids) categories.add(id);
  }

  let destroysUserContent = false;
  if (flags.content !== undefined) {
    const choice = flags.content as CleanupContentChoice;
    const ids = CLEANUP_CONTENT_CATEGORIES[choice];
    if (!ids) {
      throw new Error(
        `Unknown --content value "${flags.content}". Choose one of: ${Object.keys(
          CLEANUP_CONTENT_CATEGORIES,
        ).join(', ')}.`,
      );
    }
    for (const id of ids) categories.add(id);
    destroysUserContent = true;
  }

  return { categories: [...categories], destroysUserContent };
}

/** What a cleanup run did, in the terms someone asked for it in. */
export function formatCleanupResult(job: StorageJob): string {
  const lines: string[] = [];
  if (job.status === 'error') {
    lines.push(`Cleanup failed: ${job.error ?? 'unknown error'}`);
  } else if (job.status === 'cancelled') {
    lines.push(`Cleanup stopped early. Freed ${formatBytes(job.bytesDone)} before stopping.`);
  } else {
    lines.push(`Freed ${formatBytes(job.bytesDone)} across ${job.itemsDone} item(s).`);
  }
  if (job.skippedExternal.length > 0) {
    lines.push('', 'Left alone (stored outside the Gezel folder):');
    for (const skipped of job.skippedExternal) {
      lines.push(`  ${skipped.label} — ${skipped.path}`);
    }
  }
  if (job.restartRequired) {
    lines.push('', 'Restart Gezel to pick up the changes.');
  }
  return lines.join('\n');
}

/** What a pending cleanup would remove, listed before anything is deleted. */
export function formatCleanupPreview(
  summary: StorageSummary,
  categories: StorageCategoryId[],
): string {
  const selected = new Set(categories);
  const chosen = summary.categories.filter((c) => selected.has(c.id));
  const total = chosen.reduce((sum, c) => sum + c.bytes, 0);

  const lines = ['This will delete:'];
  for (const c of chosen) {
    lines.push(`  ${pad(formatBytes(c.bytes), 10)} ${c.label}`);
  }
  if (chosen.length === 0) lines.push('  (nothing — these categories are already empty)');
  lines.push('', `Frees about ${formatBytes(total)}.`);

  const external = chosen.flatMap((c) => c.external);
  if (external.length > 0) {
    lines.push('', 'Not touched (stored outside the Gezel folder):');
    for (const entry of external) lines.push(`  ${entry.path}`);
  }

  const userContent = chosen.filter((c) => c.class === 'user-content');
  if (userContent.length > 0) {
    lines.push('', 'WARNING: this includes content only you have. Gezel cannot download it again.');
  }
  return lines.join('\n');
}

/** What a backup would contain, shown before writing anything. */
export function formatBackupPlan(plan: BackupPlan): string {
  const lines = ['This backup will include:'];
  const byKind = new Map<string, { count: number; bytes: number }>();
  for (const item of plan.items) {
    const bucket = byKind.get(item.kind) ?? { count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += item.bytes;
    byKind.set(item.kind, bucket);
  }
  const labels: Record<string, string> = {
    gezel: 'gezels',
    project: 'projects',
    'document-root': 'documents',
    'settings-file': 'settings files',
  };
  for (const [kind, bucket] of byKind) {
    lines.push(`  ${pad(formatBytes(bucket.bytes), 10)} ${bucket.count} ${labels[kind] ?? kind}`);
  }
  if (plan.items.length === 0) lines.push('  (nothing yet — this install has no content)');
  lines.push('', `About ${formatBytes(plan.totalBytes)} total.`);
  lines.push('Saved credentials are never included; reconnect services after restoring.');
  for (const warning of plan.warnings) lines.push(`  note: ${warning}`);
  return lines.join('\n');
}

/** The review a scan produced, as a table someone can act on. */
export function formatRestoreReview(review: RestoreReview): string {
  const lines = [
    `Backup from Gezel ${review.gezelVersion}, made ${new Date(review.createdAt).toLocaleString()}`,
    '',
  ];
  for (const item of review.items) {
    const flag = item.conflict === 'exists' ? ' [already here]' : '';
    lines.push(`  ${pad(formatBytes(item.bytes), 10)} ${item.kind}: ${item.label}${flag}`);
  }
  if (review.items.length === 0) lines.push('  (this backup is empty)');
  if (review.warnings.length > 0) {
    lines.push('');
    for (const warning of review.warnings) lines.push(`  note: ${warning}`);
  }
  return lines.join('\n');
}

/**
 * Decide what to do with each item in a review.
 *
 * Anything already present is skipped unless `--replace` was passed: someone
 * restoring an old backup onto a working install should not silently lose
 * the work they have done since.
 */
export function resolveRestoreSelection(
  review: RestoreReview,
  opts: { only?: string[]; replace?: boolean },
): {
  items: Array<{
    kind: RestoreReview['items'][number]['kind'];
    id: string;
    action: 'add' | 'replace';
  }>;
  skipped: string[];
} {
  const wanted = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const items: Array<{
    kind: RestoreReview['items'][number]['kind'];
    id: string;
    action: 'add' | 'replace';
  }> = [];
  const skipped: string[] = [];

  for (const item of review.items) {
    if (wanted && !wanted.has(`${item.kind}:${item.id}`) && !wanted.has(item.id)) continue;
    if (item.conflict === 'exists' && !opts.replace) {
      skipped.push(`${item.label} (already here — use --replace to overwrite)`);
      continue;
    }
    items.push({
      kind: item.kind,
      id: item.id,
      action: item.conflict === 'exists' ? 'replace' : 'add',
    });
  }
  return { items, skipped };
}
