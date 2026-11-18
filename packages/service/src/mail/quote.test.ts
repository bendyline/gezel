import { describe, expect, it } from 'vitest';
import { stripQuotedAndSignature } from './quote.js';

describe('stripQuotedAndSignature', () => {
  it('keeps a body with no quotes or signature', () => {
    expect(stripQuotedAndSignature('Hello there.\n\nSecond paragraph.')).toBe(
      'Hello there.\n\nSecond paragraph.',
    );
  });

  it('strips a Gmail-style attribution and the quote below it', () => {
    const body =
      'Thanks, looks good.\n\nOn Wed, Jun 18, 2026 at 2:00 PM Bob <bob@x.com> wrote:\n> the original\n> more original';
    expect(stripQuotedAndSignature(body)).toBe('Thanks, looks good.');
  });

  it('strips a leading-> quote block', () => {
    expect(stripQuotedAndSignature('my reply\n> quoted\n> quoted2')).toBe('my reply');
  });

  it('strips an RFC 3676 signature', () => {
    expect(stripQuotedAndSignature('Cheers,\nRobin\n-- \nRobin K | Example Co')).toBe(
      'Cheers,\nRobin',
    );
  });

  it('strips Outlook "Original Message" blocks', () => {
    const body = 'See below.\n\n-----Original Message-----\nFrom: x\nSent: y';
    expect(stripQuotedAndSignature(body)).toBe('See below.');
  });

  it('strips mobile signatures', () => {
    expect(stripQuotedAndSignature('quick reply\nSent from my iPhone')).toBe('quick reply');
  });

  it('keeps a forward whole: its content is in no other message of the thread', () => {
    const body =
      'FYI\n\n---------- Forwarded message ---------\nFrom: Billing <b@x.com>\nDate: Mon\nSubject: Invoice\n\nPlease pay invoice 42.';
    expect(stripQuotedAndSignature(body)).toContain('Please pay invoice 42.');
    const outlook =
      'FYI\n-- \nRobin\n\nFrom: Billing\nSent: Monday\nSubject: Invoice\n\nPlease pay.';
    expect(stripQuotedAndSignature(outlook, { forwarded: true })).toContain('Please pay.');
  });

  it('keeps a reply written below the quote', () => {
    const body = 'On Wed, Bob <bob@x.com> wrote:\n> Can you make Friday?\n\nYes, Friday works.';
    expect(stripQuotedAndSignature(body)).toBe('Yes, Friday works.');
  });

  it('keeps answers written between quoted lines', () => {
    const body = '> First question?\nFirst answer.\n> Second question?\nSecond answer.\n-- \nRobin';
    expect(stripQuotedAndSignature(body)).toBe('First answer.\nSecond answer.');
  });

  it('never empties a message that is only quoted text', () => {
    expect(stripQuotedAndSignature('> only quoted\n> text')).toBe('> only quoted\n> text');
  });
});
