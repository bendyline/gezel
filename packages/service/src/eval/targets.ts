/**
 * What an in-app eval can run on this install, and how to launch each one.
 *
 * A target is a (provider, model) pair. Local engines offer exactly the
 * models already installed — the harness reads them read-only through
 * `--source-home` and never downloads a second copy. Hosted providers are
 * offered when this install can actually reach them, with the reason spelled
 * out when it cannot, so the picker never lists something that will fail
 * its first turn.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GezelConfig, resolveSecurityPolicy } from '@bendyline/gezel';
import type {
  EvalCatalog,
  EvalEnvironment,
  EvalImageModelOption,
  EvalJobSpec,
  EvalJobTargetSpec,
  EvalProviderId,
  EvalRequirement,
  EvalTarget,
} from '@bendyline/gezel/eval';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import type { EngineBinaryRegistry } from '../engines/registry.js';
import { impliedEngineVariant } from '../engines/resolver.js';
import {
  listOverlayModelIds,
  modelSearchRoots,
  modelStorageRoots,
} from '../models/storage-roots.js';
import { getCliPresence } from '../providers/cli-detection.js';
import { resolveCopilotAvailability } from '../providers/copilot-availability.js';
import { resolveManagedChromiumBinary } from '../rendering/managed-chromium.js';
import type { SecretStore } from '../secrets/types.js';
import type { EvalHarness } from './harness.js';
import type { PreparedEvalTarget } from './jobs.js';

interface InstalledModel {
  id: string;
  name: string;
  updateAvailable?: boolean;
}

interface ModelLister {
  listInstalled(): Promise<InstalledModel[]>;
}

export interface EvalTargetDeps {
  home: string;
  runsDir: string;
  readConfig: () => Promise<GezelConfig>;
  secrets: Pick<SecretStore, 'get'>;
  engineBinaries: Pick<EngineBinaryRegistry, 'ensure' | 'subscribe' | 'get'>;
  llamaCppModels: ModelLister;
  mlxModels: ModelLister;
  ds4Models: ModelLister;
  harness: () => EvalHarness | null;
  catalog: () => Promise<EvalCatalog>;
  env?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
}

const ON_DEVICE = new Set<EvalProviderId>(['llama-cpp', 'mlx', 'ds4', 'apple-foundation-models']);
/** How long a launch waits for a first-time engine download. */
const ENGINE_WAIT_MS = 15 * 60_000;

