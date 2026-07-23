import { describe, expect, it } from 'vitest';
import { providerLabel } from './provider-label.js';

describe('providerLabel', () => {
  it('returns the platform-specific label for llama-cpp', () => {
    // The point of this whole helper: don't show "On-device" on a
    // Windows PC when we know it's a Windows PC.
    expect(providerLabel('llama-cpp', 'win32')).toBe('This Windows PC');
    expect(providerLabel('llama-cpp', 'linux')).toBe('This Linux device');
  });

  it('falls back to "On-device" for llama-cpp on darwin', () => {
    // MLX owns the "This Mac" slot on Apple Silicon, so llama-cpp on
    // darwin reads as the cross-platform fallback engine — distinct
    // enough that the two tabs/pills don't collide. The technical
    // wording ("On-device") is acceptable here precisely because MLX
    // is the canonical answer for the platform-specific name.
    expect(providerLabel('llama-cpp', 'darwin')).toBe('On-device');
  });

  it('falls back to "On-device" for llama-cpp without a platform hint', () => {
    // Plain-web build / unit tests / contexts without the preload
    // bridge land here. Generic name beats wrong name.
    expect(providerLabel('llama-cpp', undefined)).toBe('On-device');
    expect(providerLabel('llama-cpp')).toBe('On-device');
  });

  it('reads MLX as "This Mac" regardless of platform', () => {
    // MLX is Apple-Silicon-exclusive — the only platform it can
    // physically run on is macOS, so the label is unconditional.
    expect(providerLabel('mlx', 'darwin')).toBe('This Mac');
    expect(providerLabel('mlx', undefined)).toBe('This Mac');
  });

  it('uses the recognizable DwarfStar engine name for ds4', () => {
    expect(providerLabel('ds4', 'darwin')).toBe('DwarfStar');
    expect(providerLabel('ds4', 'linux', { compact: true })).toBe('ds4');
  });

  it('returns the canonical name for cloud providers', () => {
    expect(providerLabel('copilot', 'win32')).toBe('Copilot');
    expect(providerLabel('openai', 'darwin')).toBe('OpenAI');
    expect(providerLabel('anthropic', 'linux')).toBe('Claude');
    expect(providerLabel('anthropic-cli')).toBe('Claude CLI');
    expect(providerLabel('codex-cli')).toBe('Codex CLI');
    expect(providerLabel('ollama')).toBe('Ollama');
  });

  describe('compact: true', () => {
    // The QueueMeter pill in the header uses the compact form when
    // the titlebar squeezes the chip narrow — a user screenshot had
    // "THIS WINDOWS PC" wrapping over 3 rows. Compact returns just
    // "Windows" / "Linux" / "Mac" / "Local" — the platform identity
    // without the "This …" / "… device" / "… PC" suffix.

    it('returns just the platform word for llama-cpp', () => {
      expect(providerLabel('llama-cpp', 'win32', { compact: true })).toBe('Windows');
      expect(providerLabel('llama-cpp', 'linux', { compact: true })).toBe('Linux');
      expect(providerLabel('llama-cpp', 'darwin', { compact: true })).toBe('Local');
      expect(providerLabel('llama-cpp', undefined, { compact: true })).toBe('Local');
    });

    it('returns "Mac" for MLX', () => {
      expect(providerLabel('mlx', 'darwin', { compact: true })).toBe('Mac');
      expect(providerLabel('mlx', undefined, { compact: true })).toBe('Mac');
    });

    it('drops the "CLI" suffix on Claude CLI / Codex CLI', () => {
      expect(providerLabel('anthropic-cli', undefined, { compact: true })).toBe('Claude');
      expect(providerLabel('codex-cli', undefined, { compact: true })).toBe('Codex');
    });

    it('leaves already-short cloud names unchanged', () => {
      // Copilot, OpenAI, Ollama, plain Claude don't have a longer
      // form, so compact is a no-op for them.
      expect(providerLabel('copilot', undefined, { compact: true })).toBe('Copilot');
      expect(providerLabel('openai', undefined, { compact: true })).toBe('OpenAI');
      expect(providerLabel('ollama', undefined, { compact: true })).toBe('Ollama');
      expect(providerLabel('anthropic', undefined, { compact: true })).toBe('Claude');
    });

    it('default (no opts) returns the full form (regression guard)', () => {
      // Existing call sites pass no opts and expect the canonical
      // long form. Pin that the default didn't shift.
      expect(providerLabel('llama-cpp', 'win32')).toBe('This Windows PC');
      expect(providerLabel('mlx', 'darwin')).toBe('This Mac');
      expect(providerLabel('anthropic-cli')).toBe('Claude CLI');
    });
  });
});
