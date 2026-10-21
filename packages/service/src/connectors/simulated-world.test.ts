import type { ConnectorTypeManifest } from '@bendyline/gezel';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorActionManager } from './actions.js';
import { ConnectorManager } from './manager.js';
import { registerProductConnectorAdapters } from './product-wiring.js';
import { connectorSecretKey } from './registry.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
} from './testing/harness.js';
import {
  SIM_FEED_URL,
  SIM_SHAREPOINT_SITE,
  SIM_YOUTUBE_HANDLE,
  type SimulatedWorld,
  createSimulatedWorld,
} from './testing/world.js';

/**
 * The whole product path against the simulated provider world: link an
 * account through OAuth (PKCE, code exchange, credential custody), sync it
 * into a real corpus through ConnectorManager, write back through
 * ConnectorActionManager and the consent registry, and refresh/rotate tokens —
 * with every byte of provider traffic answered by the fakes in
 * `connectors/testing/`. The per-adapter suites prove each adapter keeps the
 * contract; this proves the pieces around them fit together.
 */

const GOOGLE_OAUTH = {
  kind: 'oauth2',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientIdEnv: 'GEZEL_GOOGLE_CLIENT_ID',
  clientSecretEnv: 'GEZEL_GOOGLE_CLIENT_SECRET',
  authParams: { access_type: 'offline', prompt: 'consent' },
};

function manifest(
  id: string,
  extra: Partial<ConnectorTypeManifest> & { secretShape?: Record<string, unknown> },
): ConnectorTypeManifest {
  return {
    schemaVersion: 1,
    kind: 'connector-type',
    id,
    name: id,
    description: '',
    tags: [],
    maintainer: { name: 'Gezel' },
    version: '1.0.0',
    releasedAt: '2026-10-19T00:00:00Z',
    driver: 'native',
    source: { adapterId: id },
    normalize: { kind: 'native' },
    actions: [],
    completeness: 'window',
    ...extra,
  } as ConnectorTypeManifest;
}

const MAIL_ACTIONS = [
  { name: 'send', consentScope: 'recipient-allowlist' },
  { name: 'save-draft', consentScope: 'mailbox-draft' },
];

const MANIFESTS = new Map<string, ConnectorTypeManifest>([
  [
    'mail-gmail',
    manifest('mail-gmail', {
      secretShape: { ...GOOGLE_OAUTH, scopes: 'https://mail.google.com/' },
      actions: MAIL_ACTIONS,
    }),
  ],
  ['mail-microsoft365', manifest('mail-microsoft365', { actions: MAIL_ACTIONS })],
  ['calendar-google', manifest('calendar-google', {})],
  ['calendar-microsoft', manifest('calendar-microsoft', {})],
  ['files-google-drive', manifest('files-google-drive', { completeness: 'mirror' })],
  ['files-onedrive', manifest('files-onedrive', { completeness: 'mirror' })],
  ['files-sharepoint', manifest('files-sharepoint', { completeness: 'mirror' })],
  ['rss-feed', manifest('rss-feed', {})],
  ['youtube-videos', manifest('youtube-videos', {})],
  ['x-posts', manifest('x-posts', {})],
  ['bluesky-posts', manifest('bluesky-posts', {})],
  ['instagram-media', manifest('instagram-media', {})],
]);

const catalog = {
  get: async (_kind: string, id: string) => {
    const m = MANIFESTS.get(id);
    return m ? { manifest: m, sourceId: 'bundled' } : null;
  },
} as unknown as ConstructorParameters<typeof ConnectorManager>[0]['catalog'];

beforeAll(() => {
  registerProductConnectorAdapters();
});

let env: ConnectorTestEnv;
let world: SimulatedWorld;
let nightShift = false;
const priorClientId = process.env.GEZEL_GOOGLE_CLIENT_ID;

afterEach(async () => {
  await env?.dispose();
  nightShift = false;
  if (priorClientId === undefined) delete process.env.GEZEL_GOOGLE_CLIENT_ID;
  else process.env.GEZEL_GOOGLE_CLIENT_ID = priorClientId;
});

async function setup() {
  env = await createConnectorTestEnv();
  world = createSimulatedWorld({ now: new Date('2026-10-19T16:00:00Z') });
  const connectors = new ConnectorManager({
    store: env.store,
    secrets: env.secrets,
    catalog,
    fetch: world.fetch,
  });
  const actions = new ConnectorActionManager({
    store: env.store,
    secrets: env.secrets,
    catalog,
    fetch: world.fetch,
    isNightShiftActive: () => nightShift,
  });
  const project = () => env.project() as never;
  return { connectors, actions, project };
}

