import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerConsentEnforcer } from '../../connectors/consent.js';
import { connectorSecretKey, registerNativeAdapter } from '../../connectors/registry.js';
import { readCorpus } from '../../connectors/testing/harness.js';
import type { ConnectorAdapter, NormalizedRecord, RecordRef } from '../../connectors/types.js';
import { type RunningService, startService } from '../../service.js';

/**
 * The connector HTTP surface over a real daemon: bind (config validation,
 * credential custody), sync into the artifacts corpus, status, the
 * draft → queue → commit outbox with its consent gate, unbind, and the refusal
 * to start an OAuth link from a non-bundled manifest.
 *
 * The connector type is a local catalog item driving a test-registered native
 * adapter, so the whole path — routes, ConnectorManager, the engine, the
 * writer, ConnectorActionManager, consent — is production code.
 */

const ADAPTER_ID = 'route-test-native';
const TYPE_ID = 'route-test-conn';
const OAUTH_TYPE_ID = 'route-test-oauth';

/** Upstream state the test adapter serves; tests mutate it between syncs. */
const upstream = {
  items: [] as { id: string; title: string; body: string; fail?: boolean }[],
  committed: [] as { action: string; input: unknown }[],
  credentialsSeen: [] as (string | null)[],
  /** Lets `after` records through, then holds each fetch until `release` settles. */
  hold: null as { after: number; fetched: number; release: Promise<void> } | null,
  /** The service cannot be reached: listing fails the way undici does. */
  unreachable: false,
};

registerNativeAdapter(ADAPTER_ID, async (binding, deps): Promise<ConnectorAdapter> => {
  const credential = await deps.secrets.get(connectorSecretKey(binding.type, binding.id));
  return {
    typeId: TYPE_ID,
    ensureAuth: async () => {
      upstream.credentialsSeen.push(credential);
      if (credential === 'revoked')
        throw new Error('The sign-in was revoked. Re-link the account.');
    },
    listScopes: async () => ['inbox'],
    listChangesSince: async (_scope, cursor) => {
      if (upstream.unreachable) {
        const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.test'), {
          code: 'ENOTFOUND',
          hostname: 'api.example.test',
        });
        throw new TypeError('fetch failed', { cause });
      }
      const seen = new Set(Array.isArray(cursor) ? (cursor as string[]) : []);
      return {
        records: upstream.items.filter((i) => !seen.has(i.id)).map((i) => ({ id: i.id })),
        cursor: upstream.items.filter((i) => !i.fail).map((i) => i.id),
      };
    },
    fetchRecord: async (_scope: string, ref: RecordRef): Promise<NormalizedRecord> => {
      const hold = upstream.hold;
      if (hold && ++hold.fetched > hold.after) await hold.release;
      const item = upstream.items.find((i) => i.id === ref.id)!;
      if (item.fail) throw new Error(`cannot parse ${item.id}`);
      return {
        recordId: item.id,
        dirSegments: [],
        fileStem: item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        frontmatter: { title: item.title, direction: 'inbound' },
        bodyMarkdown: item.body,
        scanOrigin: 'test',
        quarantineNamespace: TYPE_ID,
        quarantineLabel: item.title,
      };
    },
    runAction: async (action, input) => {
      upstream.committed.push({ action, input });
      return { ok: true, id: `remote-${upstream.committed.length}` };
    },
    close: async () => {},
  };
});

// A consent scope the test controls: allowed only when the draft says so.
registerConsentEnforcer('route-test-consent', (ctx) =>
  (ctx.input as { approve?: unknown })?.approve === true
    ? { ok: true }
    : { ok: false, reason: 'the draft was not approved' },
);

