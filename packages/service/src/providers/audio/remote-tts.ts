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
  SynthesizeInput,
  SynthesizeOutput,
  TextToSpeechProvider,
} from './types.js';

export interface RemoteTtsProviderOpts {
  remoteId: string;
  label: string;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

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
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/synthesize`, {
      method: 'POST',
      headers: this.headers(),
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
