import { describe, expect, it, vi } from 'vitest';
import { MockTextToSpeechProvider } from '../../providers/audio/mock-tts.js';
import type { ServiceContext } from '../context.js';
import { audioRoutes } from './audio.js';

function routes() {
  const writes: string[] = [];
  const provider = new MockTextToSpeechProvider();
  const ctx = {
    store: {
      getGezel: vi.fn(async () => null),
      writeProjectArtifactBinary: vi.fn(async (_projectId: string, relPath: string) => {
        writes.push(relPath);
        return `artifacts/${relPath}`;
      }),
    },
    tts: { providerForModel: vi.fn(async () => provider) },
  } as unknown as ServiceContext;
  const app = audioRoutes(ctx);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post, writes };
}

describe('audio synthesis routes', () => {
  it('streams audio as a chunk even from an engine that cannot split it', async () => {
    // The mock delivers one WAV and never calls onChunk. Chat narration plays
    // chunks alone, so without this it would hear nothing at all.
    const { post } = routes();
    const body = await (await post('/synthesize-stream', { text: 'Hello.' })).text();
    const types = body
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => (JSON.parse(frame.slice(6)) as { type: string }).type);
    expect(types.filter((type) => type === 'chunk')).toHaveLength(1);
    expect(types.at(-1)).toBe('done');
  });

  it('saves the audio as an artifact by default', async () => {
    const { post, writes } = routes();
    const result = (await (await post('/synthesize', { text: 'Hello.' })).json()) as {
      artifactPath?: string;
    };
    expect(writes).toHaveLength(1);
    expect(result.artifactPath).toBe(`artifacts/${writes[0]}`);
  });

  it('saves nothing for speech that is only to be heard', async () => {
    const { post, writes } = routes();
    const stream = await (await post('/synthesize-stream', { text: 'Hi.', persist: false })).text();
    const result = (await (await post('/synthesize', { text: 'Hi.', persist: false })).json()) as {
      artifactPath?: string;
      meta: unknown;
    };
    expect(stream).toContain('"type":"done"');
    expect(result.meta).toBeDefined();
    expect(result.artifactPath).toBeUndefined();
    expect(writes).toEqual([]);
  });
});
