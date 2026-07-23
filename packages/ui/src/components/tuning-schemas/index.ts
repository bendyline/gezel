import type { ProviderName } from '@bendyline/gezel';
import { CLOUD_TUNING_SCHEMA } from './cloud.js';
import { LLAMA_CPP_TUNING_SCHEMA } from './llama-cpp.js';
import { MLX_TUNING_SCHEMA } from './mlx.js';
import { OLLAMA_TUNING_SCHEMA } from './ollama.js';
import type { LocalSquisqSchema as SquisqAnnotatedSchema } from './types.js';

export { CLOUD_TUNING_SCHEMA, LLAMA_CPP_TUNING_SCHEMA, MLX_TUNING_SCHEMA, OLLAMA_TUNING_SCHEMA };

/**
 * Pick the right Squisq JSON Schema for a gezel's effective provider.
 * Cloud schemas serve OpenAI, Anthropic, Anthropic CLI, Codex CLI,
 * Copilot — the provider's request-build mapping drops fields that
 * don't apply (e.g. Copilot drops everything).
 */
export function tuningSchemaForProvider(provider: ProviderName): SquisqAnnotatedSchema {
  switch (provider) {
    case 'llama-cpp':
    case 'ds4':
      return LLAMA_CPP_TUNING_SCHEMA;
    case 'mlx':
      return MLX_TUNING_SCHEMA;
    case 'ollama':
      return OLLAMA_TUNING_SCHEMA;
    case 'openai':
    case 'anthropic':
    case 'anthropic-cli':
    case 'codex-cli':
    case 'copilot':
      return CLOUD_TUNING_SCHEMA;
    case 'remote':
      // Remote models surface a generic sampling/reasoning schema; the engine
      // running on the paired server owns the real tuning application.
      return CLOUD_TUNING_SCHEMA;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}
