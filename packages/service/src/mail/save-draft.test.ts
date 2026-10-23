import type {
  ConnectorTypeManifest,
  ProjectConnectorBinding,
  ProjectDetail,
} from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorActionManager } from '../connectors/actions.js';
import { enforceConsent } from '../connectors/consent.js';
import { registerMailAdapters } from './registry.js';
import { type GmailWorld, gmailWorld } from './testing.js';

registerMailAdapters();

function enforce(input: unknown, data: Record<string, string> = {}) {
  return enforceConsent('mailbox-draft', {
    project: { id: 'p1' } as ProjectDetail,
    binding: { id: 'mail-gmail:test', type: 'mail-gmail', config: {} } as ProjectConnectorBinding,
    action: 'save-draft',
    data,
    input,
  });
}

describe("'mailbox-draft' consent", () => {
  it('needs no allowlist, and hands the adapter canonical recipients', async () => {
    const v = await enforce({
      to: ['Alice Example <alice@example.com>'],
      cc: 'carol@example.com',
      subject: 'Plan',
      body: 'text',
    });
    expect(v).toEqual({
      ok: true,
      input: {
        to: ['alice@example.com'],
        cc: ['carol@example.com'],
        subject: 'Plan',
        body: 'text',
      },
    });
  });

  it('allows a draft with no recipients yet', async () => {
    expect((await enforce({ subject: 'Ideas' })).ok).toBe(true);
    expect((await enforce({ body: 'just a body' })).ok).toBe(true);
  });

  it('refuses malformed recipients, in the input or the draft frontmatter', async () => {
    for (const to of [
      ['"<ok@trusted.com>" <attacker@evil.com>'],
      ['a@x.com, b@y.com'],
      ['friends: a@x.com, b@y.com;'],
      [{ address: 'a@x.com' }],
    ]) {
      const v = await enforce({ to, subject: 's', body: 'b' });
      expect(v.ok).toBe(false);
    }
    const fm = await enforce({ subject: 's' }, { bcc: '"x" <a@x.com> <b@y.com>' });
    expect(fm.ok).toBe(false);
  });

  it('refuses an empty draft or a non-object input', async () => {
    expect(await enforce({ to: ['a@x.com'], subject: '  ', body: '' })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/neither a subject nor a body/),
    });
    expect((await enforce('hello')).ok).toBe(false);
    expect((await enforce(null)).ok).toBe(false);
  });
});

const GMAIL_MANIFEST = {
  schemaVersion: 1,
  kind: 'connector-type',
  id: 'mail-gmail',
  name: 'Gmail',
  description: '',
  tags: [],
  maintainer: { name: 'Gezel' },
  version: '1.0.1',
  releasedAt: '2026-10-19T00:00:00Z',
  driver: 'native',
  source: { adapterId: 'mail-gmail' },
  normalize: { kind: 'native' },
  actions: [
    { name: 'send', consentScope: 'recipient-allowlist' },
    { name: 'save-draft', consentScope: 'mailbox-draft' },
  ],
  completeness: 'window',
  availableVersions: ['1.0.1'],
} as unknown as ConnectorTypeManifest;

let world: GmailWorld | null = null;
afterEach(async () => {
  await world?.env.dispose();
  world = null;
});

describe('save-draft through the connector outbox', () => {
  it('commits into the Gmail account as a draft, while send stays allowlist-gated', async () => {
    world = await gmailWorld();
    const w = world;
    const project = {
      id: 'p1',
      connectors: [{ ...w.binding, corpusDir: 'data/gmail' }],
    } as unknown as ProjectDetail;
    const actions = new ConnectorActionManager({
      store: w.env.store,
      secrets: w.env.secrets,
      catalog: { get: async () => ({ manifest: GMAIL_MANIFEST }) } as never,
      fetch: w.http.fetch,
    });

    const draft = await actions.draft(project, {
      bindingId: w.binding.id,
      action: 'save-draft',
      input: {
        to: ['Stranger <stranger@elsewhere.example>'],
        subject: 'Follow-up',
        body: 'Draft for you to review.',
      },
    });
    const committed = await actions.commit(project, draft.draftId);
    expect(committed.status).toBe('committed');
    expect(committed.result).toEqual({ draftId: expect.stringMatching(/^r-/) });
    expect(w.gmail.drafts).toHaveLength(1);
    expect(w.gmail.sent).toHaveLength(0);
    expect(w.gmail.drafts[0]!.raw.toString('utf8')).toMatch(/^To: stranger@elsewhere\.example\r$/m);

    // The same recipient through `send` is refused: no allowlist entry.
    const send = await actions.draft(project, {
      bindingId: w.binding.id,
      action: 'send',
      input: { to: ['stranger@elsewhere.example'], subject: 'x', body: 'y' },
    });
    await expect(actions.commit(project, send.draftId)).rejects.toThrow(/allowlist/);
    expect(w.gmail.sent).toHaveLength(0);
    expect(w.http.unrouted).toEqual([]);
  });

  it('night shift still files drafts (nothing leaves the account) but holds sends', async () => {
    world = await gmailWorld({ allowedRecipients: ['bob@example.com'] });
    const w = world;
    const project = { id: 'p1', connectors: [w.binding] } as unknown as ProjectDetail;
    const actions = new ConnectorActionManager({
      store: w.env.store,
      secrets: w.env.secrets,
      catalog: { get: async () => ({ manifest: GMAIL_MANIFEST }) } as never,
      fetch: w.http.fetch,
      isNightShiftActive: () => true,
    });
    const draft = await actions.draft(project, {
      bindingId: w.binding.id,
      action: 'save-draft',
      input: { to: ['bob@example.com'], subject: 'Overnight reply', body: 'for the morning' },
    });
    expect((await actions.commit(project, draft.draftId)).status).toBe('committed');
    expect(w.gmail.drafts).toHaveLength(1);
    const send = await actions.draft(project, {
      bindingId: w.binding.id,
      action: 'send',
      input: { to: ['bob@example.com'], subject: 'x', body: 'y' },
    });
    expect((await actions.commit(project, send.draftId)).status).toBe('queued-night-shift');
    expect(w.gmail.sent).toHaveLength(0);
  });
});
