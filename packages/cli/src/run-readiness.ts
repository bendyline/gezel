import type { ConfigResponse, GezelClient } from '@bendyline/gezel-client/node';

/**
 * Pre-flight for one-shot `gezel run`: is the resolved chat provider able to
 * answer without first downloading something?
 *
 * WHY: on a fresh machine the default provider is the on-device engine. A
 * chat turn against a missing llama-server kicks a background engine download
 * and returns "try again in a moment". A cold `gezel run` owns an in-process
 * service that stops when the command exits, which aborts that download, so
 * every retry printed the same sentence forever (2026-09-26 npm ship audit).
 * It also fetched up to 600 MB unasked, and the follow-up errors pointed at
 * desktop Settings screens a CLI user does not have. Checking up front keeps
 * `run` download-free and names the CLI commands that do the setup.
 *
 * Mirrors the TUI's first-run gate (tui/components/BootstrapGate.tsx): only
 * on-device providers without an external engine URL or model path are
 * checked, and a pinned model counts only when that exact model is installed.
 */

export type RunReadiness = { ready: true } | { ready: false; message: string };

type LocalProvider = 'llama-cpp' | 'mlx';

export type RunReadinessClient = Pick<
  GezelClient,
  'getConfig' | 'getGezel' | 'getNativeEngineStatus' | 'listLlamaCppModels' | 'listMlxModels'
>;

const READY: RunReadiness = { ready: true };

/**
 * The daemon's device bootstrap pins a provider shortly after a clean start.
 * Poll briefly so a fresh home is judged on the pinned provider rather than
 * the pre-bootstrap default.
 */
export async function settledFirstRunConfig(
  client: Pick<GezelClient, 'getConfig'>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<ConfigResponse> {
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 250;
  let config = await client.getConfig();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (config.firstRunCompleted || config.provider !== 'copilot') return config;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    config = await client.getConfig();
  }
  return config;
}

export async function checkRunReadiness(
  client: RunReadinessClient,
  gezelId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunReadiness> {
  // Mock mode replaces every provider; tests and CI drive `run` through it.
  if (env.GEZEL_MOCK_PROVIDER === '1') return READY;

  const config = await settledFirstRunConfig(client);
  let provider: string | undefined = config.provider;
  if (gezelId) {
    try {
      const { parsed } = await client.getGezel(gezelId);
      if (parsed.frontmatter.provider) provider = parsed.frontmatter.provider;
    } catch {
      // Let the turn itself report an unknown gezel.
    }
  }
  if (provider !== 'llama-cpp' && provider !== 'mlx') return READY;
  if (provider === 'llama-cpp' && (config.llamaCppBaseUrl || config.llamaCppModelPath)) {
    return READY;
  }
  if (provider === 'mlx' && (config.mlxBaseUrl || config.mlxModelPath)) return READY;

  const native = await client.getNativeEngineStatus();
  // No native build for this platform: the provider's own error explains it.
  if (!native.platformKey) return READY;

  const installed =
    provider === 'mlx' ? await client.listMlxModels() : await client.listLlamaCppModels();
  const installedIds = installed.models.map((model) => model.id);
  const pinned = config.defaultModel?.[provider];
  const engineMissing =
    provider === 'llama-cpp' &&
    !native.engines.some((engine) => engine.name === 'llama-server' && engine.installed);
  const modelReady = pinned ? installedIds.includes(pinned) : installedIds.length > 0;
  if (!engineMissing && modelReady) return READY;

  return {
    ready: false,
    message: formatRunSetupMessage({
      provider,
      engineMissing,
      pinned,
      installedIds,
    }),
  };
}

export function formatRunSetupMessage(input: {
  provider: LocalProvider;
  engineMissing: boolean;
  pinned: string | undefined;
  installedIds: readonly string[];
}): string {
  const { provider, engineMissing, pinned, installedIds } = input;
  const steps: string[] = [];
  if (engineMissing) steps.push('gezel native install');
  if (pinned && !installedIds.includes(pinned)) {
    steps.push(`gezel model pull ${pinned}${provider === 'mlx' ? ' --provider mlx' : ''}`);
  } else if (!pinned && installedIds.length === 0) {
    steps.push('gezel model list        (then: gezel model pull <id>)');
  }

  const lines: string[] = [];
  if (pinned && !installedIds.includes(pinned) && installedIds.length > 0) {
    lines.push(`Your selected on-device model, ${pinned}, isn't downloaded yet.`);
  } else if (
    engineMissing &&
    installedIds.length > 0 &&
    (!pinned || installedIds.includes(pinned))
  ) {
    lines.push("Gezel's on-device engine isn't installed yet.");
  } else {
    lines.push("Gezel isn't set up to chat yet: this device doesn't have an on-device model.");
  }
  lines.push('', 'Run `gezel` to choose a model and download it, step by step.');
  if (steps.length > 0) {
    lines.push('', 'Or set it up directly:', ...steps.map((step) => `  ${step}`));
  }
  lines.push(
    '',
    'To use a cloud model instead, save a key (for example',
    '`gezel secret set openaiApiKey --stdin`), then run `gezel` and pick it with /model.',
    '',
    'Nothing was downloaded.',
  );
  return lines.join('\n');
}
