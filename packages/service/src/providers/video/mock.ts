/**
 * MockVideoProvider — deterministic, dependency-free stand-in for tests,
 * CI, and `GEZEL_MOCK_PROVIDER=1`. Returns a tiny placeholder clip
 * without spawning Python or touching the GPU. The video sibling of
 * `MockImageProvider`.
 */

import type {
  InstalledVideoModelInfo,
  VideoEngineHealth,
  VideoGenerationInput,
  VideoGenerationOutput,
  VideoModelPullEvent,
  VideoProvider,
} from './types.js';

/** A 1x1 transparent PNG — stands in for the poster frame. */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export class MockVideoProvider implements VideoProvider {
  readonly name = 'mock';

  async generate(input: VideoGenerationInput): Promise<VideoGenerationOutput> {
    const width = input.width ?? 256;
    const height = input.height ?? 256;
    const numFrames = input.numFrames ?? 25;
    const fps = input.fps ?? 24;
    const steps = input.steps ?? 1;
    const seed = input.seed ?? 0;
    // Fire one progress tick so callers exercising onProgress see activity.
    input.onProgress?.({ step: 1, totalSteps: steps });
    return {
      // Not a real container — tests assert on bytes/meta, not playback.
      video: Buffer.from('GEZEL_MOCK_VIDEO'),
      poster: Buffer.from(TINY_PNG_BASE64, 'base64'),
      meta: {
        model: input.model ?? 'mock-video',
        seed,
        steps,
        widthPx: width,
        heightPx: height,
        numFrames,
        fps,
        durationMs: 0,
        mimeType: 'video/mp4',
      },
    };
  }

  async listInstalledModels(): Promise<InstalledVideoModelInfo[]> {
    return [
      {
        id: 'mock-video',
        name: 'Mock Video Model',
        approxSizeBytes: 0,
        installedAt: new Date(0).toISOString(),
      },
    ];
  }

  async *pullModel(id: string): AsyncIterable<VideoModelPullEvent> {
    yield {
      type: 'progress',
      fileIndex: 0,
      fileCount: 1,
      file: 'mock.safetensors',
      bytesWritten: 1,
      totalBytes: 1,
      bytesWrittenAll: 1,
      totalBytesAll: 1,
    };
    yield { type: 'done', id };
  }

  async deleteModel(): Promise<void> {
    /* nothing on disk */
  }

  async health(): Promise<VideoEngineHealth> {
    return { status: 'ok', baseUrl: 'mock://video', accelerator: 'cpu' };
  }
}