export class EvalTargets {
  constructor(private readonly deps: EvalTargetDeps) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env?.() ?? process.env;
  }

  private get platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform;
  }

  private get appleSilicon(): boolean {
    return this.platform === 'darwin' && (this.deps.arch ?? process.arch) === 'arm64';
  }

  /** Requirements this install can satisfy; everything else is named per scenario. */
  async environment(): Promise<EvalEnvironment> {
    const harness = this.deps.harness();
    const source = harness?.mode === 'source';
    const satisfied = new Set<EvalRequirement>(['embeddings', 'network']);
    if (source || (await this.managedChromium())) satisfied.add('chromium');
    if (source || this.env.GEZEL_EVAL_VITEST_BIN) satisfied.add('vitest');
    if (this.env.GEZEL_EVAL_DOCBLOCKS_DIR) satisfied.add('docblocks');
    if (source) satisfied.add('external-checkout');
    if ((await this.imageModels()).length > 0) satisfied.add('image-model');
    return {
      harness: harness?.mode ?? 'compiled',
      satisfied: [...satisfied].sort(),
      runsDir: this.deps.runsDir,
    };
  }

  async imageModels(): Promise<EvalImageModelOption[]> {
    const roots = modelStorageRoots({ home: this.deps.home, engine: 'sd-cpp', env: this.env });
    const out: EvalImageModelOption[] = [];
    for (const id of await listOverlayModelIds(roots)) {
      for (const root of modelSearchRoots(roots)) {
        const manifest = await readJson<{ weightsFilename?: string; name?: string }>(
          join(root, id, 'manifest.json'),
        );
        if (manifest?.weightsFilename && existsSync(join(root, id, manifest.weightsFilename))) {
          out.push({ id, label: manifest.name ?? id });
          break;
        }
      }
    }
    return out;
  }

  async list(): Promise<EvalTarget[]> {
    const [config, catalog] = await Promise.all([this.deps.readConfig(), this.deps.catalog()]);
    const harness = this.deps.harness();
    const targets: EvalTarget[] = [];
    const defaults = (config.defaultModel ?? {}) as Partial<Record<string, string>>;

    // MLX exists only on Apple silicon; elsewhere it has nothing to list.
    const local: Array<[EvalProviderId, ModelLister, boolean]> = [
      ['mlx', this.deps.mlxModels, this.appleSilicon],
      ['llama-cpp', this.deps.llamaCppModels, true],
      ['ds4', this.deps.ds4Models, true],
    ];
    for (const [provider, lister, supported] of local) {
      if (!supported) continue;
      const installed = await lister.listInstalled().catch(() => [] as InstalledModel[]);
      for (const model of installed) {
        targets.push({
          provider,
          modelId: model.id,
          label: model.name || model.id,
          category: 'local-engine',
          ...(model.updateAvailable
            ? {
                available: false,
                unavailableReason:
                  'An update to this model is waiting. Evals refuse stale weights — update it in Settings first.',
              }
            : { available: true }),
          ...(defaults[provider] === model.id ? { isDefault: true } : {}),
        });
      }
    }

    if (this.appleSilicon) {
      const helper = this.env.GEZEL_APPLE_FM_BIN?.trim();
      targets.push({
        provider: 'apple-foundation-models',
        modelId: 'apple-foundation-models',
        label: 'Apple on-device model',
        category: 'system-model',
        ...(helper && existsSync(helper)
          ? { available: true }
          : {
              available: false,
              unavailableReason: 'This install does not include the Apple on-device model helper.',
            }),
      });
    }

    const external = resolveSecurityPolicy(config).allowExternalChat;
    const blocked = 'Your security posture blocks external AI providers.';
    const cli = getCliPresence(config, this.env);
    const hosted: Array<{ provider: EvalProviderId; reason: string | null }> = [
      {
        provider: 'anthropic',
        reason: (await this.deps.secrets
          .get({ kind: 'providerCredential', name: 'anthropicApiKey' })
          .catch(() => null))
          ? null
          : 'Add an Anthropic API key in Settings first.',
      },
      {
        provider: 'openai',
        reason: (await this.deps.secrets
          .get({ kind: 'providerCredential', name: 'openaiApiKey' })
          .catch(() => null))
          ? null
          : 'Add an OpenAI API key in Settings first.',
      },
      {
        provider: 'anthropic-cli',
        reason:
          cli.anthropicCli.installed && !config.anthropicCli?.binaryPath
            ? null
            : cli.anthropicCli.installed
              ? 'Evals find the Claude CLI on PATH; a custom CLI location is not passed to trials.'
              : 'The Claude CLI is not installed.',
      },
      {
        provider: 'codex-cli',
        reason:
          cli.codexCli.installed && !config.codexCli?.binaryPath
            ? null
            : cli.codexCli.installed
              ? 'Evals find the Codex CLI on PATH; a custom CLI location is not passed to trials.'
              : 'The Codex CLI is not installed.',
      },
      { provider: 'copilot', reason: await this.copilotReason(harness) },
    ];
    for (const { provider, reason } of hosted) {
      const why = !external ? blocked : reason;
      const catalogDefault = catalog.providers.find((p) => p.id === provider)?.defaultModelId;
      const modelIds = [
        ...new Set([defaults[provider], catalogDefault].filter(Boolean)),
      ] as string[];
      for (const modelId of modelIds) {
        targets.push({
          provider,
          modelId,
          label: modelId,
          category: catalog.providers.find((p) => p.id === provider)?.category ?? 'cloud-sdk',
          ...(why ? { available: false, unavailableReason: why } : { available: true }),
          ...(defaults[provider] === modelId ? { isDefault: true } : {}),
        });
      }
    }
    return targets;
  }

  /**
   * Everything one target's harness launch needs from the daemon. Throws a
   * sentence a person can act on when the target can't run.
   */
  async prepare(target: EvalJobTargetSpec, spec: EvalJobSpec): Promise<PreparedEvalTarget> {
    const harness = this.deps.harness();
    const env: NodeJS.ProcessEnv = {
      // Never publish "passed" for a page nobody could click.
      GEZEL_EVAL_REQUIRE_RUNTIME_LAYER: '1',
      // MLX trials reuse this home's Python venv; without one they share
      // this cache instead of provisioning a venv per trial.
      GEZEL_EVAL_UV_CACHE: join(this.deps.runsDir, '.cache', 'uv'),
    };
    const args = [
      '--source-home',
      this.deps.home,
      '--preflight-dir',
      join(this.deps.runsDir, '.preflight'),
    ];

    // The machine asset store (and any read-only homes) hold models this
    // daemon lists as installed; hand the harness the same overlay.
    const roots: Record<string, string[]> = {};
    for (const engine of ['llama-cpp', 'mlx', 'ds4', 'sd-cpp']) {
      const overlay = modelStorageRoots({ home: this.deps.home, engine, env: this.env });
      if (overlay.readOnlyRoots.length > 0) roots[engine] = overlay.readOnlyRoots;
    }
    if (Object.keys(roots).length > 0) env.GEZEL_EVAL_MODEL_ROOTS = JSON.stringify(roots);

    // Installed, the harness has no Playwright browser of its own; the
    // product's managed Chromium is the one it can drive. A checkout keeps
    // its own Playwright, whose browser revision matches its own package.
    if (harness?.mode === 'compiled') {
      const chromium = await this.managedChromium();
      if (chromium) env.GEZEL_EVAL_CHROMIUM_PATH = chromium;
    }

    if (target.provider === 'anthropic' || target.provider === 'openai') {
      const name = target.provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey';
      const key = await this.deps.secrets.get({ kind: 'providerCredential', name });
      if (!key)
        throw new Error(
          `Add an ${target.provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key in Settings first.`,
        );
      // Only the selected provider's key, and only into this child.
      if (target.provider === 'anthropic') env.ANTHROPIC_API_KEY = key;
      else {
        env.OPENAI_API_KEY = key;
        const org = await this.deps.secrets
          .get({ kind: 'providerCredential', name: 'openaiOrganization' })
          .catch(() => null);
        if (org) env.OPENAI_ORG_ID = org;
      }
    }

    const config = await this.deps.readConfig();
    if (target.provider === 'llama-cpp') {
      Object.assign(env, await this.ensureEngine('llama-server', config));
    } else if (target.provider === 'ds4') {
      Object.assign(env, await this.ensureEngine('ds4-server', config));
    }
    const needsImage = await this.selectionNeedsImageModel(spec);
    if (needsImage) Object.assign(env, await this.ensureEngine('sd-server', config));

    return {
      args,
      env,
      needsDevice: ON_DEVICE.has(target.provider) || needsImage,
    };
  }

  private async selectionNeedsImageModel(spec: EvalJobSpec): Promise<boolean> {
    const catalog = await this.deps.catalog();
    const suite = spec.suiteId ? catalog.suites.find((s) => s.id === spec.suiteId) : undefined;
    const ids = new Set(
      spec.scenarioIds && spec.scenarioIds.length > 0
        ? spec.scenarioIds
        : (suite?.scenarioIds ?? []),
    );
    return catalog.scenarios.some((s) => ids.has(s.id) && s.requires.includes('image-model'));
  }

  private async managedChromium(): Promise<string | null> {
    return resolveManagedChromiumBinary(playwrightBrowsersDir(this.deps.home)).catch(() => null);
  }

  private async copilotReason(harness: EvalHarness | null): Promise<string | null> {
    // A trial daemon gets a fresh home, so it cannot see the Copilot SDK the
    // app installed into this one; only a checkout's own copy reaches it.
    if (harness?.mode !== 'source') {
      return 'Copilot evals need a gezel source checkout for now: trial runs cannot reach the Copilot SDK installed in the app.';
    }
    const availability = await resolveCopilotAvailability(this.deps.home).catch(() => null);
    return availability?.available ? null : 'Install GitHub Copilot in Settings first.';
  }

  /**
   * The engine binary a trial daemon will launch, resolved the way the
   * product resolves it for chat (downloaded on first use, when allowed).
   */
  private async ensureEngine(
    engine: 'llama-server' | 'ds4-server' | 'sd-server',
    config: GezelConfig,
  ): Promise<NodeJS.ProcessEnv> {
    const envVar = {
      'llama-server': 'GEZEL_LLAMA_SERVER_BIN',
      'ds4-server': 'GEZEL_DS4_SERVER_BIN',
      'sd-server': 'GEZEL_SD_SERVER_BIN',
    }[engine];
    const current = this.env[envVar]?.trim();
    if (current && existsSync(current)) return {};
    if (config.autoDownloadEngines === false) {
      throw new Error(
        `The ${engine} engine is not installed and engine downloads are turned off in Settings.`,
      );
    }
    const override = engine === 'llama-server' ? config.llamaCppBackendOverride : undefined;
    const variant =
      override && override !== 'auto'
        ? override
        : engine === 'llama-server'
          ? (this.env.GEZEL_LLAMA_DETECTED_BACKEND ?? impliedEngineVariant(engine, this.platform))
          : impliedEngineVariant(engine, this.platform);
    const { key, snapshot } = this.deps.engineBinaries.ensure(engine, variant);
    const binPath = await new Promise<string>((resolveBin, rejectBin) => {
      const settle = (s: { finished: boolean; error?: string; binPath?: string } | null) => {
        if (!s?.finished) return false;
        if (s.error || !s.binPath)
          rejectBin(
            new Error(`The ${engine} engine could not be set up: ${s.error ?? 'no binary'}`),
          );
        else resolveBin(s.binPath);
        return true;
      };
      if (settle(snapshot)) return;
      const timer = setTimeout(() => {
        unsubscribe?.();
        rejectBin(
          new Error(
            `The ${engine} engine is still downloading. Run the eval again when it finishes.`,
          ),
        );
      }, ENGINE_WAIT_MS);
      const unsubscribe = this.deps.engineBinaries.subscribe(key, () => {
        if (settle(this.deps.engineBinaries.get(key))) {
          clearTimeout(timer);
          unsubscribe?.();
        }
      });
      // A resolve that finished between ensure() and subscribe() emits nothing more.
      if (settle(this.deps.engineBinaries.get(key))) {
        clearTimeout(timer);
        unsubscribe?.();
      }
    });
    return { [envVar]: binPath };
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
