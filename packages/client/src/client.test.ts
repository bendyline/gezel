import { describe, expect, it, vi } from 'vitest';
import { GezelApiError, GezelClient } from './client.js';

describe('GezelClient task refs', () => {
  it('rejects malformed task refs without throwing synchronously', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    const request = client.getTaskByRef('Spanish Lang');

    await expect(request).rejects.toThrow('invalid task ref "Spanish Lang"');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('GezelClient health', () => {
  it('forwards an AbortSignal to the health request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(
        JSON.stringify({ ok: true, startedAt: '2026-01-01T00:00:00.000Z', version: '1.0.0' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await expect(client.health(controller.signal)).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('wraps fetch failures as an explicit internal transport error with the cause', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:43123'), {
      code: 'ECONNREFUSED',
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), { cause }),
      ) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    const error = await client.health().catch((err) => err);
    expect(error).toBeInstanceOf(GezelApiError);
    expect(error.status).toBe(0);
    expect(error.message).toContain('Gezel API transport unavailable on GET /api/health');
    expect(error.message).toContain('fetch failed');
    expect(error.message).toContain('ECONNREFUSED');
  });
});

describe('GezelClient workspace binary writes', () => {
  it('sends raw bytes through the authenticated workspace endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://test/api/projects/demo/workspace/raw?path=report.pdf');
      expect(init?.method).toBe('PUT');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/pdf');
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      return Response.json({ ok: true, path: 'report.pdf' });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await expect(
      client.writeProjectWorkspaceBinary(
        'demo',
        'report.pdf',
        new Uint8Array([1, 2, 3]),
        'application/pdf',
      ),
    ).resolves.toEqual({ ok: true, path: 'report.pdf' });
  });

  it('requests create-only publication for a restorable backup', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        'http://test/api/projects/demo/workspace/raw?path=report_files%2F.original%2Foriginal.pdf&create=1',
      );
      return Response.json({ ok: true, path: 'report_files/.original/original.pdf' });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await client.writeProjectWorkspaceBinary(
      'demo',
      'report_files/.original/original.pdf',
      new Uint8Array([1, 2, 3]),
      'application/pdf',
      { createOnly: true },
    );
  });
});

describe('GezelClient project preview', () => {
  it('forwards cancellation to both repository and Klerk draft requests', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      if (String(url).endsWith('/api/system/github-repo-preview')) {
        return Response.json({
          owner: 'octocat',
          repo: 'demo',
          canonicalUrl: 'https://github.com/octocat/demo',
          readme: '# Demo',
          readmeTruncated: false,
        });
      }
      return Response.json({
        about: 'A sufficiently detailed description of this demonstration project and its scope.',
        missionObjectives: 'Deliver the demonstration project with its primary workflows working.',
      });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await client.previewGitHubRepo('https://github.com/octocat/demo', controller.signal);
    await client.previewProjectAbout(
      {
        name: 'Demo',
        repoUrl: 'https://github.com/octocat/demo',
        readme: '# Demo',
      },
      controller.signal,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('GezelClient model inventory', () => {
  it('can explicitly bypass the daemon model-list cache', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://test/api/models?provider=llama-cpp&refresh=1');
      return Response.json({ provider: 'llama-cpp', models: [] });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await client.listProviderModels('llama-cpp', { refresh: true });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('GezelClient shared model migration', () => {
  it('uses the typed candidate and move endpoints', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/model-migrations/candidates?engine=mlx')) {
        expect(init?.method).toBe('GET');
        return Response.json({ available: true, candidates: [] });
      }
      expect(String(url)).toBe('http://test/api/model-migrations/move');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        source: 'development',
        engine: 'mlx',
        id: 'model-id',
      });
      return Response.json({ ok: true, engine: 'mlx', id: 'model-id', localRemoved: true });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await expect(client.listSharedModelMigrationCandidates('mlx')).resolves.toEqual({
      available: true,
      candidates: [],
    });
    await expect(
      client.moveModelToShared({ source: 'development', engine: 'mlx', id: 'model-id' }),
    ).resolves.toMatchObject({ ok: true, localRemoved: true });
  });
});

describe('GezelClient typed project creation', () => {
  it('uses the server-owned atomic creation endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://test/api/projects/typed');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        name: 'Spanish Practice',
        projectType: { typeId: 'language-trainer', params: { language: 'Spanish' } },
      });
      return new Response(JSON.stringify({ project: { id: 'spanish-practice' }, applied: {} }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await client.createTypedProject({
      name: 'Spanish Practice',
      projectType: { typeId: 'language-trainer', params: { language: 'Spanish' } },
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
