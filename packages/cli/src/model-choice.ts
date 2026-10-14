import type { GezelClient } from '@bendyline/gezel-client/node';
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

/** Catalog chat models for `engine`, best first, the way the first-run picker ranks them. */
export async function availableChatModels(
  client: ModelChoiceClient,
  engine: ChatEngine,
): Promise<{ ranked: BootstrapChatModel[]; installed: Set<string>; pinned?: string }> {
  if (engine === 'ds4') {
    throw new CliError('`--available` lists mlx and llama-cpp models; pass one with --provider.');
  }
  const [memory, catalog, installed, config] = await Promise.all([
    client.getMemoryProfile(),
    client.listCatalogItems('chat-model'),
    installedChatModels(client, engine),
    client.getConfig(),
  ]);
  const pinned = config.defaultModel?.[engine];
  return {
    ranked: rankChatModels(catalog.items, recoDevice(memory), engine as BootstrapChatProvider),
    installed: new Set(installed),
    ...(pinned ? { pinned } : {}),
  };
}

export function formatAvailableChatModels(input: {
  engine: ChatEngine;
  platformDefault: ChatEngine;
  ranked: readonly BootstrapChatModel[];
  installed: ReadonlySet<string>;
  pinned?: string;
}): string {
  const { engine, ranked, installed, pinned } = input;
  if (ranked.length === 0) return `(no ${engine} chat models in the catalog for this machine)`;
  const width = Math.max(...ranked.map((model) => model.id.length));
  const lines = [`${engine} chat models for this machine, best first:`];
  ranked.forEach((model, index) => {
    const notes = [
      index === 0 ? 'recommended' : '',
      installed.has(model.id) ? 'installed' : '',
      model.id === pinned ? 'in use' : '',
    ].filter(Boolean);
    lines.push(
      `  ${model.id.padEnd(width)}  ${formatDownloadSize(model.approxSizeBytes).padStart(7)}  ${FIT_LABEL[model.fit].padEnd(22)}  ${model.name}${notes.length > 0 ? `  (${notes.join(', ')})` : ''}`,
    );
  });
  const flag = providerFlag(engine, input.platformDefault);
  const smallest = [...ranked].sort((a, b) => a.approxSizeBytes - b.approxSizeBytes)[0]!;
  lines.push(
    '',
    `Download one with \`gezel model pull <id>${flag}\`. The smallest is ${smallest.id} (${formatDownloadSize(smallest.approxSizeBytes)}).`,
    `\`gezel model use <id>${flag}\` picks the installed model chats use.`,
  );
  return lines.join('\n');
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