async function writeLocalConnectorType(
  home: string,
  id: string,
  version: Record<string, unknown>,
): Promise<void> {
  const dir = join(home, 'connector-types', id.slice(0, 2), id);
  await mkdir(join(dir, 'versions', '1.0.0'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'connector-type',
      id,
      name: `Route test ${id}`,
      description: 'A connector type that exists only for the route tests.',
      tags: ['test'],
      maintainer: { name: 'Gezel' },
    }),
  );
  await writeFile(
    join(dir, 'versions', '1.0.0', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-10-19T00:00:00Z',
      ...version,
    }),
  );
}

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;
const PROJECT = 'default';

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-connector-routes-'));
  await writeLocalConnectorType(home, TYPE_ID, {
    driver: 'native',
    source: { adapterId: ADAPTER_ID },
    configSchema: {
      type: 'object',
      properties: { address: { type: 'string' }, mode: { enum: ['fast', 'slow'] } },
      required: ['address'],
    },
    secretShape: { kind: 'apikey', field: 'token', label: 'Token' },
    normalize: { kind: 'native' },
    actions: [{ name: 'note', consentScope: 'route-test-consent' }],
    completeness: 'window',
  });
  await writeLocalConnectorType(home, OAUTH_TYPE_ID, {
    driver: 'native',
    source: { adapterId: ADAPTER_ID },
    secretShape: {
      kind: 'oauth2',
      authorizeUrl: 'https://auth.example.test/authorize',
      tokenUrl: 'https://auth.example.test/token',
      scopes: 'read',
      clientIdEnv: 'GEZEL_ROUTE_TEST_CLIENT_ID',
    },
    normalize: { kind: 'native' },
  });
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

