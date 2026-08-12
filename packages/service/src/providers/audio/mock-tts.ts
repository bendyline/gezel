/**
 * MockTextToSpeechProvider — deterministic TTS for tests and
 * `GEZEL_MOCK_PROVIDER=1`. Synthesizes 200ms of silence so the
 * downstream WAV-write pipeline can be exercised without loading
 * Kokoro / Transformers.js.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveModelDirectory } from '../../models/model-id.js';
import type {
  AudioEngineHealth,
  AudioModelPullEvent,
  AudioModelPullSpec,
  AudioVoiceInfo,
  InstalledAudioModelInfo,
  SynthesizeInput,
  SynthesizeOutput,
  TextToSpeechProvider,
} from './types.js';

const MOCK_VOICES: ReadonlyArray<AudioVoiceInfo> = [
  {
    id: 'mock_alice',
    name: 'Alice (Mock)',
    language: 'en-US',
    gender: 'female',
    modelId: 'mock-tts-1',
  },
  { id: 'mock_bob', name: 'Bob (Mock)', language: 'en-US', gender: 'male', modelId: 'mock-tts-1' },
];

export interface MockTextToSpeechProviderOptions {
  modelsRoot?: string;
}

export class MockTextToSpeechProvider implements TextToSpeechProvider {
  readonly name = 'mock-tts';
  private readonly modelsRoot: string | undefined;

  constructor(opts: MockTextToSpeechProviderOptions = {}) {
    this.modelsRoot = opts.modelsRoot;
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
    // 200ms of silence at 24 kHz mono — same sample rate Kokoro uses
    // so callers can swap providers in tests without their downstream
    // WAV-handling code caring.
    const sampleRate = 24_000;
    const durationSeconds = 0.2;
    const numSamples = Math.round(sampleRate * durationSeconds);
    const dataSize = numSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);

    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    // Body is already zero-initialized — silence.

    return {
      wav: buf,
      meta: {
        voice: input.voice ?? MOCK_VOICES[0]!.id,
        model: input.model ?? 'mock-tts-1',
        sampleRate,
        durationSeconds,
        durationMs: 1,
      },
    };
  }

  async listInstalledModels(): Promise<InstalledAudioModelInfo[]> {
    if (!this.modelsRoot) {
      return [
        {
          id: 'mock-tts-1',
          name: 'Mock TTS v1',
          approxSizeBytes: 0,
          installedAt: new Date(0).toISOString(),
        },
      ];
    }
    try {
      const entries = await readdir(this.modelsRoot);
      return entries.map((id) => ({
        id,
        name: `Mock ${id}`,
        approxSizeBytes: 0,
        installedAt: new Date(0).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async *pullModel(id: string, spec: AudioModelPullSpec): AsyncIterable<AudioModelPullEvent> {
    yield { type: 'progress', bytesWritten: 0, totalBytes: spec.files[0]?.approxSizeBytes ?? 0 };
    if (this.modelsRoot) {
      const dir = join(this.modelsRoot, id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({ id, name: spec.name, mock: true }, null, 2),
        'utf8',
      );
    }
    yield { type: 'done', id };
  }

  async deleteModel(id: string): Promise<void> {
    if (this.modelsRoot) {
      await rm(resolveModelDirectory(this.modelsRoot, id), { recursive: true, force: true });
    }
  }

  async listVoices(): Promise<AudioVoiceInfo[]> {
    return [...MOCK_VOICES];
  }

  async health(): Promise<AudioEngineHealth> {
    return { status: 'ok' };
  }
}
