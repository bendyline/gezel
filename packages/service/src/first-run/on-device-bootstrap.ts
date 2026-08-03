import { arch, platform } from 'node:process';
import { createLogger, securityPolicyForLevel } from '@bendyline/gezel';
import type { ChatModelManifest } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { Store } from '../fs/store.js';

const firstRunLog = createLogger('first-run');
import { detectModelTier } from '../providers/llama-cpp/hardware-tier.js';
import type { LlamaCppModelManager } from '../providers/llama-cpp/index.js';
import type { MlxModelManager } from '../providers/mlx/index.js';

/**
 * Platforms we ship a bundled `llama-server` for — see
 * `.github/workflows/build-native.yml`. The first-run flow auto-
 * enrolls users into on-device only on these combos; everyone else
 * (notably Intel Mac) lands on a cloud provider by default so they
 * don't download a 3–10 GB model that would then fail with
 * "no engine bundled" when they tried to chat. The set must stay
 * in sync with the build matrix; if a platform is added there, add
 * it here too.
 */
const SUPPORTED_PLATFORMS: ReadonlyArray<`${NodeJS.Platform}-${string}`> = [
  'darwin-arm64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
];

export function isSupportedOnDevicePlatform(
  p: NodeJS.Platform = platform,
  a: string = arch,
): boolean {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(`${p}-${a}`);
}

/**
 * Darwin-arm64 gets a special branch — MLX is measurably faster than
 * llama.cpp Metal on Apple Silicon, so we route Apple Silicon users
 * to `provider=mlx`. Intel Mac, Linux, and Windows stay on llama.cpp
 * — MLX can't run there.
 *
 * The catalog id is the same on both branches: each chat-model entry
 * carries `llamaCpp` and/or `mlx` source blocks under one `id`, and
 * the provider picks the right block on install. Earlier revisions
 * of this code suffixed `-mlx` for the Apple branch under the
 * (mistaken) assumption that there were separate `gemma4-*-mlx`
 * catalog entries — there aren't, and the suffix produced ids that
 * `MlxModelManager.install()` then couldn't find in the catalog.
 *
 * Returns the provider + catalog id pair to pin, given a detected
 * tier. Exported for testing.
 */
export function resolveFirstRunTarget(
  tier: string,
  p: NodeJS.Platform = platform,
  a: string = arch,
): { provider: 'llama-cpp' | 'mlx'; modelId: string } {
  if (p === 'darwin' && a === 'arm64') {
    return { provider: 'mlx', modelId: tier };
  }
  return { provider: 'llama-cpp', modelId: tier };
}

/** The catalog's chat-model manifests — the recommendation candidate pool. */
async function listChatModelManifests(catalog: CatalogService): Promise<ChatModelManifest[]> {
  const items = await catalog.list('chat-model');
  return items
    .map((i) => i.manifest)
    .filter((m): m is ChatModelManifest => m.kind === 'chat-model');
}

/**
 * On-device first-run bootstrap.
 *
 * New installs default to an on-device recommendation. This runs once on
 * service startup and:
 *
 *   1. Skips entirely if the user has already made a provider choice
 *      (`config.provider` is set) or if we've already attempted first
 *      run (`config.firstRunCompleted`). Presence of either means
 *      "don't override the user's decisions."
 *   2. Probes the host and ranks open local models from the catalog for
 *      the available RAM and GPU memory.
 *   3. Branches on platform: Apple Silicon → `mlx` provider + MLX
 *      variant of the tier; everyone else → `llama-cpp` provider
 *      + GGUF variant. Pins the choice as the default model and
 *      sets `firstRunCompleted = true`.
 *   4. Stops here. A first-party client (the desktop banner or CLI TUI)
 *      asks before downloading. The pin tells each client which model to
 *      recommend without surprising the user with a background download.
 */
