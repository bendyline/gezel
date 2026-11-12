import {
  type ScorecardDataset,
  type ScorecardDevice,
  measuredClaim,
  measuredResultFor,
} from '@bendyline/gezel';
import type { ConfigResponse, GezelClient } from '@bendyline/gezel-client/node';
import { CliError } from './connection.js';
import {
  type BootstrapChatModel,
  type BootstrapChatProvider,
  formatDownloadSize,
  rankChatModels,
  recoDevice,
} from './tui/bootstrap.js';

/**
 * How a CLI-only person finds a chat model and makes chats use it. `model list`
 * shows what is installed, so before this there was no way to learn a catalog
 * id from the terminal, and no command set the default model (2026-10-13 npm
 * audit): `model pull` then `run` asked again for the model the daemon had
 * picked on its own.
 */

export type ChatEngine = 'mlx' | 'llama-cpp' | 'ds4';

export type ModelChoiceClient = Pick<
  GezelClient,
  | 'getConfig'
  | 'updateConfig'
  | 'getMemoryProfile'
  | 'listCatalogItems'
  | 'listMlxModels'
  | 'listLlamaCppModels'
  | 'listDs4Models'
>;

export async function installedChatModels(
  client: Pick<ModelChoiceClient, 'listMlxModels' | 'listLlamaCppModels' | 'listDs4Models'>,
  engine: ChatEngine,
): Promise<string[]> {
  const { models } =
    engine === 'mlx'
      ? await client.listMlxModels()
      : engine === 'ds4'
        ? await client.listDs4Models()
        : await client.listLlamaCppModels();
  return models.map((model) => model.id);
}

/** The config fields that decide which downloaded model chats run on. */
export interface ChatModelConfig
  extends Partial<
    Pick<
      ConfigResponse,
      | 'llamaCppBaseUrl'
      | 'llamaCppModelPath'
      | 'mlxBaseUrl'
      | 'mlxModelPath'
      | 'ds4BaseUrl'
      | 'ds4ModelPath'
    >
  > {
  provider?: string;
  defaultModel?: Readonly<Record<string, string | undefined>>;
}

/**
 * The downloaded model chats run on for `engine`, the way the daemon picks
 * it: none when chats use another provider or an external engine or model
 * file; else the pinned model; else, with no pin (or, outside MLX, a pin
 * that is no longer downloaded), the first one listed.
 */
export function chatModelInUse(
  config: ChatModelConfig,
  engine: ChatEngine,
  listedIds: readonly string[],
): string | undefined {
  if (config.provider !== engine) return undefined;
  const external =
    engine === 'mlx'
      ? config.mlxBaseUrl || config.mlxModelPath
      : engine === 'ds4'
        ? config.ds4BaseUrl || config.ds4ModelPath
        : config.llamaCppBaseUrl || config.llamaCppModelPath;
  if (external) return undefined;
  const pinned = config.defaultModel?.[engine];
  if (pinned && listedIds.includes(pinned)) return pinned;
  // MLX refuses a pinned model that is gone; the other engines fall back.
  if (pinned && engine === 'mlx') return undefined;
  return listedIds[0];
}

/** `gezel model list`: downloaded models, the one chats use marked. */
export function formatInstalledChatModels(
  engine: ChatEngine,
  models: ReadonlyArray<{ id: string; name: string; approxSizeBytes: number; readOnly?: boolean }>,
  config: ChatModelConfig,
): string {
  if (models.length === 0) {
    return `(no local ${engine} models — \`gezel model list --available\` shows ones to download)`;
  }
  const inUse = chatModelInUse(
    config,
    engine,
    models.map((model) => model.id),
  );
  const width = Math.max(28, ...models.map((model) => model.id.length));
  return models
    .map((model) => {
      const notes = [model.readOnly ? 'shared' : '', model.id === inUse ? 'in use' : ''].filter(
        Boolean,
      );
      return `${model.id.padEnd(width)}  ${(model.approxSizeBytes / 1e9).toFixed(2).padStart(6)} GB  ${model.name}${notes.length > 0 ? `  (${notes.join(', ')})` : ''}`;
    })
    .join('\n');
}

