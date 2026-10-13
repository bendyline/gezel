import type { AppModel } from '@bendyline/gezel/app-models';
import { appleFoundationModelsStatus } from '../../providers/apple-foundation-models/status.js';

/** Inventory owns system readiness, so embedders never speak the native helper protocol. */
export async function appleSystemModel(created: number): Promise<AppModel[]> {
  const status = await appleFoundationModelsStatus();
  if (!status.supported || !status.installed) return [];
  return [
    {
      id: 'apple-foundation-models:apple-foundation-models',
      object: 'model',
      created,
      owned_by: 'apple-foundation-models',
      name: 'Apple Intelligence',
      locality: 'on-device',
      availability: status.available ? 'available' : 'unavailable',
      preparation: 'system-settings',
      ...(status.runtime
        ? {
            context_window: status.runtime.contextTokens,
            // Every reply stops here (1,024 tokens) whatever `max_tokens`
            // asks for, which is also the cap with none: size work to it.
            max_output_tokens: status.runtime.maxOutputTokens,
            default_output_tokens: status.runtime.maxOutputTokens,
            capabilities: {
              text: true,
              tools: true,
              // `response_format: json_schema` runs on Apple's guided generation.
              structuredOutput: status.runtime.modelCapabilities?.guidedGeneration ?? true,
              // The helper carries text and tools only.
              images: false,
              foregroundOnly: false,
            },
          }
        : {}),
      ...(!status.available
        ? {
            unavailable_reason:
              status.reason ?? 'Apple Intelligence is not ready. Check System Settings.',
            reason_code: 'system_model_unavailable',
            recovery_actions: ['open-system-settings' as const],
          }
        : {}),
    },
  ];
}
