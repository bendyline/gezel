import { describe, expect, it } from 'vitest';
import { isSelfOrchestratingProvider, resolveExecutionDensity } from './execution-density.js';

describe('isSelfOrchestratingProvider', () => {
  it('is true for providers that bring their own agent loop', () => {
    expect(isSelfOrchestratingProvider('codex-cli')).toBe(true);
    expect(isSelfOrchestratingProvider('anthropic-cli')).toBe(true);
    expect(isSelfOrchestratingProvider('copilot')).toBe(true);
  });

  it('is false for raw providers gezel drives turn-by-turn', () => {
    expect(isSelfOrchestratingProvider('llama-cpp')).toBe(false);
    expect(isSelfOrchestratingProvider('mlx')).toBe(false);
    expect(isSelfOrchestratingProvider('anthropic')).toBe(false);
    expect(isSelfOrchestratingProvider('openai')).toBe(false);
    expect(isSelfOrchestratingProvider(undefined)).toBe(false);
  });
});

describe('resolveExecutionDensity', () => {
  it('honors an explicit setting regardless of provider', () => {
    expect(resolveExecutionDensity('flat', 'llama-cpp')).toBe('flat');
    expect(resolveExecutionDensity('scaffold', 'codex-cli')).toBe('scaffold');
  });

  it('auto picks flat for self-orchestrating providers, scaffold otherwise', () => {
    expect(resolveExecutionDensity('auto', 'codex-cli')).toBe('flat');
    expect(resolveExecutionDensity('auto', 'copilot')).toBe('flat');
    expect(resolveExecutionDensity('auto', 'mlx')).toBe('scaffold');
    expect(resolveExecutionDensity('auto', 'anthropic')).toBe('scaffold');
  });

  it('defaults to auto when unset — flat for self-orchestrating, scaffold for raw', () => {
    // auto is the default (A/B). Self-orchestrating providers go
    // flat; local / raw-cloud are unaffected (scaffold).
    expect(resolveExecutionDensity(undefined, 'codex-cli')).toBe('flat');
    expect(resolveExecutionDensity(undefined, 'copilot')).toBe('flat');
    expect(resolveExecutionDensity(undefined, 'llama-cpp')).toBe('scaffold');
    expect(resolveExecutionDensity(undefined, 'anthropic')).toBe('scaffold');
  });

  it('explicit scaffold overrides the auto default (the escape hatch)', () => {
    expect(resolveExecutionDensity('scaffold', 'codex-cli')).toBe('scaffold');
  });

  it('local MEDIUM tier resolves to flat (paired N=3 A/B); other local tiers stay scaffold', () => {
    expect(resolveExecutionDensity('auto', 'llama-cpp', 'medium')).toBe('flat');
    expect(resolveExecutionDensity(undefined, 'llama-cpp', 'medium')).toBe('flat');
    expect(resolveExecutionDensity('auto', 'mlx', 'medium')).toBe('flat');
    // small / tiny / large local stay on scaffold pending evidence
    expect(resolveExecutionDensity('auto', 'llama-cpp', 'small')).toBe('scaffold');
    expect(resolveExecutionDensity('auto', 'llama-cpp', 'tiny')).toBe('scaffold');
    expect(resolveExecutionDensity('auto', 'llama-cpp', 'large')).toBe('scaffold');
    // no tier hint → scaffold (backward-compatible with existing callers)
    expect(resolveExecutionDensity('auto', 'llama-cpp')).toBe('scaffold');
    // explicit scaffold overrides even for medium (the escape hatch)
    expect(resolveExecutionDensity('scaffold', 'llama-cpp', 'medium')).toBe('scaffold');
    // cloud tier is not local-medium → unaffected
    expect(resolveExecutionDensity('auto', 'anthropic', 'cloud')).toBe('scaffold');
  });
});
