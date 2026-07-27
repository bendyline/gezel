import type { ImageRecognition, RecognitionHealth, RecognitionMode } from '@bendyline/gezel';

/**
 * The image-recognition workload: a small local vision model that turns an
 * image into text a blind chat model can read.
 *
 * Shaped after `SpeechToTextProvider` — same "small local model, non-text
 * input, text out" problem, same supervisor lifecycle, same hardcoded-catalog
 * stage of maturity.
 */

export interface RecognizeInput {
  bytes: Buffer;
  mimeType: string;
  /** Resolved mode. `auto` is decided by the caller before it gets here. */
  mode: RecognitionMode;
  /** JSON Schema for `extract` mode, fed to llama-server `response_format`. */
  schema?: unknown;
  timeoutMsOverride?: number;
}

export interface InstalledRecognitionModelInfo {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /** Absolute path to the projector, without which the engine can't decode. */
  mmprojPath?: string;
  weightsPath?: string;
}

/** Mirrors `AudioModelPullEvent` so the shared `downloadWithSha256` fits. */
export type RecognitionPullEvent =
  | { type: 'progress'; bytesWritten: number; totalBytes?: number }
  | { type: 'error'; error: string }
  | { type: 'done'; id: string };

export interface RecognitionPullSpec {
  name: string;
  files: Array<{
    role: 'weights' | 'mmproj';
    downloadUrl: string;
    sha256: string;
    approxSizeBytes: number;
    filename: string;
  }>;
}

export interface RecognitionProvider {
  readonly name: string;
  /**
   * Never throws for engine-side problems — a failed recognition returns a
   * record with `status: 'failed'` so the chat turn can degrade to static
   * metadata instead of the user's question dying with it.
   */
  recognize(input: RecognizeInput): Promise<ImageRecognition>;
  listInstalledModels(): Promise<InstalledRecognitionModelInfo[]>;
  pullModel(id: string, spec: RecognitionPullSpec): AsyncIterable<RecognitionPullEvent>;
  deleteModel(id: string): Promise<void>;
  /** Answers without paying a cold start, so opening Settings stays instant. */
  health(): Promise<RecognitionHealth>;
  shutdown(): Promise<void>;
}
