import { describe, expect, it } from 'vitest';
import { humanizeChatError } from './chat-error-copy';

describe('humanizeChatError', () => {
  // The exact text of inference's ModelNotInstalledError. Its advice to an
  // API caller changed on 2026-11-11; the opening sentence this function
  // recognizes it by did not, and a test there pins that side.
  it('still names the model for the service’s not-downloaded error', () => {
    const raw =
      'Model "granite4.2-3b-q4" is not available locally for provider "llama-cpp". GET /v1/models lists every model Gezel knows; the ones whose "availability" is "available" are downloaded and ready. To download this one, POST /v1/models/ensure.';
    const shown = humanizeChatError(raw);
    expect(shown).toContain(`The model "granite4.2-3b-q4" isn't available on this device`);
    expect(shown).not.toContain('/v1/models');
  });

  it('drops the engine prefix a broker adds to the model id', () => {
    expect(
      humanizeChatError('HTTP 404 {"error":"model_not_loaded","model":"llama-cpp:qwen3.6-27b-q8"}'),
    ).toContain('"qwen3.6-27b-q8"');
  });

  it('leaves an error it does not recognize as it is', () => {
    expect(humanizeChatError('MLX runs on Apple Silicon Macs only.')).toBe(
      'MLX runs on Apple Silicon Macs only.',
    );
  });
});
