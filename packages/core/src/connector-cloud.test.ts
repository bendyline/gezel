import { describe, expect, it } from 'vitest';
import {
  connectionKeepsLocal,
  connectorAsksBeforeCloud,
  modelRunsOnThisComputer,
} from './connector-cloud.js';

describe('which connections stay on this computer', () => {
  it('asks for every Google account type, and nothing else', () => {
    for (const type of ['calendar-google', 'files-google-drive', 'mail-gmail']) {
      expect(connectorAsksBeforeCloud(type)).toBe(true);
    }
    for (const type of ['calendar-microsoft', 'mail-imap', 'youtube-videos', 'github-issues']) {
      expect(connectorAsksBeforeCloud(type)).toBe(false);
    }
  });

  it('keeps a Google connection local until the person allows cloud models', () => {
    expect(connectionKeepsLocal({ type: 'calendar-google' })).toBe(true);
    expect(connectionKeepsLocal({ type: 'calendar-google', allowCloudModels: false })).toBe(true);
    expect(connectionKeepsLocal({ type: 'calendar-google', allowCloudModels: true })).toBe(false);
    expect(connectionKeepsLocal({ type: 'rss-feed' })).toBe(false);
  });
});

describe('modelRunsOnThisComputer', () => {
  it('passes on-device engines and refuses cloud and paired ones', () => {
    for (const provider of ['llama-cpp', 'mlx', 'ds4', 'apple-foundation-models'] as const) {
      expect(modelRunsOnThisComputer(provider)).toBe(true);
    }
    for (const provider of ['copilot', 'openai', 'anthropic', 'anthropic-cli', 'remote'] as const) {
      expect(modelRunsOnThisComputer(provider)).toBe(false);
    }
    expect(modelRunsOnThisComputer(undefined)).toBe(false);
  });

  it('sees through Ollama to a hosted model or another machine', () => {
    expect(modelRunsOnThisComputer('ollama', 'llama3.2:3b')).toBe(true);
    expect(modelRunsOnThisComputer('ollama', 'gpt-oss:120b-cloud')).toBe(false);
    expect(modelRunsOnThisComputer('ollama', 'kimi-k2:cloud')).toBe(false);
    const at = (ollamaBaseUrl: string) =>
      modelRunsOnThisComputer('ollama', 'llama3.2:3b', { ollamaBaseUrl });
    expect(at('http://localhost:11434')).toBe(true);
    expect(at('127.0.0.1:11434')).toBe(true);
    expect(at('http://[::1]:11434')).toBe(true);
    expect(at('http://192.168.1.20:11434')).toBe(false);
    expect(at('https://ollama.com')).toBe(false);
    expect(at('http://127.0.0.1.example.com')).toBe(false);
  });
});
