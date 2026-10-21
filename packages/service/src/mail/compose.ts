/**
 * Minimal RFC 822 composer for the API and APPEND paths (Gmail's
 * `messages.send` / `drafts.create` take base64url MIME, Graph accepts base64
 * MIME, IMAP APPEND takes the bytes). Text-only with proper UTF-8 handling:
 * base64 body + RFC 2047-encoded subject. Attachments aren't supported yet.
 */

import { randomBytes } from 'node:crypto';
import { canonicalRecipients } from './recipient.js';
import type { OutgoingMail } from './types.js';

/**
 * Collapse line breaks and other control characters. Gmail sends to every
 * address in the raw headers, so a CRLF in the subject would otherwise add a
 * `Bcc:` line the recipient allowlist never saw.
 */
function singleLine(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** RFC2047 encode a header value when it contains non-ASCII. */
function encodeHeaderWord(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII-range test
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function foldBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

/**
 * One Message-ID in angle brackets, or undefined when the value names none.
 * A model may hand back `abc@host` without brackets, or a whole
 * `In-Reply-To` header with several ids.
 */
export function normalizeMessageId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const line = singleLine(value).trim();
  const bracketed = /<([^<>\s]+)>/.exec(line);
  if (bracketed) return `<${bracketed[1]}>`;
  const bare = line.split(/\s+/)[0];
  return bare && /^[^<>\s]+@[^<>\s]+$/.test(bare) ? `<${bare}>` : undefined;
}

export interface ComposedMime {
  raw: Buffer;
  /** The Message-ID written into the headers. */
  messageId: string;
}

/**
 * Build a complete RFC 822 message. `from` may be omitted for a draft the
 * provider stamps itself (Gmail and Graph fill in the mailbox owner).
 */
export function composeMime(
  from: string | undefined,
  mail: OutgoingMail,
  opts: { date?: Date } = {},
): ComposedMime {
  const to = canonicalRecipients(mail.to);
  const cc = canonicalRecipients(mail.cc ?? []);
  const bcc = canonicalRecipients(mail.bcc ?? []);
  const messageId = `<${randomBytes(12).toString('hex')}@gezel.local>`;
  const inReplyTo = normalizeMessageId(mail.inReplyTo);
  // A reply that names only its parent still threads: RFC 5322 §3.6.4 has the
  // parent's id close References, and Gmail threads on References/In-Reply-To.
  const references = (mail.references ?? [])
    .map((r) => normalizeMessageId(r))
    .filter((r): r is string => Boolean(r));
  if (inReplyTo && !references.includes(inReplyTo)) references.push(inReplyTo);
  const headers: string[] = [
    ...(from?.trim() ? [`From: ${singleLine(from)}`] : []),
    ...(to.length ? [`To: ${to.join(', ')}`] : []),
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(singleLine(mail.subject))}`,
    `Date: ${(opts.date ?? new Date()).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length ? [`References: ${references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = foldBase64(Buffer.from(mail.bodyMarkdown, 'utf8').toString('base64'));
  return {
    raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8'),
    messageId,
  };
}

/** Build a complete RFC822 message buffer for `from` → `mail`. */
export function buildRawMime(from: string, mail: OutgoingMail): Buffer {
  return composeMime(from, mail).raw;
}
