import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-history-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function api(method: string, path: string, body?: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

type Event = {
  id: string;
  at: string;
  kind: string;
  summary: string;
  projectId?: string;
  gezelId?: string;
};

async function listEvents(query = ''): Promise<Event[]> {
  const res = await api('GET', `/api/history?include=events${query ? `&${query}` : ''}`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as { events: Event[] };
  return data.events;
}

describe('GET /api/history', () => {
  // Drive the mutations once at the top so every test sees the same
  // sequence. The route surface is read-only (no POST), so a single
  // mutation phase + multiple read assertions is the simplest shape.
  beforeAll(async () => {
    // Two gezels — generates two `gezel.created` events.
    await api('POST', '/api/gezels', { name: 'HistAlpha' });
    await api('POST', '/api/gezels', { name: 'HistBeta' });
    // Rename one of them — generates `gezel.renamed`.
    await api('POST', '/api/gezels/histbeta/rename', { name: 'HistGamma' });
    // Create a project — generates `project.created`.
    await api('POST', '/api/projects', {
      name: 'HistProj',
      about: 'A project used by the history-route tests to exercise filter shapes.',
      missionObjectives: 'Project-scoped events appear under ?project=histproj.',
    });
    await svc.context.history.log({
      kind: 'tool.gated',
      projectId: 'histproj',
      summary: '[PreToolUse] rm: ask',
      details: { craftbookId: 'careful-mode', decision: 'ask', tool: 'rm' },
    });
  });

  it('returns the events stream with include=events', async () => {
    const events = await listEvents();
    // Expect at least the four mutations above to be present.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('gezel.created');
    expect(kinds).toContain('gezel.renamed');
    expect(kinds).toContain('project.created');
  });

  it('returns entries (events + sessions) when include is omitted', async () => {
    const res = await api('GET', '/api/history');
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      entries: Array<{ entryType: 'event' | 'session' }>;
    };
    expect(Array.isArray(data.entries)).toBe(true);
    // Every entry has an entryType discriminator. Without sessions in
    // this fixture, all entries are events; either way, every one must
    // carry the discriminator.
    for (const entry of data.entries) {
      expect(['event', 'session']).toContain(entry.entryType);
    }
  });

  it('newest-first ordering', async () => {
    const events = await listEvents();
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1]!.at >= events[i]!.at).toBe(true);
    }
  });

  it('filters by kind (single)', async () => {
    const events = await listEvents('kind=gezel.created');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.kind === 'gezel.created')).toBe(true);
  });

  it('filters newly-added canonical kinds without a route-local allowlist update', async () => {
    const events = await listEvents('kind=tool.gated');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool.gated',
      projectId: 'histproj',
      summary: '[PreToolUse] rm: ask',
    });
  });

  it('filters by kind (comma-separated)', async () => {
    const events = await listEvents('kind=gezel.created,gezel.renamed');
    expect(events.length).toBeGreaterThan(0);
    const distinct = new Set(events.map((e) => e.kind));
    expect(distinct.has('gezel.created') || distinct.has('gezel.renamed')).toBe(true);
    for (const e of events) {
      expect(['gezel.created', 'gezel.renamed']).toContain(e.kind);
    }
  });

  it('ignores unknown kinds in the filter (returns unfiltered set)', async () => {
    // The route's parseKinds drops unknown values; if every value is
    // unknown, it returns undefined → no kind filter applied.
    const events = await listEvents('kind=not.a.real.kind');
    const distinctKinds = new Set(events.map((e) => e.kind));
    expect(distinctKinds.size).toBeGreaterThan(1);
  });

  it('filters by project', async () => {
    const events = await listEvents('project=histproj');
    expect(events.length).toBeGreaterThan(0);
    // Project-scoped events carry projectId; global events (gezel.created)
    // appear in /history.jsonl (no projectId) and are still listed when
    // requesting global. Asking for ?project=histproj returns the union of
    // project file + global; the project file should at least include the
    // project.created event itself.
    expect(events.some((e) => e.kind === 'project.created' && e.projectId === 'histproj')).toBe(
      true,
    );
  });

  it('honors limit', async () => {
    const events = await listEvents('limit=2');
    expect(events.length).toBeLessThanOrEqual(2);
  });

  it('drops invalid limit (non-positive / non-numeric)', async () => {
    const all = await listEvents();
    const zero = await listEvents('limit=0');
    const garbage = await listEvents('limit=banana');
    expect(zero.length).toBe(all.length);
    expect(garbage.length).toBe(all.length);
  });
});
