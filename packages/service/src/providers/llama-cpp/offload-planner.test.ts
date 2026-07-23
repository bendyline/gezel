import { describe, expect, it } from 'vitest';
import { planMoeOffload } from './offload-planner.js';

const GiB = 1024 ** 3;

describe('planMoeOffload', () => {
  it('does nothing when there is no GPU', () => {
    const d = planMoeOffload({ isMoE: true, residentBytes: 40 * GiB, vramBytes: 0 });
    expect(d.cpuMoe).toBeUndefined();
    expect(d.nGpuLayers).toBeUndefined();
    expect(d.reason).toMatch(/no GPU/i);
  });

  it('leaves dense models to the engine (--fit / -ngl auto)', () => {
    const d = planMoeOffload({ isMoE: false, residentBytes: 40 * GiB, vramBytes: 12 * GiB });
    expect(d).toEqual({});
  });

  it('does not offload a MoE that fits VRAM', () => {
    const d = planMoeOffload({ isMoE: true, residentBytes: 8 * GiB, vramBytes: 24 * GiB });
    expect(d.cpuMoe).toBeUndefined();
    expect(d.reason).toMatch(/fits VRAM/i);
  });

  it('streams experts from RAM for a big MoE on a small GPU', () => {
    // 35B-A3B ~ 24 GiB resident on a 12 GiB card.
    const d = planMoeOffload({ isMoE: true, residentBytes: 24 * GiB, vramBytes: 12 * GiB });
    expect(d.cpuMoe).toBe(true);
    expect(d.nGpuLayers).toBe(-1);
    expect(d.reason).toMatch(/cpu-moe/i);
  });

  it('respects the margin at the fit boundary', () => {
    // resident 10 GiB, vram 12 GiB, margin 1 GiB → 10+1 ≤ 12 → fits.
    expect(
      planMoeOffload({ isMoE: true, residentBytes: 10 * GiB, vramBytes: 12 * GiB }).cpuMoe,
    ).toBeUndefined();
    // resident 11.5 GiB → 11.5+1 > 12 → offload.
    expect(
      planMoeOffload({ isMoE: true, residentBytes: 11.5 * GiB, vramBytes: 12 * GiB }).cpuMoe,
    ).toBe(true);
    // custom margin widens the "won't fit" zone.
    expect(
      planMoeOffload({
        isMoE: true,
        residentBytes: 10 * GiB,
        vramBytes: 12 * GiB,
        marginBytes: 3 * GiB,
      }).cpuMoe,
    ).toBe(true);
  });
});
