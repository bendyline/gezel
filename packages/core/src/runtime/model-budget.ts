import type { PortableInference } from '../mobile/inference.js';
import type { GezelConfig } from '../schemas/api.js';
import {
  type MobileInferenceBudget,
  type MobileModelInventory,
  type MobileProvider,
  resolveMobileInferenceBudget,
} from '../schemas/mobile-provider.js';
import { json } from './http/json.js';
import type { PortableStore } from './store.js';

/** The window the device reported it can hold for this model, when it did. */
function fittedContext(
  inventory: MobileModelInventory | undefined,
  modelId: string,
): number | undefined {
  return inventory?.models.find((model) => model.id === modelId)?.contextTokens;
}

/**
 * The window and reply ceiling a turn runs with, and what the model listing
 * reports: the person's per-model choice, else the window this device fits and
 * the default reply budget. A gezel's own reply budget wins over both.
 */
export function modelBudget(
  config: Pick<GezelConfig, 'modelContextOverrides' | 'modelTuning'>,
  provider: MobileProvider,
  inventory: MobileModelInventory | undefined,
  modelId: string,
  gezelMaxTokens?: number,
): MobileInferenceBudget {
  return resolveMobileInferenceBudget(provider, {
    contextSize:
      config.modelContextOverrides?.[`${provider.id}:${modelId}`] ??
      fittedContext(inventory, modelId),
    maxTokens: gezelMaxTokens ?? config.modelTuning?.[modelId]?.sampling?.maxTokens,
  });
}

/** `GET /api/models` and `/api/models/test`: the listing reports the budget turns run with. */
export async function handlePortableModelsRoute(
  host: {
    store: PortableStore;
    inference: PortableInference;
    providers(): Promise<MobileProvider[]>;
  },
  id: string | undefined,
  query: URLSearchParams,
): Promise<Response> {
  const providers = await host.providers();
  const provider = providers.find((item) => item.id === query.get('provider'));
  const inventory = provider?.id === 'llama-cpp' ? await host.inference.models?.() : undefined;
  if (id === 'test') {
    if (inventory && !inventory.models.some((model) => model.id === inventory.selectedModelId))
      return json({
        ok: false,
        provider: provider!.id,
        error: inventory.models.length
          ? 'Choose an installed chat model to finish setup.'
          : 'Download or import a chat model to get started.',
      });
    return json(
      provider?.availability === 'available'
        ? { ok: true, provider: provider.id, modelCount: inventory?.models.length ?? 1 }
        : {
            ok: false,
            provider: query.get('provider'),
            error: provider?.reason ?? 'Provider unavailable on this host',
          },
    );
  }
  if (provider?.availability !== 'available')
    return json({ provider: query.get('provider'), models: [] });
  const config = await host.store.readConfig();
  // The window and reply ceiling turns actually get, so the UI and the
  // eval harness never run on a second copy of the budget rules.
  const describe = (id: string, name: string) => {
    let budget: MobileInferenceBudget | undefined;
    try {
      budget = modelBudget(config, provider, inventory, id);
    } catch {
      budget = undefined;
    }
    return {
      id,
      name,
      contextWindow: budget?.contextSize ?? provider.contextTokens,
      ...(budget ? { maxOutputTokens: budget.maxTokens } : {}),
      supportsTools: true,
    };
  };
  return json({
    provider: provider.id,
    models: inventory
      ? inventory.models.map((model) => describe(model.id, model.name))
      : [describe(provider.id, provider.name)],
  });
}
