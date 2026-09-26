import { describe, expect, it } from 'vitest';
import { TOKEN_KEY } from './auth.js';
import { type BootState, bootPane, pickDefaultGezel } from './boot.js';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

type Route = (init: RequestInit | undefined, url: URL) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(key);
    const route = routes[key];
    if (!route) return new Response('not found', { status: 404 });
    return route(init, url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PROJECT = {
  id: 'docs',
  name: 'Documents',
  workingDir: '/Users/me/Documents',
  voormanGezelId: 'lead',
};
const HAPPY = {
  'GET /api/config': () => json({ meesterGezelId: 'meester' }),
  'POST /api/projects/infer-for-path': () =>
    json({
      project: PROJECT,
      created: true,
      matchedBy: 'well-known',
      readOnly: true,
      warnings: [],
    }),
  'GET /api/gezels': () =>
    json({
      gezels: [
        { id: 'lead', name: 'Lead' },
        { id: 'meester', name: 'Meester' },
      ],
    }),
};

async function run(
  routes: Record<string, Route>,
  storage = memoryStorage(),
  path: string | null = '/Users/me/Documents/a.docx',
) {
  const { fetchImpl, calls } = fakeFetch(routes);
  const states: BootState[] = [];
  const ready = await bootPane(
    {
      fetch: fetchImpl,
      baseUrl: 'https://localhost:4000',
      storage,
      documentPath: path,
      grantTimeoutMs: 5_000,
    },
    (s) => states.push(s),
  );
  return { ready, states, calls, storage };
}

describe('bootPane', () => {
  it('reuses a working token and resolves the project and default gezel', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'tok' });
    const { ready, calls } = await run(HAPPY, storage);
    expect(ready).toMatchObject({
      token: 'tok',
      gezelId: 'lead',
      matchedBy: 'well-known',
      edits: true,
    });
    expect(ready?.project).toMatchObject({ id: 'docs', readOnly: true });
    expect(calls).not.toContain('POST /v1/apps/register');
  });

  it('asks for a connection code on first run and stores the approved token', async () => {
    const { ready, states, storage } = await run({
      ...HAPPY,
      'POST /v1/apps/register': (init) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({ appId: 'office', scopes: ['product'] });
        return json(
          {
            grantRequestId: 'g1',
            status: 'pending',
            verificationRequired: true,
            verificationCode: 'ABC123',
          },
          202,
        );
      },
      'GET /v1/apps/grant/g1': () => json({ status: 'approved', token: 'fresh' }),
    });
    expect(states).toContainEqual({ kind: 'code', code: 'ABC123' });
    expect(ready?.token).toBe('fresh');
    expect(storage.map.get(TOKEN_KEY)).toBe('fresh');
  });

  it('drops a revoked token and connects again', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'old' });
    let first = true;
    const { ready } = await run(
      {
        ...HAPPY,
        'GET /api/config': () => {
          if (first) {
            first = false;
            return json({ error: 'unauthorized' }, 401);
          }
          return json({});
        },
        'POST /v1/apps/register': () =>
          json({ grantRequestId: 'g2', status: 'pending', verificationCode: 'X' }, 202),
        'GET /v1/apps/grant/g2': () => json({ status: 'approved', token: 'new' }),
      },
      storage,
    );
    expect(ready?.token).toBe('new');
  });

  it.each([
    ['denied', 'denied'],
    ['expired', 'expired'],
  ] as const)('reports a %s grant', async (status, kind) => {
    const { ready, states } = await run({
      'POST /v1/apps/register': () =>
        json({ grantRequestId: 'g', status: 'pending', verificationCode: 'X' }, 202),
      'GET /v1/apps/grant/g': () => json({ status }),
    });
    expect(ready).toBeNull();
    expect(states.at(-1)).toEqual({ kind });
  });

  it('explains an existing grant it cannot recover', async () => {
    const { states } = await run({
      'POST /v1/apps/register': () => json({ error: 'already_connected' }, 409),
    });
    expect(states.at(-1)).toEqual({ kind: 'needs-revoke' });
  });

  it('says so when Gezel is not running', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'tok' });
    const failing = {
      'GET /api/config': () => Promise.reject(new TypeError('Failed to fetch')),
    } as Record<string, Route>;
    const { states } = await run(failing, storage);
    expect(states.at(-1)).toEqual({ kind: 'daemon-down' });
    expect(storage.map.get(TOKEN_KEY)).toBe('tok');
  });

  it('sends no path for an unsaved document and remembers choices per path', async () => {
    const storage = memoryStorage({ [TOKEN_KEY]: 'tok' });
    let sentBody: Record<string, unknown> = {};
    await run(
      {
        ...HAPPY,
        'POST /api/projects/infer-for-path': (init) => {
          sentBody = JSON.parse(String(init?.body));
          return json({
            project: { id: 'default', name: 'Default' },
            created: false,
            matchedBy: 'default',
            readOnly: false,
            warnings: [],
          });
        },
      },
      storage,
      null,
    );
    expect(sentBody).toEqual({ kind: 'document', source: 'office' });
  });
});

describe('pickDefaultGezel', () => {
  const roster = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
    { id: 'm', name: 'M' },
  ];
  it('prefers remembered, then lead, then members, then Meester, then anyone', () => {
    expect(
      pickDefaultGezel(
        { id: 'p', name: 'P', readOnly: true, voormanGezelId: 'a' },
        roster,
        'm',
        'b',
      ),
    ).toBe('b');
    expect(
      pickDefaultGezel(
        { id: 'p', name: 'P', readOnly: true, voormanGezelId: 'a' },
        roster,
        'm',
        'gone',
      ),
    ).toBe('a');
    expect(
      pickDefaultGezel(
        { id: 'p', name: 'P', readOnly: true, gezelIds: ['x', 'b'] },
        roster,
        'm',
        undefined,
      ),
    ).toBe('b');
    expect(pickDefaultGezel({ id: 'p', name: 'P', readOnly: true }, roster, 'm', undefined)).toBe(
      'm',
    );
    expect(
      pickDefaultGezel({ id: 'p', name: 'P', readOnly: true }, roster, undefined, undefined),
    ).toBe('a');
    expect(pickDefaultGezel({ id: 'p', name: 'P', readOnly: true }, [], undefined, undefined)).toBe(
      '',
    );
  });
});
