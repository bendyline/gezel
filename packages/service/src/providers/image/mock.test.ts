import { describe, expect, it } from 'vitest';
import { MockImageProvider } from './mock.js';

/**
 * PNG signature — first 8 bytes of every valid PNG.
 * Used to verify the mock returns a decodable file rather than random bytes.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('MockImageProvider.generate', () => {
  it('returns a valid PNG with metadata', async () => {
    const provider = new MockImageProvider();
    const out = await provider.generate({ prompt: 'a tiny compass' });

    expect(out.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(out.png.length).toBeGreaterThan(PNG_SIGNATURE.length);
    expect(out.meta.widthPx).toBeGreaterThan(0);
    expect(out.meta.heightPx).toBeGreaterThan(0);
    expect(out.meta.model).toBeTypeOf('string');
    expect(out.meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('honors explicit width/height/steps/seed', async () => {
    const provider = new MockImageProvider();
    const out = await provider.generate({
      prompt: 'a red square',
      width: 24,
      height: 16,
      steps: 7,
      seed: 42,
    });
    expect(out.meta.widthPx).toBe(24);
    expect(out.meta.heightPx).toBe(16);
    expect(out.meta.steps).toBe(7);
    expect(out.meta.seed).toBe(42);
  });

  it('produces different pixels for different prompts', async () => {
    const provider = new MockImageProvider();
    const a = await provider.generate({ prompt: 'cat', width: 4, height: 4, seed: 1 });
    const b = await provider.generate({ prompt: 'dog', width: 4, height: 4, seed: 1 });
    expect(a.png.equals(b.png)).toBe(false);
  });

  it('pullModel registers the model and deleteModel removes it', async () => {
    const provider = new MockImageProvider();
    const events: Array<{ type: string }> = [];
    for await (const e of provider.pullModel('test-model', {
      downloadUrl: 'https://example.invalid/a.gguf',
      sha256: 'a'.repeat(64),
      approxSizeBytes: 1_000,
      name: 'Test',
      weightsKind: 'checkpoint',
      auxiliaryFiles: [],
    })) {
      events.push(e);
    }
    expect(events.at(-1)?.type).toBe('done');
    expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThan(0);

    const installed = await provider.listInstalledModels();
    expect(installed).toHaveLength(1);
    expect(installed[0]!.id).toBe('test-model');

    await provider.deleteModel('test-model');
    expect(await provider.listInstalledModels()).toHaveLength(0);
  });
});
