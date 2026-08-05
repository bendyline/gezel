import { describe, expect, it } from 'vitest';
import { mlxGenerationPhaseDetail } from './provider.js';

describe('mlxGenerationPhaseDetail', () => {
  it('shows speed and tokens when the sidecar reports both', () => {
    expect(mlxGenerationPhaseDetail(16.25, 203)).toBe('16 tok/s · 203 tokens');
  });

  it('still emits meaningful progress for BatchGenerator zero-speed frames', () => {
    expect(mlxGenerationPhaseDetail(0, 203)).toBe('Generating · 203 tokens');
  });

  it('has a liveness fallback when usage is absent', () => {
    expect(mlxGenerationPhaseDetail(undefined, undefined)).toBe('Generating response');
  });
});