beforeEach(async () => {
  upstream.items = [];
  upstream.committed = [];
  upstream.credentialsSeen = [];
  upstream.hold = null;
  upstream.unreachable = false;
  // Every test starts from a project with no bindings.
  const project = await svc.context.store.getProject(PROJECT);
  for (const b of project?.connectors ?? []) {
    await call('DELETE', `/connectors/${encodeURIComponent(b.id)}`);
  }
});

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: boolean; project?: string } = {},
): Promise<{ status: number; body: T }> {
  const res = await httpFetch(`${baseUrl}/api/projects/${opts.project ?? PROJECT}${path}`, {
    method,
    headers: {
      ...(opts.auth === false ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface BindingView {
  id: string;
  type: string;
  corpusDir: string;
  lastSyncedAt?: string;
  lastError?: string;
}

async function bind(extra: Record<string, unknown> = {}): Promise<BindingView> {
  const res = await call<{ binding: BindingView }>('POST', '/connectors/bind', {
    type: TYPE_ID,
    displayName: 'Support inbox',
    config: { address: 'help@example.com' },
    credential: { token: 'super-secret-token' },
    ...extra,
  });
  expect(res.status).toBe(200);
  return res.body.binding;
}

describe('/api/projects/:id/connectors', () => {
  it('rejects unauthenticated callers and unknown projects', async () => {
    expect((await call('GET', '/connectors', undefined, { auth: false })).status).toBe(401);
    expect(
      (await call('GET', '/connectors', undefined, { project: 'no-such-project' })).status,
    ).toBe(404);
  });

  it("says which catalog types Gezel's own sign-in app can connect", async () => {
    const app = async (type: string) =>
      (
        await call<{ key: string | null; builtin: boolean }>(
          'GET',
          `/connectors/oauth-app?type=${type}`,
        )
      ).body;
    const microsoft = 'GEZEL_MICROSOFT_CLIENT_ID';
    for (const type of ['calendar-microsoft', 'files-onedrive', 'files-sharepoint']) {
      expect(await app(type)).toEqual({ key: microsoft, builtin: true });
    }
    // Mail asks to send and edit; Gezel's app only reads.
    expect(await app('mail-microsoft365')).toEqual({ key: microsoft, builtin: false });
    // This build has no Google release file.
    expect((await app('calendar-google')).builtin).toBe(false);
    // A local type never gets Gezel's app, whatever it asks for.
    expect(await app(OAUTH_TYPE_ID)).toEqual({
      key: 'GEZEL_ROUTE_TEST_CLIENT_ID',
      builtin: false,
    });
    // A type that does not sign in through OAuth has no app at all.
    expect(await app(TYPE_ID)).toEqual({ key: null, builtin: false });
    expect((await call('GET', '/connectors/oauth-app')).status).toBe(400);
  });

  it('a project with no bindings reports unconfigured', async () => {
    const res = await call<{ configured: boolean; bindings: unknown[] }>('GET', '/connectors');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, bindings: [] });
  });

  it('bind validates config against the type schema with a field-level 400', async () => {
    const missing = await call<{ error: string }>('POST', '/connectors/bind', {
      type: TYPE_ID,
      config: {},
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/address: required/);
    const badEnum = await call<{ error: string }>('POST', '/connectors/bind', {
      type: TYPE_ID,
      config: { address: 'a@b.test', mode: 'warp' },
    });
    expect(badEnum.status).toBe(400);
    expect(badEnum.body.error).toMatch(/mode/);
    const unknownType = await call('POST', '/connectors/bind', { type: 'no-such-type' });
    expect(unknownType.status).toBe(400);
  });

  it('bind keeps the credential in the SecretStore — never on the project or in any response', async () => {
    const binding = await bind();
    expect(binding.corpusDir).toBe('data/support-inbox');
    const stored = await svc.context.secrets.get(connectorSecretKey(TYPE_ID, binding.id));
    expect(JSON.parse(stored!)).toEqual({ token: 'super-secret-token' });
    const project = await svc.context.store.getProject(PROJECT);
    expect(JSON.stringify(project)).not.toContain('super-secret-token');
    expect(project?.connectors?.[0]).not.toHaveProperty('credential');
    const status = await call('GET', '/connectors');
    expect(JSON.stringify(status.body)).not.toContain('super-secret-token');
  });

  it('sync writes the corpus under artifacts, persists the cursor, and resumes', async () => {
    const binding = await bind();
    upstream.items = [
      { id: 'm1', title: 'Quarterly review', body: 'Numbers attached.' },
      { id: 'm2', title: 'Lunch', body: 'Noon?' },
    ];
    const first = await call<{ result: { written: number; errors: number } }>(
      'POST',
      `/connectors/${encodeURIComponent(binding.id)}/sync`,
    );
    expect(first.status).toBe(200);
    expect(first.body.result).toMatchObject({ written: 2, errors: 0 });
    expect(upstream.credentialsSeen).toEqual([JSON.stringify({ token: 'super-secret-token' })]);

    const records = await readCorpus(
      svc.context.store.projectArtifactsDir(PROJECT),
      `${binding.corpusDir}/inbox`,
    );
    expect(records.map((r) => r.frontmatter.title).sort()).toEqual(['Lunch', 'Quarterly review']);
    expect(records.every((r) => r.frontmatter.trust === 'untrusted-external')).toBe(true);

    const meta = JSON.parse(
      await readFile(
        join(svc.context.store.projectArtifactsDir(PROJECT), binding.corpusDir, '_meta.json'),
        'utf8',
      ),
    );
    expect(meta).toMatchObject({ type: TYPE_ID, completeness: 'window', scopes: ['inbox'] });

    upstream.items.push({ id: 'm3', title: 'New one', body: 'hi' });
    const second = await call<{ result: { written: number } }>(
      'POST',
      `/connectors/${encodeURIComponent(binding.id)}/sync`,
    );
    expect(second.body.result.written).toBe(1);

    const status = await call<{ bindings: BindingView[] }>('GET', '/connectors');
    expect(status.body.bindings[0]).toMatchObject({ id: binding.id, completeness: 'window' });
    expect(status.body.bindings[0]!.lastSyncedAt).toBeTruthy();
    expect(status.body.bindings[0]!.lastError).toBeUndefined();
  });

  it('a pass that lands most records still says which ones failed', async () => {
    const binding = await bind();
    upstream.items = [
      { id: 'ok', title: 'Fine', body: 'fine' },
      { id: 'bad', title: 'Broken', body: '', fail: true },
    ];
    await call('POST', `/connectors/${encodeURIComponent(binding.id)}/sync`);
    const status = await call<{ bindings: BindingView[] }>('GET', '/connectors');
    expect(status.body.bindings[0]!.lastSyncedAt).toBeTruthy();
    expect(status.body.bindings[0]!.lastError).toMatch(/1 record\(s\) could not be synced/);
  });

  it('a hard auth failure lands in lastError with the actionable message', async () => {
    const binding = await bind({ credential: 'revoked' });
    const res = await call<{ result: { error?: string } }>(
      'POST',
      `/connectors/${encodeURIComponent(binding.id)}/sync`,
    );
    expect(res.status).toBe(200);
    expect(res.body.result.error).toMatch(/Re-link/);
    const status = await call<{ bindings: BindingView[] }>('GET', '/connectors');
    expect(status.body.bindings[0]!.lastError).toMatch(/Re-link/);
  });

  it('draft → queue → commit runs the action only through its consent scope', async () => {
    const binding = await bind();
    const undeclared = await call<{ error: string }>(
      'POST',
      `/connectors/${encodeURIComponent(binding.id)}/actions`,
      { action: 'delete-everything', input: {} },
    );
    expect(undeclared.status).toBe(400);
    expect(undeclared.body.error).toMatch(
      /declares no action 'delete-everything'.*available: note/,
    );

    const draft = await call<{ draftId: string; relPath: string }>(
      'POST',
      `/connectors/${encodeURIComponent(binding.id)}/actions`,
      { action: 'note', input: { text: 'hello', approve: false } },
    );
    expect(draft.status).toBe(200);
    expect(draft.body.relPath).toMatch(/^data\/support-inbox\/_actions\/_drafts\//);

    const pending = await call<{ pending: { draftId: string; status: string }[] }>(
      'GET',
      '/connectors/actions',
    );
    expect(pending.body.pending).toEqual([
      expect.objectContaining({ draftId: draft.body.draftId, status: 'draft' }),
    ]);

    const queued = await call('POST', `/connectors/actions/${draft.body.draftId}/queue`);
    expect(queued.status).toBe(200);

    const denied = await call<{ error: string }>(
      'POST',
      `/connectors/actions/${draft.body.draftId}/commit`,
    );
    expect(denied.status).toBe(400);
    expect(denied.body.error).toMatch(/commit denied: the draft was not approved/);
    expect(upstream.committed).toEqual([]);

    // The human edits the reviewable draft file to approve it, then commits.
    const artifacts = svc.context.store.projectArtifactsDir(PROJECT);
    const outboxPath = join(
      artifacts,
      binding.corpusDir,
      '_actions',
      '_outbox',
      `${draft.body.draftId}.md`,
    );
    const outbox = await readFile(outboxPath, 'utf8');
    await writeFile(outboxPath, outbox.replace('"approve": false', '"approve": true'));

    const committed = await call<{ status: string; result: { id: string } }>(
      'POST',
      `/connectors/actions/${draft.body.draftId}/commit`,
    );
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({ status: 'committed', result: { id: 'remote-1' } });
    expect(upstream.committed).toEqual([
      { action: 'note', input: { text: 'hello', approve: true } },
    ]);
    const sent = await readFile(
      join(artifacts, binding.corpusDir, '_actions', '_sent', `${draft.body.draftId}.md`),
      'utf8',
    );
    expect(sent).toMatch(/status: sent/);
    const after = await call<{ pending: unknown[] }>('GET', '/connectors/actions');
    expect(after.body.pending).toEqual([]);
  });

  // A consent scope is a standing permission on the connection, so the hold is
  // what stops an unattended run. It keyed on the night shift alone, and a
  // daytime scheduled task's commit went straight out.
  it("holds a gezel's commit unless the person started the turn", async () => {
    const binding = await bind();
    const gezel = await svc.context.store.createGezel({ name: 'Rosa', role: 'Writer' });
    const sessionToken = svc.context.tokenStore.issueSession({
      appId: 'session:attend-1',
      projectId: PROJECT,
      gezelId: gezel.id,
      team: false,
    }).token;
    const commitAsSession = async (draftId: string) => {
      const res = await httpFetch(
        `${baseUrl}/api/projects/${PROJECT}/connectors/actions/${draftId}/commit`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
        },
      );
      return { status: res.status, body: (await res.json()) as { status?: string } };
    };
    const draft = async () =>
      (
        await call<{ draftId: string }>(
          'POST',
          `/connectors/${encodeURIComponent(binding.id)}/actions`,
          { action: 'note', input: { text: 'hello', approve: true } },
        )
      ).body.draftId;

    const turn = vi.spyOn(svc.context.chat, 'isUserDirectedTurn').mockReturnValue(false);
    const priorPolicy = (await svc.context.store.readConfig()).securityPolicy ?? null;
    // A gezel's commit needs external services before the hold is reached.
    await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
    try {
      const unattended = await commitAsSession(await draft());
      expect(unattended).toMatchObject({ status: 200, body: { status: 'held-for-approval' } });
      expect(upstream.committed).toEqual([]);
      expect(turn).toHaveBeenCalledWith('attend-1');

      turn.mockReturnValue(true);
      const asked = await commitAsSession(await draft());
      expect(asked).toMatchObject({ status: 200, body: { status: 'committed' } });
      expect(upstream.committed).toHaveLength(1);
    } finally {
      turn.mockRestore();
      await svc.context.store.writeConfig({ securityPolicy: priorPolicy });
    }
  });

  it('discarding a draft removes it; committing a missing draft is a 400', async () => {
    const binding = await bind();
    const draft = await call<{ draftId: string }>(
      'POST',
      `/connectors/${encodeURIComponent(binding.id)}/actions`,
      { action: 'note', input: { approve: true } },
    );
    expect((await call('DELETE', `/connectors/actions/${draft.body.draftId}`)).status).toBe(204);
    const commit = await call<{ error: string }>(
      'POST',
      `/connectors/actions/${draft.body.draftId}/commit`,
    );
    expect(commit.status).toBe(400);
    expect(commit.body.error).toMatch(/no connector action draft/);
  });

  it('unbind removes the binding and its credential', async () => {
    const binding = await bind();
    expect((await call('DELETE', `/connectors/${encodeURIComponent(binding.id)}`)).status).toBe(
      204,
    );
    expect(await svc.context.secrets.get(connectorSecretKey(TYPE_ID, binding.id))).toBeNull();
    const status = await call<{ bindings: unknown[] }>('GET', '/connectors');
    expect(status.body.bindings).toEqual([]);
  });

  it('counts the records a connection holds, climbing while it syncs', async () => {
    interface Row {
      id: string;
      corpusDir?: string;
      items?: number;
      syncing?: boolean;
    }
    const row = async (id: string) =>
      (await call<{ bindings: Row[] }>('GET', '/connectors')).body.bindings.find(
        (b) => b.id === id,
      );
    const binding = await bind({ displayName: 'Counted inbox' });
    expect(await row(binding.id)).toMatchObject({ corpusDir: binding.corpusDir, items: 0 });

    upstream.items = [
      { id: 'm1', title: 'First', body: 'one' },
      { id: 'm2', title: 'Second', body: 'two' },
      { id: 'm3', title: 'Third', body: 'three' },
    ];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    upstream.hold = { after: 1, fetched: 0, release: gate };
    const syncing = call('POST', `/connectors/${encodeURIComponent(binding.id)}/sync`);
    let midway: Row | undefined;
    for (let i = 0; i < 100; i++) {
      midway = await row(binding.id);
      if (midway?.items === 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(midway).toMatchObject({ items: 1, syncing: true });
    release();
    expect((await syncing).status).toBe(200);

    const after = await row(binding.id);
    expect(after?.items).toBe(3);
    expect(after?.syncing).toBeUndefined();
    const meta = JSON.parse(
      await readFile(
        join(svc.context.store.projectArtifactsDir(PROJECT), binding.corpusDir, '_meta.json'),
        'utf8',
      ),
    );
    expect(meta.records).toBe(3);

    // A quiet pass keeps the count; a record the source drops is not counted twice.
    await call('POST', `/connectors/${encodeURIComponent(binding.id)}/sync`);
    expect((await row(binding.id))?.items).toBe(3);
  });

  it('waits calmly while the service cannot be reached, and catches up after', async () => {
    interface Row {
      id: string;
      lastError?: string;
      lastSyncedAt?: string;
      unreachable?: { since: string; offline: boolean; host?: string };
    }
    const row = async (id: string) =>
      (await call<{ bindings: Row[] }>('GET', '/connectors')).body.bindings.find(
        (b) => b.id === id,
      );
    const binding = await bind({ displayName: 'Plane inbox' });
    const sync = () =>
      call<{ result: { error?: string; unreachable?: unknown } }>(
        'POST',
        `/connectors/${encodeURIComponent(binding.id)}/sync`,
      );
    upstream.items = [{ id: 'm1', title: 'Boarding pass', body: 'Gate 12' }];

    upstream.unreachable = true;
    const first = await sync();
    expect(first.body.result.error).toMatch(/^Couldn't reach api\.example\.test: /);
    const waiting = await row(binding.id);
    expect(waiting?.lastError).toBeUndefined();
    expect(waiting?.unreachable).toMatchObject({ host: 'api.example.test' });
    const since = waiting?.unreachable?.since;
    expect(since).toBeTruthy();

    await new Promise((r) => setTimeout(r, 5));
    await sync();
    expect((await row(binding.id))?.unreachable?.since).toBe(since);
    expect(svc.context.connectors.retryWaiting()).toBeGreaterThan(0);

    upstream.unreachable = false;
    await sync();
    const back = await row(binding.id);
    expect(back?.unreachable).toBeUndefined();
    expect(back?.lastError).toBeUndefined();
    expect(back?.lastSyncedAt).toBeTruthy();
  });

  it('says what a connection downloaded, and deletes it only when asked', async () => {
    const corpus = (b: BindingView) =>
      join(svc.context.store.projectArtifactsDir(PROJECT), b.corpusDir);
    const exists = (p: string) =>
      readFile(join(p, '_meta.json')).then(
        () => true,
        () => false,
      );
    upstream.items = [{ id: 'm1', title: 'Quarterly review', body: 'Numbers attached.' }];

    const kept = await bind();
    await call('POST', `/connectors/${encodeURIComponent(kept.id)}/sync`);
    expect((await call('DELETE', `/connectors/${encodeURIComponent(kept.id)}`)).status).toBe(204);
    expect(await exists(corpus(kept))).toBe(true);
    await rm(corpus(kept), { recursive: true, force: true });

    const gone = await bind();
    await call('POST', `/connectors/${encodeURIComponent(gone.id)}/sync`);
    const stored = await call<{ files: number; bytes: number }>(
      'GET',
      `/connectors/${encodeURIComponent(gone.id)}/stored`,
    );
    expect(stored.body.files).toBeGreaterThan(0);
    expect(stored.body.bytes).toBeGreaterThan(0);
    const removed = await call<{ ok: boolean; deleted: { files: number } }>(
      'DELETE',
      `/connectors/${encodeURIComponent(gone.id)}?deleteData=1`,
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ ok: true, deleted: { files: stored.body.files } });
    expect(await exists(corpus(gone))).toBe(false);
  });

  it('refuses to start an OAuth link from a non-bundled manifest', async () => {
    process.env.GEZEL_ROUTE_TEST_CLIENT_ID = 'client';
    try {
      const res = await call<{ error: string }>('POST', '/connectors/oauth/start', {
        type: OAUTH_TYPE_ID,
        redirectUri: 'http://127.0.0.1:1/callback',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/untrusted catalog source/);
    } finally {
      delete process.env.GEZEL_ROUTE_TEST_CLIENT_ID;
    }
  });

  it('completing an unknown OAuth state is a clear 400', async () => {
    const res = await call<{ error: string }>('POST', '/connectors/oauth/complete', {
      state: 'never-issued',
      code: 'x',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/state not found or expired/);
  });
});
