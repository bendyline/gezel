import { describe, expect, it } from 'vitest';
import { resolveEffectiveVideoModelId } from './video-gen.js';

function fixture(installedIds: string[], defaultVideoModel?: string) {
  const ctx = {
    store: {
      readConfig: async () => ({ ...(defaultVideoModel ? { defaultVideoModel } : {}) }),
    },
  } as unknown as Parameters<typeof resolveEffectiveVideoModelId>[0];
  const provider = {
    listInstalledModels: async () =>
      installedIds.map((id) => ({ id, name: id, approxSizeBytes: 1, installedAt: '' })),
  };
  return { ctx, provider };
}

describe('resolveEffectiveVideoModelId', () => {
  it('prefers the requested model', async () => {
    const { ctx, provider } = fixture(['ltx-2-19b', 'ltx-2.3-22b-distilled'], 'ltx-2-19b');
    expect(await resolveEffectiveVideoModelId(ctx, provider, 'ltx-2.3-22b-distilled')).toBe(
      'ltx-2.3-22b-distilled',
    );
  });

  it('uses the Settings default over the first installed model', async () => {
    const { ctx, provider } = fixture(
      ['ltx-2-19b', 'ltx-2.3-22b-distilled'],
      'ltx-2.3-22b-distilled',
    );
    expect(await resolveEffectiveVideoModelId(ctx, provider, undefined)).toBe(
      'ltx-2.3-22b-distilled',
    );
  });

  it('falls back to the first installed model when the default is not installed', async () => {
    const { ctx, provider } = fixture(['ltx-2-19b', 'wan2.2-ti2v-5b'], 'ltx-2.3-22b');
    expect(await resolveEffectiveVideoModelId(ctx, provider, undefined)).toBe('ltx-2-19b');
  });

  it('returns undefined when nothing is installed', async () => {
    const { ctx, provider } = fixture([]);
    expect(await resolveEffectiveVideoModelId(ctx, provider, undefined)).toBeUndefined();
  });
});
