import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createIronCalcEngine: vi.fn(async (options: unknown) => ({ options })),
}));

vi.mock('@ironcalc/wasm/wasm_bg.wasm?url', () => ({
  default: '/assets/ironcalc-test.wasm',
}));

vi.mock('@bendyline/squisq-calc/ironcalc', () => ({
  createIronCalcEngine: mocks.createIronCalcEngine,
}));

import { ironCalcEngineFactory } from './calculation.js';

describe('ironCalcEngineFactory', () => {
  beforeEach(() => {
    mocks.createIronCalcEngine.mockClear();
  });

  it('does not initialize IronCalc until Squisq requests a formula session', () => {
    expect(mocks.createIronCalcEngine).not.toHaveBeenCalled();
  });

  it('passes Squisq calculation limits and the bundled wasm URL to IronCalc', async () => {
    const config = {
      date1904: true,
      budgets: { maxWorkUnits: 250_000, maxEvalTimeMs: 2_000 },
    };

    const engine = await ironCalcEngineFactory(config);

    expect(mocks.createIronCalcEngine).toHaveBeenCalledWith({
      ...config,
      wasmSource: '/assets/ironcalc-test.wasm',
    });
    expect(engine).toEqual({
      options: { ...config, wasmSource: '/assets/ironcalc-test.wasm' },
    });
  });
});
