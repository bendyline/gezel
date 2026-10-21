/**
 * Mail's mapping from a parsed `MailMessage` to the generic connector writer.
 * The on-disk layout, trust frontmatter, injection scan, quarantine, path
 * safety, attachments, and the flags sidecar all live in
 * `connectors/writer.ts`; this file only computes the mail-specific slugs +
 * frontmatter and hands a `NormalizedRecord` to the sync engine.
 *
 * The engine owns the corpus root (the binding's `corpusDir`) and the folder
 * (scope) level, so a record carries only its thread folder:
 *
 *   <workspace>/<corpusDir>/<folderSlug>/
 *     <subject-slug>--<threadHash8>/
 *       001--<iso-min>--from-<local>--<msgHash8>.md
 *
 * The thread folder is named for the conversation, never for a message's
 * date: a reply sent a day later must land beside the message it answers, or
 * the "read the siblings for context" promise quote-stripping relies on
 * breaks. Corpora written before this layout used `<yyyy-mm-dd>--` prefixed
 * folders; the adapter sets `recordsMayMove`, so a message re-fetched into
 * the new layout drops its old copy.
 */

import type { NormalizedRecord } from '../connectors/types.js';
import { sha8, slug } from '../connectors/writer.js';
import type { MailMessage } from './types.js';

/** Local-part of the first email address in a From header. */
function fromLocalPart(from: string): string {
  const m = /<([^>@]+)@/.exec(from) ?? /([^\s<>@]+)@/.exec(from);
  return slug(m?.[1] ?? from, 24);
}

/**
 * Leading reply/forward markers (English, German, Nordic, Dutch, and numbered
 * `Re[2]:` forms) and leading bracket tags (`[EXT]`, `[list-name]`), which
 * gateways and clients add to some messages of a thread and not others.
 */
const SUBJECT_PREFIX =
  /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|antw|doorst)\s*(?:\[\d+\])?\s*:\s*|\[[^\]]{0,40}\]\s*)+/i;

/** The conversation's subject, as a folder-name slug. */
export function threadSubjectSlug(subject: string): string {
  const base = subject.replace(SUBJECT_PREFIX, '').trim();
  return base ? slug(base, 40) : 'no-subject';
}

/** Map a parsed message to the generic connector record (mail's normalize). */
export function messageToRecord(
  accountId: string,
  message: MailMessage,
  opts: { quarantineNamespace?: string } = {},
): NormalizedRecord {
  const threadDirName = `${threadSubjectSlug(message.subject)}--${sha8(message.threadKey)}`;
  const isoMin = message.date.slice(0, 16).replace(/:/g, '-');

  const frontmatter: Record<string, string> = {
    message_id: message.messageId,
    thread_id: message.threadKey,
    ...(message.inReplyTo ? { in_reply_to: message.inReplyTo } : {}),
    ...(message.references.length ? { references: message.references.join(' ') } : {}),
    from: message.from,
    to: message.to,
    ...(message.cc ? { cc: message.cc } : {}),
    date: message.date,
    subject: message.subject,
    ...(message.flags.length ? { labels: message.flags.join(', ') } : {}),
    ...(message.attachments.length
      ? { attachments: message.attachments.map((a) => a.filename).join(', ') }
      : {}),
    ...(message.url ? { url: message.url } : {}),
    account: accountId,
    folder: message.folder,
    direction: 'inbound',
  };

  return {
    recordId: message.messageId,
    dirSegments: [threadDirName],
    fileStem: `${isoMin}--from-${fromLocalPart(message.from)}`,
    frontmatter,
    bodyMarkdown: message.bodyMarkdown,
    scanOrigin: 'email',
    quarantineNamespace: opts.quarantineNamespace ?? 'mail',
    quarantineLabel: `Message from ${message.from || 'unknown sender'}`,
    attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content })),
    flags: message.flags,
    seen: message.flags.includes('\\Seen'),
  };
}
