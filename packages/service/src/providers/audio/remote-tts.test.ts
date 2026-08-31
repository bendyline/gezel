import { describe, expect, it, vi } from 'vitest';
import { RemoteTtsProvider } from './remote-tts.js';

const meta = {
  voice: 'af_heart',
  model: 'kokoro',
  sampleRate: 24_000,
  durationSeconds: 1,
  durationMs: 10,
};

describe('RemoteTtsProvider progressive synthesis', () => {
  it('forwards broker progress and sentence audio before returning the final WAV', async () => {
    const frames = [
      {
        type: 'progress',
        progress: {
          phase: 'synthesizing',
          completedCharacters: 6,
          totalCharacters: 12,
          completedChunks: 1,
        },
      },
      {
        type: 'chunk',
        chunk: {
          index: 0,
          b64Wav: Buffer.from('chunk').toString('base64'),
          sampleRate: 24_000,
          durationSeconds: 0.5,
        },
      },
      {
        type: 'done',
        result: { wav: Buffer.from('final').toString('base64'), meta },
      },
    ];
    const fetch = vi.fn(
      async () =>
        new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ) as unknown as typeof globalThis.fetch;
    const provider = new RemoteTtsProvider({
      remoteId: 'machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6229',
      token: 'token',
      fetch,
    });
    const progress = vi.fn();
    const chunks = vi.fn();

    const output = await provider.synthesize({
      text: 'Hello there.',
      onProgress: progress,
      onChunk: chunks,
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://127.0.0.1:6229/v1/remote/audio/synthesize-stream',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(progress).toHaveBeenCalledOnce();
    expect(chunks).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, wav: Buffer.from('chunk') }),
    );
    expect(output.wav).toEqual(Buffer.from('final'));
  });

  it('falls back to one-shot synthesis against an older broker', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ wav: Buffer.from('final').toString('base64'), meta }),
      ) as unknown as typeof globalThis.fetch;
    const provider = new RemoteTtsProvider({
      remoteId: 'machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6229',
      token: 'token',
      fetch,
    });

    await expect(
      provider.synthesize({ text: 'Hello.', onProgress: vi.fn() }),
    ).resolves.toMatchObject({ meta });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