/** `--provider` for a command line, left off when it is the platform default. */
export function providerFlag(engine: ChatEngine, platformDefault: ChatEngine): string {
  return engine === platformDefault ? '' : ` --provider ${engine}`;
}

const FIT_LABEL: Record<BootstrapChatModel['fit'], string> = {
  fits: 'fits',
  'fits-offload': 'fits, partly offloaded',
  tight: 'tight',
  'too-big': 'too big',
};

/** Catalog chat models for `engine`, recommended first, the way the first-run picker ranks them. */
export async function availableChatModels(
  client: ModelChoiceClient & Partial<Pick<GezelClient, 'getNativeEngineStatus'>>,
  engine: ChatEngine,
): Promise<{
  ranked: BootstrapChatModel[];
  installed: Set<string>;
  inUse?: string;
  gpuUnmeasured?: boolean;
}> {
  if (engine === 'ds4') {
    throw new CliError('`--available` lists mlx and llama-cpp models; pass one with --provider.');
  }
  const [memory, catalog, installed, config, native] = await Promise.all([
    client.getMemoryProfile(),
    client.listCatalogItems('chat-model'),
    installedChatModels(client, engine),
    client.getConfig(),
    client.getNativeEngineStatus?.().catch(() => undefined),
  ]);
  const inUse = chatModelInUse(config, engine, installed);
  // An AMD or Intel graphics card is read through llama-server. Before the
  // engine is installed the profile falls back to main memory, and the first
  // row was the model for a computer with no graphics card at all: Gemma 4 E2B
  // on a 32 GB card, beside models the same table scored at 97% (2026-11-10).
  const gpuUnmeasured =
    engine === 'llama-cpp' &&
    memory.source === 'system-ram-fallback' &&
    !!native?.platformKey &&
    !native.engines.some((entry) => entry.name === 'llama-server' && entry.installed);
  return {
    ranked: rankChatModels(catalog.items, recoDevice(memory), engine as BootstrapChatProvider),
    installed: new Set(installed),
    ...(inUse ? { inUse } : {}),
    ...(gpuUnmeasured ? { gpuUnmeasured } : {}),
  };
}

export function formatAvailableChatModels(input: {
  engine: ChatEngine;
  platformDefault: ChatEngine;
  ranked: readonly BootstrapChatModel[];
  installed: ReadonlySet<string>;
  /** The model chats run on ({@link chatModelInUse}). */
  inUse?: string;
  /**
   * What the published scorecard says about each model (`measuredClaim`),
   * keyed by id. "Fits" is about memory; this column is about whether the
   * model finishes work, measured on real jobs. Absent entries print as
   * not measured.
   */
  measured?: ReadonlyMap<string, string>;
  /**
   * The engine that reads this computer's graphics card is not installed yet,
   * so the ranking saw main memory only. No row is called recommended then.
   */
  gpuUnmeasured?: boolean;
}): string {
  const { engine, ranked, installed, inUse, measured, gpuUnmeasured } = input;
  if (ranked.length === 0) return `(no ${engine} chat models in the catalog for this machine)`;
  const width = Math.max(...ranked.map((model) => model.id.length));
  const measuredWidth = measured
    ? Math.max('not measured'.length, ...ranked.map((m) => (measured.get(m.id) ?? '').length))
    : 0;
  // Not "best first": the recommendation is a deliberate first download, often
  // smaller and lower-scoring than larger models that also fit.
  const lines = [
    gpuUnmeasured
      ? `${engine} chat models, ranked by this computer's main memory only (its graphics card is not measured yet):`
      : `${engine} chat models for this machine, the recommended first download on top, then by catalog ranking:`,
  ];
  ranked.forEach((model, index) => {
    const notes = [
      index === 0 && !gpuUnmeasured ? 'recommended' : '',
      installed.has(model.id) ? 'installed' : '',
      model.id === inUse ? 'in use' : '',
    ].filter(Boolean);
    const claim = measured
      ? `  ${(measured.get(model.id) ?? 'not measured').padEnd(measuredWidth)}`
      : '';
    lines.push(
      `  ${model.id.padEnd(width)}  ${formatDownloadSize(model.approxSizeBytes).padStart(7)}  ${FIT_LABEL[model.fit].padEnd(22)}${claim}  ${model.name}${notes.length > 0 ? `  (${notes.join(', ')})` : ''}`,
    );
  });
  const flag = providerFlag(engine, input.platformDefault);
  const smallest = [...ranked].sort((a, b) => a.approxSizeBytes - b.approxSizeBytes)[0]!;
  if (gpuUnmeasured) {
    lines.push(
      '',
      'Gezel reads a graphics card through its engine, which is not installed yet. Run `gezel native install`, then list again to see the model recommended for this computer.',
    );
  }
  lines.push(
    '',
    `Download one with \`gezel model pull <id>${flag}\`. The smallest is ${smallest.id} (${formatDownloadSize(smallest.approxSizeBytes)}).`,
    `\`gezel model use <id>${flag}\` picks the installed model chats use.`,
  );
  if (measured) {
    lines.push(
      '"Fits" is about memory. The measured column is the published scorecard\'s pass rate on real jobs, on the hardware named; `gezel bench` measures a model on this machine.',
    );
  }
  return lines.join('\n');
}

