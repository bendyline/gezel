import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTAINER_PORT,
  containerPublicBase,
  ollamaEmulationAddresses,
} from './app-endpoints.js';

describe('containerPublicBase', () => {
  it('is localhost on the container port unless the container was told an address', () => {
    expect(containerPublicBase({})).toBe(`http://localhost:${DEFAULT_CONTAINER_PORT}`);
    expect(containerPublicBase({ GEZEL_CONTAINER_PORT: '6300' })).toBe('http://localhost:6300');
    expect(containerPublicBase({ GEZEL_PUBLIC_URL: 'https://gezel.example.org//' })).toBe(
      'https://gezel.example.org',
    );
  });

  it('prefers the port the listener actually took, and ignores a port that is not one', () => {
    expect(containerPublicBase({ GEZEL_CONTAINER_PORT: '0' }, 49152)).toBe(
      'http://localhost:49152',
    );
    expect(containerPublicBase({ GEZEL_CONTAINER_PORT: 'eighty' })).toBe(
      `http://localhost:${DEFAULT_CONTAINER_PORT}`,
    );
  });
});

describe('ollamaEmulationAddresses', () => {
  it('serves both dialects on the one fixed port', () => {
    expect(ollamaEmulationAddresses()).toEqual({
      openai: 'http://127.0.0.1:11434/v1',
      ollama: 'http://127.0.0.1:11434',
    });
  });
});
