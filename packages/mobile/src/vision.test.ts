import { describe, expect, it, vi } from 'vitest';
import { type FallbackDescriber, type NativeVisionPlugin, createNativeVision } from './vision.js';

const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function plugin(result: Partial<Awaited<ReturnType<NativeVisionPlugin['read']>>>) {
  return {
    status: vi.fn(),
    prepare: vi.fn(),
    read: vi.fn(async (_options: Parameters<NativeVisionPlugin['read']>[0]) => ({
      describer: 'unavailable' as const,
      models: [],
      ...result,
    })) as ReturnType<typeof vi.fn<NativeVisionPlugin['read']>>,
    cancel: vi.fn(async () => {}),
  } satisfies NativeVisionPlugin;
}

function read(
  vision: ReturnType<typeof createNativeVision>,
  signal = new AbortController().signal,
) {
  return vision.read({ data: PHOTO, mimeType: 'image/jpeg', signal });
}

describe('native vision host', () => {
  it('keeps confident labels, most confident first, and passes the OS description through', async () => {
    const native = plugin({
      labels: [
        { label: 'Plant', confidence: 0.71 },
        { label: 'Tomato', confidence: 0.93 },
        { label: 'Plant', confidence: 0.7 },
      ],
      text: '  ',
      description: 'A tomato plant on a sunny windowsill.',
      describer: 'ready',
      width: 1536,
      height: 2048,
      models: ['mlkit-image-labeling', 'mlkit-genai-image-description'],
    });
    const reading = await read(createNativeVision(native));

    expect(native.read).toHaveBeenCalledWith(
      expect.objectContaining({
        image: btoa(String.fromCharCode(...PHOTO)),
        describe: true,
        prompt: expect.objectContaining({ maxTokens: 400 }),
      }),
    );
    expect(reading).toEqual({
      labels: ['tomato', 'plant'],
      description: 'A tomato plant on a sunny windowsill.',
      width: 1536,
      height: 2048,
      models: ['mlkit-image-labeling', 'mlkit-genai-image-description'],
    });
  });

  it('asks the fallback model when the OS has no describer', async () => {
    const fallback: FallbackDescriber = {
      state: vi.fn(async () => 'ready' as const),
      describe: vi.fn(async () => ({
        description: 'A dog asleep on a rug.',
        model: 'llama-cpp:qwen3.5-0.8b-q4',
      })),
    };
    const reading = await read(
      createNativeVision(
        plugin({ labels: [{ label: 'Dog', confidence: 0.9 }], models: ['apple-vision'] }),
        fallback,
      ),
    );
    expect(reading.description).toBe('A dog asleep on a rug.');
    expect(reading.models).toEqual(['apple-vision', 'llama-cpp:qwen3.5-0.8b-q4']);
    expect(reading.describer).toBeUndefined();
  });

  it('says why no sentence came back', async () => {
    const notInstalled: FallbackDescriber = {
      state: async () => 'not-installed',
      describe: vi.fn(),
    };
    expect(
      (await read(createNativeVision(plugin({ models: ['apple-vision'] }), notInstalled)))
        .describer,
    ).toBe('not-installed');
    expect(
      (await read(createNativeVision(plugin({ describer: 'download-required', models: [] }))))
        .describer,
    ).toBe('not-installed');
    expect((await read(createNativeVision(plugin({ models: [] })))).describer).toBe('unavailable');
    const broken: FallbackDescriber = {
      state: async () => 'ready',
      describe: async () => {
        throw new Error('out of memory');
      },
    };
    expect((await read(createNativeVision(plugin({ models: [] }), broken))).describer).toBe(
      'failed',
    );
  });

  it('cancels the native read when the turn stops', async () => {
    let finish!: () => void;
    const native = plugin({});
    native.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ describer: 'unavailable', models: [] });
        }),
    );
    const controller = new AbortController();
    const pending = read(createNativeVision(native), controller.signal);
    await vi.waitFor(() => expect(native.read).toHaveBeenCalled());
    controller.abort();
    finish();
    await expect(pending).rejects.toThrow();
    const { requestId } = native.read.mock.calls[0]![0];
    expect(native.cancel).toHaveBeenCalledWith({ requestId });
  });
});
