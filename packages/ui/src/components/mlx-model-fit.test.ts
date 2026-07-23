import { describe, expect, it } from 'vitest';
import {
  MLX_FALLBACK_RESIDENT_FACTOR,
  mlxFitsMemoryBudget,
  mlxResidentBytes,
} from './mlx-model-fit.js';

const GiB = 1024 ** 3;
const MAC_128_GB_BUDGET = 96 * GiB;

describe('MLX model memory fit', () => {
  it('allows the measured Laguna Q6 working set on a 128 GB Mac', () => {
    expect(
      mlxFitsMemoryBudget(
        { approxSizeBytes: 92_507_783_098, residentBytes: 99_000_000_000 },
        MAC_128_GB_BUDGET,
      ),
    ).toBe(true);
  });

  it('keeps the Laguna Q8 conversion oversized on the same budget', () => {
    expect(
      mlxFitsMemoryBudget(
        { approxSizeBytes: 124_917_624_491, residentBytes: 125_000_000_000 },
        MAC_128_GB_BUDGET,
      ),
    ).toBe(false);
  });

  it('uses the capacity broker fallback when no resident estimate is cataloged', () => {
    expect(mlxResidentBytes({ approxSizeBytes: 10_000_000_000 })).toBe(
      10_000_000_000 * MLX_FALLBACK_RESIDENT_FACTOR,
    );
  });
});
