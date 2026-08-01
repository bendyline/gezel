import { describe, expect, it } from 'vitest';
import { type ResidentModel, selectBackgroundEngine } from './background-routing.js';

const mlx26b: ResidentModel = { provider: 'mlx', modelId: 'gemma4-26b-q4' };
const llamaTiny: ResidentModel = { provider: 'llama-cpp', modelId: 'gemma4-e2b-q4' };
const llamaSmall: ResidentModel = { provider: 'llama-cpp', modelId: 'qwen3.5-9b' };
const llama70b: ResidentModel = { provider: 'llama-cpp', modelId: 'llama-3-70b' };

describe('selectBackgroundEngine', () => {
  it('routes a chore to a small model on the other engine under coexist', () => {
    const target = selectBackgroundEngine({
      foregroundProvider: 'mlx',
      resident: [mlx26b, llamaSmall],
      gpuPolicy: 'coexist',
    });
    expect(target).toEqual(llamaSmall);
  });

  it('prefers the smallest tier among other-engine candidates', () => {
    const target = selectBackgroundEngine({
      foregroundProvider: 'mlx',
      resident: [mlx26b, llamaSmall, llamaTiny],
      gpuPolicy: 'coexist',
    });
    // tiny beats small.
    expect(target).toEqual(llamaTiny);
  });

  it('returns null under a swap policy (other engine would evict the foreground)', () => {
    const target = selectBackgroundEngine({
      foregroundProvider: 'mlx',
      resident: [mlx26b, llamaTiny],
      gpuPolicy: 'swap',
    });
    expect(target).toBeNull();
  });

  it('returns null when the only small model is on the foreground engine', () => {
    // A small model on the *same* engine still queues on that engine —
    // no parallelism win, so we decline and leave existing behavior.
    const target = selectBackgroundEngine({
      foregroundProvider: 'llama-cpp',
      resident: [{ provider: 'llama-cpp', modelId: 'gemma4-e2b-q4' }, mlx26b],
      gpuPolicy: 'coexist',
    });
    expect(target).toBeNull();
  });

  it('returns null when the other engine only has a large model', () => {
    const target = selectBackgroundEngine({
      foregroundProvider: 'mlx',
      resident: [mlx26b, llama70b],
      gpuPolicy: 'coexist',
    });
    expect(target).toBeNull();
  });

  it('returns null for a cloud foreground (already runs off-box)', () => {
    const target = selectBackgroundEngine({
      foregroundProvider: 'anthropic',
      resident: [llamaTiny],
      gpuPolicy: 'coexist',
    });
    expect(target).toBeNull();
  });

  it('returns null when nothing is resident', () => {
    const target = selectBackgroundEngine({
      foregroundProvider: 'mlx',
      resident: [],
      gpuPolicy: 'coexist',
    });
    expect(target).toBeNull();
  });

  it('is deterministic when two other-engine candidates share a tier', () => {
    const a: ResidentModel = { provider: 'llama-cpp', modelId: 'qwen3.5-9b' };
    const b: ResidentModel = { provider: 'llama-cpp', modelId: 'llama-3-8b' };
    const target = selectBackgroundEngine({
      foregroundProvider: 'mlx',
      resident: [a, b],
      gpuPolicy: 'coexist',
    });
    // Both 'small'; tiebreak by modelId localeCompare → 'llama-3-8b'.
    expect(target).toEqual(b);
  });
});
