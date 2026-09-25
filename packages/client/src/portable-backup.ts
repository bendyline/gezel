import type { BackupRequest, RestoreReview } from '@bendyline/gezel';
import { GezelApiError } from './api-error.js';

/** Portable backup endpoints carry ZIP bytes, unlike the desktop path-based API. */
export async function exportPortableBackup(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  options: Pick<BackupRequest, 'include' | 'excludeWorkspaces'>,
): Promise<Uint8Array> {
  const response = await fetchImpl(`${baseUrl}/api/storage/backup/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok)
    throw new GezelApiError('Could not export the backup', response.status, await response.text());
  return new Uint8Array(await response.arrayBuffer());
}

/** Inspection creates a review only; the caller must separately confirm a restore. */
export async function scanPortableRestore(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  bytes: Uint8Array,
): Promise<RestoreReview> {
  const response = await fetchImpl(`${baseUrl}/api/storage/restore/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip' },
    body: bytes.slice(),
  });
  if (!response.ok)
    throw new GezelApiError('Could not inspect the backup', response.status, await response.text());
  return (await response.json()) as RestoreReview;
}
