/**
 * Provider-agnostic MIME parsing: raw RFC822 bytes → normalized `MailMessage`.
 * Uses mailparser (battle-tested charset/transfer-encoding/multipart handling),
 * then prefers the plain-text alternative, converts HTML when that's all there
 * is, and strips quoted history + signatures so each stored message is just
 * what its sender wrote.
 */

import { createHash } from 'node:crypto';
import { type AddressObject, type ParsedMail, simpleParser } from 'mailparser';
import { htmlBodyToMarkdown } from './html.js';
import { stripQuotedAndSignature } from './quote.js';
import type { MailAttachment, MailMessage } from './types.js';

export interface ParseContext {
  folder: string;
  /** Provider fetch handle (IMAP UID as string, Gmail/Graph message id). */
  id: string;
  /** IMAP UID when applicable; absent for API providers. */
  uid?: number;
  flags: string[];
  /** Fallback date (e.g. IMAP internaldate) when the message has no Date. */
  fallbackDate?: string;
}

function addressText(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return '';
  if (Array.isArray(addr))
    return addr
      .map((a) => a.text)
      .filter(Boolean)
      .join(', ');
  return addr.text ?? '';
}

function normalizeReferences(refs: string | string[] | undefined): string[] {
  if (!refs) return [];
  const arr = Array.isArray(refs) ? refs : refs.split(/\s+/);
  return arr.map((r) => r.trim()).filter(Boolean);
}

function synthesizeMessageId(parsed: ParsedMail, ctx: ParseContext): string {
  const basis = `${addressText(parsed.from)}|${parsed.subject ?? ''}|${parsed.date?.toISOString() ?? ctx.fallbackDate ?? ''}|${ctx.id}`;
  return `<${createHash('sha256').update(basis).digest('hex').slice(0, 32)}@gezel.local>`;
}

/** Parse raw RFC822 into a normalized, quote-stripped MailMessage. */
export async function parseRawMessage(
  raw: Buffer | Uint8Array | string,
  ctx: ParseContext,
): Promise<MailMessage> {
  const parsed = await simpleParser(raw as Buffer);

  const messageId = parsed.messageId?.trim() || synthesizeMessageId(parsed, ctx);
  const references = normalizeReferences(parsed.references);
  const inReplyTo = parsed.inReplyTo?.trim() || undefined;
  const threadKey = references[0] ?? inReplyTo ?? messageId;
  const date = parsed.date?.toISOString() ?? ctx.fallbackDate ?? new Date(0).toISOString();

  // Body: prefer plain text; otherwise convert the HTML alternative.
  let body: string;
  if (parsed.text?.trim()) {
    body = parsed.text;
  } else if (parsed.html) {
    body = await htmlBodyToMarkdown(parsed.html);
  } else {
    body = '';
  }
  const bodyMarkdown = stripQuotedAndSignature(body);

  const attachments: MailAttachment[] = [];
  for (const att of parsed.attachments ?? []) {
    if (!att.content) continue;
    // Skip inline-only parts with no filename (tracking pixels, css images).
    const filename = att.filename ?? (att.cid ? `${att.cid}` : '');
    if (!filename) continue;
    attachments.push({
      filename,
      contentType: att.contentType ?? 'application/octet-stream',
      size: att.size ?? att.content.length,
      content: new Uint8Array(att.content.buffer, att.content.byteOffset, att.content.byteLength),
    });
  }

  return {
    ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
    messageId,
    threadKey,
    ...(inReplyTo ? { inReplyTo } : {}),
    references,
    date,
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    subject: parsed.subject ?? '',
    flags: ctx.flags,
    folder: ctx.folder,
    bodyMarkdown,
    attachments,
  };
}
