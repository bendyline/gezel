/**
 * What a backup carries, where each item lives in the archive, and what is
 * left out as derived state — the policy both hosts must agree on for an
 * archive written on one to restore on the other.
 *
 * The ZIP writers stay host-specific (streaming yazl on the desktop, an
 * in-memory writer on a phone). This module is only the vocabulary they
 * share. It existed twice before, and the two copies disagreed: the desktop
 * emitted a settings item the portable reader refused, so a desktop backup
 * could not even be inspected on a phone.
 */
import { assertSafeEntityId } from './entity-id.js';
import type { BackupItemKind, BackupRequest } from './schemas/storage.js';

/** Settings files a backup may carry, by their id under `settings/`. */
export const BACKUP_SETTINGS_FILE_IDS = ['config.json', 'history.jsonl'] as const;
export type BackupSettingsFileId = (typeof BACKUP_SETTINGS_FILE_IDS)[number];

export function isBackupSettingsFileId(id: string): id is BackupSettingsFileId {
  return (BACKUP_SETTINGS_FILE_IDS as readonly string[]).includes(id);
}

/** Where a settings file lives relative to the product root. */
export function backupSettingsTarget(id: BackupSettingsFileId): string {
  return id;
}

export interface BackupItemRef {
  kind: BackupItemKind;
  id: string;
}

/** The one mapping from a manifest item to its path prefix inside the archive. */
export function backupEntryPrefix(item: BackupItemRef): string {
  if (item.kind === 'project' || item.kind === 'gezel') {
    assertSafeEntityId(item.id);
    return `${item.kind === 'project' ? 'projects' : 'gezels'}/${item.id}`;
  }
  if (item.kind === 'document-root' && item.id === 'documents') return 'documents';
  if (item.kind === 'settings-file' && isBackupSettingsFileId(item.id))
    return `settings/${item.id}`;
  throw new Error('This backup item is not supported');
}

/** `kind/id`: the identity a restore selection and a manifest agree on. */
export function backupItemIdentity(item: BackupItemRef): string {
  return `${item.kind}/${item.id}`;
}

/**
 * Subtrees under a gezel or project that are derived state a fresh install
 * rebuilds: search indexes, shadow copies, installed toolsets, terminal
 * scrollback. Carrying them wastes space, and importing them can mislead.
 */
export const BACKUP_DERIVED_SUBPATHS = {
  gezel: ['memories/index', 'toolsets'],
  project: [
    '_index',
    'index',
    'memories/index',
    'artifacts/shadow',
    'artifacts/.tabular',
    'toolsets',
    'terminals',
    '.gezel/index',
    '.gezel/terminals',
  ],
} as const satisfies Record<'gezel' | 'project', readonly string[]>;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DERIVED_GEZEL = new RegExp(
  `^gezels/[^/]+/(?:${BACKUP_DERIVED_SUBPATHS.gezel.map(escapeRegExp).join('|')})(?:/|$)`,
);
const DERIVED_PROJECT = new RegExp(
  `^projects/[^/]+/(?:${BACKUP_DERIVED_SUBPATHS.project.map(escapeRegExp).join('|')})(?:/|$)`,
);

/** Whether an archive-relative path is derived state that a backup leaves out. */
export function isBackupDerivedPath(path: string): boolean {
  return DERIVED_GEZEL.test(path) || DERIVED_PROJECT.test(path);
}

/** Whether a request's include list asks for this item. No list means everything. */
export function isBackupItemRequested(
  item: BackupItemRef,
  include: BackupRequest['include'],
): boolean {
  if (!include) return true;
  if (item.kind === 'gezel') return include.gezels?.includes(item.id) ?? true;
  if (item.kind === 'project') return include.projects?.includes(item.id) ?? true;
  if (item.kind === 'document-root') return include.documents !== false;
  return include.settings !== false;
}

export function selectBackupItems<T extends BackupItemRef>(
  items: readonly T[],
  include: BackupRequest['include'],
): T[] {
  return items.filter((item) => isBackupItemRequested(item, include));
}
