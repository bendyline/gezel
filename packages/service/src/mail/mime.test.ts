import { describe, expect, it } from 'vitest';
import { parseRawMessage } from './mime.js';

const ctx = { folder: 'INBOX', id: '42', uid: 42, flags: ['\\Seen'] };

describe('parseRawMessage', () => {
  it('parses headers, threads, and strips quoted history', async () => {
    const raw = [
      'From: Alice <alice@example.com>',
      'To: robin@crafts.example',
      'Cc: bob@acme.com',
      'Subject: Re: Q2 roadmap',
      'Message-ID: <msg-1@example.com>',
      'In-Reply-To: <root@example.com>',
      'References: <root@example.com> <msg-0@example.com>',
      'Date: Wed, 18 Jun 2026 14:02:11 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thanks Alice, the timeline looks good.',
      '',
      'On Wed, Jun 18, 2026 at 2:00 PM Bob <bob@acme.com> wrote:',
      '> earlier message text',
    ].join('\r\n');

    const msg = await parseRawMessage(raw, ctx);
    expect(msg.messageId).toBe('<msg-1@example.com>');
    expect(msg.threadKey).toBe('<root@example.com>'); // references root
    expect(msg.inReplyTo).toBe('<root@example.com>');
    expect(msg.from).toContain('alice@example.com');
    expect(msg.subject).toBe('Re: Q2 roadmap');
    expect(msg.date).toBe('2026-06-18T14:02:11.000Z');
    expect(msg.flags).toEqual(['\\Seen']);
    expect(msg.bodyMarkdown).toBe('Thanks Alice, the timeline looks good.');
  });

  it('synthesizes a stable message id when absent', async () => {
    const raw = ['From: a@x.com', 'Subject: hi', '', 'body'].join('\r\n');
    const msg = await parseRawMessage(raw, ctx);
    expect(msg.messageId).toMatch(/^<[0-9a-f]{32}@gezel\.local>$/);
    // threadKey falls back to the (synthesized) message id
    expect(msg.threadKey).toBe(msg.messageId);
  });

  it('converts an HTML-only body and extracts attachments', async () => {
    const boundary = 'b1';
    const raw = [
      'From: a@x.com',
      'Subject: html mail',
      'Message-ID: <h@x.com>',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hello <strong>world</strong></p>',
      `--${boundary}`,
      'Content-Type: text/plain; name="note.txt"',
      'Content-Disposition: attachment; filename="note.txt"',
      '',
      'attached text',
      `--${boundary}--`,
    ].join('\r\n');

    const msg = await parseRawMessage(raw, ctx);
    expect(msg.bodyMarkdown.toLowerCase()).toContain('hello');
    expect(msg.bodyMarkdown).toContain('world');
    expect(msg.attachments.length).toBe(1);
    expect(msg.attachments[0]?.filename).toBe('note.txt');
  });

  it('keeps a stable date and id when the Date header is unreadable', async () => {
    // mailparser substitutes "now" for a Date it cannot parse, which used to
    // re-date (and, with no Message-ID, re-identify) the message every fetch.
    const raw = ['From: a@x.com', 'Subject: hi', 'Date: sometime last week', '', 'body'].join(
      '\r\n',
    );
    const withFallback = { ...ctx, fallbackDate: '2026-05-01T08:00:00.000Z' };
    const a = await parseRawMessage(raw, withFallback);
    const b = await parseRawMessage(raw, withFallback);
    expect(a.date).toBe('2026-05-01T08:00:00.000Z');
    expect(a.messageId).toBe(b.messageId);
    const noFallback = await parseRawMessage(raw, ctx);
    expect(noFallback.date).toBe(new Date(0).toISOString());
  });

  it('threads on the first id of a multi-id In-Reply-To', async () => {
    const raw = [
      'From: a@x.com',
      'Subject: Re: hi',
      'Message-ID: <c@x.com>',
      'In-Reply-To: <p1@x.com> <p2@x.com>',
      '',
      'body',
    ].join('\r\n');
    const msg = await parseRawMessage(raw, ctx);
    expect(msg.inReplyTo).toBe('<p1@x.com>');
    expect(msg.threadKey).toBe('<p1@x.com>');
  });

  it('skips inline parts with no filename (tracking pixels)', async () => {
    const raw = [
      'From: a@x.com',
      'Subject: pixel',
      'Message-ID: <px@x.com>',
      'Content-Type: multipart/related; boundary="r1"',
      '',
      '--r1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Hi <img src="cid:pixel@x"></p>',
      '--r1',
      'Content-Type: image/gif',
      'Content-ID: <pixel@x>',
      'Content-Disposition: inline',
      'Content-Transfer-Encoding: base64',
      '',
      'R0lGODlhAQABAAAAACw=',
      '--r1--',
    ].join('\r\n');
    const msg = await parseRawMessage(raw, ctx);
    expect(msg.attachments).toEqual([]);
  });

  it('reads the HTML when the plain-text part is only a stub', async () => {
    const raw = [
      'From: news@shop.example',
      'Subject: Your order shipped',
      'Message-ID: <stub@shop.example>',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'To view this message, please use an HTML-capable email reader.',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><body><p>Order 1234 shipped on Monday and arrives Thursday.</p></body></html>',
      '--alt--',
    ].join('\r\n');
    const msg = await parseRawMessage(raw, ctx);
    expect(msg.bodyMarkdown).toContain('Order 1234 shipped');
  });

  it('drops inline data images from a converted HTML body', async () => {
    const pixel = 'A'.repeat(4000);
    const raw = [
      'From: a@x.com',
      'Subject: picture',
      'Message-ID: <img@x.com>',
      'Content-Type: text/html; charset=utf-8',
      '',
      `<p>Look at this</p><img src="data:image/png;base64,${pixel}">`,
    ].join('\r\n');
    const msg = await parseRawMessage(raw, ctx);
    expect(msg.bodyMarkdown).toContain('Look at this');
    expect(msg.bodyMarkdown).not.toContain(pixel.slice(0, 100));
  });

  it('keeps a forwarded message whole', async () => {
    const raw = [
      'From: robin@crafts.example',
      'Subject: Fwd: Invoice 42',
      'Message-ID: <fwd@crafts.example>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See below.',
      '-- ',
      'Robin',
      '',
      'From: Billing <b@x.com>',
      'Sent: Monday',
      'Subject: Invoice 42',
      '',
      'Please pay invoice 42 by Friday.',
    ].join('\r\n');
    const msg = await parseRawMessage(raw, ctx);
    expect(msg.bodyMarkdown).toContain('Please pay invoice 42 by Friday.');
  });
});
