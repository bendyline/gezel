import { describe, expect, it } from 'vitest';
import { LOCAL_PROVIDERS, isLocalProvider, makeEngineKey, parseEngineKey } from './engine-key.js';

describe('engine-key', () => {
  it('LOCAL_PROVIDERS lists llama-cpp, mlx, and ds4', () => {
    expect(LOCAL_PROVIDERS).toEqual(['llama-cpp', 'mlx', 'ds4']);
  });

  it('isLocalProvider gates the local set', () => {
    expect(isLocalProvider('llama-cpp')).toBe(true);
    expect(isLocalProvider('mlx')).toBe(true);
    expect(isLocalProvider('ds4')).toBe(true);
    expect(isLocalProvider('copilot')).toBe(false);
    expect(isLocalProvider('ollama')).toBe(false);
    expect(isLocalProvider('')).toBe(false);
  });

  it('makeEngineKey / parseEngineKey round-trip a ds4 key', () => {
    const key = makeEngineKey('ds4', 'deepseek-v4-flash-284b-q2', 0);
    expect(key).toBe('ds4:deepseek-v4-flash-284b-q2:0');
    expect(parseEngineKey(key)).toEqual({
      provider: 'ds4',
      modelId: 'deepseek-v4-flash-284b-q2',
      replicaIdx: 0,
    });
  });

  it('makeEngineKey composes the canonical string', () => {
    expect(makeEngineKey('mlx', 'gemma4-26b', 0)).toBe('mlx:gemma4-26b:0');
    expect(makeEngineKey('llama-cpp', 'qwen3.6', 2)).toBe('llama-cpp:qwen3.6:2');
  });

  it('makeEngineKey rejects negative or non-integer replicas', () => {
    expect(() => makeEngineKey('mlx', 'a', -1)).toThrow();
    expect(() => makeEngineKey('mlx', 'a', 1.5)).toThrow();
  });

  it('makeEngineKey rejects modelId containing a colon', () => {
    expect(() => makeEngineKey('mlx', 'has:colon', 0)).toThrow();
  });

  it('parseEngineKey is the inverse of makeEngineKey', () => {
    const key = makeEngineKey('mlx', 'gemma4-26b', 1);
    expect(parseEngineKey(key)).toEqual({
      provider: 'mlx',
      modelId: 'gemma4-26b',
      replicaIdx: 1,
    });
  });

  it('parseEngineKey handles modelIds with dots and dashes', () => {
    expect(parseEngineKey('llama-cpp:qwen3.5-9b:0')).toEqual({
      provider: 'llama-cpp',
      modelId: 'qwen3.5-9b',
      replicaIdx: 0,
    });
  });

  it('parseEngineKey returns null for malformed input', () => {
    expect(parseEngineKey('')).toBeNull();
    expect(parseEngineKey('mlx')).toBeNull();
    expect(parseEngineKey('mlx:gemma')).toBeNull();
    expect(parseEngineKey('mlx:gemma:abc')).toBeNull();
    expect(parseEngineKey('openai:gpt-4:0')).toBeNull();
  });
});
