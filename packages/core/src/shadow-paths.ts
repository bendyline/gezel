import {
  PROJECT_DIFFPACKS_DIR_NAME,
  PROJECT_PROMPTS_DIR_NAME,
  PROJECT_SHADOW_DIR_NAME,
  PROJECT_TABULAR_DIR_NAME,
} from './paths.js';

/**
 * Normalize an artifacts-relative path to its collapsed segment list so
 * `./shadow/x`, `shadow\\x`, and `docs/../shadow/x` all compare equal. Shared
 * by every reserved-subtree predicate below.
 */
function artifactSegments(path: string): string[] {
  const segments = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (segment === '..') collapsed.pop();
    else collapsed.push(segment);
  }
  return collapsed;
}

/**
 * True for artifacts-relative paths inside the reserved `shadow/` subtree —
 * gezel's derived cache of workspace shadow files (converted documents, image
 * descriptions, audio transcripts). Writes there are denied everywhere the
 * artifacts tree is user- or gezel-writable: only the indexer's own converter
 * produces shadow content, and it bypasses the artifact store entirely.
 *
 * Mirrors the connector-corpus predicate: segments are normalized and `..`
 * collapsed so `./shadow/x`, `shadow\\x`, and `docs/../shadow/x` all match.
 */
export function isReservedShadowArtifactPath(path: string): boolean {
  return artifactSegments(path)[0]?.toLowerCase() === PROJECT_SHADOW_DIR_NAME;
}

/**
 * True for artifacts-relative paths inside the reserved `tabular/` subtree —
 * Parquet tables derived from workspace CSVs and spreadsheets.
 *
 * Denied unconditionally, like `shadow/` and unlike a connector corpus. The
 * corpus guard only fires for gezel-initiated writes because the mirror is
 * arguably the user's to edit; a table here is not a mirror of anything the
 * user typed — it is derived output whose only legitimate writer is the
 * materializer, which bypasses the artifact store. A hand-edited Parquet part
 * would simply be overwritten on the source file's next content change, so
 * accepting the write would be a lie.
 */
export function isReservedTabularArtifactPath(path: string): boolean {
  return artifactSegments(path)[0]?.toLowerCase() === PROJECT_TABULAR_DIR_NAME;
}

/**
 * True for the machine-owned halves of a diffpack: `diffpacks/<id>/after/**`
 * (the copy-on-write draft tree) and `diffpacks/<id>/files/**` (the sealed
 * unified diffs). Those two are written only by the draft store and the
 * sealer, which bypass the artifact store — routing an ordinary
 * `write_artifact` there would let a model forge a diff it never drafted.
 *
 * Deliberately NOT the whole pack folder: `notes.md` and any scratch the
 * gezel keeps beside it stay writable, because explaining the fix is the
 * model's job.
 */
export function isReservedDiffpackArtifactPath(path: string): boolean {
  const segments = artifactSegments(path);
  if (segments[0]?.toLowerCase() !== PROJECT_DIFFPACKS_DIR_NAME) return false;
  if (segments.length < 3) return false;
  const third = segments[2]?.toLowerCase();
  return third === 'after' || third === 'files';
}

/**
 * True for artifacts-relative paths inside the reserved `prompts/` subtree —
 * the user's chat prompt drafts (`prompts/<draftId>/message.md`,
 * `message_files/`, `draft.json`).
 *
 * Unlike `shadow/` and `tabular/` this is a GEZEL-ONLY denial, and callers
 * must gate it on `initiatedByGezel` exactly like the connector-corpus guard.
 * The composer writes `message_files/` through the ordinary artifact raw
 * route, so an unconditional denial would break the user's own uploads. What
 * it protects is narrower and sharper: a gezel must never edit, delete, or
 * move the message a person is still writing — reading it is fine.
 */
export function isReservedPromptDraftArtifactPath(path: string): boolean {
  return artifactSegments(path)[0]?.toLowerCase() === PROJECT_PROMPTS_DIR_NAME;
}
