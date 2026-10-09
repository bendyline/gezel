/**
 * Wire shape of `GET /api/config` and `PUT /api/config`: the install's
 * settings as the daemon answers them, with secrets masked and some fields
 * materialized to their defaults.
 */
import type {
  AmbientDashboardDisplayTarget,
  AmbientDashboardTheme,
  ChannelsConfig,
  DeviceSafetyPolicyConfig,
  GezelConfig,
  NotificationsConfig,
  ProviderName,
  RetrievalPolicy,
  SecurityPolicy,
} from '@bendyline/gezel';
import type { RecognitionMode } from '@bendyline/gezel/schemas';

export interface ConfigResponse {
  provider: ProviderName;
  /** Generalist mode setting (`auto` when unset). See docs/generalist-mode.md. */
  generalistMode?: 'auto' | 'on' | 'off';
  githubToken?: string;
  hasGithubToken: boolean;
  openaiApiKey?: string;
  hasOpenaiApiKey: boolean;
  openaiOrganization?: string;
  hasOpenaiOrganization?: boolean;
  /** Anthropic API key (masked when set). Drives the `anthropic` provider. */
  anthropicApiKey?: string;
  hasAnthropicApiKey?: boolean;
  /** Google AI Studio API key (masked when set). Drives the `google-ai`
   *  image provider (Nano Banana 2). */
  googleAiApiKey?: string;
  hasGoogleAiApiKey?: boolean;
  ollamaBaseUrl?: string;
  autoStartOllama?: boolean;
  ollamaNumCtx?: number;
  /** Max tokens generated per turn (Ollama's `options.num_predict`). */
  ollamaNumPredict?: number;
  /** Force-enable / force-disable Ollama's reasoning mode. Undefined =
   *  auto (reasoning families → off, others → Ollama default). */
  ollamaThink?: boolean;
  /** Mid-stream silence cap before the watchdog aborts (seconds). */
  ollamaStreamingIdleSec?: number;
  /** Cold-start + prompt-prefill silence cap before first token (seconds). */
  ollamaPreFirstByteIdleSec?: number;
  /** Hard total per-turn cap, regardless of activity (minutes). */
  ollamaTurnTimeoutMin?: number;
  /** Copilot-only hard per-turn cap, in minutes. Default 3. */
  copilotTurnTimeoutMin?: number;
  /** Idle local models unload after this many milliseconds. Default 5 minutes. */
  localEngineIdleTimeoutMs?: number;
  /**
   * llama-cpp: absolute path to a single GGUF file the supervised
   * llama-server should load. Phase 1 MVP; replaced by a model
   * manager in Phase 2.
   */
  llamaCppModelPath?: string;
  /**
   * llama-cpp: base URL of an already-running llama-server. When
   * set, the service talks to the user-managed server instead of
   * supervising its own.
   */
  llamaCppBaseUrl?: string;
  /**
   * llama-cpp: context window (tokens) llama-server is booted with.
   * This explicit numeric override wins over the engine-owned context-sizing
   * selector. When unset, Adaptive uses model tuning or a 64K practical
   * target; Model maximum requests the advertised native window.
   */
  llamaCppNumCtx?: number;
  /** ds4: base URL of an already-running ds4-server (external mode). */
  ds4BaseUrl?: string;
  /** ds4: explicit supported GGUF path passed to `ds4-server --model`. */
  ds4ModelPath?: string;
  /** ds4: model-matched vision encoder passed to `ds4-server --vision`. */
  ds4VisionEncoderPath?: string;
  /** ds4: context window (tokens) ds4-server is booted with (`--ctx`). */
  ds4NumCtx?: number;
  /** ds4: request SSD expert streaming (safe default; unsafe `false` is ignored). */
  ds4SsdStreaming?: boolean;
  /** ds4: requested expert-cache GiB; the service clamps it to safe headroom. */
  ds4CacheExpertsGb?: number;
  /**
   * llama-cpp: force a specific backend variant instead of letting the
   * Electron supervisor auto-detect. `'auto'` or undefined keeps the
   * auto-detect (CUDA → Vulkan → CPU on PC, Metal on Mac). Read by
   * the supervisor at app boot — changes take effect on next launch.
   */
  llamaCppBackendOverride?: 'auto' | 'cuda' | 'vulkan' | 'metal' | 'cpu';
  /**
   * llama-cpp: KV-cache quantization (`--cache-type-k`/`--cache-type-v`).
   * Undefined → `q8_0` default. Lower precision frees RAM for longer
   * contexts at a minor accuracy cost. Read at engine launch.
   */
  llamaCppKvCacheType?: 'f16' | 'q8_0' | 'q4_0';
  /**
   * llama-cpp: Flash Attention mode (`--flash-attn on|off|auto`).
   * Tri-state string, or a legacy boolean (`true` = on). Undefined →
   * server default (`auto`); the launcher forces `on` under a quantized
   * KV cache. Read at engine launch.
   */
  llamaCppFlashAttn?: boolean | 'on' | 'off' | 'auto';
  /**
   * llama-cpp: keep ALL Mixture-of-Experts weights in system RAM
   * (`--cpu-moe`) while attention/dense layers run on the GPU — the
   * lever for running a big MoE on a constrained-VRAM discrete GPU.
   * Undefined → off (the hardware planner may enable it automatically).
   */
  llamaCppCpuMoe?: boolean;
  /**
   * llama-cpp: keep the MoE weights of only the first N layers in system
   * RAM (`--n-cpu-moe N`) — the partial-split form of `llamaCppCpuMoe`.
   */
  llamaCppNCpuMoe?: number;
  /**
   * llama-cpp: keep dense FFN weights from the first N layers in system
   * RAM (`--n-cpu-ffn N`). Undefined lets the hardware planner decide;
   * 0 explicitly disables automatic dense-FFN offload.
   */
  llamaCppNCpuFfn?: number;
  /** Legacy setting retained so Settings can migrate it to `llamaCppLoadMode`. */
  llamaCppMlock?: boolean;
  /** llama-cpp v0.4.0 model file loading policy (`--load-mode`). */
  llamaCppLoadMode?: 'auto' | 'none' | 'mmap' | 'mlock' | 'mmap+mlock' | 'dio';
  /** llama-cpp v0.4.0 on-demand tensor loading policy (`--lazy-mode`). */
  llamaCppLazyMode?: 'on' | 'auto' | 'off';
  /** Preserve and replay private reasoning across assistant history. */
  llamaCppReasoningPreserve?: boolean;
  /**
   * llama-cpp: allocate a full-size sliding-window KV cache (`--swa-full`)
   * instead of the memory-efficient windowed one, for SWA models (Gemma).
   * ~30% more memory at long context, and the precondition for the engine
   * accepting `--cache-reuse` at all on those models — with a windowed
   * cache it refuses ("cache_reuse is not supported by this context").
   * No effect on Qwen 3.5/3.6, which cannot KV-shift regardless.
   * Undefined → off (windowed cache).
   */
  llamaCppSwaFull?: boolean;
  /**
   * llama-cpp: speculative-decoding mode (`--spec-type`). Lossless
   * decode speedup. `ngram-*` need no draft model; `draft-mtp` uses the
   * model's own MTP head. Undefined → capability-gated Auto: MTP for a
   * compatible installed GGUF, off otherwise.
   */
  llamaCppSpecType?:
    | 'none'
    | 'draft-mtp'
    | 'draft-eagle3'
    | 'draft-dflash'
    | 'draft-simple'
    | 'ngram-mod'
    | 'ngram-simple'
    | 'ngram-map-k'
    | 'ngram-map-k4v'
    | 'ngram-cache';
  /** Draft selection for MTP/simple drafts. Undefined retains greedy. */
  llamaCppSpecDraftSampling?: 'greedy' | 'probabilistic';
  /**
   * First-run bootstrap bookkeeping — set once the on-device default-
   * provider bootstrap has evaluated (success or failure). Prevents
   * re-running on every boot. Cloud-provider users get this flipped
   * true immediately; local-install-in-progress users see it true
   * even while the download is still running.
   */
  firstRunCompleted?: boolean;
  /**
   * Human-readable error from the last first-run model install, if
   * any. Home view surfaces a Retry affordance when set.
   */
  firstRunInstallError?: string;
  defaultModel?: {
    copilot?: string;
    openai?: string;
    anthropic?: string;
    'anthropic-cli'?: string;
    'codex-cli'?: string;
    ollama?: string;
    'llama-cpp'?: string;
    'apple-foundation-models'?: string;
    'android-mlkit'?: string;
    mlx?: string;
    ds4?: string;
    /** Namespaced `remote:<remoteId>/<model>` default; rarely set. */
    remote?: string;
  };
  defaultReasoningEffort?: {
    copilot?: string;
    openai?: string;
    anthropic?: string;
    'anthropic-cli'?: string;
    'codex-cli'?: string;
    ollama?: string;
    'llama-cpp'?: string;
    'apple-foundation-models'?: string;
    'android-mlkit'?: string;
    mlx?: string;
    ds4?: string;
    remote?: string;
  };
  /**
   * Install-wide per-model tuning overrides, keyed by catalog model id.
   * Sits between per-gezel `tuning` overrides and the catalog manifest's
   * recommended defaults in the resolution stack.
   */
  modelTuning?: Record<string, import('@bendyline/gezel').ChatModelTuning>;
  /**
   * Install-wide per-model preset (tuning profile) selection, keyed by
   * catalog model id. The resolver applies it as a profile layer when
   * the gezel hasn't picked its own `tuningProfile`. Sparse: only set
   * for models the user has explicitly configured.
   */
  modelTuningProfile?: Record<string, string>;
  /**
   * Shared accelerator-health admission policy. The UI exposes Observe and
   * Manage while retaining `off` as an operator/configuration escape hatch.
   */
  deviceSafety?: DeviceSafetyPolicyConfig;
  /** MLX: base URL of an already-running mlx_lm.server, for dev/LAN. */
  mlxBaseUrl?: string;
  /** MLX: absolute path to an MLX model directory override. */
  mlxModelPath?: string;
  /** MLX: optional managed context cap; defaults to the model's native window. */
  mlxNumCtx?: number;
  /** MLX: pip-style spec for mlx-lm; pinned versions avoid surprise breaks. */
  mlxPackageSpec?: string;
  /**
   * MLX: bits to quantize the KV cache to (`--kv-bits`). 0/undefined →
   * off (full precision). Lower precision speeds generation and lowers
   * memory, but can crash long sessions that hit a rotating KV cache.
   */
  mlxKvBits?: number;
  /**
   * Multi-engine pool: combined RAM budget (GB) across all resident
   * local engines. Unset → auto-derive from the host (unified-memory
   * machines get a larger share than discrete-GPU ones — see
   * `autoDetectBudgetBytes`). Authoritative when present; `null` clears
   * the override and returns to auto.
   */
  localEngineMemoryGb?: number | null;
  /**
   * Multi-engine pool: per-model clone count keyed by catalog `modelId`.
   * Missing keys default to 1 resident replica.
   */
  localEngineReplicas?: Record<string, number>;
  /**
   * Hard ceiling for the Settings clone-count picker. Defaults to 4 server-side.
   */
  localEngineReplicasMax?: number;
  /**
   * Per-engine prompt-cache memory budget in MB. Operator override; when
   * unset the controller picks a tiered RAM-aware default (1/2/4/8 GB
   * across <16/16-32/32-64/≥64 GB systems). Read by CacheControlsPanel.
   */
  cacheBudgetMb?: {
    mlx?: number;
    'llama-cpp'?: number;
  };
  /** Read-only snapshot of the resolved Python runtime after first venv provision. */
  pythonRuntime?: {
    source: 'system-uv' | 'system-python' | 'bundled-uv';
    installerPath?: string;
    uvVersion?: string;
    pythonVersion?: string;
    resolvedAt?: string;
  };
  meesterGezelId?: string;
  klerkGezelId?: string;
  boekwachterGezelId?: string;
  keurmeesterGezelId?: string;
  /** Keurmeester supervision — see `GezelConfigSchema.keurmeester` in core. */
  keurmeester?: {
    enabled?: boolean;
    providerName?: string;
    model?: string;
    allowTakeover?: boolean;
    maxConsultsPerSession?: number;
    maxConsultsPerTask?: number;
    cooldownMs?: number;
  };
  autoRecall?: {
    enabled?: boolean;
    topK?: number;
    minScore?: number;
  };
  /** Proactive indexed-context policy for substantive turns. */
  retrieval?: RetrievalPolicy;
  summarization?: {
    enabled?: boolean;
    provider?: 'copilot' | 'openai' | 'ollama';
    model?: string;
    minUserTurns?: number;
    idleHours?: number;
  };
  debugMode?: boolean;
  /**
   * When true, advanced/power-user surfaces are revealed in the UI —
   * currently the "Scripts" area link in the sidebar. Materialized on GET
   * (defaults to `false` when unset) so the Settings UI can bind directly.
   * Default `false`.
   */
  showAdvancedFeatures?: boolean;
  /**
   * When true, very early work-in-progress surfaces are revealed in the UI
   * and CLI. Materialized on GET; defaults on in development builds and off
   * in releases, while an explicit user choice always wins.
   */
  showWorkInProgressFeatures?: boolean;
  /**
   * Debug-only opt-in: when true, the service restores every
   * template-derived gezel's about.md to its catalog default on each boot,
   * discarding local edits. Materialized on GET (defaults to `false` when
   * unset) so the Settings UI can bind directly.
   */
  resetTemplatesOnStartup?: boolean;
  /**
   * "Boring mode" — when true, the UI renders every gezel's
   * `roleBasedName` (e.g. `visual-designer`) instead of their friendly
   * name, drops "Meester" / role titles from headers, and the service
   * substitutes the same value into system prompts. Default `false`.
   */
  roleBasedNameOnlyMode?: boolean;
  /**
   * Whether poppetje avatars are shown across the UI (chat, sidebar,
   * project chips, home cards). When false, those surfaces fall back to a
   * legacy sigil or letter avatar. Default `true`.
   */
  showPoppetjes?: boolean;
  /**
   * Social mode: gezels talk in character, growth is on display, and a
   * chat opens on what is waiting. The desktop answers it resolved; a phone
   * leaves it absent when unset, which means on there.
   */
  social?: boolean;
  /** Earned notifications: `dailyCap` (absent = 3, 0 = off). */
  notifications?: NotificationsConfig;
  /**
   * When true, the chat UI calls `/api/audio/synthesize` for each
   * completed assistant message and plays the resulting WAV using the
   * speaking gezel's per-character voice. Opt-in; default `false`.
   */
  narrateAssistantReplies?: boolean;
  /**
   * Also narrate the short updates a gezel gives between tool calls, not
   * only its final reply. Default `true`; inert while narration is off.
   */
  narrateProgressUpdates?: boolean;
  /** Catalog id of the whisper.cpp model transcription runs on. */
  defaultSttModel?: string;
  /** Preferred browser microphone for prompt narration. */
  microphoneDeviceId?: string;
  /** Device-label fallback when the origin-scoped browser id changes. */
  microphoneDeviceLabel?: string;
  /**
   * Global AI engagement mode — panic-button control over proactive
   * behavior. Materialized on GET so the Settings UI can bind directly.
   * Default when unset: `proactive`.
   */
  aiEngagementMode?: 'proactive' | 'scheduled' | 'reactive' | 'off';
  /**
   * Whether the desktop app shows a persistent system-tray icon.
   * Materialized on GET (defaults to `true` when unset) so the Settings
   * UI can bind directly. Consumed by the Electron main process.
   */
  showSystemTray?: boolean;
  /**
   * Whether the packaged desktop app checks for updates on launch.
   * Materialized on GET (defaults to `true` when unset). Turning this off
   * does not disable the user-initiated tray action.
   */
  autoUpdateChecks?: boolean;
  /**
   * When the tray is enabled, whether the window's close button quits the
   * whole app (and removes the tray icon) instead of hiding to the tray.
   * Materialized on GET (defaults to `false` when unset). Windows/Linux
   * only; consumed by the Electron main process.
   */
  quitOnClose?: boolean;
  /**
   * Persisted UI theme preference (server-side mirror of the
   * renderer's `localStorage`). The embedded service binds an
   * ephemeral port every launch, so a localStorage-only pref strands
   * itself across reboots — this field is the cross-boot source of
   * truth. See `theme.ts`.
   */
  themePref?: 'system' | 'light' | 'dark';
  /**
   * Whether the terminal UI shows streamed and persisted reasoning inline.
   * Absent/true shows reasoning; false keeps only the live activity count.
   */
  cliShowThinking?: boolean;
  /**
   * Whether the terminal UI shows streamed file/artifact/note bodies inline.
   * Absent/false keeps writes compact; true enables `/show writes` behavior.
   */
  cliShowWrites?: boolean;
  /**
   * Last-used markdown/document export settings. Mirrored server-side so the
   * quick-export action survives the embedded daemon's changing loopback port.
   */
  documentExportOptions?: import('@bendyline/gezel').DocumentExportOptions;
  /**
   * Whether the document editors paint red spelling squiggles. Default
   * `true`.
   */
  inlineSpellChecking?: boolean;
  /**
   * Whether the document editors paint grammar/style squiggles. Default
   * `true`. Off with `inlineSpellChecking` also off means the proofing
   * engine never loads.
   */
  inlineGrammarChecking?: boolean;
  /**
   * Which side the primary navigation sidebar sits on. Cross-boot source
   * of truth (same ephemeral-port reasoning as `themePref`). Absent =
   * `right` (the default); only an explicit `left` opts out. See
   * `sidebar-side.ts`.
   */
  sidebarSide?: 'left' | 'right';
  /**
   * Whether the Home greeting band is collapsed to its single status
   * row. Cross-boot source of truth (same ephemeral-port reasoning as
   * `themePref`). Absent/false = expanded.
   */
  homeGreetingCollapsed?: boolean;
  /** First-run onboarding steps finished or skipped; see `GezelConfig.onboarding`. */
  onboarding?: { foldersStepDoneAt?: string; overnightStepDoneAt?: string };
  /**
   * Workshop tempo — how frenetic proactive behavior feels. Only
   * meaningful when `aiEngagementMode === 'proactive'`. Default
   * `bedrijvig` preserves pre-tempo behavior.
   */
  workshopTempo?: 'gezellig' | 'bedrijvig' | 'druk' | 'dolle-boel';
  /**
   * Night Shift configuration. See `GezelConfig.nightShift` in core
   * schemas. Window hours are local; the two power flags drive the
   * Electron shell via the power-intent poll.
   */
  nightShift?: {
    enabled?: boolean;
    window?: { startHour: number; endHour: number };
    keepAwakeWhileRunning?: boolean;
    wakeOnStart?: boolean;
    /** Stand the shift down on battery (absent = on). */
    pauseOnBattery?: boolean;
    /** One desktop notification when the morning review is ready (absent = on). */
    morningNotification?: boolean;
    /** Optional provider/model defaults used only by Night Shift work. */
    modelOverride?: {
      enabled?: boolean;
      provider?: ProviderName;
      model?: string;
    };
    /**
     * Cloud-subscription quota reserve. See `GezelConfig.nightShift`
     * in core schemas: `overall` is ON by default (absent = enabled,
     * percent 20); `perDay` is opt-in (percent 10 when enabled).
     */
    quotaReserve?: {
      overall?: { enabled?: boolean; percent?: number };
      perDay?: { enabled?: boolean; percent?: number };
    };
  };
  /**
   * Prompt-draft retention. See `GezelConfig.promptDrafts` in core schemas:
   * how many days a SENT draft (and the files it attached) is kept before the
   * daily sweep removes it. `0` keeps them forever; unsent drafts are never
   * swept whatever this says.
   */
  promptDrafts?: {
    keepSentDays?: number;
  };
  /**
   * Tool-filtering policy. See `GezelConfig.toolFilterMode` in core
   * schemas. The GET response always materializes this (defaults to
   * `small-model`) so the Settings UI can bind to it without a
   * separate "is-unset" branch.
   */
  toolFilterMode?: 'always' | 'never' | 'small-model';
  channels?: ChannelsConfig;
  /** Copilot SDK built-ins are denied by default; explicit false opts out. */
  sandboxCopilot?: boolean;
  /** Allow/deny globs for the `fetch_url` MCP tool. */
  fetchUrl?: {
    allow?: string[];
    deny?: string[];
  };
  /** Configuration for the `web_search` MCP tool. */
  webSearch?: {
    provider?: 'brave' | 'wikipedia' | 'tavily' | 'mock';
    fallbackProvider?: 'brave' | 'wikipedia' | 'tavily';
    defaultLimit?: number;
    allow?: string[];
    deny?: string[];
  };
  braveSearchApiKey?: string;
  hasBraveSearchApiKey: boolean;
  tavilyApiKey?: string;
  hasTavilyApiKey: boolean;
  /**
   * Centralized security & compliance posture (the Security & Compliance
   * panel + first-run slider). Absent → the app treats the install as the
   * `free` posture. See `SecurityPolicy` / `resolveSecurityPolicy`.
   */
  securityPolicy?: SecurityPolicy;
  /** When true (the default), the Playwright MCP toolset runs headless. */
  playwrightHeadless?: boolean;
  /** Recently-opened projects, newest-first. Deprecated — superseded by
   *  `recentTabs` which carries projects alongside gezels, documents,
   *  and tasks. The UI still reads this once on boot for migration. */
  projectMru?: { id: string; at: number }[];
  /** Last N items the user has clicked across all four entity kinds.
   *  `at` is `lastAccessedAt` (LRU eviction); `order` is the stable
   *  left-to-right tab position. */
  recentTabs?: Array<
    | { kind: 'project'; id: string; at: number; order: number }
    | { kind: 'gezel'; id: string; at: number; order: number }
    | { kind: 'document'; path: string; at: number; order: number }
    | { kind: 'task'; ref: string; at: number; order: number }
  >;
  webhookBearerToken?: string;
  hasWebhookBearerToken: boolean;
  webhookBasicAuth?: string;
  hasWebhookBasicAuth: boolean;
  /**
   * Absolute path to the Copilot SDK install under
   * `~/.gezel/system-toolsets/`, present once system bootstrap
   * has finished. The Home tab uses this to show an exact
   * `cd <path> && npx copilot login` command that reuses the
   * pinned + integrity-verified copy instead of downloading fresh.
   */
  copilotCliInstallDir?: string;
  /**
   * Per-provider parallelism caps. Caps how many concurrent
   * `sendAndWait` calls run against a given backend at once. See
   * `GezelConfig.providerConcurrency` for defaults.
   */
  providerConcurrency?: GezelConfig['providerConcurrency'];
  /** Settings for the `anthropic-cli` provider. See `GezelConfig.anthropicCli`. */
  anthropicCli?: {
    binaryPath?: string;
    manageRuntimeFiles?: boolean;
    defaultPermissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
    extraModels?: Array<{ id: string; name: string }>;
    poolSize?: number;
    workerIdleSec?: number;
  };
  /** Settings for the `codex-cli` provider. See `GezelConfig.codexCli`. */
  codexCli?: {
    binaryPath?: string;
    manageRuntimeFiles?: boolean;
    defaultPermissionMode?:
      | 'plan'
      | 'edit'
      | 'reviewed'
      | 'full'
      | 'default'
      | 'acceptEdits'
      | 'bypassPermissions';
    defaultReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    extraModels?: Array<{ id: string; name: string }>;
    extraConfigOverrides?: Record<string, string>;
  };
  /**
   * Passive filesystem/PATH presence for the `claude` binary. Config reads do
   * not execute the CLI; provider tests and actual use perform the full health
   * probe. `version` remains optional for compatibility with probed responses.
   */
  anthropicCliStatus?: {
    installed: boolean;
    path?: string;
    version?: string;
    error?: string;
  };
  /** Passive presence for the `codex` binary. Mirrors `anthropicCliStatus`. */
  codexCliStatus?: ConfigResponse['anthropicCliStatus'];
  /** Apple silicon with the gezel-apple-fm helper; availability is known once it starts. */
  appleFoundationModelsStatus?: { installed: boolean };
  /** Active image-generation provider; undefined → 'sd-cpp'. */
  imageProvider?: 'sd-cpp' | 'google-ai' | 'openai' | 'mock';
  /** Per-provider default image model id. `'sd-cpp'` names a locally installed model. */
  defaultImageModel?: {
    'sd-cpp'?: string;
    'google-ai'?: string;
    openai?: string;
  };
  /**
   * Cost-confirmation behaviour for cloud image generation. `'ask'`
   * (or undefined) prompts the user before each cloud call.
   */
  imageGenerationConfirmation?: 'always-allow' | 'ask' | { mode: 'snooze'; until: string };
  /** Active video-generation provider; undefined → 'diffusers'. */
  videoProvider?: 'diffusers' | 'mock';
  /** Default video model id (the local engine otherwise picks the first installed). */
  defaultVideoModel?: string;
  /**
   * Confirmation behaviour for video generation. `'ask'` (or undefined)
   * prompts before each generation — local included, since video is
   * long-running and GPU-monopolizing.
   */
  videoGenerationConfirmation?: 'always-allow' | 'ask' | { mode: 'snooze'; until: string };
  /** Active image-recognition engine; undefined → 'llama-cpp'. */
  recognitionProvider?: 'llama-cpp' | 'mlx' | 'mock';
  /** Catalog id of the vision model used for image recognition. */
  defaultRecognitionModel?: string;
  /** Image-recognition policy. See `GezelConfigSchema.recognition`. */
  recognition?: {
    mode?: 'auto' | 'always' | 'off';
    modes?: RecognitionMode[];
    maxImagesPerTurn?: number;
    timeoutMsPerImage?: number;
    maxDigestChars?: number;
    maxMegapixels?: number;
  };
  /** Per-model native-vision preference, keyed by catalog id. Absent → on. */
  nativeVision?: Record<string, boolean>;
  /**
   * OpenAI-compatible endpoint controls (Settings → Connected Apps).
   * `enabled` unset means ON; `servingGezelId` optionally overrides the
   * Meester/first-gezel fallback for requests naming an unknown model;
   * `supportingBehaviors` (unset = on) applies gezel's per-model
   * behavior profile to app sessions — model tuning applies regardless. See
   * `GezelConfig.openaiEndpoints` in core schemas.
   */
  openaiEndpoints?: {
    enabled?: boolean;
    servingGezelId?: string;
    supportingBehaviors?: boolean;
    /** Host an unauthenticated Ollama-compatible listener on port 11434. Default off. */
    emulateOllama?: boolean;
  };
  /**
   * Opt-in live gilde content updates (Settings → About). Default off.
   * See `GezelConfig.gildeUpdates` in core schemas.
   */
  gildeUpdates?: {
    enabled?: boolean;
  };
  /**
   * Face recognition biometric opt-in (Settings → Image recognition).
   * Default off. See `GezelConfig.faceRecognition` in core schemas.
   */
  faceRecognition?: {
    enabled?: boolean;
  };
  /**
   * The launch reference list for craftbooks started with a subject.
   * Default on. See `GezelConfig.taskReferences` in core schemas.
   */
  taskReferences?: {
    enabled?: boolean;
  };
  /**
   * The on-device relevance check. Default off. See
   * `GezelConfig.relevanceModel` in core schemas.
   */
  relevanceModel?: {
    enabled?: boolean;
    modelId?: string;
  };
  /**
   * Opt-in ambient dashboard (Settings → Ambient display). Default off.
   * See `GezelConfig.ambientDashboard` in core schemas.
   */
  ambientDashboard?: {
    enabled?: boolean;
    intervalMinutes?: number;
    resolution?: string;
    themeId?: AmbientDashboardTheme;
    displayTarget?: AmbientDashboardDisplayTarget;
    style?: string;
    keep?: number;
  };
  /** Whether the Electron shell keeps the wallpaper set to the latest
   *  dashboard. See `GezelConfig.ambientDisplay` in core schemas. */
  ambientDisplay?: {
    applyWallpaper?: boolean;
  };
  /** Remote model execution: serving this device's models to paired clients. */
  remoteServing?: {
    enabled?: boolean;
    bindAddress?: string;
    port?: number;
    priority?: 'equal' | 'below-local' | 'above-local';
    reserveLocalGb?: number;
    allowModels?: string[];
    limits?: {
      maxConcurrentPerDevice?: number;
      maxChatPerDevice?: number;
      requestsPerMinute?: number;
    };
  };
}
