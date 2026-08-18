import { describe, expect, it } from 'vitest';
import { externalGezelModelId } from './external-gezel-model.js';

describe('externalGezelModelId', () => {
  it('combines the role and gezel name as a lowercase model id', () => {
    expect(externalGezelModelId({ id: 'sipho-stable-id', name: 'Sipho', role: 'Developer' })).toBe(
      'gezel:developer-sipho',
    );
  });

  it('slugifies multi-word and accented labels', () => {
    expect(
      externalGezelModelId({
        id: 'eloise-stable-id',
        name: 'Éloïse van Dijk',
        role: 'UX Researcher',
      }),
    ).toBe('gezel:ux-researcher-eloise-van-dijk');
  });

  it('falls back to the name when a gezel has no role', () => {
    expect(externalGezelModelId({ id: 'helper-id', name: 'Helper' })).toBe('gezel:helper');
  });
});
