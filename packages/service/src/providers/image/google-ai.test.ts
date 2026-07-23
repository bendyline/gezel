import { describe, expect, it, vi } from 'vitest';
import { GoogleAiImageProvider, snapImageConfig } from './google-ai.js';

const FAKE_PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  text?: string;
}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.status === 401 ? 'Unauthorized' : 'OK',
    async json() {
      if (opts.body === undefined) throw new Error('no body');
      return opts.body;
    },
    async text() {
      return opts.text ?? '';
    },
  } as unknown as Response;
}

describe('GoogleAiImageProvider.generate', () => {
  it('extracts the inline PNG from candidates[].content.parts[]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        body: {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'here you go' },
                  { inlineData: { mimeType: 'image/png', data: FAKE_PNG_B64 } },
                ],
              },
            },
          ],
        },
      }),
    );
    const provider = new GoogleAiImageProvider({ apiKey: 'AIzatest', fetchImpl });
    const out = await provider.generate({ prompt: 'a cat' });
    expect(out.png.toString('base64')).toBe(FAKE_PNG_B64);
    expect(out.meta.model).toBe('gemini-3.1-flash-image-preview');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain(':generateContent');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.contents[0].parts[0].text).toBe('a cat');
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    // No imageConfig when neither width nor height is supplied
    expect(body.generationConfig.imageConfig).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'AIzatest' });
  });

  it('prepends inlineData parts for each input image', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        body: {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: FAKE_PNG_B64 } }] } },
          ],
        },
      }),
    );
    const provider = new GoogleAiImageProvider({ apiKey: 'k', fetchImpl });
    await provider.generate({
      prompt: 'make it yellow',
      inputImages: [
        { data: Buffer.from('first'), mimeType: 'image/png' },
        { data: Buffer.from('second'), mimeType: 'image/jpeg' },
      ],
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[0].inlineData.mimeType).toBe('image/png');
    expect(parts[0].inlineData.data).toBe(Buffer.from('first').toString('base64'));
    expect(parts[1].inlineData.mimeType).toBe('image/jpeg');
    expect(parts[2].text).toBe('make it yellow');
  });

  it('passes a snapped imageConfig when width/height supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        body: {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: FAKE_PNG_B64 } }] } },
          ],
        },
      }),
    );
    const provider = new GoogleAiImageProvider({ apiKey: 'k', fetchImpl });
    await provider.generate({ prompt: 'p', width: 1920, height: 1080 });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
  });

  it('throws a clear error when Gemini returns text only (refusal)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        body: {
          candidates: [{ content: { parts: [{ text: "I can't help with that." }] } }],
        },
      }),
    );
    const provider = new GoogleAiImageProvider({ apiKey: 'k', fetchImpl });
    await expect(provider.generate({ prompt: 'p' })).rejects.toThrow(/text instead of an image/);
  });

  it('throws actionable error when API key is missing', async () => {
    const provider = new GoogleAiImageProvider({ apiKey: null });
    await expect(provider.generate({ prompt: 'p' })).rejects.toThrow(/not configured/);
  });

  it('surfaces non-2xx HTTP responses with a truncated body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: false, status: 400, text: '{"error":"bad request"}' }));
    const provider = new GoogleAiImageProvider({ apiKey: 'k', fetchImpl });
    await expect(provider.generate({ prompt: 'p' })).rejects.toThrow(/HTTP 400/);
  });
});

describe('GoogleAiImageProvider.health', () => {
  it('returns not-configured when no API key', async () => {
    const provider = new GoogleAiImageProvider({ apiKey: null });
    const health = await provider.health();
    expect(health.status).toBe('not-configured');
  });

  it('returns ok on a successful /models probe', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ body: {} }));
    const provider = new GoogleAiImageProvider({ apiKey: 'k', fetchImpl });
    const health = await provider.health();
    expect(health.status).toBe('ok');
  });

  it('returns unreachable + invalid API key on 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 401, body: {} }));
    const provider = new GoogleAiImageProvider({ apiKey: 'k', fetchImpl });
    const health = await provider.health();
    expect(health.status).toBe('unreachable');
    expect(health.error).toBe('invalid API key');
  });

  it('returns unreachable on network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const provider = new GoogleAiImageProvider({ apiKey: 'k', fetchImpl });
    const health = await provider.health();
    expect(health.status).toBe('unreachable');
    expect(health.error).toMatch(/ENOTFOUND/);
  });
});

describe('GoogleAiImageProvider model management', () => {
  it('lists the hardcoded Nano Banana 2 entry', async () => {
    const provider = new GoogleAiImageProvider({ apiKey: 'k' });
    const models = await provider.listInstalledModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe('gemini-3.1-flash-image-preview');
    expect(models[0]!.approxSizeBytes).toBe(0);
  });

  it('rejects pullModel with a clear cloud-provider message', async () => {
    const provider = new GoogleAiImageProvider({ apiKey: 'k' });
    const iter = provider.pullModel('whatever', {
      downloadUrl: '',
      sha256: '',
      approxSizeBytes: 0,
      name: '',
      weightsKind: 'checkpoint',
      auxiliaryFiles: [],
    });
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(/cloud provider/i);
  });

  it('rejects deleteModel', async () => {
    const provider = new GoogleAiImageProvider({ apiKey: 'k' });
    await expect(provider.deleteModel('x')).rejects.toThrow(/cloud provider/i);
  });
});

describe('snapImageConfig', () => {
  it('snaps 1920x1080 → 16:9 / 2K', () => {
    expect(snapImageConfig(1920, 1080)).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
  });

  it('snaps 1024x1024 → 1:1 / 1K', () => {
    expect(snapImageConfig(1024, 1024)).toEqual({ aspectRatio: '1:1', imageSize: '1K' });
  });

  it('snaps 720x1280 portrait → 9:16 / 2K', () => {
    expect(snapImageConfig(720, 1280)).toEqual({ aspectRatio: '9:16', imageSize: '2K' });
  });

  it('snaps tiny dim 256x256 → 1:1 / 512', () => {
    expect(snapImageConfig(256, 256)).toEqual({ aspectRatio: '1:1', imageSize: '512' });
  });
});
