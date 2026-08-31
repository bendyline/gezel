import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch as undiciFetch } from 'undici';
import { describe, expect, it } from 'vitest';
import {
  WhisperCppProvider,
  inlineAudioFilename,
  normalizeWhisperTranscript,
} from './whisper-cpp.js';

describe('WhisperCppProvider', () => {
  it('removes MediaRecorder codec parameters from the upload filename', () => {
    expect(inlineAudioFilename('audio/webm;codecs=opus')).toBe('audio.webm');
    expect(inlineAudioFilename('audio/mp4;codecs=mp4a.40.2')).toBe('audio.mp4');
  });

  it('falls back safely for a malformed MIME type', () => {
    expect(inlineAudioFilename('not-a-mime')).toBe('audio.wav');
  });

  it('normalizes whisper.cpp no-speech output to an empty transcript', () => {
    expect(normalizeWhisperTranscript(' [BLANK_AUDIO] ')).toBe('');
    expect(normalizeWhisperTranscript('spoken words')).toBe('spoken words');
  });

  it('sends inline audio as a real multipart file through undici fetch', async () => {
    let contentType = '';
    let requestBody = Buffer.alloc(0);
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        contentType = request.headers['content-type'] ?? '';
        requestBody = Buffer.concat(chunks);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ text: 'working transcript' }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address() as AddressInfo;
      const provider = new WhisperCppProvider({
        baseUrl: `http://127.0.0.1:${address.port}`,
        modelsRoot: join(tmpdir(), `gezel-whisper-multipart-${process.pid}`),
        fetchImpl: undiciFetch as unknown as typeof fetch,
      });

      const result = await provider.transcribe({
        audio: { data: Buffer.from('RIFF-test-audio'), mimeType: 'audio/wav' },
      });

      expect(result.text).toBe('working transcript');
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(requestBody.toString('latin1')).toContain(
        'Content-Disposition: form-data; name="file"; filename="audio.wav"',
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
