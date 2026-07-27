import { type ImageRecognition, nowIso } from '@bendyline/gezel';
import type { RecognitionHealth } from '@bendyline/gezel';
import { readImageStaticMeta } from '../../index-store/image-meta.js';
import type {
  InstalledRecognitionModelInfo,
  RecognitionProvider,
  RecognitionPullEvent,
  RecognitionPullSpec,
  RecognizeInput,
} from './types.js';

/**
 * Deterministic recognition for tests, evals, and `GEZEL_MOCK_PROVIDER=1`.
 *
 * Output is keyed off the image's content hash so the same bytes always
 * produce the same digest — which is what makes the cache assertable ("call
 * twice, recognizer ran once") without a real 3 GB model on disk.
 */
export class MockRecognitionProvider implements RecognitionProvider {
  readonly name = 'mock';
  /** Every call, in order — tests assert on this. */
  readonly calls: RecognizeInput[] = [];
  private installed: InstalledRecognitionModelInfo[];

  /**
   * Starts with nothing installed so mock runs read honestly — a dev or E2E
   * session shows "No model" until something is pulled, matching what a real
   * fresh install looks like. Tests that need a ready engine pass `installed`.
   */
  constructor(opts?: { installed?: InstalledRecognitionModelInfo[] }) {
    this.installed = opts?.installed ?? [];
  }

  async recognize(input: RecognizeInput): Promise<ImageRecognition> {
    this.calls.push(input);
    const meta = readImageStaticMeta(input.bytes);
    const tag = meta.sha256.slice(0, 8);
    const out: ImageRecognition = {
      schemaVersion: 1,
      sha256: meta.sha256,
      meta,
      modes: [input.mode],
      engine: 'mock',
      modelId: 'mock-vision',
      status: 'ok',
      durationMs: 1,
      at: nowIso(),
    };
    if (input.mode === 'ocr') out.ocrText = `MOCK OCR ${tag}`;
    else if (input.mode === 'extract') out.structured = { data: { mock: tag } };
    else if (input.mode === 'ui') out.description = `MOCK UI ${tag}`;
    else out.description = `MOCK DESCRIPTION ${tag}`;
    return out;
  }

  async listInstalledModels(): Promise<InstalledRecognitionModelInfo[]> {
    return this.installed;
  }

  async *pullModel(id: string, spec: RecognitionPullSpec): AsyncIterable<RecognitionPullEvent> {
    const total = spec.files.reduce((n, f) => n + f.approxSizeBytes, 0);
    yield { type: 'progress', bytesWritten: total, totalBytes: total };
    this.installed = [
      ...this.installed,
      { id, name: spec.name, approxSizeBytes: total, installedAt: nowIso() },
    ];
    yield { type: 'done', id };
  }

  async deleteModel(id: string): Promise<void> {
    this.installed = this.installed.filter((m) => m.id !== id);
  }

  async health(): Promise<RecognitionHealth> {
    if (this.installed.length === 0) return { state: 'no-model' };
    return { state: 'ok', modelId: 'mock-vision' };
  }

  async shutdown(): Promise<void> {}
}