export async function bootstrapOnDeviceFirstRun(opts: {
  store: Store;
  llamaCppModels: LlamaCppModelManager;
  mlxModels: MlxModelManager;
  catalog: CatalogService;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  /** Test seams — production callers use ambient `process.platform` / `process.arch`. */
  platformOverride?: NodeJS.Platform;
  archOverride?: string;
}): Promise<void> {
  const { store, llamaCppModels, mlxModels, logger } = opts;
  const effPlatform = opts.platformOverride ?? platform;
  const effArch = opts.archOverride ?? arch;
  const log = {
    info: (m: string) => (logger?.info ?? ((s: string) => firstRunLog.info(s)))(m),
    warn: (m: string) => (logger?.warn ?? ((s: string) => firstRunLog.warn(s)))(m),
  };

  const storedConfig = await store.readConfig();
  // Absence is not a security posture. Preserve historical unrestricted
  // behavior for installs that already completed first-run (or already have a
  // provider choice), while giving genuinely new installs Lockdown.
  const config = storedConfig.securityPolicy
    ? storedConfig
    : {
        ...storedConfig,
        securityPolicy: securityPolicyForLevel(
          storedConfig.firstRunCompleted || storedConfig.provider !== undefined
            ? 'free'
            : 'lockdown',
        ),
      };
  if (!storedConfig.securityPolicy) {
    await store.writeConfig({ securityPolicy: config.securityPolicy });
  }
  if (!isSupportedOnDevicePlatform(effPlatform, effArch)) {
    // Intel Mac and other platforms we don't ship a bundled engine
    // for. Auto-enrolling here would download 3-10 GB of model that
    // couldn't actually run, then surface "no engine bundled" on
    // the first chat turn. Mark first-run complete and let the user
    // land on whichever cloud provider they credential later.
    log.info(
      `[first-run] skipping on-device enrollment: ${effPlatform}-${effArch} isn't in the bundled-binary matrix.`,
    );
    if (!config.firstRunCompleted) {
      await store.writeConfig({ firstRunCompleted: true });
    }
    return;
  }

  // Re-eval branch: a prior bootstrap may have pinned a tier that no
  // longer matches the resolver's verdict on this machine — either the
  // tier heuristics improved (the 12 GB threshold tolerance fix that
  // unstuck E2B → E4B for cards reporting just-under 12 GB), the
  // catalog gained a higher tier (E4B → 26B-A4B MoE), or the install
  // was abandoned mid-download and never landed on disk so the user
  // is effectively still in first-run state. We only intervene when:
  //   - first-run was already completed (so we're not stomping the
  //     fresh-machine path below)
  //   - the user is still on an on-device provider matching what the
  //     bootstrap chose (don't undo a manual switch to Copilot)
  //   - no install is currently in flight (don't race a live download)
  //   - the pinned model isn't actually installed (deleting from
  //     Settings counts; abandoned downloads count)
  // and only ACT when the resolver picks a different tier — same tier
  // means the existing pin is fine, the limbo recovery in the banner
  // will re-fire that install on its own.
  if (config.firstRunCompleted && (config.provider === 'llama-cpp' || config.provider === 'mlx')) {
    const provider = config.provider;
    const installer = provider === 'mlx' ? mlxModels : llamaCppModels;
    if (installer.getActiveInstalls().length === 0) {
      const pinned = config.defaultModel?.[provider];
      const installed = await installer.listInstalled();
      const pinnedIsOnDisk = pinned ? installed.some((m) => m.id === pinned) : false;
      if (!pinnedIsOnDisk && installed.length > 0) {
        // The pin is stale but the user has working models — repoint at one
        // of those instead of the tier winner. Re-pinning to a not-installed
        // recommendation here would make Home offer a fresh multi-GB
        // download while gigabytes of working weights sit on disk, which
        // reads as "the app forgot my models."
        const fallback = installed[0]!.id;
        log.warn(
          `[first-run] pinned ${provider}/${pinned ?? '<none>'} is not installed but ` +
            `${installed.length} model(s) are; re-pinning to installed ${fallback}.`,
        );
        await store.writeConfig({
          defaultModel: { ...config.defaultModel, [provider]: fallback },
          firstRunInstallError: null as unknown as undefined,
        });
        return;
      }
      if (!pinnedIsOnDisk) {
        const decision = await detectModelTier(await listChatModelManifests(opts.catalog));
        const target = resolveFirstRunTarget(decision.tier, effPlatform, effArch);
        if (target.provider === provider && target.modelId !== pinned) {
          log.info(
            `[first-run] re-evaluating: pinned ${provider}/${pinned ?? '<none>'} not installed; ` +
              `resolver now picks ${target.modelId} (${decision.reason}). Updating pin.`,
          );
          await store.writeConfig({
            defaultModel: { ...config.defaultModel, [provider]: target.modelId },
            firstRunInstallError: null as unknown as undefined,
          });
          // Note: no auto-install fire here — the Home banner's limbo
          // recovery (FirstRunInstallBanner.tsx) detects the new pin
          // + missing install and kicks off the install via SSE. That
          // path also reflects progress in the catalog UI.
        }
      }
    }
    return;
  }
  if (config.firstRunCompleted) {
    log.info('[first-run] already completed on a prior boot, skipping.');
    return;
  }
  if (config.provider !== undefined) {
    // User has opinions — set the flag so we don't evaluate again,
    // but don't override the provider or install anything.
    log.info(`[first-run] user already selected provider=${config.provider}, skipping.`);
    await store.writeConfig({ firstRunCompleted: true });
    return;
  }

  // Pick a tier, pin config, mark first-run complete.
  const decision = await detectModelTier(await listChatModelManifests(opts.catalog));
  const totalGb = Math.round(decision.inputs.totalRamBytes / 1024 ** 3);
  const gpuGb = decision.inputs.gpuVramBytes
    ? `, gpuVram=${Math.round(decision.inputs.gpuVramBytes / 1024 ** 3)}GB`
    : '';
  const target = resolveFirstRunTarget(decision.tier, effPlatform, effArch);
  log.info(
    `[first-run] chose ${target.provider}/${target.modelId}: ${decision.reason} (totalRam=${totalGb}GB${gpuGb})`,
  );

  // Write the provider + default-model pin so the Home banner can
  // label the "Download recommended model" CTA with the right id.
  // We deliberately do NOT auto-fire the install — a fresh launch
  // shouldn't kick off a multi-GB download without the user's
  // explicit consent. The UI reads the pin and offers the button;
  // clicking it goes through the same install SSE route Settings uses.
  await store.writeConfig({
    provider: target.provider,
    defaultModel: { ...config.defaultModel, [target.provider]: target.modelId },
    firstRunCompleted: true,
    firstRunInstallError: null as unknown as undefined,
  });
}
