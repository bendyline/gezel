import {
  GEZEL_VERSION,
  UpdateConfigRequestSchema,
  createLogger,
  resolveSandboxCopilot,
  resolveShowWorkInProgressFeatures,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createFreshBoekwachter,
  transferBoekwachterMembership,
} from '../../gezels/autonomous-roles.js';
import { ensureIndexingJobTask } from '../../index-store/indexing-job.js';
import { getCliPresence } from '../../providers/cli-detection.js';
import { resolveDefaultProviderName } from '../../providers/default-provider.js';
import { resolveGpuPolicy } from '../../providers/gpu-arbiter.js';
import type { ProviderCredentialName, SecretStore } from '../../secrets/types.js';
import { resolveInstalledSystemLibrary } from '../../system-toolsets/resolve.js';
import type { ServiceContext } from '../context.js';
import { usesMachineEngine } from './machine-engine-proxy.js';
import { invalidateModelsCache } from './models.js';

const log = createLogger('http');

type CredentialView = {
  githubToken?: string;
  hasGithubToken: boolean;
  openaiApiKey?: string;
  hasOpenaiApiKey: boolean;
  openaiOrganization?: string;
  hasOpenaiOrganization: boolean;
  anthropicApiKey?: string;
  hasAnthropicApiKey: boolean;
  googleAiApiKey?: string;
  hasGoogleAiApiKey: boolean;
  webhookBearerToken?: string;
  hasWebhookBearerToken: boolean;
  webhookBasicAuth?: string;
  hasWebhookBasicAuth: boolean;
  braveSearchApiKey?: string;
  hasBraveSearchApiKey: boolean;
  tavilyApiKey?: string;
  hasTavilyApiKey: boolean;
};

async function readCredentialView(secrets: SecretStore): Promise<CredentialView> {
  const [gh, oa, org, anth, google, whBearer, whBasic, brave, tavily] = await Promise.all([
    secrets.get({ kind: 'providerCredential', name: 'githubToken' }),
    secrets.get({ kind: 'providerCredential', name: 'openaiApiKey' }),
    secrets.get({ kind: 'providerCredential', name: 'openaiOrganization' }),
    secrets.get({ kind: 'providerCredential', name: 'anthropicApiKey' }),
    secrets.get({ kind: 'providerCredential', name: 'googleAiApiKey' }),
    secrets.get({ kind: 'providerCredential', name: 'webhookBearerToken' }),
    secrets.get({ kind: 'providerCredential', name: 'webhookBasicAuth' }),
    secrets.get({ kind: 'providerCredential', name: 'braveSearchApiKey' }),
    secrets.get({ kind: 'providerCredential', name: 'tavilyApiKey' }),
  ]);
  return {
    githubToken: gh ? maskValue(gh) : undefined,
    hasGithubToken: gh !== null,
    openaiApiKey: oa ? maskValue(oa) : undefined,
    hasOpenaiApiKey: oa !== null,
    openaiOrganization: org ?? undefined,
    hasOpenaiOrganization: org !== null,
    anthropicApiKey: anth ? maskValue(anth) : undefined,
    hasAnthropicApiKey: anth !== null,
    googleAiApiKey: google ? maskValue(google) : undefined,
    hasGoogleAiApiKey: google !== null,
    webhookBearerToken: whBearer ? maskValue(whBearer) : undefined,
    hasWebhookBearerToken: whBearer !== null,
    webhookBasicAuth: whBasic ? maskValue(whBasic) : undefined,
    hasWebhookBasicAuth: whBasic !== null,
    braveSearchApiKey: brave ? maskValue(brave) : undefined,
    hasBraveSearchApiKey: brave !== null,
    tavilyApiKey: tavily ? maskValue(tavily) : undefined,
    hasTavilyApiKey: tavily !== null,
  };
}

/** Apply a credential patch to the SecretStore.
 *  `undefined` means "unchanged"; empty string means "clear". */
async function applyCredentialPatch(
  secrets: SecretStore,
  patch: {
    githubToken?: string;
    openaiApiKey?: string;
    openaiOrganization?: string;
    anthropicApiKey?: string;
    googleAiApiKey?: string;
    webhookBearerToken?: string;
    webhookBasicAuth?: string;
    braveSearchApiKey?: string;
    tavilyApiKey?: string;
  },
): Promise<ProviderCredentialName[]> {
  const changed: ProviderCredentialName[] = [];
  const pairs: Array<[ProviderCredentialName, string | undefined]> = [
    ['githubToken', patch.githubToken],
    ['openaiApiKey', patch.openaiApiKey],
    ['openaiOrganization', patch.openaiOrganization],
    ['anthropicApiKey', patch.anthropicApiKey],
    ['googleAiApiKey', patch.googleAiApiKey],
    ['webhookBearerToken', patch.webhookBearerToken],
    ['webhookBasicAuth', patch.webhookBasicAuth],
    ['braveSearchApiKey', patch.braveSearchApiKey],
    ['tavilyApiKey', patch.tavilyApiKey],
  ];
  for (const [name, value] of pairs) {
    if (value === undefined) continue;
    const key = { kind: 'providerCredential' as const, name };
    if (value === '') {
      await secrets.delete(key);
    } else {
      await secrets.set(key, value);
    }
    changed.push(name);
  }
  return changed;
}

