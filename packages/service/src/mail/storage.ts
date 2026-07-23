/**
 * Mail's mapping from a parsed `MailMessage` to the generic connector writer.
 * The on-disk layout, trust frontmatter, injection scan, quarantine, path
 * safety, attachments, and the flags sidecar all live in `connectors/writer.ts`
 * now; this file only computes the mail-specific slugs + frontmatter and hands a
 * `NormalizedRecord` to `writeRecord`. `writeMessage`'s signature is unchanged.
 *
 *   <workspace>/<mailDir>/<accountSlug>/<folder>/
 *     <yyyy-mm-dd>--<subject-slug>--<threadHash8>/
 *       001--<iso-min>--from-<local>--<msgHash8>.md
 */

import type { NormalizedRecord } from '../connectors/types.js';
import { sha8, slug, writeRecord } from '../connectors/writer.js';
import type { MailMessage } from './types.js';

/** Local-part of the first email address in a From header. */
function fromLocalPart(from: string): string {
  const m = /<([^>@]+)@/.exec(from) ?? /([^\s<>@]+)@/.exec(from);
  return slug(m?.[1] ?? from, 24);
}

/** Strip a subject's Re:/Fwd: prefixes before slugging. */
function subjectSlug(subject: string): string {
  return slug(subject.replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, ''), 40);
}

export interface WriteMessageInput {
  workspaceDir: string;
  mailDir: string;
  /** `<provider>:<address>` — the account binding (frontmatter `account`). */
  accountId: string;
  message: MailMessage;
}

export type WriteStatus = 'written' | 'exists' | 'quarantined';

export interface WriteMessageResult {
  status: WriteStatus;
  /** Workspace-relative path of the message markdown, when one was written. */
  relPath?: string;
}

/** Map a parsed message to the generic connector record (mail's normalize). */
export function messageToRecord(accountId: string, message: MailMessage): NormalizedRecord {
  const accountSlug = slug(accountId.replace(/[:@]/g, '-'), 60);
  const folderSlug = slug(message.folder, 32);
  const threadDirName = `${message.date.slice(0, 10)}--${subjectSlug(message.subject)}--${sha8(message.threadKey)}`;
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
    account: accountId,
    folder: message.folder,
    direction: 'inbound',
  };

  return {
    recordId: message.messageId,
    dirSegments: [accountSlug, folderSlug, threadDirName],
    fileStem: `${isoMin}--from-${fromLocalPart(message.from)}`,
    frontmatter,
    bodyMarkdown: message.bodyMarkdown,
    scanOrigin: 'email',
    quarantineNamespace: 'mail',
    quarantineLabel: `Message from ${message.from || 'unknown sender'}`,
    attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content })),
    flags: message.flags,
    seen: message.flags.includes('\\Seen'),
  };
}

/**
 * Write one synced message to disk. Idempotent (delegates to `writeRecord`).
 * Byte-for-byte identical to the pre-extraction layout + frontmatter.
 */
export async function writeMessage(input: WriteMessageInput): Promise<WriteMessageResult> {
  return writeRecord({
    workspaceDir: input.workspaceDir,
    corpusDir: input.mailDir,
    record: messageToRecord(input.accountId, input.message),
  });
}
