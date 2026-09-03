import { PROJECT_PROMPTS_DIR_NAME } from './paths.js';

/**
 * Shared vocabulary for prompt drafts — id shape, the artifacts-relative
 * paths inside one draft folder, and the media-ref rewrite the send path
 * performs. Lives in core because the service performs the rewrite when it
 * persists a message and the UI performs the identical rewrite when it paints
 * the optimistic bubble; two implementations would drift and the drift would
 * only show as a broken image in one of the two.
 */

/** The prompt markdown a draft folder is built around. */
export const PROMPT_DRAFT_MESSAGE_FILE = 'message.md';

/**
 * The draft's uploads. Named for `message.md` on purpose: it is the same
 * `<stem>_files/` companion convention every squisq document in gezel uses,
 * so the editor's own container/media wiring works with no special case.
 */
export const PROMPT_DRAFT_FILES_DIR_NAME = 'message_files';

/** The draft's metadata sidecar. */
export const PROMPT_DRAFT_META_FILE = 'draft.json';

const DRAFT_ID_RE = /^(\d{4}-\d{2}-\d{2})-(\d{4,})$/;

export function isPromptDraftId(value: string): boolean {
  return DRAFT_ID_RE.test(value);
}

/**
 * `YYYY-MM-DD-NNNN` from a local calendar date and a project-wide sequence.
 * The sequence carries the identity; the date is there so a folder listing
 * reads like a diary.
 */
export function formatPromptDraftId(date: Date, seq: number): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}-${String(seq).padStart(4, '0')}`;
}

export function parsePromptDraftId(id: string): { date: string; seq: number } | null {
  const m = DRAFT_ID_RE.exec(id);
  if (!m) return null;
  return { date: m[1]!, seq: Number.parseInt(m[2]!, 10) };
}

/** `prompts/<draftId>` — artifacts-relative, no leading `artifacts/`. */
export function promptDraftArtifactDir(draftId: string): string {
  return `${PROJECT_PROMPTS_DIR_NAME}/${draftId}`;
}

export function promptDraftMessageArtifactPath(draftId: string): string {
  return `${promptDraftArtifactDir(draftId)}/${PROMPT_DRAFT_MESSAGE_FILE}`;
}

export function promptDraftFilesArtifactDir(draftId: string): string {
  return `${promptDraftArtifactDir(draftId)}/${PROMPT_DRAFT_FILES_DIR_NAME}`;
}

export function promptDraftMetaArtifactPath(draftId: string): string {
  return `${promptDraftArtifactDir(draftId)}/${PROMPT_DRAFT_META_FILE}`;
}

/**
 * The prefix a sent message carries: `artifacts/prompts/<id>/message_files/`.
 * That `artifacts/<path>` scope is already resolved by the service's image
 * extraction and by the UI's media provider, which is why sending needs no
 * new ref shape — only a rewrite from the document-relative form.
 */
export function promptDraftFilesRefPrefix(draftId: string): string {
  return `artifacts/${promptDraftFilesArtifactDir(draftId)}/`;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
// A markdown destination opener: `](`, optional whitespace, optional `<`.
const MD_REF_RE = /(\]\(\s*<?)(?:\.\/)?message_files\//g;
// An HTML attribute squisq may emit for an inline image or link.
const HTML_REF_RE = /(\b(?:src|href)\s*=\s*["'])(?:\.\/)?message_files\//g;

/**
 * Rewrite the draft's document-relative media references into the
 * project-relative form a persisted chat message must carry.
 *
 * Deliberately narrow. Only a link/image *destination* is touched, so prose
 * that merely mentions the folder is left alone, and fenced code is skipped
 * whole — a user showing someone else how markdown works must not have their
 * example silently edited. Paths that already resolve (`attachments/`,
 * `artifacts/`, `images/`), absolute paths, and URLs never match, and neither
 * does a `message_files/` segment that is not at the start of the
 * destination. The swap preserves the remaining bytes exactly: percent
 * encoding and spaces are the editor's business, and "helpfully" normalizing
 * them here would break refs the resolver matches literally.
 *
 * Idempotent — rewritten destinations begin with `artifacts/` and no longer
 * match.
 */
export function rewritePromptDraftFileRefs(markdown: string, draftId: string): string {
  if (!markdown.includes(PROMPT_DRAFT_FILES_DIR_NAME)) return markdown;
  const prefix = promptDraftFilesRefPrefix(draftId);
  const lines = markdown.split('\n');
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) {
        fence = marker[0]!.repeat(marker.length);
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;
    lines[i] = line
      .replace(MD_REF_RE, (_all, opener: string) => `${opener}${prefix}`)
      .replace(HTML_REF_RE, (_all, opener: string) => `${opener}${prefix}`);
  }
  return lines.join('\n');
}

const TITLE_MAX_CHARS = 120;

/**
 * A draft's display name: the first line that says anything, cleaned up
 * enough to read in a picker row. Derived rather than stored so renaming a
 * draft is just editing its first line.
 */
export function derivePromptDraftTitle(markdown: string, maxChars = TITLE_MAX_CHARS): string {
  for (const raw of markdown.split('\n')) {
    const cleaned = raw
      // Leading block markers: heading hashes, blockquotes, list bullets.
      .replace(/^\s*(?:[>#]+\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
      // Show the words, not the plumbing, for a draft that opens with media.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1).trimEnd()}…` : cleaned;
  }
  return '';
}
