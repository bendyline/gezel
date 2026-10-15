import type { PortableInference } from '../mobile/inference.js';
import type { MobileProvider, MobileProviderId } from '../schemas/mobile-provider.js';

/**
 * This device's own model: what a conversation on another device's model runs
 * on while that device is away, and what background chores (the Klerk's
 * rewrites, growth proposals) always run on. The chosen llama.cpp model when
 * there is one, otherwise the system model.
 */
export async function pickLocalProvider(host: {
  providers(): Promise<MobileProvider[]>;
  inference: Pick<PortableInference, 'models'>;
}): Promise<{ providerId: MobileProviderId; provider: MobileProvider } | null> {
  const available = (await host.providers()).filter((item) => item.availability === 'available');
  const llama = available.find((item) => item.id === 'llama-cpp');
  if (llama) {
    const inventory = await host.inference.models?.();
    if (inventory?.models.some((model) => model.id === inventory.selectedModelId))
      return { providerId: 'llama-cpp', provider: llama };
  }
  const system = available.find((item) => item.id !== 'llama-cpp');
  return system ? { providerId: system.id, provider: system } : null;
}
