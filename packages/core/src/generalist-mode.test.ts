import { describe, expect, it } from 'vitest';
import {
  effectiveGeneralistModeSetting,
  isFrontierProvider,
  isSelfOrchestratingProvider,
  legacyDensityToGeneralistMode,
  resolveExecutionDensity,
  resolveGeneralistKickoff,
  resolveTaskExecutionMode,
} from './generalist-mode.js';

const FRONTIER = ['copilot', 'anthropic', 'anthropic-cli', 'openai', 'codex-cli'] as const;
const NOT_FRONTIER = ['llama-cpp', 'mlx', 'ds4', 'ollama', 'remote', 'mock'] as const;
const TIERS = ['tiny', 'small', 'medium', 'large', 'cloud'] as const;

describe('isFrontierProvider', () => {
  it('is true for every hosted frontier provider, SDK or CLI', () => {
    for (const p of FRONTIER) expect(isFrontierProvider(p)).toBe(true);
  });

  it('is false for local engines, paired-device inference, and the mock', () => {
    for (const p of NOT_FRONTIER) expect(isFrontierProvider(p)).toBe(false);
    expect(isFrontierProvider(undefined)).toBe(false);
  });
});

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

describe('resolveTaskExecutionMode', () => {
  it('honors an explicit setting regardless of provider or tier', () => {
    expect(resolveTaskExecutionMode('on', 'llama-cpp', 'tiny')).toBe('generalist');
    expect(resolveTaskExecutionMode('off', 'codex-cli', 'cloud')).toBe('stepwise');
  });

  it('auto (and unset) is generalist for every frontier provider', () => {
    for (const p of FRONTIER) {
      expect(resolveTaskExecutionMode('auto', p)).toBe('generalist');
      expect(resolveTaskExecutionMode(undefined, p, 'cloud')).toBe('generalist');
    }
  });

  it('auto (and unset) is stepwise for local models at EVERY tier, including medium', () => {
    // The single-session + union-tool-surface semantics are unmeasured on
    // local engines; the generalist eval decides whether medium joins.
    for (const p of NOT_FRONTIER) {
      for (const tier of TIERS) {
        expect(resolveTaskExecutionMode('auto', p, tier)).toBe('stepwise');
        expect(resolveTaskExecutionMode(undefined, p, tier)).toBe('stepwise');
      }
      expect(resolveTaskExecutionMode('auto', p)).toBe('stepwise');
    }
  });
});

describe('resolveGeneralistKickoff', () => {
  it('honors an explicit setting regardless of provider', () => {
    expect(resolveGeneralistKickoff('on', 'llama-cpp')).toBe('on');
    expect(resolveGeneralistKickoff('off', 'codex-cli')).toBe('off');
    // explicit off overrides even local medium (the escape hatch)
    expect(resolveGeneralistKickoff('off', 'llama-cpp', 'medium')).toBe('off');
  });

  it('auto (and unset) is on for every frontier provider', () => {
    for (const p of FRONTIER) {
      expect(resolveGeneralistKickoff('auto', p)).toBe('on');
      expect(resolveGeneralistKickoff(undefined, p, 'cloud')).toBe('on');
    }
  });

  it('keeps the measured local MEDIUM rule; other local tiers stay off', () => {
    expect(resolveGeneralistKickoff('auto', 'llama-cpp', 'medium')).toBe('on');
    expect(resolveGeneralistKickoff(undefined, 'llama-cpp', 'medium')).toBe('on');
    expect(resolveGeneralistKickoff('auto', 'mlx', 'medium')).toBe('on');
    expect(resolveGeneralistKickoff('auto', 'llama-cpp', 'small')).toBe('off');
    expect(resolveGeneralistKickoff('auto', 'llama-cpp', 'tiny')).toBe('off');
    expect(resolveGeneralistKickoff('auto', 'llama-cpp', 'large')).toBe('off');
    // no tier hint → off (backward-compatible with callers that pass none)
    expect(resolveGeneralistKickoff('auto', 'llama-cpp')).toBe('off');
  });
});

describe('legacy executionDensity mapping', () => {
  it('maps the three old intents onto the new setting and drops anything else', () => {
    expect(legacyDensityToGeneralistMode('flat')).toBe('on');
    expect(legacyDensityToGeneralistMode('scaffold')).toBe('off');
    expect(legacyDensityToGeneralistMode('auto')).toBe('auto');
    expect(legacyDensityToGeneralistMode(undefined)).toBeUndefined();
    expect(legacyDensityToGeneralistMode('bogus')).toBeUndefined();
  });

  it('the new key wins over a lingering legacy key', () => {
    expect(
      effectiveGeneralistModeSetting({ generalistMode: 'off', executionDensity: 'flat' }),
    ).toBe('off');
    expect(effectiveGeneralistModeSetting({ executionDensity: 'flat' })).toBe('on');
    expect(effectiveGeneralistModeSetting({})).toBeUndefined();
  });

  it('the deprecated resolveExecutionDensity shim answers in the old vocabulary', () => {
    expect(resolveExecutionDensity('flat', 'llama-cpp')).toBe('flat');
    expect(resolveExecutionDensity('scaffold', 'codex-cli')).toBe('scaffold');
    expect(resolveExecutionDensity('auto', 'codex-cli')).toBe('flat');
    expect(resolveExecutionDensity(undefined, 'llama-cpp', 'medium')).toBe('flat');
    expect(resolveExecutionDensity(undefined, 'llama-cpp')).toBe('scaffold');
  });
});
