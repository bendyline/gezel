import type { MolenCheckIssue, MolenCheckResponse, MolenDocumentKind } from './schemas/molen.js';

/**
 * Recognizing a Molen document a gezel wrote, and the words a model reads
 * about the daemon's check of it. The check itself runs in the daemon
 * (`checkMolenDocument`, which holds `@bendyline/molen-stage`).
 */

const MOLEN_FORMAT_RE = /^molen\/(film|game|scene)@/;

/** Which Molen document a parsed value is, by its `format` (any version), or null. */
export function molenDocumentKind(doc: unknown): MolenDocumentKind | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const format = (doc as { format?: unknown }).format;
  if (typeof format !== 'string') return null;
  const match = MOLEN_FORMAT_RE.exec(format);
  return match ? (match[1] as MolenDocumentKind) : null;
}

/**
 * The Molen document a file's text claims to be: the kind its JSON names in
 * `format`, even when the JSON itself does not parse yet, or null. A write
 * tool checks these, so a document cut off mid-write still gets an answer.
 */
export function claimedMolenKind(text: string): MolenDocumentKind | null {
  const match = /"format"\s*:\s*"molen\/(film|game|scene)@/.exec(text.slice(0, 2_000));
  return match ? (match[1] as MolenDocumentKind) : null;
}

/** A check's notices as lines a model reads, at most `max`, or '' when there are none. */
export function molenNoticeLines(notices: readonly MolenCheckIssue[], max = 5): string {
  if (notices.length === 0) return '';
  const shown = notices.slice(0, max).map((n) => `- ${n.message}${n.hint ? ` (${n.hint})` : ''}`);
  const more = notices.length > max ? [`- and ${notices.length - max} more`] : [];
  return [...shown, ...more].join('\n');
}

/**
 * What a write tool appends after landing a Molen document, so the model
 * fixes a misspelled cast id or a missing win condition in the same turn.
 * `fix` names the repair the session can make (its roster decides).
 */
export function molenCheckText(path: string, check: MolenCheckResponse, fix: string): string {
  if (check.ok) {
    const notices = molenNoticeLines(check.notices);
    return `[Molen check] ${path} plays: ${check.summary ?? `a ${check.kind} document`}.${notices ? `\nWorth fixing:\n${notices}` : ''}`;
  }
  const issues =
    check.formatted ??
    check.issues
      .map((issue) => `- ${issue.path ? `${issue.path}: ` : ''}${issue.message}`)
      .join('\n');
  return `[Molen check] ${path} does not play yet:\n${issues}\n${fix}`;
}
