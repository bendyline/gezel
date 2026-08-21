/**
 * Mail's quick-open catalog entries, derived ENTIRELY from artifact paths —
 * zero file reads. The connector writer's layout (storage.ts) encodes
 * everything a subject-line quick-open needs:
 *
 *   <corpusDir>/<folderSlug>/<yyyy-mm-dd>--<subject-slug>--<hash8>/
 *     <seq>--<iso-min>--from-<local>--<hash8>.md
 *
 * The message BODY is already searchable through the artifacts content arm;
 * these entries add the mail-shaped layer — "type a few words of the
 * subject, land on the message" — that a body search can't provide.
 */

export interface MailCatalogEntry {
  projectId: string;
  /** Artifacts-relative path — navigable via the standard OpenFileIntent. */
  path: string;
  subject: string;
  from: string;
  /** `yyyy-mm-dd hh:mm` when the stem carried a time, else `yyyy-mm-dd`. */
  date: string;
}

const THREAD_DIR = /^(\d{4}-\d{2}-\d{2})--(.+)--[0-9a-f]{8}$/;
const FILE_STEM = /^\d+--(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})--from-(.+?)--[0-9a-f]{8}\.md$/;

/** De-slug for display: hyphens back to spaces (casing is lost; fine here). */
function unslug(s: string): string {
  return s.replace(/-+/g, ' ').trim();
}

/**
 * Parse one artifacts-relative path into a catalog entry, or null when the
 * path doesn't match mail's layout (attachments, flags sidecars, other
 * connectors' records under the same corpus root).
 */
export function parseMailPath(projectId: string, path: string): MailCatalogEntry | null {
  const segments = path.split('/');
  if (segments.length < 3) return null;
  const fileName = segments[segments.length - 1]!;
  const threadDir = segments[segments.length - 2]!;
  const thread = THREAD_DIR.exec(threadDir);
  const stem = FILE_STEM.exec(fileName);
  if (!thread || !stem) return null;
  return {
    projectId,
    path,
    subject: unslug(thread[2]!) || '(no subject)',
    from: unslug(stem[4]!),
    date: `${stem[1]} ${stem[2]}:${stem[3]}`,
  };
}

/**
 * Build the catalog entries for one project from its mail corpus roots and
 * the artifact index's file list.
 */
export function mailCatalogEntries(
  projectId: string,
  corpusDirs: readonly string[],
  artifactPaths: readonly string[],
): MailCatalogEntry[] {
  if (corpusDirs.length === 0) return [];
  const prefixes = corpusDirs.map((d) => (d.endsWith('/') ? d : `${d}/`));
  const out: MailCatalogEntry[] = [];
  for (const path of artifactPaths) {
    if (!prefixes.some((p) => path.startsWith(p))) continue;
    const entry = parseMailPath(projectId, path);
    if (entry) out.push(entry);
  }
  return out;
}
