import { estimateMlxResidentBytes } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { mlxFitsMemoryBudget, mlxResidentBytes } from './mlx-model-fit.js';

const GiB = 1024 ** 3;
const MAC_128_GB_BUDGET = 112 * GiB;

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
      estimateMlxResidentBytes(10_000_000_000),
    );
  });

  it('does not falsely reject the Qwen3.8 Flash Next Q4 conversion on a 128 GiB Mac', () => {
    // The catalog installs 32 runtime files. README + .gitattributes are not
    // model payload, so this is 3,241 bytes below the full HF repository tree.
    const qwenDownloadBytes = 111_546_650_177;
    const current128GiBAutoBudget = 112 * GiB;
    expect(
      mlxFitsMemoryBudget({ approxSizeBytes: qwenDownloadBytes }, current128GiBAutoBudget),
    ).toBe(true);
  });
});
