/**
 * RemoteTtsProvider — Device A's text-to-speech provider backed by a paired
 * server's TTS engine. `synthesize()` RPCs to `B/v1/remote/audio/synthesize`;
 * the WAV streams back and A persists it. `listVoices()` proxies B's voices.
 */

import { parseRemoteModelId } from '../remote/model-id.js';
import type {
  AudioEngineHealth,
  AudioModelPullEvent,
  AudioVoiceInfo,
  InstalledAudioModelInfo,
  SynthesizeChunk,
  SynthesizeInput,
  SynthesizeOutput,
  SynthesizeProgress,
  TextToSpeechProvider,
} from './types.js';

export interface RemoteTtsProviderOpts {
  remoteId: string;
  label: string;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

type RemoteSynthesizeFrame =
  | { type: 'progress'; progress: SynthesizeProgress }
  | {
      type: 'chunk';
      chunk: Omit<SynthesizeChunk, 'wav'> & { b64Wav: string };
    }
  | { type: 'done'; result: { wav: string; meta: SynthesizeOutput['meta'] } }
  | { type: 'error'; error: string };

export class RemoteTtsProvider implements TextToSpeechProvider {
  readonly name: string;

  constructor(private readonly opts: RemoteTtsProviderOpts) {
    this.name = `remote:${opts.label}`;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.token}` };
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
    const model = input.model
      ? (parseRemoteModelId(input.model)?.modelId ?? input.model)
      : undefined;
    if (input.onProgress || input.onChunk) {
      const streamed = await this.synthesizeStreaming(input, model);
      if (streamed) return streamed;
    }
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/synthesize`, {
      method: 'POST',
      headers: this.headers(),
      ...(input.signal ? { signal: input.signal } : {}),
      body: JSON.stringify({
        text: input.text,
        ...(input.voice ? { voice: input.voice } : {}),
        ...(model ? { model } : {}),
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[remote-tts] synthesize failed HTTP ${res.status} ${await res.text().catch(() => '')}`.trim(),
      );
    }
    const body = (await res.json()) as { wav: string; meta: SynthesizeOutput['meta'] };
    return { wav: Buffer.from(body.wav, 'base64'), meta: body.meta };
  }

  private async synthesizeStreaming(
    input: SynthesizeInput,
    model: string | undefined,
  ): Promise<SynthesizeOutput | null> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/synthesize-stream`, {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      ...(input.signal ? { signal: input.signal } : {}),
      body: JSON.stringify({
        text: input.text,
        ...(input.voice ? { voice: input.voice } : {}),
        ...(model ? { model } : {}),
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      }),
    });
    // Rolling-upgrade fallback: an older machine broker only has one-shot TTS.
    if (res.status === 404 || res.status === 405) return null;
    if (!res.ok || !res.body) {
      throw new Error(
        `[remote-tts] synthesize stream failed HTTP ${res.status} ${await res.text().catch(() => '')}`.trim(),
      );
    }

    let output: SynthesizeOutput | undefined;
    await readSseFrames(res.body, async (raw) => {
      const frame = raw as RemoteSynthesizeFrame;
      if (frame.type === 'progress') await input.onProgress?.(frame.progress);
      if (frame.type === 'chunk') {
        await input.onChunk?.({
          index: frame.chunk.index,
          wav: Buffer.from(frame.chunk.b64Wav, 'base64'),
          sampleRate: frame.chunk.sampleRate,
          durationSeconds: frame.chunk.durationSeconds,
        });
      }
      if (frame.type === 'error') throw new Error(frame.error);
      if (frame.type === 'done') {
        output = { wav: Buffer.from(frame.result.wav, 'base64'), meta: frame.result.meta };
      }
    });
    if (!output) throw new Error('[remote-tts] synthesize stream ended without audio');
    return output;
  }

  async listVoices(): Promise<AudioVoiceInfo[]> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/voices`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { voices?: AudioVoiceInfo[] };
    return body.voices ?? [];
  }

  async listInstalledModels(): Promise<InstalledAudioModelInfo[]> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/tts/models`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: InstalledAudioModelInfo[] };
    return body.models ?? [];
  }

  // biome-ignore lint/correctness/useYield: nothing to pull — remote servers manage their own weights, so this generator only rejects.
  async *pullModel(_id: string): AsyncIterable<AudioModelPullEvent> {
    throw new Error('Remote servers manage their own TTS models — install on the server directly.');
  }

  async deleteModel(): Promise<void> {
    throw new Error('Remote servers manage their own TTS models.');
  }

  async health(): Promise<AudioEngineHealth> {
    try {
      const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/tts/health`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        return { status: 'unreachable', baseUrl: this.opts.baseUrl, error: `HTTP ${res.status}` };
      }
      return (await res.json()) as AudioEngineHealth;
    } catch (err) {
      return {
        status: 'unreachable',
        baseUrl: this.opts.baseUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** Small, backpressure-aware SSE reader for the broker's finite TTS stream. */
async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  onFrame: (raw: unknown) => void | Promise<void>,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary?.index !== undefined) {
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) await onFrame(JSON.parse(data));
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
