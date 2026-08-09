import type { ModelInfo, ProviderName } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client/node';

/** One provider/model pair offered by the TUI's combined `/model` picker. */
export interface ModelChoice {
  provider: ProviderName;
  model: ModelInfo;
  value: string;
  label: string;
}

interface ModelInventoryClient {
  getCopilotStatus(): Promise<{ available: boolean }>;
  getMemoryProfile(): Promise<{ totalRamBytes: number }>;
  listProviderModels(provider: ProviderName): Promise<{ models: ModelInfo[] }>;
}

const PROVIDER_ORDER: readonly ProviderName[] = [
  'mlx',
  'llama-cpp',
  'ds4',
  'ollama',
  'copilot',
  'openai',
  'anthropic',
  'anthropic-cli',
  'codex-cli',
];

/** Engine-forward labels: unlike the desktop's "This Mac" shorthand, the
 * terminal picker names the actual engine so similarly local choices remain
 * distinguishable in a flat list. */
export function modelProviderLabel(provider: ProviderName): string {
  switch (provider) {
    case 'copilot':
      return 'GitHub Copilot';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'anthropic-cli':
      return 'Claude CLI';
    case 'codex-cli':
      return 'Codex CLI';
    case 'ollama':
      return 'Ollama';
    case 'llama-cpp':
      return 'llama.cpp';
    case 'mlx':
      return 'MLX';
    case 'ds4':
      return 'DwarfStar (ds4)';
    case 'remote':
      return 'Remote';
  }
}

/** Cheap availability filter matching the desktop selector. Model inventory
 * calls provide the final gate: an engine with no usable models disappears. */
export function configuredModelProviders(
  config: ConfigResponse,
  opts: {
    platform: NodeJS.Platform;
    arch: NodeJS.Architecture;
    copilotAvailable: boolean | null;
    totalRamBytes: number | null;
  },
): ProviderName[] {
  const providers: ProviderName[] = [];

  if (opts.platform === 'darwin' && opts.arch === 'arm64') providers.push('mlx');
  providers.push('llama-cpp');
  const ds4PlatformAvailable =
    Boolean(config.ds4BaseUrl) ||
    opts.platform === 'linux' ||
    (opts.platform === 'darwin' && opts.arch === 'arm64');
  const ds4MemoryAvailable =
    Boolean(config.ds4BaseUrl) ||
    opts.totalRamBytes === null ||
    opts.totalRamBytes >= 45 * 1024 ** 3;
  if (ds4PlatformAvailable && ds4MemoryAvailable) providers.push('ds4');
  providers.push('ollama');

  // null means an older daemon did not expose the availability endpoint.
  // Preserve its previous behavior and let model enumeration decide.
  if (opts.copilotAvailable !== false) providers.push('copilot');
  if (config.hasOpenaiApiKey) providers.push('openai');
  if (config.hasAnthropicApiKey) providers.push('anthropic');
  if (config.anthropicCliStatus?.installed) providers.push('anthropic-cli');
  if (config.codexCliStatus?.installed) providers.push('codex-cli');

  return providers.sort((a, b) => PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b));
}

/** Load every usable engine in parallel and flatten it into one keyboard-first
 * list. Optional/unconfigured providers fail closed without blocking the rest. */
export async function loadModelChoices(
  client: ModelInventoryClient,
  config: ConfigResponse,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): Promise<ModelChoice[]> {
  const [copilot, memory] = await Promise.all([
    client.getCopilotStatus().catch(() => null),
    client.getMemoryProfile().catch(() => null),
  ]);
  const providers = configuredModelProviders(config, {
    platform,
    arch,
    copilotAvailable: copilot?.available ?? null,
    totalRamBytes: memory?.totalRamBytes ?? null,
  });
  const inventories = await Promise.all(
    providers.map(async (provider) => {
      try {
        const result = await client.listProviderModels(provider);
        return { provider, models: result.models };
      } catch {
        return { provider, models: [] };
      }
    }),
  );

  return inventories.flatMap(({ provider, models }) =>
    models.map((model) => ({
      provider,
      model,
      value: `${provider}:${model.id}`,
      label: `${modelProviderLabel(provider)} · ${model.name}`,
    })),
  );
}
