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
});
