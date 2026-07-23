import { describe, expect, it, vi } from 'vitest';
import { type OpenAIImageClient, OpenAIImageProvider, pickSize } from './openai-image.js';

const FAKE_PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

function fakeClient(b64 = FAKE_PNG_B64): {
  client: OpenAIImageClient;
  generate: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn().mockResolvedValue({ data: [{ b64_json: b64 }] });
  const edit = vi.fn().mockResolvedValue({ data: [{ b64_json: b64 }] });
  return {
    client: { images: { generate, edit } },
    generate,
    edit,
  };
}

describe('OpenAIImageProvider.generate', () => {
  it('calls images.generate with model gpt-image-2 by default and returns the PNG buffer', async () => {
    const { client, generate } = fakeClient();
    const provider = new OpenAIImageProvider({
      apiKey: 'sk-test',
      clientFactory: async () => client,
    });
    const out = await provider.generate({ prompt: 'a cat' });
    expect(out.png.toString('base64')).toBe(FAKE_PNG_B64);
    expect(out.meta.model).toBe('gpt-image-2');
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-image-2', prompt: 'a cat', n: 1 }),
    );
  });

  it('snaps unsupported sizes (and warns) without erroring', async () => {
    const warn = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { client, generate } = fakeClient();
    const provider = new OpenAIImageProvider({
      apiKey: 'sk-test',
      clientFactory: async () => client,
    });
    await provider.generate({ prompt: 'p', width: 800, height: 600 });
    const callArgs = generate.mock.calls[0]![0];
    // 800x600 (4:3 landscape) snaps to the closest landscape: 1536x1024
    expect(['1024x1024', '1024x1536', '1536x1024']).toContain(callArgs.size);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('omits `size` when no width/height provided (lets OpenAI auto-pick)', async () => {
    const { client, generate } = fakeClient();
    const provider = new OpenAIImageProvider({
      apiKey: 'sk-test',
      clientFactory: async () => client,
    });
    await provider.generate({ prompt: 'p' });
    const callArgs = generate.mock.calls[0]![0];
    expect(callArgs.size).toBeUndefined();
  });

  it('throws actionable error when API key is missing', async () => {
    const provider = new OpenAIImageProvider({ apiKey: null });
    await expect(provider.generate({ prompt: 'p' })).rejects.toThrow(/not configured/);
  });

  it('throws when the API returns no image data', async () => {
    const generate = vi.fn().mockResolvedValue({ data: [] });
    const edit = vi.fn().mockResolvedValue({ data: [] });
    const provider = new OpenAIImageProvider({
      apiKey: 'sk-test',
      clientFactory: async () => ({ images: { generate, edit } }),
    });
    await expect(provider.generate({ prompt: 'p' })).rejects.toThrow(/no image data/);
  });

  it('routes through images.edit when inputImages is supplied', async () => {
    const { client, edit, generate } = fakeClient();
    const provider = new OpenAIImageProvider({
      apiKey: 'sk-test',
      clientFactory: async () => client,
    });
    const source = Buffer.from('source-bytes');
    await provider.generate({
      prompt: 'make it yellow',
      inputImages: [{ data: source, mimeType: 'image/png' }],
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    const call = edit.mock.calls[0]![0];
    expect(call.image).toBe(source);
    expect(call.prompt).toBe('make it yellow');
  });

  it('passes an array of buffers when multiple inputImages are supplied', async () => {
    const { client, edit } = fakeClient();
    const provider = new OpenAIImageProvider({
      apiKey: 'sk-test',
      clientFactory: async () => client,
    });
    await provider.generate({
      prompt: 'compose',
      inputImages: [
        { data: Buffer.from('a'), mimeType: 'image/png' },
        { data: Buffer.from('b'), mimeType: 'image/png' },
      ],
    });
    const call = edit.mock.calls[0]![0];
    expect(Array.isArray(call.image)).toBe(true);
    expect((call.image as Buffer[]).length).toBe(2);
  });
});

describe('OpenAIImageProvider model management', () => {
  it('lists hardcoded gpt-image-2 entries', async () => {
    const provider = new OpenAIImageProvider({ apiKey: 'k' });
    const models = await provider.listInstalledModels();
    expect(models.map((m) => m.id)).toContain('gpt-image-2');
  });

  it('rejects pullModel with cloud-provider message', async () => {
    const provider = new OpenAIImageProvider({ apiKey: 'k' });
    const iter = provider.pullModel('x', {
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
    const provider = new OpenAIImageProvider({ apiKey: 'k' });
    await expect(provider.deleteModel('x')).rejects.toThrow(/cloud provider/i);
  });
});

describe('OpenAIImageProvider.health', () => {
  it('returns not-configured when no API key', async () => {
    const provider = new OpenAIImageProvider({ apiKey: null });
    const health = await provider.health();
    expect(health.status).toBe('not-configured');
  });
});

describe('pickSize', () => {
  it('passes through exact supported sizes', () => {
    expect(pickSize(1024, 1024)).toEqual({ size: '1024x1024' });
    expect(pickSize(1536, 1024)).toEqual({ size: '1536x1024' });
  });

  it('snaps near-square unsupported sizes to 1024x1024', () => {
    expect(pickSize(1000, 1000).size).toBe('1024x1024');
    expect(pickSize(1000, 1000).snappedFrom).toBe('1000x1000');
  });

  it('snaps tall portrait to 1024x1536', () => {
    expect(pickSize(800, 1200).size).toBe('1024x1536');
  });

  it('snaps wide landscape to 1536x1024', () => {
    expect(pickSize(1200, 800).size).toBe('1536x1024');
  });

  it('returns no size when width or height is missing', () => {
    expect(pickSize(undefined, undefined)).toEqual({});
    expect(pickSize(1024, undefined)).toEqual({});
  });
});
