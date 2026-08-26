import { describe, expect, it } from 'vitest';
import { type Ds4DsparkOptions, ds4DsparkArgs, resolveDs4Dspark } from './dspark.js';

const SUPPORT = '/models/DeepSeek-V4-Flash-DSpark-support-0731.gguf';

/** A launch that would draft: CUDA, fully resident, support model present. */
function eligible(over: Partial<Ds4DsparkOptions> = {}): Ds4DsparkOptions {
  return { backend: 'cuda', ssdStreaming: false, supportModelPath: SUPPORT, ...over };
}

describe('DS4 DSpark policy', () => {
  it('drafts under auto on a CUDA host with a fully resident model', () => {
    const d = resolveDs4Dspark(eligible());
    expect(d.enabled).toBe(true);
    expect(ds4DsparkArgs(d)).toEqual(['--dspark', '--mtp', SUPPORT]);
  });

  it('does not draft under auto on Metal, where it measured net-negative', () => {
    const d = resolveDs4Dspark(eligible({ backend: 'metal' }));
    expect(d.enabled).toBe(false);
    expect(ds4DsparkArgs(d)).toEqual([]);
    // Not a user request, so nothing to warn about.
    expect(d.unmetRequest).toBeUndefined();
  });

  it('defaults to auto when no mode is configured', () => {
    expect(resolveDs4Dspark(eligible({ mode: undefined })).enabled).toBe(true);
    expect(resolveDs4Dspark(eligible({ mode: undefined, backend: 'metal' })).enabled).toBe(false);
  });

  it('honors an explicit on for Metal, which auto would decline', () => {
    const d = resolveDs4Dspark(eligible({ mode: 'on', backend: 'metal' }));
    expect(d.enabled).toBe(true);
    expect(d.supportModelPath).toBe(SUPPORT);
  });

  it('never drafts when off, even where auto would', () => {
    const d = resolveDs4Dspark(eligible({ mode: 'off' }));
    expect(d.enabled).toBe(false);
    expect(ds4DsparkArgs(d)).toEqual([]);
  });

  // The engine aborts at startup on this combination rather than ignoring the
  // flag, so resolving it to `enabled` would take the whole session down.
  it('refuses to draft while SSD streaming, and says so when asked to', () => {
    const auto = resolveDs4Dspark(eligible({ ssdStreaming: true }));
    expect(auto.enabled).toBe(false);
    expect(auto.reason).toMatch(/ssd.streaming/i);
    expect(auto.unmetRequest).toBeUndefined();

    const asked = resolveDs4Dspark(eligible({ mode: 'on', ssdStreaming: true }));
    expect(asked.enabled).toBe(false);
    expect(asked.unmetRequest).toMatch(/ssd streaming/i);
  });

  it('cannot draft without a support model, and says so when asked to', () => {
    const auto = resolveDs4Dspark(eligible({ supportModelPath: undefined }));
    expect(auto.enabled).toBe(false);
    expect(auto.unmetRequest).toBeUndefined();

    const asked = resolveDs4Dspark(eligible({ mode: 'on', supportModelPath: undefined }));
    expect(asked.enabled).toBe(false);
    expect(asked.unmetRequest).toMatch(/support model/i);
  });

  // `off` is the user's own choice, so it is not an unmet request no matter
  // what else is true — only `on` can go unhonored.
  it('reports an unmet request only for on', () => {
    for (const mode of ['off', 'auto'] as const) {
      expect(
        resolveDs4Dspark(eligible({ mode, ssdStreaming: true, supportModelPath: undefined }))
          .unmetRequest,
      ).toBeUndefined();
    }
  });

  it('always explains itself, on every branch', () => {
    const cases: Ds4DsparkOptions[] = [
      eligible(),
      eligible({ mode: 'off' }),
      eligible({ mode: 'on' }),
      eligible({ backend: 'metal' }),
      eligible({ ssdStreaming: true }),
      eligible({ supportModelPath: undefined }),
    ];
    for (const c of cases) expect(resolveDs4Dspark(c).reason).toMatch(/\S/);
  });

  // `--mtp-draft` moves only the legacy-MTP path; a DSpark companion carries
  // its own block_size. Emitting it here would look load-bearing and be inert.
  it('emits no --mtp-draft', () => {
    expect(ds4DsparkArgs(resolveDs4Dspark(eligible()))).not.toContain('--mtp-draft');
  });
});
