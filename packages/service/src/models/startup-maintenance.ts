import { createLogger } from '@bendyline/gezel';
import type { ConfigStore } from '../fs/config-store.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import type { MlxModelManager } from '../providers/mlx/index.js';
import { migrateLegacyQuantSuffixIds, remapEngineScopedKeys } from './legacy-quant-suffix.js';
import { modelStorageRoots, reclaimAbandonedModelDownloads } from './storage-roots.js';
const log = createLogger('models');
export async function migrateInstalledModelIds(
  home: string,
  store: Pick<ConfigStore, 'readConfig' | 'writeConfig'>,
): Promise<void> {
  try {
    const renames = (
      await Promise.all(
        (['llama-cpp', 'ds4', 'mlx'] as const).map((engine) =>
          migrateLegacyQuantSuffixIds({ roots: modelStorageRoots({ home, engine }), engine }),
        ),
      )
    ).flat();
    if (renames.length > 0) {
      const config = await store.readConfig();
      const modelFitness = remapEngineScopedKeys(config.modelFitness, renames);
      const modelContextOverrides = remapEngineScopedKeys(config.modelContextOverrides, renames);
      if (
        modelFitness !== config.modelFitness ||
        modelContextOverrides !== config.modelContextOverrides
      ) {
        await store.writeConfig({
          ...(modelFitness ? { modelFitness } : {}),
          ...(modelContextOverrides ? { modelContextOverrides } : {}),
        });
      }
    }
  } catch (err) {
    log.warn('[models] legacy quant-suffix migration failed:', err);
  }
}
export async function reclaimStaleModelDownloads(
  home: string,
  managers: {
    llamaCppModels: LlamaCppModelManager;
    ds4Models: LlamaCppModelManager;
    mlxModels: MlxModelManager;
  },
): Promise<void> {
  const { llamaCppModels, ds4Models, mlxModels } = managers;

  for (const { engine, manager } of [
    { engine: 'llama-cpp', manager: llamaCppModels },
    { engine: 'ds4', manager: ds4Models },
    { engine: 'mlx', manager: mlxModels },
  ] as const) {
    const activeIds = new Set(manager.getActiveInstalls().map((i) => i.catalogId));
    const reclaimed = await reclaimAbandonedModelDownloads({
      writableRoot: modelStorageRoots({ home, engine }).writableRoot,
      activeIds,
    }).catch(() => []);
    for (const item of reclaimed) {
      log.info(
        `[models] reclaimed abandoned ${engine} download "${item.id}" (${Math.round(item.bytes / 1024 ** 2)} MB of stale .partial data)`,
      );
    }
  }
}
