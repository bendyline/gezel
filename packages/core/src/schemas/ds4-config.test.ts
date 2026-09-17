import { describe, expect, it } from 'vitest';
import { Ds4ConfigSchema } from './ds4-config.js';

describe('Ds4ConfigSchema MTP controls', () => {
  it('accepts automatic embedded MTP with an exact-sampling override', () => {
    expect(
      Ds4ConfigSchema.parse({
        ds4Mtp: 'auto',
        ds4MtpExactSampling: false,
      }),
    ).toMatchObject({ ds4Mtp: 'auto', ds4MtpExactSampling: false });
  });

  it('rejects unknown MTP modes', () => {
    expect(Ds4ConfigSchema.safeParse({ ds4Mtp: 'maybe' }).success).toBe(false);
  });
});
