import { describe, expect, it, vi } from 'vitest';
import { RemoteSttProvider } from './remote-stt.js';

describe('RemoteSttProvider', () => {
  it('forwards rolling transcript context to the remote Whisper engine', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ text: 'five six seven', durationMs: 12 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const provider = new RemoteSttProvider({
      remoteId: 'machine',
      label: 'This machine',
      baseUrl: 'https://127.0.0.1:6229',
      token: 'test-token',
      fetch: fetchImpl as typeof fetch,
    });

    await provider.transcribe({
      audio: { data: Buffer.from('RIFF-test'), mimeType: 'audio/wav' },
      prompt: 'one two three four',
    });

    expect(requestBody).toMatchObject({ prompt: 'one two three four' });
  });
});
