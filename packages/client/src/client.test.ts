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

describe('GezelClient project error reset', () => {
  it('forwards cancellation to the clear-errors request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://test/api/projects/project-1/clear-errors');
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBe(controller.signal);
      return Response.json({ cleared: 1 });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await expect(client.clearProjectErrors('project-1', controller.signal)).resolves.toEqual({
      cleared: 1,
    });
  });
});

describe('GezelClient authenticated file blobs', () => {
  it.each([
    ['document', (client: GezelClient) => client.fetchDocumentBlob('missing.png')],
    ['artifact', (client: GezelClient) => client.fetchProjectArtifactBlob('p1', 'missing.png')],
    ['workspace', (client: GezelClient) => client.fetchProjectWorkspaceBlob('p1', 'missing.png')],
  ])('preserves a typed 404 for a missing %s file', async (_label, fetchBlob) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('missing', { status: 404 }));
    const client = new GezelClient({
      baseUrl: 'http://test',
      token: 't',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const error = await fetchBlob(client).catch((caught) => caught);
    expect(error).toBeInstanceOf(GezelApiError);
    expect(error.status).toBe(404);
  });
});

describe('GezelClient speech transcription', () => {
  it('forwards cancellation without serializing the AbortSignal into the audio request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://test/api/audio/transcribe');
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBe(controller.signal);
      expect(JSON.parse(String(init?.body))).toEqual({
        audio: { data: 'dm9pY2U=', mimeType: 'audio/webm' },
        projectId: 'demo',
      });
      return Response.json({ text: 'voice', durationMs: 1200 });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await expect(
      client.transcribeAudio({
        audio: { data: 'dm9pY2U=', mimeType: 'audio/webm' },
        projectId: 'demo',
        signal: controller.signal,
      }),
    ).resolves.toEqual({ text: 'voice', durationMs: 1200 });
  });
});

describe('GezelClient speech synthesis', () => {
  it('streams synthesis progress and returns the finished audio response', async () => {
    const controller = new AbortController();
    const progress = vi.fn();
    const chunks = vi.fn();
    const result = {
      artifactPath: 'artifacts/audio/tts.wav',
      b64Wav: 'UklGRg==',
      meta: {
        voice: 'af_heart',
        model: 'kokoro',
        sampleRate: 24_000,
        durationSeconds: 3,
        durationMs: 1500,
      },
    };
    const frames = [
      {
        type: 'progress',
        progress: {
          phase: 'synthesizing',
          completedCharacters: 8,
          totalCharacters: 12,
          completedChunks: 1,
        },
      },
      {
        type: 'chunk',
        chunk: {
          index: 0,
          b64Wav: 'UklGRg==',
          sampleRate: 24_000,
          durationSeconds: 1.2,
        },
      },
      { type: 'done', result },
    ];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://test/api/audio/synthesize-stream');
      expect(init?.method).toBe('POST');
      expect(init?.signal).toBe(controller.signal);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer t');
      expect(JSON.parse(String(init?.body))).toEqual({ text: 'Hello there.', inline: true });
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await expect(
      client.synthesizeSpeechWithProgress(
        { text: 'Hello there.', inline: true },
        { onProgress: progress, onChunk: chunks },
        controller.signal,
      ),
    ).resolves.toEqual(result);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ completedCharacters: 8, totalCharacters: 12 }),
    );
    expect(chunks).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, durationSeconds: 1.2 }),
    );
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

describe('GezelClient model bundle export', () => {
  it('forwards cancellation to the streaming export request', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://test/api/model-bundles/llama-cpp/demo/export');
      expect(init?.signal).toBe(controller.signal);
      return new Response('bundle');
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await expect(
      client.exportModelBundle('llama-cpp', 'demo', controller.signal),
    ).resolves.toBeInstanceOf(Response);
  });
});

describe('GezelClient model bundle import', () => {
  it('reports scan progress and forwards the scan identity and cancellation signal', async () => {
    const controller = new AbortController();
    const scanId = '11111111-1111-4111-8111-111111111111';
    const progress: Array<import('@bendyline/gezel').GezmodelImportProgress> = [];
    let progressPolls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith(`/imports/${scanId}/progress`)) {
        progressPolls += 1;
        if (progressPolls === 1) {
          return Response.json({
            status: 'active',
            progress: { phase: 'verifying', bytesCompleted: 40, bytesTotal: 100 },
          });
        }
        return Response.json({ status: 'complete', review: { importId: scanId } });
      }
      expect(href).toBe('http://test/api/model-bundles/imports/scan');
      expect(init?.signal).toBe(controller.signal);
      expect(new Headers(init?.headers).get('X-Gezel-Import-Id')).toBe(scanId);
      expect(new Headers(init?.headers).get('X-Gezel-Upload-Bytes')).toBe('100');
      expect(new Headers(init?.headers).get('Prefer')).toBe('respond-async');
      await new Promise((resolve) => setTimeout(resolve, 25));
      return Response.json({ importId: scanId }, { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GezelClient({ baseUrl: 'http://test', token: 't', fetch: fetchImpl });

    await client.scanModelBundle(new Uint8Array([1, 2, 3]), {
      scanId,
      totalBytes: 100,
      signal: controller.signal,
      onProgress: (next) => progress.push(next),
    });

    expect(progress[0]).toEqual({ phase: 'receiving', bytesCompleted: 0, bytesTotal: 100 });
    expect(progress).toContainEqual({ phase: 'verifying', bytesCompleted: 40, bytesTotal: 100 });
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
