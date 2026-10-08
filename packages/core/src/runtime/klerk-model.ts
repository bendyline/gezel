import { isEngagementAllowed } from '../engagement.js';
import type { PortableInference } from '../mobile/inference.js';
import {
  type MobileModelInventory,
  type MobileProvider,
  MobileProviderIdSchema,
} from '../schemas/mobile-provider.js';
import type { PortableCatalogModel } from './content.js';
import { HttpStatusError as ProductError } from './http/errors.js';
import { modelBudget } from './model-budget.js';
import { portableSampling } from './portable-sampling.js';
import type { PortableStore } from './store.js';
import type { PortableTransformTarget } from './transform.js';

/** What resolving the Klerk's model reads in the product service. */
export interface PortableKlerkModelHost {
  store: PortableStore;
  inference: PortableInference;
  providers(): Promise<MobileProvider[]>;
  recruit(role: string): Promise<{ id: string }>;
  /** The catalog entry of a downloaded model; an imported file has none. */
  catalogModelFor(
    inventory: MobileModelInventory | undefined,
    modelId: string,
  ): PortableCatalogModel | undefined;
}

/**
 * The Klerk's model for a one-shot completion: the configured Klerk gezel,
 * recruited the first time, on its provider with the budget and sampling a
 * turn would get.
 */
export async function resolvePortableKlerkModel(
  host: PortableKlerkModelHost,
  signal: AbortSignal,
): Promise<PortableTransformTarget> {
  signal.throwIfAborted();
  const config = await host.store.readConfig();
  if (!isEngagementAllowed(config)) throw new ProductError('AI engagement is off', 403);
  let gezel = config.klerkGezelId ? await host.store.getGezel(config.klerkGezelId) : null;
  if (!gezel) {
    const recruited = await host.recruit('Klerk');
    signal.throwIfAborted();
    gezel = await host.store.getGezel(recruited.id);
    if (!gezel) throw new ProductError('The Klerk could not be prepared');
    await host.store.writeConfig({ klerkGezelId: gezel.id });
  }
  const providerId = MobileProviderIdSchema.parse(gezel.provider ?? config.provider ?? 'llama-cpp');
  const provider = (await host.providers()).find((item) => item.id === providerId);
  if (provider?.availability !== 'available')
    throw new ProductError(provider?.reason ?? 'Choose an available model in Settings.', 409);
  const inventory = providerId === 'llama-cpp' ? await host.inference.models?.() : undefined;
  const modelId = gezel.parsed.frontmatter.model ?? inventory?.selectedModelId ?? providerId;
  if (providerId !== 'llama-cpp' && modelId !== providerId)
    throw new ProductError('The Klerk model is not available from this on-device provider.', 409);
  if (inventory && !inventory.models.some((model) => model.id === modelId))
    throw new ProductError(
      'The Klerk model is no longer available. Choose a model in Settings.',
      409,
    );
  const budget = modelBudget(
    config,
    provider,
    inventory,
    modelId,
    gezel.parsed.frontmatter.tuning?.sampling?.maxTokens,
  );
  const sampling =
    providerId === 'llama-cpp'
      ? portableSampling({
          catalog: host.catalogModelFor(inventory, modelId),
          installDefault: config.modelTuning?.[modelId],
          override: gezel.parsed.frontmatter.tuning,
          tuningProfileId: gezel.parsed.frontmatter.tuningProfile,
          installDefaultProfileId: config.modelTuningProfile?.[modelId],
          suggestedProfileId: gezel.parsed.frontmatter.suggestedTuningProfile,
        })
      : undefined;
  signal.throwIfAborted();
  return {
    gezelId: gezel.id,
    about: gezel.about,
    providerId,
    modelId,
    ...budget,
    ...(sampling ? { sampling } : {}),
  };
}
