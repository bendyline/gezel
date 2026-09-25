import { GezelSdkError, type ModelListResponse } from '@bendyline/gezel-app-sdk/browser';
import type { PortableInference } from '@bendyline/gezel/mobile-inference';
import { MobileModelSchema, MobileProviderIdSchema } from '@bendyline/gezel/mobile-providers';

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
      return models.map((model) => ({
        id: `${provider.id}:${model.id}`,
        object: 'model' as const,
        created: 0,
        owned_by: provider.id,
        name: model.name,
        context_window: provider.contextTokens,
        availability: provider.availability,
        unavailable_reason: provider.reason,
        locality: provider.locality,
        capabilities: provider.capabilities,
      }));
    }),
  };
}

export async function requireModel(inference: PortableInference, model: string) {
  const identity = modelIdentity(model);
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
  if (
    identity.providerId === 'llama-cpp' &&
    !(await inference.models!()).models.some((entry) => entry.id === identity.modelId)
  ) {
    throw new GezelSdkError('The requested model is not installed in this app', {
      code: 'model_unavailable',
    });
  }
  return { ...identity, provider };
}
