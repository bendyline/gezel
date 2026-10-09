import { GezelSdkError, type ModelListResponse } from '@bendyline/gezel-app-sdk/browser';
import type { PortableInference } from '@bendyline/gezel/mobile-inference';
import {
  MobileModelSchema,
  MobileProviderIdSchema,
  resolveMobileInferenceBudget,
  resolveMobileInferenceLimits,
} from '@bendyline/gezel/mobile-providers';

export function modelIdentity(model: string) {
  const separator = model.indexOf(':');
  const parsed = MobileProviderIdSchema.safeParse(
    separator < 0 ? model : model.slice(0, separator),
  );
  if (!parsed.success)
    throw new GezelSdkError('Unknown on-device provider', { code: 'provider_unavailable' });
  const providerId = parsed.data;
  const modelId = separator < 0 ? providerId : model.slice(separator + 1);
  if (providerId === 'llama-cpp') {
    if (separator < 0)
      throw new GezelSdkError('Choose an explicit imported model', { code: 'model_required' });
    if (!MobileModelSchema.shape.id.safeParse(modelId).success)
      throw new GezelSdkError('Invalid imported model identity', { code: 'model_unavailable' });
  } else if (modelId !== providerId) {
    throw new GezelSdkError('Unknown model for the on-device provider', {
      code: 'model_unavailable',
    });
  }
  return { providerId, modelId };
}

export async function listModels(inference: PortableInference): Promise<ModelListResponse> {
  const [providers, inventory] = await Promise.all([inference.providers(), inference.models!()]);
  return {
    object: 'list',
    data: providers.flatMap((provider) => {
      const models =
        provider.id === 'llama-cpp' ? inventory.models : [{ id: provider.id, name: provider.name }];
      return models.map((model) => {
        const contextSize = 'contextTokens' in model ? model.contextTokens : undefined;
        const limits = resolveMobileInferenceLimits(provider, contextSize);
        const budget = resolveMobileInferenceBudget(provider, { contextSize });
        return {
          id: `${provider.id}:${model.id}`,
          object: 'model' as const,
          created: 0,
          owned_by: provider.id,
          name:
            provider.id === 'apple-foundation-models'
              ? 'Apple Foundation Models'
              : provider.id === 'android-mlkit'
                ? 'Gemini Nano (Android ML Kit)'
                : model.name,
          context_window: limits.contextSize,
          max_output_tokens: limits.maxTokens,
          default_output_tokens: budget.maxTokens,
          supported_options: [
            'model',
            'messages',
            'stream',
            'max_tokens',
            ...(provider.id === 'llama-cpp' &&
            provider.capabilities.structuredChat &&
            inference.chat
              ? ['temperature', 'reasoning_effort']
              : []),
          ],
          availability: provider.availability,
          unavailable_reason: provider.reason,
          locality: provider.locality,
          capabilities: { ...provider.capabilities, tools: false, structuredOutput: false },
          native_capabilities: provider.capabilities,
          preparation:
            provider.id === 'llama-cpp'
              ? 'app-download'
              : provider.id === 'android-mlkit'
                ? 'system-download'
                : 'system-settings',
          reason_code:
            provider.availability === 'available'
              ? undefined
              : provider.availability === 'unavailable'
                ? 'provider_unavailable'
                : 'model_download_required',
          recovery_actions:
            provider.availability === 'available'
              ? []
              : provider.availability === 'unavailable'
                ? ['choose-model']
                : provider.id === 'apple-foundation-models'
                  ? ['open-system-settings']
                  : ['prepare'],
        };
      });
    }),
  };
}

export async function requireModel(inference: PortableInference, selectedId: string) {
  const identity = modelIdentity(selectedId);
  const provider = (await inference.providers()).find((entry) => entry.id === identity.providerId);
  if (!provider)
    throw new GezelSdkError('Provider is unavailable on this device', {
      code: 'provider_unavailable',
    });
  if (provider.availability !== 'available') {
    throw new GezelSdkError(provider.reason ?? `Provider is ${provider.availability}`, {
      code: provider.availability,
    });
  }
  const model =
    identity.providerId === 'llama-cpp'
      ? (await inference.models!()).models.find((entry) => entry.id === identity.modelId)
      : undefined;
  if (identity.providerId === 'llama-cpp' && !model) {
    throw new GezelSdkError('The requested model is not installed in this app', {
      code: 'model_unavailable',
    });
  }
  return { ...identity, provider, model };
}
