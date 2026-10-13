import type { ProviderName } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { resolveCatalogParameterSize } from '../chat/catalog-model-lookup.js';
import { classifyLocalModelTier } from '../chat/local-model-tier.js';
import type { ConfigStore } from '../fs/config-store.js';
import {
  type ResolveTuningInput,
  type ResolvedModelProfile,
  type ResolvedTuning,
  resolveProfileForCatalogId,
  resolveTuning,
} from '../model-profile/index.js';
import { applyBehaviorEnvOverrides } from '../model-profile/runtime.js';
import { resolveCatalogIdFromModelId } from './catalog-model-config.js';
export async function resolveModelSessionDefaults(
  store: Pick<ConfigStore, 'readConfig'>,
  catalog: CatalogService,
  providerName: ProviderName,
  modelId: string | undefined,
  overrides: {
    tuning?: ResolveTuningInput['override'];
    tuningProfileId?: string;
    suggestedProfileId?: string;
    reasoningEffort?: ResolveTuningInput['reasoningEffort'];
  } = {},
): Promise<{ profile: ResolvedModelProfile; tuning: ResolvedTuning }> {
  const config = await store.readConfig();
  const resolvedModelId = modelId ?? config.defaultModel?.[providerName];
  const resolvedCatalogId =
    (await resolveCatalogIdFromModelId(catalog, resolvedModelId)) ?? resolvedModelId;
  const tier = classifyLocalModelTier({
    providerName,
    modelId: resolvedModelId,
    parameterSize: await resolveCatalogParameterSize(catalog, resolvedCatalogId),
  });
  const profile = applyBehaviorEnvOverrides(
    await resolveProfileForCatalogId({
      catalog: catalog,
      catalogId: resolvedCatalogId,
      tier,
      providerName,
    }),
  );
  const catalogDetail = resolvedCatalogId
    ? await catalog.get('chat-model', resolvedCatalogId).catch(() => null)
    : null;
  const catalogTuning =
    catalogDetail && catalogDetail.manifest.kind === 'chat-model'
      ? catalogDetail.manifest.tuning
      : undefined;
  const catalogStyle =
    catalogDetail && catalogDetail.manifest.kind === 'chat-model'
      ? catalogDetail.manifest.style
      : undefined;
  const installDefaultTuning = resolvedCatalogId
    ? config.modelTuning?.[resolvedCatalogId]
    : undefined;
  const installDefaultProfileId = resolvedCatalogId
    ? config.modelTuningProfile?.[resolvedCatalogId]
    : undefined;
  const tuning = resolveTuning({
    ...(catalogTuning ? { catalog: catalogTuning } : {}),
    ...(installDefaultTuning ? { installDefault: installDefaultTuning } : {}),
    ...(overrides.tuning ? { override: overrides.tuning } : {}),
    ...(overrides.tuningProfileId ? { tuningProfileId: overrides.tuningProfileId } : {}),
    ...(installDefaultProfileId ? { installDefaultProfileId } : {}),
    ...(overrides.suggestedProfileId ? { suggestedProfileId: overrides.suggestedProfileId } : {}),
    ...(catalogStyle?.reasoningFormat
      ? { styleReasoningFormat: catalogStyle.reasoningFormat }
      : {}),
    ...(overrides.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
  });
  return { profile, tuning };
}
