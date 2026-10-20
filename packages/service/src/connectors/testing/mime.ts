/**
 * A small RFC 822 builder for mail fixtures. Real providers hand the adapter
 * raw MIME (Gmail `format=raw`, Graph `$value`, IMAP `BODY[]`), so the fakes
 * serve real MIME too and the shared parser runs exactly as in production.
 *
 * Deliberately covers the shapes that break naive parsers: HTML-only bodies,
 * multipart/alternative, base64 attachments, a non-UTF-8 charset, quoted
 * replies, and a message with no Message-ID at all.
 */

export interface FixtureMessage {
  /** Without angle brackets; omitted entirely when `null`. */
  messageId?: string | null;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  /** ISO timestamp. */
  date?: string;
  inReplyTo?: string;
  references?: string[];
  text?: string;
  html?: string;
  attachments?: { filename: string; contentType?: string; content: string | Uint8Array }[];
  /** Encode the text part in this charset (latin1 supported). */
  charset?: 'utf-8' | 'iso-8859-1';
}

const CRLF = '\r\n';

function b64(content: string | Uint8Array): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return (buf.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);
}

function encodeHeader(value: string): string {
  // RFC 2047 for anything non-ASCII so the parser exercises decoding.
  return /[^\x20-\x7e]/.test(value)
    ? `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`
    : value;
}

function textPart(text: string, charset: FixtureMessage['charset']): string {
  if (charset === 'iso-8859-1') {
    return [
      'Content-Type: text/plain; charset=iso-8859-1',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text, 'latin1').toString('base64'),
    ].join(CRLF);
  }
  return [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
  ].join(CRLF);
}

function htmlPart(html: string): string {
  return [
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
  ].join(CRLF);
}

/** Build raw RFC 822 bytes for a fixture message. */
export function buildMime(msg: FixtureMessage): Buffer {
  const headers: string[] = [];
  if (msg.messageId !== null)
    headers.push(
      `Message-ID: <${msg.messageId ?? `${Math.random().toString(36).slice(2)}@fixture.test`}>`,
    );
  headers.push(`From: ${encodeHeader(msg.from ?? 'Alice Example <alice@example.com>')}`);
  headers.push(`To: ${encodeHeader(msg.to ?? 'Me <me@example.com>')}`);
  if (msg.cc) headers.push(`Cc: ${encodeHeader(msg.cc)}`);
  headers.push(`Subject: ${encodeHeader(msg.subject ?? '(fixture)')}`);
  headers.push(`Date: ${new Date(msg.date ?? '2026-10-01T09:00:00Z').toUTCString()}`);
  if (msg.inReplyTo) headers.push(`In-Reply-To: <${msg.inReplyTo}>`);
  if (msg.references?.length)
    headers.push(`References: ${msg.references.map((r) => `<${r}>`).join(' ')}`);
  headers.push('MIME-Version: 1.0');

  const body = (() => {
    const alternatives: string[] = [];
    if (msg.text !== undefined) alternatives.push(textPart(msg.text, msg.charset));
    if (msg.html !== undefined) alternatives.push(htmlPart(msg.html));
    if (alternatives.length === 0) alternatives.push(textPart('', msg.charset));
    const content =
      alternatives.length === 1
        ? alternatives[0]!
        : (() => {
            const b = 'alt-boundary-fixture';
            return [
              `Content-Type: multipart/alternative; boundary="${b}"`,
              '',
              ...alternatives.flatMap((p) => [`--${b}`, p]),
              `--${b}--`,
            ].join(CRLF);
          })();
    if (!msg.attachments?.length) return content;
    const b = 'mixed-boundary-fixture';
    const parts = [
      content,
      ...msg.attachments.map((a) =>
        [
          `Content-Type: ${a.contentType ?? 'application/octet-stream'}; name="${a.filename}"`,
          `Content-Disposition: attachment; filename="${a.filename}"`,
          'Content-Transfer-Encoding: base64',
          '',
          b64(a.content),
        ].join(CRLF),
      ),
    ];
    return [
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      ...parts.flatMap((p) => [`--${b}`, p]),
      `--${b}--`,
    ].join(CRLF);
  })();

  // The body block carries its own top-level Content-Type line(s).
  const [bodyHeaders, ...rest] = body.split(`${CRLF}${CRLF}`);
  return Buffer.from(
    [...headers, bodyHeaders, '', rest.join(`${CRLF}${CRLF}`), ''].join(CRLF),
    'utf8',
  );
}