describe('connectors against the simulated world', () => {
  it('links Gmail through OAuth, syncs the inbox, and writes back through consent', async () => {
    const { connectors, actions, project } = await setup();
    process.env.GEZEL_GOOGLE_CLIENT_ID = 'sim-google-client';

    // ── Link ────────────────────────────────────────────────────────────
    const { authUrl, state } = await connectors.startOAuth(project(), {
      type: 'mail-gmail',
      redirectUri: 'http://127.0.0.1:53111/callback',
      config: {
        address: 'sam@simulated.test',
        provider: 'gmail',
        allowedDomains: ['northwind.test'],
      },
      displayName: 'Work Gmail',
      loginHint: 'sam@simulated.test',
    });
    const auth = new URL(authUrl);
    expect(auth.searchParams.get('client_id')).toBe('sim-google-client');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('login_hint')).toBe('sam@simulated.test');
    const binding = await connectors.completeOAuth(project(), { state, code: 'code-from-browser' });
    expect(binding.corpusDir).toBe('data/work-gmail');
    const exchange = world.googleTokens.grants.at(-1)!;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code_verifier')).toBeTruthy();
    const cred = await env.readCredential<{ refreshToken: string; tokenUrl: string }>(binding);
    expect(cred).toMatchObject({ tokenUrl: 'https://oauth2.googleapis.com/token' });
    expect(cred?.refreshToken).toBeTruthy();
    expect(JSON.stringify(env.project())).not.toContain(cred!.refreshToken);

    // ── Sync ────────────────────────────────────────────────────────────
    const first = await connectors.syncBinding(project(), binding.id);
    expect(first.error).toBeUndefined();
    expect(first.written + first.quarantined).toBe(6);
    expect(first.quarantined).toBe(1);
    const records = await assertCorpusInvariants(env.artifactsDir, binding.corpusDir!, {
      requiredKeys: ['subject', 'from', 'date', 'message_id'],
    });
    expect(records).toHaveLength(6);
    // Both sides of the Q3 thread share one thread folder despite different days.
    const q3 = records.filter((r) => /Q3 review deck/.test(r.frontmatter.subject ?? ''));
    expect(q3).toHaveLength(2);
    expect(new Set(q3.map((r) => r.path.split('/').slice(0, -1).join('/'))).size).toBe(1);
    const held = records.find((r) => r.frontmatter.scan_action === 'quarantine');
    expect(held?.body).not.toContain('api_key');
    expect(env.project().connectors?.[0]?.lastError).toBeUndefined();

    const quiet = await connectors.syncBinding(project(), binding.id);
    expect(quiet.written).toBe(0);

    world.gmail.addMessage({
      messageId: 'followup@simulated.test',
      from: 'Priya Natarajan <priya@northwind.test>',
      subject: 'Slides look great',
      text: 'Thanks for the quick fix.',
      labelIds: ['INBOX'],
    });
    expect((await connectors.syncBinding(project(), binding.id)).written).toBe(1);

    // ── Write-back: save a draft into the mailbox (nothing sent) ───────────
    const draft = await actions.draft(project(), {
      bindingId: binding.id,
      action: 'save-draft',
      input: {
        to: ['priya@northwind.test'],
        subject: 'Re: Q3 review deck — numbers need a second look',
        body: 'Slide refreshed with the 3.1% figure.',
        inReplyTo: '<q3-review-1@simulated.test>',
      },
    });
    const saved = await actions.commit(project(), draft.draftId);
    expect(saved.status).toBe('committed');
    expect(world.gmail.drafts).toHaveLength(1);
    expect(world.gmail.sent).toHaveLength(0);

    // ── Write-back: send is allowlist-gated ────────────────────────────────
    const toCustomer = await actions.draft(project(), {
      bindingId: binding.id,
      action: 'send',
      input: { to: ['jordan@contoso-customer.test'], subject: 'Update', body: 'Working on it.' },
    });
    await expect(actions.commit(project(), toCustomer.draftId)).rejects.toThrow(
      /not on the binding's allowlist/,
    );
    expect(world.gmail.sent).toHaveLength(0);

    const toColleague = await actions.draft(project(), {
      bindingId: binding.id,
      action: 'send',
      input: { to: ['priya@northwind.test'], subject: 'Done', body: 'Slide updated.' },
    });
    // Night shift holds a send for daytime approval, but not a mailbox draft.
    nightShift = true;
    expect((await actions.commit(project(), toColleague.draftId)).status).toBe(
      'queued-night-shift',
    );
    expect(world.gmail.sent).toHaveLength(0);
    const overnight = await actions.draft(project(), {
      bindingId: binding.id,
      action: 'save-draft',
      input: {
        to: ['priya@northwind.test'],
        subject: 'Overnight draft',
        body: 'Ready for the morning.',
      },
    });
    expect((await actions.commit(project(), overnight.draftId)).status).toBe('committed');
    expect(world.gmail.drafts).toHaveLength(2);
    nightShift = false;
    expect((await actions.commit(project(), toColleague.draftId)).status).toBe('committed');
    expect(world.gmail.sent).toHaveLength(1);

    // ── Token refresh mid-life ──────────────────────────────────────────
    const stale = await env.readCredential<Record<string, unknown>>(binding);
    await env.storeCredential(binding, { ...stale, expiresAt: '2000-01-01T00:00:00Z' });
    const refreshed = await connectors.syncBinding(project(), binding.id);
    expect(refreshed.error).toBeUndefined();
    expect(world.googleTokens.grants.at(-1)?.get('grant_type')).toBe('refresh_token');
    const after = await env.readCredential<{ accessToken: string; expiresAt: string }>(binding);
    expect(after?.accessToken).not.toBe(stale?.accessToken);
    expect(Date.parse(after!.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('a revoked Google grant surfaces an actionable error and keeps the cursor', async () => {
    const { connectors, project } = await setup();
    const binding = await connectors.bind(project(), {
      type: 'mail-gmail',
      config: { address: 'sam@simulated.test', provider: 'gmail' },
      credential: JSON.stringify(world.googleCredential()),
    });
    await connectors.syncBinding(project(), binding.id);
    const cursor = JSON.stringify(env.project().connectors?.[0]?.cursor);
    const cred = await env.readCredential<Record<string, unknown>>(binding);
    await env.storeCredential(binding, { ...cred, expiresAt: '2000-01-01T00:00:00Z' });
    world.googleTokens.rejectRefresh = true;
    const r = await connectors.syncBinding(project(), binding.id);
    expect(r.error).toMatch(/Re-link/);
    expect(env.project().connectors?.[0]?.lastError).toMatch(/Re-link/);
    expect(JSON.stringify(env.project().connectors?.[0]?.cursor)).toBe(cursor);
  });

  it('Microsoft 365 mail refreshes and persists the rotated refresh token', async () => {
    const { connectors, project } = await setup();
    const credential = world.microsoftCredential('organizations', {
      expiresAt: '2000-01-01T00:00:00Z',
    });
    const binding = await connectors.bind(project(), {
      type: 'mail-microsoft365',
      config: { address: 'sam@simulated.test', provider: 'microsoft365', tenant: 'organizations' },
      credential: JSON.stringify(credential),
    });
    const r = await connectors.syncBinding(project(), binding.id);
    expect(r.error).toBeUndefined();
    expect(r.written + r.quarantined).toBe(6);
    const after = await env.readCredential<{ refreshToken: string }>(binding);
    // Microsoft invalidates the old refresh token on use; losing the rotated
    // one would strand the binding at its next refresh.
    expect(after?.refreshToken).not.toBe(credential.refreshToken);
    await assertCorpusInvariants(env.artifactsDir, binding.corpusDir!);
    const secret = await env.secrets.get(connectorSecretKey('mail-microsoft365', binding.id));
    expect(secret).toContain(after!.refreshToken);
  });

  it('Google and Microsoft calendars normalize to the same record shape', async () => {
    const { connectors, project } = await setup();
    const google = await connectors.bind(project(), {
      type: 'calendar-google',
      displayName: 'Google calendar',
      credential: JSON.stringify(world.googleCredential()),
    });
    const microsoft = await connectors.bind(project(), {
      type: 'calendar-microsoft',
      displayName: 'Outlook calendar',
      credential: JSON.stringify(world.microsoftCredential()),
    });
    const g = await connectors.syncBinding(project(), google.id);
    const m = await connectors.syncBinding(project(), microsoft.id);
    expect(g.error).toBeUndefined();
    expect(m.error).toBeUndefined();
    const gRecords = await assertCorpusInvariants(env.artifactsDir, google.corpusDir!, {
      requiredKeys: ['title', 'date', 'provider'],
      sharedArtifacts: true,
    });
    const mRecords = await assertCorpusInvariants(env.artifactsDir, microsoft.corpusDir!, {
      requiredKeys: ['title', 'date', 'provider'],
      sharedArtifacts: true,
    });
    // The cancelled Google event never becomes a record.
    expect(gRecords.map((r) => r.frontmatter.title).sort()).toEqual([
      'Q3 review with Priya',
      'Team offsite',
    ]);
    expect(mRecords.map((r) => r.frontmatter.title).sort()).toEqual([
      'Customer escalation: export failures',
      'Month-end close',
    ]);
    // Same keys, whichever provider: a craftbook never needs to know which.
    const keys = (r: { frontmatter: Record<string, string> }) =>
      Object.keys(r.frontmatter).filter((k) => !['scan_flags'].includes(k));
    const timedGoogle = gRecords.find((r) => r.frontmatter.title === 'Q3 review with Priya')!;
    const timedMicrosoft = mRecords.find((r) => r.frontmatter.title?.startsWith('Customer'))!;
    expect(new Set(keys(timedGoogle))).toEqual(new Set(keys(timedMicrosoft)));
    expect(timedGoogle.frontmatter.provider).toBe('google');
    expect(timedMicrosoft.frontmatter.provider).toBe('microsoft');
  });

  it('files, feeds, and video connectors each sync a corpus from the same world', async () => {
    const { connectors, project } = await setup();
    const cases: {
      type: string;
      config?: Record<string, unknown>;
      credential?: string;
      keys: string[];
    }[] = [
      {
        type: 'files-google-drive',
        config: { folderIds: [world.ids.driveProjects] },
        credential: JSON.stringify(world.googleCredential()),
        keys: ['title', 'path', 'file_id', 'provider'],
      },
      {
        type: 'files-onedrive',
        config: { folderPath: 'Documents/Projects' },
        credential: JSON.stringify(world.microsoftCredential('common')),
        keys: ['title', 'path', 'file_id', 'provider'],
      },
      {
        type: 'files-sharepoint',
        config: { siteUrl: SIM_SHAREPOINT_SITE, library: 'Documents' },
        credential: JSON.stringify(world.microsoftCredential('organizations')),
        keys: ['title', 'path', 'file_id', 'provider'],
      },
      { type: 'rss-feed', config: { feeds: [SIM_FEED_URL] }, keys: ['title', 'url', 'date'] },
      {
        type: 'youtube-videos',
        config: { channels: [SIM_YOUTUBE_HANDLE] },
        credential: 'simulated-api-key',
        keys: ['title', 'url', 'date'],
      },
    ];
    const counts: Record<string, number> = {};
    for (const c of cases) {
      const binding = await connectors.bind(project(), {
        type: c.type,
        ...(c.config ? { config: c.config } : {}),
        ...(c.credential ? { credential: c.credential } : {}),
      });
      const r = await connectors.syncBinding(project(), binding.id);
      expect(r.error, `${c.type}: ${r.error}`).toBeUndefined();
      const records = await assertCorpusInvariants(env.artifactsDir, binding.corpusDir!, {
        requiredKeys: c.keys,
        sharedArtifacts: true,
      });
      counts[c.type] = records.length;
      const quiet = await connectors.syncBinding(project(), binding.id);
      expect(quiet.written, `${c.type} resumes quietly`).toBe(0);
    }
    expect(counts).toEqual({
      'files-google-drive': 3,
      'files-onedrive': 1,
      'files-sharepoint': 1,
      'rss-feed': 2,
      'youtube-videos': 2,
    });
    expect(world.unrouted).toEqual([]);
  });

  it('social connectors sync posts from the same world', async () => {
    const { connectors, project } = await setup();
    const cases = [
      { type: 'x-posts', credential: JSON.stringify(world.x.credential()) },
      {
        type: 'bluesky-posts',
        config: { handle: world.bluesky.handle, service: world.bluesky.service },
        credential: JSON.stringify({ appPassword: world.bluesky.appPassword }),
      },
      { type: 'instagram-media', credential: JSON.stringify(world.instagram.credential()) },
    ];
    for (const c of cases) {
      const binding = await connectors.bind(project(), {
        type: c.type,
        ...(c.config ? { config: c.config } : {}),
        credential: c.credential,
      });
      const r = await connectors.syncBinding(project(), binding.id);
      expect(r.error, `${c.type}: ${r.error}`).toBeUndefined();
      expect(r.written, c.type).toBeGreaterThan(0);
      const records = await assertCorpusInvariants(env.artifactsDir, binding.corpusDir!, {
        sharedArtifacts: true,
      });
      expect(
        records.some((rec) => rec.frontmatter.url),
        `${c.type} records carry a url`,
      ).toBe(true);
    }
    expect(world.unrouted).toEqual([]);
  });

  it('every request the managers made was answered by the world', async () => {
    const { connectors, project } = await setup();
    const binding = await connectors.bind(project(), {
      type: 'mail-gmail',
      config: { address: 'sam@simulated.test', provider: 'gmail' },
      credential: JSON.stringify(world.googleCredential()),
    });
    await connectors.syncBinding(project(), binding.id);
    expect(world.unrouted).toEqual([]);
  });
});
