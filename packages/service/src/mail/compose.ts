/**
 * Minimal RFC822 composer for API-based send (Gmail's `messages.send` takes a
 * base64url raw message). Text-only with proper UTF-8 handling: base64 body +
 * RFC2047-encoded subject. Attachments aren't supported on the send path yet.
 */

import { randomBytes } from 'node:crypto';
import type { OutgoingMail } from './types.js';

/** RFC2047 encode a header value when it contains non-ASCII. */
function encodeHeaderWord(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII-range test
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?utf-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function foldBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

/** Build a complete RFC822 message buffer for `from` → `mail`. */
export function buildRawMime(from: string, mail: OutgoingMail): Buffer {
  const headers: string[] = [
    `From: ${from}`,
    `To: ${mail.to.join(', ')}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.join(', ')}`] : []),
    ...(mail.bcc?.length ? [`Bcc: ${mail.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeaderWord(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@gezel.local>`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`] : []),
    ...(mail.references?.length ? [`References: ${mail.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = foldBase64(Buffer.from(mail.bodyMarkdown, 'utf8').toString('base64'));
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8');
}
