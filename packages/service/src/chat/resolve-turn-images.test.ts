import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import type { RecognitionManager } from '../providers/recognition/manager.js';
import { resolveTurnImages } from './resolve-turn-images.js';

/**
 * A blind model plus a reader that didn't read is the case the user never
 * hears about. The per-image digest tells the MODEL ("Could not read this
 * image"), but the warning list is what reaches the person who attached the
 * screenshot — and it used to be populated only for an overflowing batch or
 * a fully-unavailable plan.
 *
 * Wild-caught on a Voorman turn: `recognition failed (ocr): The operation
 * was aborted due to timeout`, no warning surfaced, and the gezel answered a
 * "can you fix?" about a screenshot it had never seen.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-turn-images-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A reader that is installed and available, but fails every image. */
function failingRecognition(failureReason: string): RecognitionManager {
  return {
    isAvailable: async () => true,
    recognize: async (input: { bytes: Buffer; mimeType: string }) => ({
      schemaVersion: 1 as const,
      sha256: 'deadbeef',
      meta: { format: 'png' as const, byteLength: input.bytes.length, sha256: 'deadbeef' },
      modes: ['ocr' as const],
      engine: 'llama-vision',
      modelId: 'gemma4-e4b',
      status: 'failed' as const,
      failureReason,
      durationMs: 45_000,
      at: new Date().toISOString(),
    }),
  } as unknown as RecognitionManager;
}

async function attach(): Promise<string> {
  const { relativePath } = await store.writeProjectAttachment('default', PNG, 'image/png');
  return relativePath;
}

describe('resolveTurnImages — a local read that was planned but did not happen', () => {
  it('warns the user when the reader could not read the only attached image', async () => {
    const ref = await attach();
    const result = await resolveTurnImages({
      store,
      projectId: 'default',
      sessionId: 'sess',
      markdown: `can you fix? ![shot](${ref})`,
      provider: 'llama-cpp',
      modelId: 'qwen3.8-27b-q2',
      mode: 'auto',
      recognition: failingRecognition('The operation was aborted due to timeout'),
    });

    expect(result.verdict).toBe('preprocess');
    // The model is told per-image...
    expect(result.digests).toHaveLength(1);
    expect(result.digests[0]!.digest).toContain('Could not read this image');
    // ...and now so is the user.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Couldn't read the image");
    expect(result.warnings[0]).toContain('aborted due to timeout');
    expect(result.warnings[0]).toContain('cannot see the picture');
  });

  it('stays silent when the reader succeeds', async () => {
    const ref = await attach();
    const ok = {
      isAvailable: async () => true,
      recognize: async (input: { bytes: Buffer }) => ({
        schemaVersion: 1 as const,
        sha256: 'cafe',
        meta: { format: 'png' as const, byteLength: input.bytes.length, sha256: 'cafe' },
        modes: ['describe' as const],
        engine: 'llama-vision',
        modelId: 'gemma4-e4b',
        status: 'ok' as const,
        description: 'a browser window showing a 404 in the console',
        durationMs: 900,
        at: new Date().toISOString(),
      }),
    } as unknown as RecognitionManager;

    const result = await resolveTurnImages({
      store,
      projectId: 'default',
      sessionId: 'sess',
      markdown: `look ![shot](${ref})`,
      provider: 'llama-cpp',
      modelId: 'qwen3.8-27b-q2',
      mode: 'auto',
      recognition: ok,
    });

    expect(result.verdict).toBe('preprocess');
    expect(result.warnings).toEqual([]);
    expect(result.digests[0]!.digest).toContain('browser window');
  });

  it('does not double-warn when the plan was unavailable to begin with', async () => {
    const ref = await attach();
    // No reader installed AND local scanning off — this is the pre-existing
    // "unavailable" warning, which must not be joined by the new one.
    const result = await resolveTurnImages({
      store,
      projectId: 'default',
      sessionId: 'sess',
      markdown: `look ![shot](${ref})`,
      provider: 'llama-cpp',
      modelId: 'qwen3.8-27b-q2',
      mode: 'off',
    });

    expect(result.verdict).toBe('unavailable');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("can't see images");
  });
});
