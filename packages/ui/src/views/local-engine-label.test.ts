import { describe, expect, it } from 'vitest';
import { localEngineSettingsLabel } from './local-engine-label.js';

describe('localEngineSettingsLabel', () => {
  it('uses Mac language and identifies each local runtime on macOS', () => {
    expect(localEngineSettingsLabel('mlx', 'darwin')).toBe('This Mac (Apple MLX)');
    expect(localEngineSettingsLabel('llama-cpp', 'darwin')).toBe('This Mac (llama)');
    expect(localEngineSettingsLabel('ds4', 'darwin')).toBe('This Mac (DwarfStar - DS4)');
  });

  it('uses PC language on Windows and Linux', () => {
    expect(localEngineSettingsLabel('llama-cpp', 'win32')).toBe('This PC (llama)');
    expect(localEngineSettingsLabel('ds4', 'linux')).toBe('This PC (DwarfStar - DS4)');
  });
});
