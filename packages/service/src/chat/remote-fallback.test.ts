import { describe, expect, it } from 'vitest';
import {
  isRemoteOnlyModel,
  remoteFallbackNotice,
  remoteIdForRoute,
  remoteReturnNotice,
} from './remote-fallback.js';

const FP = 'cd'.repeat(32);
const remoteModel = (model: string) => `remote:${FP}/${model}`;

describe('remoteIdForRoute', () => {
  it('follows the same precedence as the model itself: gezel, night override, default', () => {
    const config = { defaultModel: { remote: `remote:${'ee'.repeat(32)}/x` } };
    expect(remoteIdForRoute({ frontmatterModel: remoteModel('qwen'), config })).toBe(FP);
    expect(
      remoteIdForRoute({
        nightOverride: { provider: 'remote', model: remoteModel('night') },
        config,
      }),
    ).toBe(FP);
    expect(remoteIdForRoute({ config })).toBe('ee'.repeat(32));
  });

  it('finds no server for a route without a remote model', () => {
    expect(remoteIdForRoute({ frontmatterModel: 'gemma-4', config: {} })).toBeUndefined();
    expect(remoteIdForRoute({ config: {} })).toBeUndefined();
  });
});

describe('isRemoteOnlyModel', () => {
  it('tells a paired server model from one any provider could run', () => {
    expect(isRemoteOnlyModel(remoteModel('qwen'))).toBe(true);
    expect(isRemoteOnlyModel('gemma-4-e4b')).toBe(false);
    expect(isRemoteOnlyModel(undefined)).toBe(false);
  });
});

describe('notices', () => {
  it('names the absent server and what answered instead', () => {
    expect(remoteFallbackNotice('Werkbank', 'llama-cpp')).toBe(
      "Werkbank isn't reachable, so this computer's own model answered instead. Gezel switches back once Werkbank is reachable again.",
    );
    expect(remoteFallbackNotice('Werkbank', 'copilot')).toContain('so Copilot answered instead');
    expect(remoteReturnNotice('Werkbank')).toBe(
      'Werkbank is reachable again and answered this one.',
    );
  });
});