const CreateMeesterRequestSchema = z.object({
  name: z.string().min(1).optional(),
});

const CreateKlerkRequestSchema = z.object({
  name: z.string().min(1).optional(),
});

const CreateBoekwachterRequestSchema = z.object({
  name: z.string().min(1).optional(),
});

const CreateKeurmeesterRequestSchema = z.object({
  name: z.string().min(1).optional(),
});

/** Shared masking rule used by the config + toolset-config routes. */
export function maskValue(value: string): string {
  // Reveal a 4-char suffix only when the secret is long enough that those
  // chars are a small fraction of it. For short values (a PIN, a code) the
  // suffix could be most of the secret, so emit a fixed mask instead.
  if (value.length <= 8) return '****';
  return `****${value.slice(-4)}`;
}

export function configRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const config = await ctx.store.readConfig();
    const creds = await readCredentialView(ctx.secrets);
    // Where the Copilot CLI has been unpacked at runtime (if the user has
    // installed it). Drives the Copilot tab's sign-in hint: `cd <path> &&
    // npx copilot login` reuses the integrity-verified copy instead of
    // downloading fresh from npm. Version-tolerant so a pin bump doesn't
    // strip the login command out from under someone mid-upgrade.
    const copilotCliInstallDir = (
      await resolveInstalledSystemLibrary(ctx.home, '@github/copilot-sdk')
    )?.path;
    // Passive CLI-binary presence for provider pickers. Config is read during
    // every CLI command's authorization check and by most UI surfaces, so it
    // must never execute third-party CLIs. The provider-specific "Test
    // connection" routes perform the real version/capability probe on demand.
    const cliDetections = getCliPresence({
      ...(config.anthropicCli ? { anthropicCli: config.anthropicCli } : {}),
      ...(config.codexCli ? { codexCli: config.codexCli } : {}),
    });
    // Mask secrets so they don't leak into the UI. The has* booleans let
    // the UI know whether a given credential is configured.
    return c.json({
      provider: resolveDefaultProviderName(config),
      ...creds,
      ollamaBaseUrl: config.ollamaBaseUrl,
      autoStartOllama: config.autoStartOllama ?? true,
      ollamaNumCtx: config.ollamaNumCtx,
      ollamaNumPredict: config.ollamaNumPredict,
      ollamaThink: config.ollamaThink,
      ollamaStreamingIdleSec: config.ollamaStreamingIdleSec,
      ollamaPreFirstByteIdleSec: config.ollamaPreFirstByteIdleSec,
      ollamaTurnTimeoutMin: config.ollamaTurnTimeoutMin,
      copilotTurnTimeoutMin: config.copilotTurnTimeoutMin,
      defaultModel: config.defaultModel,
      defaultReasoningEffort: config.defaultReasoningEffort,
      firstRunCompleted: config.firstRunCompleted,
      firstRunInstallError: config.firstRunInstallError,
      meesterGezelId: config.meesterGezelId,
      klerkGezelId: config.klerkGezelId,
      boekwachterGezelId: config.boekwachterGezelId,
      keurmeesterGezelId: config.keurmeesterGezelId,
      keurmeester: config.keurmeester,
      debugMode: config.debugMode === true,
      showAdvancedFeatures: config.showAdvancedFeatures === true,
      showWorkInProgressFeatures: resolveShowWorkInProgressFeatures(
        config.showWorkInProgressFeatures,
        GEZEL_VERSION,
      ),
      resetTemplatesOnStartup: config.resetTemplatesOnStartup === true,
      roleBasedNameOnlyMode: config.roleBasedNameOnlyMode === true,
      showPoppetjes: config.showPoppetjes !== false,
      narrateAssistantReplies: config.narrateAssistantReplies === true,
      aiEngagementMode: config.aiEngagementMode ?? 'proactive',
      showSystemTray: config.showSystemTray !== false,
      autoUpdateChecks: config.autoUpdateChecks !== false,
      quitOnClose: config.quitOnClose === true,
      themePref: config.themePref,
      cliShowThinking: config.cliShowThinking !== false,
      cliShowWrites: config.cliShowWrites === true,
      documentExportOptions: config.documentExportOptions,
      sidebarSide: config.sidebarSide,
      homeGreetingCollapsed: config.homeGreetingCollapsed === true,
      workshopTempo: config.workshopTempo ?? 'bedrijvig',
      nightShift: config.nightShift,
      toolFilterMode: config.toolFilterMode ?? 'always',
      channels: config.channels,
      sandboxCopilot: resolveSandboxCopilot(config.sandboxCopilot),
      fetchUrl: config.fetchUrl,
      webSearch: config.webSearch,
      playwrightHeadless: config.playwrightHeadless !== false,
      projectMru: config.projectMru,
      // The unified tab MRU (projects + gezels + documents + tasks).
      // Hand-pick alongside `projectMru` because the response shape is a
      // hand-crafted whitelist; without this entry, GET /api/config
      // silently strips the field and the boot path falls back to the
      // legacy `projectMru` only — leaving any tab kinds beyond projects
      // (and any project tabs added since the last `projectMru` write)
      // missing from the bar after each app relaunch.
      recentTabs: config.recentTabs,
      copilotCliInstallDir,
      cacheBudgetMb: config.cacheBudgetMb,
      providerConcurrency: config.providerConcurrency,
      localEngineIdleTimeoutMs: config.localEngineIdleTimeoutMs,
      // Install-wide per-model tuning. Hand-pick into the whitelist or the
      // Settings preset/fine-tuning controls "lose" their value on the
      // next GET — the resolver still reads them from config.json so the
      // chosen preset DOES apply, but the dropdown would render empty.
      modelTuning: config.modelTuning,
      modelTuningProfile: config.modelTuningProfile,
      // llama-cpp passthrough so the Settings UI can display + edit
      // saved values. The supervisor reads `llamaCppBackendOverride`
      // directly from config.json on app boot (see
      // packages/app/src/supervisor/index.ts) — a UI change here only
      // affects the next launch.
      llamaCppBaseUrl: config.llamaCppBaseUrl,
      llamaCppModelPath: config.llamaCppModelPath,
      llamaCppNumCtx: config.llamaCppNumCtx,
      llamaCppBackendOverride: config.llamaCppBackendOverride,
      llamaCppKvCacheType: config.llamaCppKvCacheType,
      llamaCppFlashAttn: config.llamaCppFlashAttn,
      llamaCppSpecType: config.llamaCppSpecType,
      llamaCppCpuMoe: config.llamaCppCpuMoe,
      llamaCppSwaFull: config.llamaCppSwaFull,
      mlxBaseUrl: config.mlxBaseUrl,
      mlxModelPath: config.mlxModelPath,
      mlxPackageSpec: config.mlxPackageSpec,
      mlxKvBits: config.mlxKvBits,
      anthropicCli: config.anthropicCli,
      codexCli: config.codexCli,
      anthropicCliStatus: cliDetections.anthropicCli,
      codexCliStatus: cliDetections.codexCli,
      imageProvider: config.imageProvider,
      defaultImageModel: config.defaultImageModel,
      imageGenerationConfirmation: config.imageGenerationConfirmation,
      gpuMemoryPolicy: config.gpuMemoryPolicy,
      deviceSafety: config.deviceSafety,
      // Centralized security & compliance posture. Hand-pick into the
      // whitelist or the Security & Compliance panel "loses" its value on
      // the next GET (the enforcement paths read it straight from
      // config.json, so gates still apply — but the UI would render the
      // default `free` slider position regardless of the stored policy).
      securityPolicy: config.securityPolicy,
      // OpenAI-compatible endpoint controls (Settings → Connected Apps).
      // Hand-pick into the whitelist like everything above, or the panel's
      // toggle/dropdown would render defaults on the next GET.
      openaiEndpoints: config.openaiEndpoints,
      // Live gilde content updates toggle (Settings → About). Same
      // whitelist rule as above.
      gildeUpdates: config.gildeUpdates,
      remoteServing: {
        ...(config.remoteServing ?? {}),
        enabled: ctx.remoteServing.status().listening,
        ...(ctx.remoteServing.status().port ? { port: ctx.remoteServing.status().port } : {}),
      },
    });
  });

  app.put('/', async (c) => {
    const body = UpdateConfigRequestSchema.parse(await c.req.json());
    // externalFolders is owned by the move worker (Settings → Folders).
    // Direct PUTs would change paths the in-memory Store still trusts,
    // so we reject the field here and force the caller through the
    // folders move endpoint, which orchestrates backup + move + config
    // swap + service restart atomically.
    if (body.externalFolders !== undefined) {
      return c.json(
        {
          error: 'restart-required',
          hint: 'Use POST /api/folders/move to change externalized folders.',
        },
        409,
      );
    }
    // On machine installs the broker owns the LAN listener (it holds the
    // engines and serves headless); flipping this daemon's copy on would
    // double-bind 6229. Managed through /api/machine-serving instead.
    // Disabling stays allowed so a stale pre-broker flag can be cleared.
    if (body.remoteServing?.enabled === true && usesMachineEngine(ctx)) {
      return c.json(
        {
          error: 'remote-serving-managed-by-machine',
          hint: "This machine's LAN serving is controlled by the machine service — manage it in Settings → Remote Servers.",
        },
        409,
      );
    }
    const previous = await ctx.store.readConfig();
    // Credentials → SecretStore; everything else → config.json. Strip the
    // credential fields so they never hit plaintext disk even if the
    // caller passed them (pre-SecretStore behavior).
    const {
      githubToken,
      openaiApiKey,
      openaiOrganization,
      anthropicApiKey,
      googleAiApiKey,
      webhookBearerToken,
      webhookBasicAuth,
      braveSearchApiKey,
      tavilyApiKey,
      ...plainPatch
    } = body;
    const changedCredentials = await applyCredentialPatch(ctx.secrets, {
      githubToken,
      openaiApiKey,
      openaiOrganization,
      anthropicApiKey,
      googleAiApiKey,
      webhookBearerToken,
      webhookBasicAuth,
      braveSearchApiKey,
      tavilyApiKey,
    });
    const updated = await ctx.store.writeConfig(plainPatch);
    if (body.remoteServing !== undefined) {
      try {
        await ctx.remoteServing.reconfigure(updated.remoteServing);
      } catch (err) {
        await ctx.store.writeConfig({ remoteServing: previous.remoteServing });
        await ctx.remoteServing.reconfigure(previous.remoteServing).catch(() => undefined);
        return c.json(
          {
            error: 'remote-serving-failed',
            message: err instanceof Error ? err.message : String(err),
          },
          409,
        );
      }
      ctx.remoteTenantLimits.setLimits(updated.remoteServing?.limits);
    }
    // Ollama emulation follows the remote-serving contract: the live
    // listener must track config, and a bind failure (usually real
    // Ollama already on 11434) reverts the toggle and surfaces an
    // actionable 409 instead of persisting a switch that lies.
    if (body.openaiEndpoints !== undefined) {
      try {
        await ctx.ollamaEmulation.reconfigure(updated.openaiEndpoints);
      } catch (err) {
        await ctx.store.writeConfig({ openaiEndpoints: previous.openaiEndpoints });
        await ctx.ollamaEmulation.reconfigure(previous.openaiEndpoints).catch(() => undefined);
        return c.json(
          {
            error: 'ollama-emulation-failed',
            message: err instanceof Error ? err.message : String(err),
          },
          409,
        );
      }
      // A configured Codex profile follows the same master switch. Its
      // authenticated bridge is best-effort here: a port collision should
      // surface as "Update needed" on the dedicated card, not roll back the
      // master setting for every other connected app.
      await ctx.codexSetup.reconcile().catch((err) => {
        log.warn(
          `[codex-setup] bridge reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      await ctx.opencodeSetup.reconcile().catch((err) => {
        log.warn(
          `[opencode-setup] bridge reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      await ctx.piSetup.reconcile().catch((err) => {
        log.warn(
          `[pi-setup] bridge reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    // Live gilde updates: enabling kicks a background check; disabling
    // reverts to bundled content immediately and prunes the cache. Never
    // fails the config write — check failures land in the status surface.
    if (body.gildeUpdates !== undefined) {
      await ctx.gildeUpdates.setEnabled(updated.gildeUpdates?.enabled === true);
    }
    // Summaries carry the gezel's NAME — the id is a slug ("ada-lovelace")
    // that reads as plumbing in the History view; ids stay in `details`.
    const designationName = async (id: string): Promise<string> =>
      (await ctx.store.getGezel(id).catch(() => null))?.name ?? id;
    if (body.meesterGezelId !== undefined && body.meesterGezelId !== previous.meesterGezelId) {
      await ctx.history.log({
        kind: 'meester.changed',
        summary: body.meesterGezelId
          ? `Meester set to ${await designationName(body.meesterGezelId)}`
          : 'Meester cleared',
        details: {
          previousGezelId: previous.meesterGezelId,
          gezelId: body.meesterGezelId,
        },
      });
    }
    if (body.klerkGezelId !== undefined && body.klerkGezelId !== previous.klerkGezelId) {
      await ctx.history.log({
        kind: 'klerk.changed',
        summary: body.klerkGezelId
          ? `Klerk set to ${await designationName(body.klerkGezelId)}`
          : 'Klerk cleared',
        details: {
          previousGezelId: previous.klerkGezelId,
          gezelId: body.klerkGezelId,
        },
      });
    }
    if (
      body.boekwachterGezelId !== undefined &&
      body.boekwachterGezelId !== previous.boekwachterGezelId
    ) {
      await transferBoekwachterMembership(
        ctx.store,
        previous.boekwachterGezelId,
        body.boekwachterGezelId,
      );
      await ensureIndexingJobTask(ctx.store, ctx.tasks);
      await ctx.history.log({
        kind: 'boekwachter.changed',
        summary: `Boekwachter set to ${await designationName(body.boekwachterGezelId)}`,
        details: {
          previousGezelId: previous.boekwachterGezelId,
          gezelId: body.boekwachterGezelId,
        },
      });
    }
    if (
      body.keurmeesterGezelId !== undefined &&
      body.keurmeesterGezelId !== previous.keurmeesterGezelId
    ) {
      await ctx.history.log({
        kind: 'keurmeester.changed',
        summary: body.keurmeesterGezelId
          ? `Keurmeester set to ${body.keurmeesterGezelId}`
          : 'Keurmeester cleared',
        details: {
          previousGezelId: previous.keurmeesterGezelId,
          gezelId: body.keurmeesterGezelId,
        },
      });
    }
    if (changedCredentials.length > 0) {
      await ctx.history.log({
        kind: 'config.credential.updated',
        summary: `Updated credentials (${changedCredentials.join(', ')})`,
        details: { fieldIds: changedCredentials },
      });
    }
    // Any credential / provider / endpoint / security-boundary change must
    // tear down cached sessions immediately so the next turn gets the new
    // provider, tool surface, and process-level browser confinement. Hiding a
    // tool in the refreshed prompt is insufficient while the old MCP child is
    // still alive and callable.
    const hardResetFields: Array<keyof typeof body> = [
      'provider',
      'ollamaBaseUrl',
      'ollamaNumPredict',
      'ollamaThink',
      // CodexCliProvider snapshots this nested object (including its
      // reasoning default) when the provider is constructed. Rebuild it so
      // a Settings change applies to the next turn instead of only after a
      // daemon restart. The object also carries permission/runtime settings,
      // so treating the whole field as a hard boundary is intentional.
      'codexCli',
      'securityPolicy',
    ];
    // `defaultModel` / `defaultReasoningEffort` also need a reset because
    // live session objects bake the model in at construction — a plain
    // config write won't flow through to an already-resumed session until
    // the in-memory state is rebuilt. But these are pure preferences: the
    // engines are still valid, so we defer teardown of any session that's
    // mid-turn (e.g. holding an in-flight `generate_video` MCP call) until
    // it goes idle, rather than severing it. See ChatManager.resetClient.
    const modelPrefFields: Array<keyof typeof body> = ['defaultModel', 'defaultReasoningEffort'];
    const nightShiftModelPreferenceChanged =
      body.nightShift !== undefined &&
      JSON.stringify(previous.nightShift?.modelOverride ?? null) !==
        JSON.stringify(updated.nightShift?.modelOverride ?? null);
    const hardReset =
      changedCredentials.length > 0 || hardResetFields.some((f) => body[f] !== undefined);
    if (hardReset) {
      await ctx.chat.resetClient();
      invalidateModelsCache();
    } else if (
      modelPrefFields.some((f) => body[f] !== undefined) ||
      nightShiftModelPreferenceChanged ||
      body.localEngineIdleTimeoutMs !== undefined
    ) {
      await ctx.chat.resetClient({ deferBusy: true });
      invalidateModelsCache();
    }
    // ds4 prices its broker reservation at the launch window, so a machine-wide
    // context change moves what every ds4 model must reserve. The launch itself
    // still waits for the next engine start (unchanged); only the cached
    // reservation has to be re-derived.
    if (body.ds4NumCtx !== undefined && body.ds4NumCtx !== previous.ds4NumCtx) {
      ctx.chat.invalidateResidentBytesCache('ds4');
      invalidateModelsCache('ds4');
    }
    // Image provider reset: rebuild whenever the active image provider
    // selection changes, the default cloud model changes, or any
    // credential the cloud branches consult is touched. Scoped narrower
    // than the chat reset above so an unrelated webhook credential
    // change doesn't churn the image provider.
    const imageResetFields: Array<keyof typeof body> = ['imageProvider', 'defaultImageModel'];
    const imageCredsTouched = changedCredentials.some(
      (n) => n === 'googleAiApiKey' || n === 'openaiApiKey' || n === 'openaiOrganization',
    );
    if (imageCredsTouched || imageResetFields.some((f) => body[f] !== undefined)) {
      await ctx.imageProvider.reset();
    }
    // Video provider reset: rebuild when the active video provider
    // selection or default model changes. Narrowly scoped like the image
    // reset above.
    const videoResetFields: Array<keyof typeof body> = ['videoProvider', 'defaultVideoModel'];
    if (videoResetFields.some((f) => body[f] !== undefined)) {
      await ctx.videoProvider.reset();
    }
    // Recognition reset: a model or engine change has to tear down the
    // running vision server, which holds the old weights open. Policy-only
    // edits (`recognition.mode`) are read per-turn and need no rebuild.
    if (body.recognitionProvider !== undefined || body.defaultRecognitionModel !== undefined) {
      await ctx.recognition.reset(body.defaultRecognitionModel);
    }
    // If channel config or webhook credentials changed, rebuild live
    // channel instances so the next send picks up the new state.
    const channelCredChanged = changedCredentials.some(
      (n) => n === 'webhookBearerToken' || n === 'webhookBasicAuth',
    );
    if (body.channels !== undefined || channelCredChanged) {
      await ctx.channels.reconfigure();
      if (body.channels !== undefined) {
        await ctx.history.log({
          kind: 'channel.configured',
          summary: 'Channel configuration updated',
          details: { channels: Object.keys(body.channels ?? {}) },
        });
      }
    }
    // Live-flip the verbose-diagnostics flag in place so subsystems pick
    // it up on their next log call — no restart needed.
    if (body.debugMode !== undefined) {
      const nextDebug = body.debugMode === true;
      if (nextDebug !== ctx.debug.isEnabled()) {
        ctx.debug.set(nextDebug);
        log.info(`[debug] verbose diagnostics ${nextDebug ? 'ON' : 'OFF'}`);
      }
    }
    // Cache budget changes flow live into the controller — eviction
    // kicks in immediately if the new budget is below current usage.
    // Only pushes the providers the operator actually touched, so an
    // mlx-only update doesn't reset llama.cpp's budget.
    if (body.cacheBudgetMb !== undefined) {
      const mb = body.cacheBudgetMb;
      if (typeof mb.mlx === 'number') ctx.chat.setCacheBudget('mlx', mb.mlx * 1024 * 1024);
      if (typeof mb['llama-cpp'] === 'number') {
        ctx.chat.setCacheBudget('llama-cpp', mb['llama-cpp'] * 1024 * 1024);
      }
    }
    // Same contract for the local-engine memory budget: push it into the
    // live broker so the slider takes effect on the next model spawn
    // instead of the next daemon restart. `null` reverts to auto. A shrink
    // never evicts — it just makes the next reserve fail until the pool's
    // LRU frees room, so moving the slider can't sever a running turn.
    if (body.localEngineMemoryGb !== undefined) {
      const gb = body.localEngineMemoryGb;
      await ctx.chat.setLocalEngineMemoryBudget(gb === null ? null : Math.round(gb * 1024 ** 3));
    }
    if (body.allowRamSpillover !== undefined) {
      await ctx.chat.setAllowRamSpillover(body.allowRamSpillover);
    }
    // GPU memory policy: hot-swap on the live arbiter so the next
    // chat turn / image gen sees the new behavior without a restart.
    // `'auto'` is resolved to a concrete policy via the same helper
    // service.ts uses at boot, so the user always gets the
    // platform-appropriate default when they pick auto.
    if (body.gpuMemoryPolicy !== undefined) {
      ctx.gpuArbiter.setPolicy(resolveGpuPolicy(body.gpuMemoryPolicy));
    }
    if (body.deviceSafety !== undefined) {
      ctx.gpuArbiter.setDeviceSafetyPolicy(body.deviceSafety);
    }
    if (
      body.aiEngagementMode !== undefined &&
      body.aiEngagementMode !== previous.aiEngagementMode
    ) {
      const prevMode = previous.aiEngagementMode ?? 'proactive';
      const nextMode = body.aiEngagementMode;
      ctx.chat.setEngagementMode(nextMode);
      await ctx.history.log({
        kind: 'config.engagementMode.changed',
        summary: `AI engagement mode: ${prevMode} → ${nextMode}`,
        details: { previous: prevMode, next: nextMode },
      });
      if (nextMode === 'off') {
        ctx.chat.onEngagementModeChangedToOff();
      }
    }
    const creds = await readCredentialView(ctx.secrets);
    return c.json({
      provider: resolveDefaultProviderName(updated),
      ...creds,
      ollamaBaseUrl: updated.ollamaBaseUrl,
      autoStartOllama: updated.autoStartOllama ?? true,
      ollamaNumCtx: updated.ollamaNumCtx,
      ollamaNumPredict: updated.ollamaNumPredict,
      ollamaThink: updated.ollamaThink,
      ollamaStreamingIdleSec: updated.ollamaStreamingIdleSec,
      ollamaPreFirstByteIdleSec: updated.ollamaPreFirstByteIdleSec,
      ollamaTurnTimeoutMin: updated.ollamaTurnTimeoutMin,
      copilotTurnTimeoutMin: updated.copilotTurnTimeoutMin,
      defaultModel: updated.defaultModel,
      defaultReasoningEffort: updated.defaultReasoningEffort,
      firstRunCompleted: updated.firstRunCompleted,
      firstRunInstallError: updated.firstRunInstallError,
      meesterGezelId: updated.meesterGezelId,
      klerkGezelId: updated.klerkGezelId,
      boekwachterGezelId: updated.boekwachterGezelId,
      keurmeesterGezelId: updated.keurmeesterGezelId,
      keurmeester: updated.keurmeester,
      debugMode: updated.debugMode === true,
      showAdvancedFeatures: updated.showAdvancedFeatures === true,
      showWorkInProgressFeatures: resolveShowWorkInProgressFeatures(
        updated.showWorkInProgressFeatures,
        GEZEL_VERSION,
      ),
      resetTemplatesOnStartup: updated.resetTemplatesOnStartup === true,
      roleBasedNameOnlyMode: updated.roleBasedNameOnlyMode === true,
      showPoppetjes: updated.showPoppetjes !== false,
      narrateAssistantReplies: updated.narrateAssistantReplies === true,
      aiEngagementMode: updated.aiEngagementMode ?? 'proactive',
      showSystemTray: updated.showSystemTray !== false,
      autoUpdateChecks: updated.autoUpdateChecks !== false,
      quitOnClose: updated.quitOnClose === true,
      themePref: updated.themePref,
      cliShowThinking: updated.cliShowThinking !== false,
      cliShowWrites: updated.cliShowWrites === true,
      documentExportOptions: updated.documentExportOptions,
      sidebarSide: updated.sidebarSide,
      homeGreetingCollapsed: updated.homeGreetingCollapsed === true,
      workshopTempo: updated.workshopTempo ?? 'bedrijvig',
      nightShift: updated.nightShift,
      toolFilterMode: updated.toolFilterMode ?? 'always',
      channels: updated.channels,
      sandboxCopilot: resolveSandboxCopilot(updated.sandboxCopilot),
      fetchUrl: updated.fetchUrl,
      webSearch: updated.webSearch,
      playwrightHeadless: updated.playwrightHeadless !== false,
      localEngineIdleTimeoutMs: updated.localEngineIdleTimeoutMs,
      // Echo llama-cpp fields for parity with the GET handler. Without
      // these the UI's Settings → On-device → Advanced controls would
      // appear to "lose" their value the instant the user hits Save —
      // setConfig(next) would clear the displayed value even though
      // the underlying config.json (and the supervisor's view of it)
      // is correct.
      llamaCppBaseUrl: updated.llamaCppBaseUrl,
      llamaCppModelPath: updated.llamaCppModelPath,
      llamaCppNumCtx: updated.llamaCppNumCtx,
      llamaCppBackendOverride: updated.llamaCppBackendOverride,
      llamaCppKvCacheType: updated.llamaCppKvCacheType,
      llamaCppFlashAttn: updated.llamaCppFlashAttn,
      llamaCppSpecType: updated.llamaCppSpecType,
      llamaCppCpuMoe: updated.llamaCppCpuMoe,
      llamaCppSwaFull: updated.llamaCppSwaFull,
      mlxBaseUrl: updated.mlxBaseUrl,
      mlxModelPath: updated.mlxModelPath,
      mlxPackageSpec: updated.mlxPackageSpec,
      mlxKvBits: updated.mlxKvBits,
      // Keep PUT response parity with GET. Settings swaps this response into
      // local state, so omitting the nested Codex settings made the effort
      // picker jump straight back to the model default after every change.
      codexCli: updated.codexCli,
      imageProvider: updated.imageProvider,
      defaultImageModel: updated.defaultImageModel,
      imageGenerationConfirmation: updated.imageGenerationConfirmation,
      gpuMemoryPolicy: updated.gpuMemoryPolicy,
      deviceSafety: updated.deviceSafety,
      // Echo install-wide tuning so the preset / custom fine-tuning
      // dropdowns keep their value the instant the user hits Save —
      // setConfig(next) would otherwise clear the displayed selection
      // even though config.json (and the resolver) is correct. Same
      // bug class as the llama-cpp echo above.
      modelTuning: updated.modelTuning,
      modelTuningProfile: updated.modelTuningProfile,
      // Echo the security posture for parity with GET — without it the
      // Security & Compliance panel's optimistic setConfig(next) would
      // revert the slider/toggles to the default `free` the instant the
      // user changes them, even though config.json is correct. Same
      // echo-bug class as the llama-cpp / tuning fields above.
      securityPolicy: updated.securityPolicy,
      // Same echo-bug class as securityPolicy above: without this, the
      // Connected Apps toggle/dropdown revert visually the instant the
      // user changes them.
      openaiEndpoints: updated.openaiEndpoints,
      remoteServing: {
        ...(updated.remoteServing ?? {}),
        enabled: ctx.remoteServing.status().listening,
        ...(ctx.remoteServing.status().port ? { port: ctx.remoteServing.status().port } : {}),
      },
    });
  });

  /**
   * Create a brand-new gezel wearing the Meester role and make them the
   * active meester. Accepts an optional `name`; falls back to a random pick
   * from the curated list.
   */
  app.post('/meester', async (c) => {
    const body = CreateMeesterRequestSchema.parse(await c.req.json().catch(() => ({})));
    const previous = await ctx.store.readConfig();
    const created = await ctx.store.createFreshMeester(body.name);
    await ctx.history.log({
      kind: 'gezel.created',
      gezelId: created.id,
      summary: `Created Meester "${created.name}"`,
      details: { name: created.name, role: 'Meester', source: 'meester.new' },
    });
    if (previous.meesterGezelId !== created.id) {
      await ctx.history.log({
        kind: 'meester.changed',
        summary: `Meester set to ${created.name}`,
        details: {
          previousGezelId: previous.meesterGezelId,
          gezelId: created.id,
        },
      });
    }
    const updated = await ctx.store.readConfig();
    const creds = await readCredentialView(ctx.secrets);
    return c.json(
      {
        gezel: created,
        config: {
          provider: resolveDefaultProviderName(updated),
          ...creds,
          ollamaBaseUrl: updated.ollamaBaseUrl,
          autoStartOllama: updated.autoStartOllama ?? true,
          defaultModel: updated.defaultModel,
          defaultReasoningEffort: updated.defaultReasoningEffort,
          meesterGezelId: updated.meesterGezelId,
          klerkGezelId: updated.klerkGezelId,
          boekwachterGezelId: updated.boekwachterGezelId,
        },
      },
      201,
    );
  });

  /**
   * Create a brand-new gezel wearing the Klerk role and make them the
   * active klerk. Mirrors POST /meester. Optional `name` overrides the
   * random pick from the curated list.
   */
  app.post('/klerk', async (c) => {
    const body = CreateKlerkRequestSchema.parse(await c.req.json().catch(() => ({})));
    const previous = await ctx.store.readConfig();
    const created = await ctx.store.createFreshKlerk(body.name);
    await ctx.history.log({
      kind: 'gezel.created',
      gezelId: created.id,
      summary: `Created Klerk "${created.name}"`,
      details: { name: created.name, role: 'Klerk', source: 'klerk.new' },
    });
    if (previous.klerkGezelId !== created.id) {
      await ctx.history.log({
        kind: 'klerk.changed',
        summary: `Klerk set to ${created.name}`,
        details: {
          previousGezelId: previous.klerkGezelId,
          gezelId: created.id,
        },
      });
    }
    const updated = await ctx.store.readConfig();
    const creds = await readCredentialView(ctx.secrets);
    return c.json(
      {
        gezel: created,
        config: {
          provider: resolveDefaultProviderName(updated),
          ...creds,
          ollamaBaseUrl: updated.ollamaBaseUrl,
          autoStartOllama: updated.autoStartOllama ?? true,
          defaultModel: updated.defaultModel,
          defaultReasoningEffort: updated.defaultReasoningEffort,
          meesterGezelId: updated.meesterGezelId,
          klerkGezelId: updated.klerkGezelId,
          boekwachterGezelId: updated.boekwachterGezelId,
        },
      },
      201,
    );
  });

  /**
   * Create a fresh canonical Boekwachter, transfer the projects that had
   * the previous designation, and make the new gezel the install-wide
   * default for this autonomous role.
   */
  app.post('/boekwachter', async (c) => {
    const body = CreateBoekwachterRequestSchema.parse(await c.req.json().catch(() => ({})));
    const previous = await ctx.store.readConfig();
    const created = await createFreshBoekwachter(ctx.store, ctx.catalog, body.name);
    await transferBoekwachterMembership(ctx.store, previous.boekwachterGezelId, created.id);
    await ensureIndexingJobTask(ctx.store, ctx.tasks);
    await ctx.history.log({
      kind: 'boekwachter.changed',
      summary: `Boekwachter set to ${created.name}`,
      details: {
        previousGezelId: previous.boekwachterGezelId,
        gezelId: created.id,
      },
    });
    const updated = await ctx.store.readConfig();
    const creds = await readCredentialView(ctx.secrets);
    return c.json(
      {
        gezel: created,
        config: {
          provider: resolveDefaultProviderName(updated),
          ...creds,
          ollamaBaseUrl: updated.ollamaBaseUrl,
          autoStartOllama: updated.autoStartOllama ?? true,
          defaultModel: updated.defaultModel,
          defaultReasoningEffort: updated.defaultReasoningEffort,
          meesterGezelId: updated.meesterGezelId,
          klerkGezelId: updated.klerkGezelId,
          boekwachterGezelId: updated.boekwachterGezelId,
          keurmeesterGezelId: updated.keurmeesterGezelId,
        },
      },
      201,
    );
  });

  /**
   * Create a brand-new gezel wearing the Keurmeester role and make them
   * the active keurmeester. Mirrors POST /klerk. Optional `name` overrides
   * the random pick from the curated list.
   */
  app.post('/keurmeester', async (c) => {
    const body = CreateKeurmeesterRequestSchema.parse(await c.req.json().catch(() => ({})));
    const previous = await ctx.store.readConfig();
    const created = await ctx.store.createFreshKeurmeester(body.name);
    await ctx.history.log({
      kind: 'gezel.created',
      gezelId: created.id,
      summary: `Created Keurmeester "${created.name}"`,
      details: { name: created.name, role: 'Keurmeester', source: 'keurmeester.new' },
    });
    if (previous.keurmeesterGezelId !== created.id) {
      await ctx.history.log({
        kind: 'keurmeester.changed',
        summary: `Keurmeester set to ${created.name}`,
        details: {
          previousGezelId: previous.keurmeesterGezelId,
          gezelId: created.id,
        },
      });
    }
    const updated = await ctx.store.readConfig();
    const creds = await readCredentialView(ctx.secrets);
    return c.json(
      {
        gezel: created,
        config: {
          provider: resolveDefaultProviderName(updated),
          ...creds,
          ollamaBaseUrl: updated.ollamaBaseUrl,
          autoStartOllama: updated.autoStartOllama ?? true,
          defaultModel: updated.defaultModel,
          defaultReasoningEffort: updated.defaultReasoningEffort,
          meesterGezelId: updated.meesterGezelId,
          klerkGezelId: updated.klerkGezelId,
          boekwachterGezelId: updated.boekwachterGezelId,
          keurmeesterGezelId: updated.keurmeesterGezelId,
        },
      },
      201,
    );
  });

  return app;
}
