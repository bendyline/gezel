import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandboekArticle, HandboekToc } from '@bendyline/gezel';
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
  home = await mkdtemp(join(tmpdir(), 'gezel-handboek-'));
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

function api(method: string, path: string) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('GET /api/handboek', () => {
  it('rejects unauthenticated access', async () => {
    const res = await httpFetch(`${baseUrl}/api/handboek/toc`);
    expect(res.status).toBe(401);
  });

  it('serves the TOC with curated and generated areas', async () => {
    const res = await api('GET', '/api/handboek/toc');
    expect(res.status).toBe(200);
    const toc = (await res.json()) as HandboekToc;
    const areaIds = toc.areas.map((a) => a.area);
    expect(areaIds).toContain('conceptual');
    expect(areaIds).toContain('gezel-roles');
    const conceptual = toc.areas.find((a) => a.area === 'conceptual')!;
    expect(conceptual.entries[0]!.id).toBe('welcome');
    const roles = toc.areas.find((a) => a.area === 'gezel-roles')!;
    expect(roles.entries.filter((e) => e.id === 'role/meester')).toHaveLength(1);
  });

  it('serves a personalized article in app mode (default)', async () => {
    // The fresh install auto-creates a Meester, so the crew article can
    // name them and carry their figure.
    const res = await api('GET', '/api/handboek/article/the-crew');
    expect(res.status).toBe(200);
    const article = (await res.json()) as HandboekArticle;
    expect(article.title).toBe('Your crew: gezellen, the Meester, and the Voorman');
    expect(article.markdown).toContain('Your Meester is **');
    expect(article.markdown).not.toContain('::handboek-');
    expect(article.figures.length).toBeGreaterThan(0);
    expect(article.figures[0]!.path).toMatch(/^poppetje\/.+\.headshot\.svg$/);
  });

  it('serves slash ids and site mode without personal data', async () => {
    const res = await api('GET', '/api/handboek/article/role/meester?mode=site');
    expect(res.status).toBe(200);
    const article = (await res.json()) as HandboekArticle;
    expect(article.id).toBe('role/meester');
    expect(article.generated).toBe(false);
    expect(article.figures).toHaveLength(0);
    expect(article.markdown).toContain('| Tool group | Purpose | Tools |');
  });

  it('404s unknown articles', async () => {
    const res = await api('GET', '/api/handboek/article/never-heard-of-it');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/handboek/how-do-i', () => {
  it('returns agent-tailored articles for a plain-language question', async () => {
    const res = await api(
      'GET',
      '/api/handboek/how-do-i?q=what%20craftbooks%20can%20my%20crew%20follow',
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      results: Array<{ id: string; markdown: string; figures: unknown[] }>;
    };
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.some((r) => r.id.includes('craftbook'))).toBe(true);
    for (const r of data.results) {
      expect(r.figures).toHaveLength(0);
      expect(r.markdown).not.toContain('::handboek-');
    }
  });

  it('400s without a question', async () => {
    const res = await api('GET', '/api/handboek/how-do-i');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/handboek/narration', () => {
  it('builds a per-block manifest, serves audio, and caches segments', async () => {
    const res = await api('GET', '/api/handboek/narration/article/welcome');
    expect(res.status).toBe(200);
    const manifest = (await res.json()) as {
      articleId: string;
      segments: Array<{ blockId: string; hash: string; durationMs: number }>;
    };
    expect(manifest.articleId).toBe('welcome');
    expect(manifest.segments.length).toBeGreaterThan(0);
    for (const seg of manifest.segments) {
      expect(seg.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(seg.durationMs).toBeGreaterThan(0);
    }

    const audio = await api('GET', `/api/handboek/narration/audio/${manifest.segments[0]!.hash}`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toContain('audio/wav');
    const bytes = new Uint8Array(await audio.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');

    // Second call is served from the on-disk cache — same hashes.
    const again = (await (await api('GET', '/api/handboek/narration/article/welcome')).json()) as {
      segments: Array<{ hash: string }>;
    };
    expect(again.segments.map((s) => s.hash)).toEqual(manifest.segments.map((s) => s.hash));
  });

  it('404s unknown narration hashes', async () => {
    const res = await api('GET', `/api/handboek/narration/audio/${'0'.repeat(64)}`);
    expect(res.status).toBe(404);
  });
});
