/**
 * MockSpeechToTextProvider — deterministic STT for tests and the
 * `GEZEL_MOCK_PROVIDER=1` flow. Returns a fixed transcript so e2e
 * tests can assert "the chat received the transcribe_audio result"
 * without needing a real whisper-server binary or model file.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AudioEngineHealth,
  AudioModelPullEvent,
  AudioModelPullSpec,
  InstalledAudioModelInfo,
  SpeechToTextProvider,
  TranscribeInput,
  TranscribeOutput,
} from './types.js';

export interface MockSpeechToTextProviderOptions {
  /** Optional dir to track "installed" models so list/pull/delete are observable. */
  modelsRoot?: string;
  /** Override the canned transcript. */
  text?: string;
}

const DEFAULT_TEXT =
  'This is a mock transcription. Set GEZEL_MOCK_PROVIDER=0 and install whisper.cpp to transcribe real audio.';

export class MockSpeechToTextProvider implements SpeechToTextProvider {
  readonly name = 'mock-stt';
  private readonly modelsRoot: string | undefined;
  private readonly text: string;

  constructor(opts: MockSpeechToTextProviderOptions = {}) {
    this.modelsRoot = opts.modelsRoot;
    this.text = opts.text ?? DEFAULT_TEXT;
  }

  async transcribe(_input: TranscribeInput): Promise<TranscribeOutput> {
    return {
      text: this.text,
      durationMs: 5,
      language: 'en',
    };
  }

  async listInstalledModels(): Promise<InstalledAudioModelInfo[]> {
    if (!this.modelsRoot) {
      return [
        {
          id: 'mock-whisper-base',
          name: 'Mock Whisper Base',
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
      await rm(join(this.modelsRoot, id), { recursive: true, force: true });
    }
  }

  async health(): Promise<AudioEngineHealth> {
    return { status: 'ok', baseUrl: 'mock://stt' };
  }
}
