import {
  type Ds4DsparkOptions,
  ds4DsparkArgs,
  ds4DsparkStreamsWithSsd,
  resolveDs4Dspark,
} from '@bendyline/gezel-inference/internal/providers/ds4/dspark';
import { describe, expect, it } from 'vitest';

const SUPPORT = '/models/DeepSeek-V4-Flash-DSpark-support-0731.gguf';

/** A launch that would draft: CUDA, fully resident, support model present. */
function eligible(over: Partial<Ds4DsparkOptions> = {}): Ds4DsparkOptions {
  return { backend: 'cuda', ssdStreaming: false, supportModelPath: SUPPORT, ...over };
}

describe('DS4 DSpark policy', () => {
  it('drafts under auto on a CUDA host with a fully resident model', () => {
    const d = resolveDs4Dspark(eligible());
    expect(d.enabled).toBe(true);
    expect(ds4DsparkArgs(d)).toEqual(['--dspark', '--mtp-model', SUPPORT]);
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
    for (const targetArchitecture of [undefined, 'deepseek4', 'glm-dsa', 'qwen4exp']) {
      const auto = resolveDs4Dspark(eligible({ ssdStreaming: true, targetArchitecture }));
      expect(auto.enabled).toBe(false);
      expect(auto.reason).toMatch(/ssd.streaming/i);
      expect(auto.unmetRequest).toBeUndefined();

      const asked = resolveDs4Dspark(
        eligible({ mode: 'on', ssdStreaming: true, targetArchitecture }),
      );
      expect(asked.enabled).toBe(false);
      expect(asked.unmetRequest).toMatch(/ssd streaming/i);
    }
  });

  // ds4 ee7e840 accepts --mtp-model with --ssd-streaming for V4.1 only.
  it('drafts a streamed DeepSeek V4.1 launch when asked to', () => {
    const d = resolveDs4Dspark(
      eligible({ mode: 'on', ssdStreaming: true, targetArchitecture: 'deepseek41' }),
    );
    expect(d.enabled).toBe(true);
    expect(ds4DsparkArgs(d)).toEqual(['--dspark', '--mtp-model', SUPPORT]);
  });

  // Upstream reports V4.1 drafting can be slower than plain decode, and a
  // streamed launch has not been measured here, so auto stays out of it.
  it('does not draft a streamed V4.1 launch under auto, and does not warn', () => {
    for (const backend of ['cuda', 'metal'] as const) {
      const d = resolveDs4Dspark(
        eligible({ backend, ssdStreaming: true, targetArchitecture: 'deepseek41' }),
      );
      expect(d.enabled).toBe(false);
      expect(d.reason).toMatch(/ds4Dspark=on/);
      expect(d.unmetRequest).toBeUndefined();
    }
  });

  it('drops streamed V4.1 drafting when the drafter would starve the expert cache', () => {
    const d = resolveDs4Dspark(
      eligible({
        mode: 'on',
        ssdStreaming: true,
        targetArchitecture: 'deepseek41',
        companionFitsMemory: false,
      }),
    );
    expect(d.enabled).toBe(false);
    expect(d.reason).toMatch(/minimum expert cache/);
    expect(d.unmetRequest).toMatch(/expert cache/);
  });

  it('allows streamed drafting only for the deepseek41 architecture', () => {
    expect(ds4DsparkStreamsWithSsd('deepseek41')).toBe(true);
    for (const arch of [undefined, '', 'deepseek4', 'glm-dsa', 'glm5-next', 'qwen4exp']) {
      expect(ds4DsparkStreamsWithSsd(arch)).toBe(false);
    }
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
      eligible({ ssdStreaming: true, targetArchitecture: 'deepseek41' }),
      eligible({ mode: 'on', ssdStreaming: true, targetArchitecture: 'deepseek41' }),
      eligible({ supportModelPath: undefined }),
    ];
    for (const c of cases) expect(resolveDs4Dspark(c).reason).toMatch(/\S/);
  });

  // `--mtp-draft` moves only the legacy-MTP path; a DSpark companion carries
  // its own block_size. Emitting it here would look load-bearing and be inert.
  it('emits no --mtp-draft', () => {
    expect(ds4DsparkArgs(resolveDs4Dspark(eligible()))).not.toContain('--mtp-draft');
  });

  it('drops drafting rather than residency when the companion will not fit', () => {
    const d = resolveDs4Dspark({
      mode: 'auto',
      backend: 'cuda',
      ssdStreaming: false,
      companionFitsMemory: false,
      supportModelPath: '/models/dspark-support.gguf',
    });
    expect(d.enabled).toBe(false);
    expect(d.supportModelPath).toBeUndefined();
    expect(d.reason).toMatch(/does not fit alongside the resident weights/);
  });

  it('reports an unmet ds4Dspark=on when the companion will not fit', () => {
    const d = resolveDs4Dspark({
      mode: 'on',
      backend: 'cuda',
      ssdStreaming: false,
      companionFitsMemory: false,
      supportModelPath: '/models/dspark-support.gguf',
    });
    expect(d.enabled).toBe(false);
    // The user asked for drafting and is not getting it; silence here would
    // leave them believing they were.
    expect(d.unmetRequest).toMatch(/does not fit in memory/);
  });

  it('still drafts when the companion fits', () => {
    const d = resolveDs4Dspark({
      mode: 'auto',
      backend: 'cuda',
      ssdStreaming: false,
      companionFitsMemory: true,
      supportModelPath: '/models/dspark-support.gguf',
    });
    expect(d.enabled).toBe(true);
    expect(d.supportModelPath).toBe('/models/dspark-support.gguf');
  });
});
