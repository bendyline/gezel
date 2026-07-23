/**
 * RemoteSttProvider — Device A's speech-to-text provider backed by a paired
 * server's whisper engine. `transcribe()` resolves the audio to bytes (reading
 * a local path on A if needed) and RPCs to `B/v1/remote/audio/transcribe`.
 */

import { readFile } from 'node:fs/promises';
import { parseRemoteModelId } from '../remote/model-id.js';
import type {
  AudioEngineHealth,
  AudioModelPullEvent,
  InstalledAudioModelInfo,
  SpeechToTextProvider,
  TranscribeInput,
  TranscribeOutput,
} from './types.js';

export interface RemoteSttProviderOpts {
  remoteId: string;
  label: string;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

export class RemoteSttProvider implements SpeechToTextProvider {
  readonly name: string;

  constructor(private readonly opts: RemoteSttProviderOpts) {
    this.name = `remote:${opts.label}`;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.token}` };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
    // The bytes must cross the wire; if the caller passed a local path (A's
    // artifact tree), read it here on A before sending.
    const bytes =
      'path' in input.audio
        ? { data: await readFile(input.audio.path), mimeType: 'audio/wav' }
        : input.audio;
    const model = input.model
      ? (parseRemoteModelId(input.model)?.modelId ?? input.model)
      : undefined;
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/transcribe`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        audio: { data: bytes.data.toString('base64'), mimeType: bytes.mimeType },
        ...(model ? { model } : {}),
        ...(input.language ? { language: input.language } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[remote-stt] transcribe failed HTTP ${res.status} ${await res.text().catch(() => '')}`.trim(),
      );
    }
    return (await res.json()) as TranscribeOutput;
  }

  async listInstalledModels(): Promise<InstalledAudioModelInfo[]> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/stt/models`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: InstalledAudioModelInfo[] };
    return body.models ?? [];
  }

  // biome-ignore lint/correctness/useYield: nothing to pull — remote servers manage their own weights, so this generator only rejects.
  async *pullModel(_id: string): AsyncIterable<AudioModelPullEvent> {
    throw new Error('Remote servers manage their own STT models — install on the server directly.');
  }

  async deleteModel(): Promise<void> {
    throw new Error('Remote servers manage their own STT models.');
  }

  async health(): Promise<AudioEngineHealth> {
    try {
      const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/audio/stt/health`, {
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