/**
 * The measured column for `formatAvailableChatModels`: one scorecard claim
 * per catalog model, from the published dataset, preferring rounds run on
 * the same platform as this machine.
 */
export function measuredClaimsFor(
  dataset: ScorecardDataset,
  ids: readonly string[],
  device: Pick<ScorecardDevice, 'platform' | 'arch' | 'label'>,
): Map<string, string> {
  const claims = new Map<string, string>();
  for (const id of ids) claims.set(id, measuredClaim(measuredResultFor(dataset, id, device)));
  return claims;
}

/**
 * Make chats use an installed model: the engine becomes the chat provider and
 * the model its default. Without `requested`, the engine is the one that has
 * the model, preferring the platform default.
 */
export async function useChatModel(
  client: ModelChoiceClient,
  id: string,
  options: { requested?: ChatEngine; platformDefault: ChatEngine },
): Promise<ChatEngine> {
  const order: ChatEngine[] = options.requested
    ? [options.requested]
    : [options.platformDefault, ...(['mlx', 'llama-cpp', 'ds4'] as const)].filter(
        (engine, index, all) => all.indexOf(engine) === index,
      );
  let engine: ChatEngine | undefined;
  for (const candidate of order) {
    const installed = await installedChatModels(client, candidate).catch((): string[] => []);
    if (installed.includes(id)) {
      engine = candidate;
      break;
    }
  }
  if (!engine) {
    const target = options.requested ?? options.platformDefault;
    throw new CliError(
      `${id} isn't downloaded for ${target}. Download it with \`gezel model pull ${id}${providerFlag(target, options.platformDefault)}\`, or see \`gezel model list --available\`.`,
    );
  }
  const config = await client.getConfig();
  await client.updateConfig({
    provider: engine,
    defaultModel: { ...(config.defaultModel ?? {}), [engine]: id },
    firstRunCompleted: true,
  });
  return engine;
}

/**
 * After a pull: make the new model the engine's default when the current one
 * is unset or not downloaded, so `pull` then `run` works. A default that is
 * installed is the person's choice and stays.
 */
export async function pinPulledModel(
  client: ModelChoiceClient,
  engine: ChatEngine,
  id: string,
): Promise<'pinned' | 'kept' | 'already'> {
  const config = await client.getConfig();
  const current = config.defaultModel?.[engine];
  if (current === id) return 'already';
  if (current && (await installedChatModels(client, engine)).includes(current)) return 'kept';
  await client.updateConfig({
    defaultModel: { ...(config.defaultModel ?? {}), [engine]: id },
    firstRunCompleted: true,
  });
  return 'pinned';
}
