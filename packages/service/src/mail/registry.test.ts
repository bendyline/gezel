import { afterEach, describe, expect, it } from 'vitest';
import { NATIVE_ADAPTERS } from '../connectors/registry.js';
import { composeMime, normalizeMessageId } from './compose.js';
import {
  backfillDaysFrom,
  mailAdapterFactory,
  mailProviderFor,
  registerMailAdapters,
} from './registry.js';
import { type GmailWorld, gmailWorld } from './testing.js';

let world: GmailWorld | null = null;
afterEach(async () => {
  await world?.env.dispose();
  world = null;
});

describe('mail provider resolution', () => {
  it('builds Gmail for a mail-gmail binding whose config names no provider', async () => {
    // The old factory defaulted to IMAP and JSON-parsed the OAuth blob as an
    // IMAP credential.
    world = await gmailWorld();
    world.gmail.addMessage({ subject: 'Hi', text: 'hi' });
    const adapter = await mailAdapterFactory(
      world.binding,
      world.env.deps({ fetch: world.http.fetch }),
    );
    expect(adapter.typeId).toBe('mail-gmail');
    await adapter.ensureAuth();
    expect(await adapter.listScopes()).toEqual(['INBOX']);
  });

  it('refuses a config.provider that disagrees with the type', () => {
    expect(() =>
      mailProviderFor({ id: 'b', type: 'mail-gmail', config: { provider: 'imap' } }),
    ).toThrow(/gmail account but its config names provider 'imap'/);
    expect(
      mailProviderFor({ id: 'b', type: 'mail-outlook', config: { provider: 'outlook' } }),
    ).toBe('outlook');
    expect(() => mailProviderFor({ id: 'b', type: 'mail-imap' }, 'gmail')).toThrow(/reached/);
    expect(() => mailProviderFor({ id: 'b', type: 'calendar-google' })).toThrow(/not a mail type/);
  });

  it('registers one adapter per provider, pinned by adapter id', async () => {
    registerMailAdapters();
    for (const id of ['mail-imap', 'mail-gmail', 'mail-microsoft365', 'mail-outlook']) {
      expect(NATIVE_ADAPTERS.has(id)).toBe(true);
    }
    world = await gmailWorld();
    const adapter = await NATIVE_ADAPTERS.get('mail-gmail')!(
      world.binding,
      world.env.deps({ fetch: world.http.fetch }),
    );
    expect(adapter.typeId).toBe('mail-gmail');
  });

  it('reads backfillDays from config, with a default and a ceiling', () => {
    expect(backfillDaysFrom(undefined)).toBe(90);
    expect(backfillDaysFrom({ backfillDays: 14 })).toBe(14);
    expect(backfillDaysFrom({ backfillDays: 0 })).toBe(90);
    expect(backfillDaysFrom({ backfillDays: '30' })).toBe(90);
    expect(backfillDaysFrom({ backfillDays: 99_999 })).toBe(3650);
  });
});

describe('composeMime', () => {
  it('writes a recipient-less draft without From when the provider stamps it', () => {
    const { raw, messageId } = composeMime(undefined, {
      to: [],
      subject: 'Ideas',
      bodyMarkdown: 'notes',
    });
    const text = raw.toString('utf8');
    expect(text).not.toMatch(/^From:/m);
    expect(text).not.toMatch(/^To:/m);
    expect(text).toContain(`Message-ID: ${messageId}`);
  });

  it('threads a reply that names only its parent, and strips header injection', () => {
    const text = composeMime('me@example.com', {
      to: ['bob@example.com'],
      subject: 'Re: hi\r\nBcc: attacker@evil.example',
      bodyMarkdown: 'ok',
      inReplyTo: 'parent@example.com\r\nBcc: attacker@evil.example',
    }).raw.toString('utf8');
    expect(text).toMatch(/^In-Reply-To: <parent@example\.com>\r$/m);
    expect(text).toMatch(/^References: <parent@example\.com>\r$/m);
    expect(text).not.toMatch(/^Bcc:/m);
  });

  it('normalizes Message-ID forms', () => {
    expect(normalizeMessageId('a@b')).toBe('<a@b>');
    expect(normalizeMessageId('<a@b> <c@d>')).toBe('<a@b>');
    expect(normalizeMessageId('not an id')).toBeUndefined();
    expect(normalizeMessageId(undefined)).toBeUndefined();
  });
});
