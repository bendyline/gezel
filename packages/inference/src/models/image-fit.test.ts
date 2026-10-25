import type { MediaWeightFile } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { sdServerLedgerClaim, sdServerRequirement } from './image-fit.js';

const GIB = 1024 ** 3;

/** FLUX.2 Klein 4B Q4 as the catalog pins it: GGUF diffusion and encoder, F32 VAE. */
const kleinFiles: MediaWeightFile[] = [
  { component: 'diffusion_model', format: 'gguf', sizeBytes: 2_460_378_560 },
  { component: 'llm', format: 'gguf', sizeBytes: 2_497_281_312 },
  {
    component: 'vae',
    format: 'safetensors',
    sizeBytes: 249_519_092,
    tensors: { floatElements: { F32: 62_373_347 }, otherBytes: 8 },
  },
];

function klein(pool: 'discrete' | 'unified' | 'cpu') {
  return sdServerRequirement({
    modelId: 'flux-2-klein-4b-q4',
    weightsKind: 'diffusion-model',
    files: kleinFiles,
    pool,
  });
}

describe('sdServerLedgerClaim', () => {
  it('claims the render peak on a discrete card, not the weights alone', () => {
    const requirement = klein('discrete');
    const claim = sdServerLedgerClaim(requirement, 11.3 * GIB);
    // M0 measured 9.4 GiB dedicated for a 1024px render on a 12 GiB card;
    // the weights alone are under 5 GiB.
    expect(requirement.gpuBytes).toBeLessThan(5.5 * GIB);
    expect(claim.gpuBytes).toBe(requirement.gpuPeakBytes);
    expect(claim.gpuBytes).toBeGreaterThan(8 * GIB);
    expect(claim.bytes).toBeGreaterThanOrEqual(claim.gpuBytes);
  });

  it('caps the claim at the card so a model that offloads is still admitted', () => {
    const claim = sdServerLedgerClaim(klein('discrete'), 6 * GIB);
    expect(claim.gpuBytes).toBe(6 * GIB);
  });

  it('leaves unified and processor pools as priced', () => {
    for (const pool of ['unified', 'cpu'] as const) {
      const requirement = klein(pool);
      expect(sdServerLedgerClaim(requirement, 64 * GIB)).toEqual({
        bytes: requirement.bytes,
        gpuBytes: requirement.gpuBytes,
      });
    }
  });
});
