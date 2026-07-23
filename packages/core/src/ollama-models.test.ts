import { describe, expect, it } from 'vitest';
import { isOllamaReasoningModel, leaksUntaggedReasoning } from './ollama-models.js';

describe('isOllamaReasoningModel', () => {
  it('matches known reasoning families by prefix and embedded substring', () => {
    expect(isOllamaReasoningModel('deepseek-r1:latest')).toBe(true);
    expect(isOllamaReasoningModel('qwq:32b')).toBe(true);
    expect(isOllamaReasoningModel('hf.co/bartowski/qwen3-thinking-gguf:Q4_K_M')).toBe(true);
    expect(isOllamaReasoningModel('gpt-oss:20b')).toBe(true);
  });

  it('rejects non-reasoning families and empty input', () => {
    expect(isOllamaReasoningModel('llama3.2:8b')).toBe(false);
    expect(isOllamaReasoningModel('mistral:7b')).toBe(false);
    expect(isOllamaReasoningModel('')).toBe(false);
  });
});

describe('leaksUntaggedReasoning', () => {
  it('flags Qwen variants regardless of how the model id is shaped', () => {
    expect(leaksUntaggedReasoning('qwen3:30b')).toBe(true);
    expect(leaksUntaggedReasoning('qwen2.5:7b')).toBe(true);
    expect(leaksUntaggedReasoning('Qwen/Qwen3-30B-A3B-Instruct')).toBe(true);
    expect(leaksUntaggedReasoning('/models/qwen3-coder-30b.gguf')).toBe(true);
    expect(leaksUntaggedReasoning('hf.co/bartowski/qwen3-thinking-gguf:Q4_K_M')).toBe(true);
  });

  it('flags DeepSeek-R1, QwQ, gpt-oss families', () => {
    expect(leaksUntaggedReasoning('deepseek-r1:latest')).toBe(true);
    expect(leaksUntaggedReasoning('qwq:32b')).toBe(true);
    expect(leaksUntaggedReasoning('gpt-oss:20b')).toBe(true);
  });

  it('flags Gemma 3/4 across MLX and Ollama tag shapes', () => {
    expect(leaksUntaggedReasoning('gemma3:e4b')).toBe(true);
    expect(leaksUntaggedReasoning('gemma4:e4b')).toBe(true);
    expect(leaksUntaggedReasoning('gemma4-26b')).toBe(true);
    expect(leaksUntaggedReasoning('gemma4-e4b-mlx')).toBe(true);
    expect(leaksUntaggedReasoning('google/gemma-3-27b-it')).toBe(true);
  });

  it('returns false for non-leaking families and empty / undefined input', () => {
    expect(leaksUntaggedReasoning('llama3.2:8b')).toBe(false);
    expect(leaksUntaggedReasoning('mistral:7b')).toBe(false);
    expect(leaksUntaggedReasoning('gemma2:9b')).toBe(false);
    expect(leaksUntaggedReasoning('')).toBe(false);
    expect(leaksUntaggedReasoning(undefined)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(leaksUntaggedReasoning('QWEN3-30B')).toBe(true);
    expect(leaksUntaggedReasoning('DeepSeek-R1')).toBe(true);
  });
});
