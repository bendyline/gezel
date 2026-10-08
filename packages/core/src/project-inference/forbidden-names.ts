import type { ForbiddenReason } from './types.js';

/*
 * Kept apart from forbidden-roots.ts, whose path math imports `node:path`, so
 * the browser entry can export the wording without that module.
 */

/** Plain names for the folders the daemon refuses as project roots, by `reason`. */
const FORBIDDEN_FOLDER_NAMES: Record<ForbiddenReason, string> = {
  'user-home': 'your home folder',
  'home-container': 'the folder that holds user homes',
  'gezel-home': "gezel's own data folder",
  'temp-dir': 'the temp folder',
  'system-dir': 'a system folder',
  'per-user-app-data': 'an app data folder',
  'hidden-home-dir': 'a hidden settings folder',
  'cloud-root-parent': 'the folder that holds your cloud drives',
  'filesystem-root': 'the top of a drive',
  'network-root': 'the top of a network drive',
  'mount-root': 'the top of a mounted drive',
};

/**
 * A plain name for a folder gezel refuses as a project root ("your home
 * folder"), for telling a person why. Browser-safe, so the app and every
 * client word it the same way.
 */
export function forbiddenFolderPlainName(reason: string | undefined): string {
  return (
    (reason ? FORBIDDEN_FOLDER_NAMES[reason as ForbiddenReason] : undefined) ??
    'a folder gezel keeps out of projects'
  );
}
