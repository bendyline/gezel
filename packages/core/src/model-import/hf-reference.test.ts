import { describe, expect, it } from 'vitest';
import {
  huggingFaceModelUrl,
  isHuggingFaceRepoId,
  isSafeGgufRepoPath,
  parseHuggingFaceReference,
} from './hf-reference.js';

describe('parseHuggingFaceReference', () => {
  it('reads a bare repo, with and without a quant tag', () => {
    expect(parseHuggingFaceReference('unsloth/Qwen3-8B-GGUF')).toEqual({
      repo: 'unsloth/Qwen3-8B-GGUF',
    });
    expect(parseHuggingFaceReference('unsloth/Qwen3-8B-GGUF:Q4_K_M')).toEqual({
      repo: 'unsloth/Qwen3-8B-GGUF',
      quant: 'Q4_K_M',
    });
    expect(parseHuggingFaceReference('  hf.co/bartowski/Phi-4-GGUF:IQ4_XS ')).toEqual({
      repo: 'bartowski/Phi-4-GGUF',
      quant: 'IQ4_XS',
    });
  });

  it('reads model pages, blob and resolve links', () => {
    expect(parseHuggingFaceReference('https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF')).toEqual(
      { repo: 'ggml-org/gemma-3-4b-it-GGUF' },
    );
    expect(
      parseHuggingFaceReference(
        'https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF/blob/main/gemma-3-4b-it-Q4_K_M.gguf',
      ),
    ).toEqual({
      repo: 'ggml-org/gemma-3-4b-it-GGUF',
      revision: 'main',
      file: 'gemma-3-4b-it-Q4_K_M.gguf',
    });
    expect(
      parseHuggingFaceReference(
        'https://hf.co/org/m-GGUF/resolve/0123456789abcdef0123456789abcdef01234567/Q8_0/m-Q8_0-00001-of-00002.gguf?download=true',
      ),
    ).toEqual({
      repo: 'org/m-GGUF',
      revision: '0123456789abcdef0123456789abcdef01234567',
      file: 'Q8_0/m-Q8_0-00001-of-00002.gguf',
    });
    expect(parseHuggingFaceReference('https://huggingface.co/org/m-GGUF/tree/main')).toEqual({
      repo: 'org/m-GGUF',
      revision: 'main',
    });
  });

  it('refuses other hosts, datasets, Spaces and unsafe paths', () => {
    expect(parseHuggingFaceReference('https://example.com/org/model')).toBeNull();
    expect(parseHuggingFaceReference('https://huggingface.co/datasets/org/data')).toBeNull();
    expect(parseHuggingFaceReference('https://huggingface.co/spaces/org/app')).toBeNull();
    // A URL's own `..` is resolved before the path is read; the bare form is not.
    expect(parseHuggingFaceReference('huggingface.co/org/m/blob/main/../secret.gguf')).toBeNull();
    expect(
      parseHuggingFaceReference('https://huggingface.co/org/m/blob/main/../../etc/passwd.gguf'),
    ).toEqual({ repo: 'org/m' });
    expect(
      parseHuggingFaceReference('https://huggingface.co/org/m/blob/main/model.bin'),
    ).toBeNull();
    expect(parseHuggingFaceReference('just some words')).toBeNull();
    expect(parseHuggingFaceReference('org/..')).toBeNull();
  });
});

describe('isSafeGgufRepoPath', () => {
  it('accepts nested GGUF paths and refuses traversal', () => {
    expect(isSafeGgufRepoPath('Q4_K_M/model-Q4_K_M-00001-of-00003.gguf')).toBe(true);
    expect(isSafeGgufRepoPath('../model.gguf')).toBe(false);
    expect(isSafeGgufRepoPath('/abs/model.gguf')).toBe(false);
    expect(isSafeGgufRepoPath('dir\\model.gguf')).toBe(false);
    expect(isSafeGgufRepoPath('model.safetensors')).toBe(false);
  });
});

describe('isHuggingFaceRepoId', () => {
  it('needs exactly owner/name', () => {
    expect(isHuggingFaceRepoId('a/b')).toBe(true);
    expect(isHuggingFaceRepoId('a/b/c')).toBe(false);
    expect(isHuggingFaceRepoId('a')).toBe(false);
    expect(isHuggingFaceRepoId('a/b c')).toBe(false);
  });
});

describe('huggingFaceModelUrl', () => {
  it('links the model page, and a pinned revision when it is not main', () => {
    expect(huggingFaceModelUrl('org/m')).toBe('https://huggingface.co/org/m');
    expect(huggingFaceModelUrl('org/m', 'abc')).toBe('https://huggingface.co/org/m/tree/abc');
  });
});
