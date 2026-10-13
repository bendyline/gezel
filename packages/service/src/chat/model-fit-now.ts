import type { ChatModelManifest, ModelsFitNowResponse, SessionModelFit } from '@bendyline/gezel';
import { launchFitsNow, pickRecommendedModel } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { isLocalProvider } from '@bendyline/gezel-inference/internal/providers/native/engine-key';
import type { ProviderName } from '@bendyline/gezel-inference/internal/providers/types';
import type { Store } from '../fs/store.js';
import {
  type LiveLaunchView,
  liveLaunchView,
  toRecoCandidate,
} from '../providers/llama-cpp/hardware-tier.js';
import { type ChatManager, effectiveSessionModel } from './manager.js';

export interface ModelFitDeps {
  store: Pick<Store, 'readConfig' | 'getGezel'>;
  chat: Pick<ChatManager, 'getSessionRecord' | 'listModelsForProvider'>;
  catalog: Pick<CatalogService, 'list'>;
  /** Test seam: the host as a launch would find it. */
  launchView?: () => Promise<LiveLaunchView>;
}

/**
 * Whether a session's model would start now, and the best model already on
 * this computer that would. A capacity denial used to offer only Retry, which
 * repeated the same refusal, and named no model that would have worked.
 */
export async function sessionModelFitNow(
  deps: ModelFitDeps,
  sessionId: string,
): Promise<SessionModelFit | null> {
  const record = await deps.chat.getSessionRecord(sessionId);
  if (!record) return null;
  const provider: ProviderName = record.providerName;
  const config = await deps.store.readConfig();
  const frontmatterModel = (await deps.store.getGezel(record.gezelId).catch(() => null))?.parsed
    .frontmatter.model;
  const model = effectiveSessionModel({ record, frontmatterModel, config });
  const followsDefault =
    frontmatterModel === undefined &&
    record.modelSource !== 'capability-routing' &&
    !(record.nightShift === true && config.nightShift?.modelOverride?.enabled === true);
  const base = { provider, ...(model ? { model } : {}), followsDefault };
  if (!isLocalProvider(provider)) return { ...base, startsNow: null };

  const manifests = new Map<string, ChatModelManifest>();
  for (const item of await deps.catalog.list('chat-model').catch(() => [])) {
    if (item.manifest.kind === 'chat-model') manifests.set(item.manifest.id, item.manifest);
  }
  const view = await (deps.launchView ?? liveLaunchView)();
  // The candidate mapper picks the engine block by platform; MLX is the Mac engine.
  const platform =
    provider === 'mlx' ? 'darwin' : view.platform === 'darwin' ? 'linux' : view.platform;
  const candidate = (id: string) => {
    const manifest = manifests.get(id);
    return manifest ? toRecoCandidate(manifest, platform, view.machine) : null;
  };

  const current = model ? candidate(model) : null;
  const startsNow = current ? launchFitsNow(current, view.device) : null;
  if (startsNow !== false) return { ...base, startsNow };

  const installed = await deps.chat.listModelsForProvider(provider).catch(() => []);
  const alternatives = installed
    .map((info) => ({ info, c: candidate(info.id) }))
    .filter(
      (entry): entry is { info: (typeof installed)[number]; c: NonNullable<typeof entry.c> } =>
        entry.c !== null &&
        entry.info.id !== model &&
        entry.c.supportsTools !== false &&
        launchFitsNow(entry.c, view.device),
    )
    .sort(
      (a, b) =>
        (b.c.recoScore ?? 0) - (a.c.recoScore ?? 0) || b.c.residentBytes - a.c.residentBytes,
    );
  // Rank the way first run does, so the suggestion is a comfortable fit and
  // not merely the highest score that squeezes in; a model the catalog has
  // not curated falls back to score, then size.
  const ranked = pickRecommendedModel(
    alternatives.map((entry) => entry.c),
    view.device,
  );
  const best = alternatives.find((entry) => entry.c.id === ranked?.id) ?? alternatives[0];
  return {
    ...base,
    startsNow,
    ...(best
      ? {
          alternative: {
            model: best.info.id,
            name: manifests.get(best.info.id)?.name ?? best.info.name,
          },
        }
      : {}),
  };
}

/**
 * Whether each installed model for an on-device provider would start now.
 * The same arithmetic as the first-run pick and the failed-turn card, so
 * Settings never calls a model a good match the next turn refuses.
 */
export async function installedModelsFitNow(
  deps: Pick<ModelFitDeps, 'catalog' | 'launchView'> & {
    chat: Pick<ChatManager, 'listModelsForProvider'>;
  },
  provider: ProviderName,
): Promise<ModelsFitNowResponse | null> {
  if (!isLocalProvider(provider)) return null;
  const manifests = new Map<string, ChatModelManifest>();
  for (const item of await deps.catalog.list('chat-model').catch(() => [])) {
    if (item.manifest.kind === 'chat-model') manifests.set(item.manifest.id, item.manifest);
  }
  const view = await (deps.launchView ?? liveLaunchView)();
  const platform =
    provider === 'mlx' ? 'darwin' : view.platform === 'darwin' ? 'linux' : view.platform;
  const installed = await deps.chat.listModelsForProvider(provider).catch(() => []);
  const models: ModelsFitNowResponse['models'] = [];
  for (const info of installed) {
    const manifest = manifests.get(info.id);
    const candidate = manifest ? toRecoCandidate(manifest, platform, view.machine) : null;
    if (!candidate) continue;
    models.push({
      id: info.id,
      startsNow: launchFitsNow(candidate, view.device),
      launchBytes: Math.round(candidate.launchBytes ?? candidate.residentBytes),
    });
  }
  return {
    provider,
    launchCapBytes: Math.round(view.device.launchCapBytes ?? 0),
    ...(view.device.freeGpuBytes !== undefined
      ? { freeGpuBytes: Math.round(view.device.freeGpuBytes) }
      : {}),
    models,
  };
}
