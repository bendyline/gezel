import type { AppleFoundationModelsStatus } from '@bendyline/gezel';
import type { AppModel } from '@bendyline/gezel/app-models';
import { appleFoundationModelsStatus } from '../../providers/apple-foundation-models/status.js';

/**
 * How long listings reuse Apple's readiness. Each check launches the
 * `gezel-apple-fm` helper for one handshake (26-59 ms measured), and the SDK's
 * `streamText` lists models before every call, so a fresh check per listing
 * cost a process launch per chat. Short enough that Apple Intelligence
 * enabled in System Settings shows up almost at once.
 */
const STATUS_TTL_MS = 10_000;
let cachedStatus: { at: number; status: Promise<AppleFoundationModelsStatus> } | null = null;

/** Concurrent listings share one in-flight check. */
function appleStatus(): Promise<AppleFoundationModelsStatus> {
  const now = Date.now();
  if (!cachedStatus || now - cachedStatus.at > STATUS_TTL_MS)
    cachedStatus = { at: now, status: appleFoundationModelsStatus() };
  return cachedStatus.status;
}

/** @internal Lets tests list models under a changed Apple status. */
export function resetAppleStatusCache(): void {
  cachedStatus = null;
}

/** Inventory owns system readiness, so embedders never speak the native helper protocol. */
export async function appleSystemModel(created: number): Promise<AppModel[]> {
  const status = await appleStatus();
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
