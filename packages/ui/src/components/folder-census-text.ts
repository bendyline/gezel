import type { FolderCensus, FolderKind } from '@bendyline/gezel';

function count(n: number, complete: boolean, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()}${complete ? '' : '+'} ${n === 1 ? one : many}`;
}

/**
 * What a folder holds, in a line: "12,480 photos · 1,204 only in iCloud".
 * Leads with what the folder is for (photos in Pictures, documents in
 * Documents), falls back to the plain file count.
 */
export function folderCensusLine(
  census: FolderCensus,
  kind: FolderKind | 'desktop' | 'downloads' | 'other',
  cloudLabel = 'the cloud',
): string {
  const parts: string[] = [];
  if (kind === 'pictures' && census.images > 0) {
    parts.push(count(census.images, census.complete, 'photo'));
    if (census.videos > 0) parts.push(count(census.videos, census.complete, 'video'));
  } else if (kind === 'documents' && census.documents > 0) {
    parts.push(count(census.documents, census.complete, 'document'));
  } else {
    parts.push(count(census.files, census.complete, 'file'));
  }
  if (census.cloudOnly > 0) {
    parts.push(`${census.cloudOnly.toLocaleString()} only in ${cloudLabel}`);
  }
  return parts.join(' · ');
}
