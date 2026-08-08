import { describe, expect, it } from 'vitest';
import { formatEngineIdentity, formatEngineStatus } from './EnginePill.js';

describe('formatEngineIdentity', () => {
  it('presents llama-cpp as llama and includes its model', () => {
    expect(formatEngineIdentity('llama-cpp', 'gemma-4-e4b')).toBe('llama · gemma-4-e4b');
  });

  it('preserves other provider names', () => {
    expect(formatEngineIdentity('openai', 'gpt-5')).toBe('openai · gpt-5');
  });

  it('falls back cleanly when no provider or model is resolved', () => {
    expect(formatEngineIdentity(undefined, undefined)).toBe('on-device');
    expect(formatEngineIdentity('copilot', undefined)).toBe('copilot');
  });
});

describe('formatEngineStatus', () => {
  it('places the effective access mode between activity and engine identity', () => {
    expect(formatEngineStatus('mlx', 'qwen3.6-27b-q8', true, 'reading prompt', 'editable')).toBe(
      '● reading prompt · editable · mlx · qwen3.6-27b-q8',
    );
  });
});
