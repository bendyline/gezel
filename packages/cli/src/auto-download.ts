import type { GezelClient } from '@bendyline/gezel-client/node';
import { CliError, type CliGlobals } from './connection.js';
import { ensureModelEngines } from './craftbook-setup.js';
import { formatGb, pullChatModel, waitForMlxRuntime } from './model-pull.js';
import { settledFirstRunConfig } from './run-readiness.js';
import { type BootstrapChatModel, rankChatModels, recoDevice } from './tui/bootstrap.js';

/** The environment switch for `--download`, for scripts and containers. */
export const AUTO_DOWNLOAD_ENV = 'GEZEL_AUTO_DOWNLOAD';

/**
 * `--download` (or GEZEL_AUTO_DOWNLOAD=1): a command downloads what it needs
 * without asking, printing each step. Downloads only: turning on a security
 * setting or saving a key always takes a person.
 */
export function autoDownloadRequested(
  globals: Pick<CliGlobals, 'download'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return globals.download === true || env[AUTO_DOWNLOAD_ENV] === '1';
}

export type AutoDownloadClient = Pick<
  GezelClient,
  | 'getConfig'
  | 'getGezel'
  | 'getNativeEngineStatus'
  | 'ensureNativeEngine'
  | 'listLlamaCppModels'
  | 'listMlxModels'
  | 'getMemoryProfile'
  | 'listCatalogItems'
  | 'checkModelDownloadSpace'
  | 'installLlamaCppModel'
  | 'installMlxModel'
  | 'installDs4Model'
  | 'getMlxRuntimeStatus'
  | 'updateConfig'
>;

/**
 * Get a local chat model ready for a run with nobody at the keyboard: the
 * engine, then the model this computer's hardware ranks first (the one the
 * terminal setup recommends), pinned as the default. Ranked after the engine
 * is in, because a Vulkan GPU is invisible until llama-server can see it.
 * A selected model that is not downloaded yet is downloaded instead. Does
 * nothing for a cloud provider or an external engine.
 */
export async function downloadForRun(
  client: AutoDownloadClient,
  options: {
    gezelId?: string;
    write: (text: string) => void;
    /** Test seam; production ranks the catalog for this device. */
    recommend?: (provider: 'llama-cpp' | 'mlx') => Promise<BootstrapChatModel | undefined>;
  },
): Promise<void> {
  const { write } = options;
  const config = await settledFirstRunConfig(client);
  let provider: string | undefined = config.provider;
  if (options.gezelId) {
    try {
      const { parsed } = await client.getGezel(options.gezelId);
      if (parsed.frontmatter.provider) provider = parsed.frontmatter.provider;
    } catch {
      // The turn itself reports an unknown gezel.
    }
  }
  if (provider !== 'llama-cpp' && provider !== 'mlx') return;
  if (provider === 'llama-cpp' && (config.llamaCppBaseUrl || config.llamaCppModelPath)) return;
  if (provider === 'mlx' && (config.mlxBaseUrl || config.mlxModelPath)) return;
  if (!(await client.getNativeEngineStatus()).platformKey) return;

  write('Getting this computer ready for local models (--download)…\n');
  await ensureModelEngines(client, [provider], write);

  const installed =
    provider === 'mlx' ? await client.listMlxModels() : await client.listLlamaCppModels();
  const installedIds = new Set(installed.models.map((model) => model.id));
  const pinned = config.defaultModel?.[provider];
  if (pinned ? installedIds.has(pinned) : installedIds.size > 0) return;

  const recommend =
    options.recommend ??
    (async (engine: 'llama-cpp' | 'mlx') => {
      const [memory, catalog] = await Promise.all([
        client.getMemoryProfile(),
        client.listCatalogItems('chat-model'),
      ]);
      return rankChatModels(catalog.items, recoDevice(memory), engine)[0];
    });
  const best = await recommend(provider);
  const target = pinned ?? best?.id;
  if (!target) {
    throw new CliError(
      'No open chat model in the catalog fits this computer. Save a cloud key instead (for example `gezel secret set openaiApiKey --stdin`) and pick it in `gezel` with /model.',
    );
  }
  const size = best && best.id === target ? best.approxSizeBytes : 0;
  if (size > 0) {
    const space = await client.checkModelDownloadSpace({ sizeBytes: size });
    if (space.known && !space.ok) {
      throw new CliError(
        `${best?.name ?? target} needs ${formatGb(space.requiredBytes)} GB, and Gezel model storage has ${formatGb(space.freeBytes)} GB free. Free some space, then run again.`,
      );
    }
  }
  write(
    pinned
      ? `Downloading ${target}, the model this computer is set to use.\n`
      : `Downloading ${best?.name ?? target}${size > 0 ? ` (${formatGb(size)} GB)` : ''}, the model recommended for this computer.\n`,
  );
  await pullChatModel(client, provider, target, write);
  if (provider === 'mlx') await waitForMlxRuntime(client, write);
  await client.updateConfig({
    provider,
    defaultModel: { ...config.defaultModel, [provider]: target },
    firstRunInstallError: null,
  });
  write('Ready.\n\n');
}
