import { z } from 'zod';
import { PoppetjeSchema } from '../poppetje/schema.js';
import { ChannelsConfigSchema } from './channels.js';
import { FileReviewIssueSeveritySchema, FileReviewWireSchema } from './file-review.js';
import {
  ChatMessageSchema,
  GezelDetailSchema,
  GezelGenderSchema,
  GezelSummarySchema,
  GezelTraitSchema,
  ProviderNameSchema,
} from './gezel.js';
import { GezelGrowthStateSchema } from './growth.js';
import { ChatModelTuningSchema } from './model-tuning.js';
import { NativeEngineNameSchema } from './native-engines.js';
import {
  HttpsOriginSchema,
  ProjectDetailSchema,
  ProjectGitHubSchema,
  ProjectNudgeConfigSchema,
  ProjectSchema,
  ProjectTabVisibilitySchema,
} from './project.js';
import { NpmInstallApprovalDecisionSchema, QuestionSchema } from './question.js';
import { RecognitionModeSchema } from './recognition.js';
import { ExpectedDeliverableSchema } from './session.js';
import { TaskRefSchema } from './task.js';
import { TuningProfileIdSchema } from './tuning-profile-registry.js';

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  startedAt: z.string(),
  nodeVersion: z.string().optional(),
  platform: z.string().optional(),
  /**
   * Backend the supervisor selected for the bundled llama-server on this
   * launch — `cuda`, `vulkan`, `metal`, or `cpu`. Set by the Electron
   * supervisor in `packages/app/src/supervisor/index.ts` before the
   * service starts. Undefined when launched outside a supervisor or
   * when no llama-cpp binary was bundled. The Home tab uses this to
   * label the on-device engine ("using Nvidia GPU…" / "using GPU…" /
   * "using CPU…") so the user sees what's actually running.
   */
  llamaCppBackend: z.enum(['cuda', 'vulkan', 'metal', 'cpu']).optional(),
  /**
   * What the hardware probe found, **independent of any user override**.
   * Same enum as `llamaCppBackend`. When the user has pinned
   * `config.llamaCppBackendOverride` (e.g. to `cpu` to downgrade from a
   * misbehaving CUDA install), `llamaCppBackend` reflects the pinned
   * choice while `llamaCppDetectedBackend` keeps reporting what the
   * machine actually supports. The Settings dropdown uses this to offer
   * the full set of available downgrades — without it, picking "CPU
   * only" hides the GPU options and the user can't switch back.
   *
   * Undefined when no probe ran (non-supervisor launch).
   */
  llamaCppDetectedBackend: z.enum(['cuda', 'vulkan', 'metal', 'cpu']).optional(),
  /**
   * Best-effort guess of the host's primary GPU vendor, **independent
   * of which llama-server backend was selected**. Set when the
   * supervisor's probe identified an `amd` / `nvidia` / `intel` GPU
   * via PCI sysfs (Linux) or vendor driver DLLs (Windows). The Home
   * tab uses this to label the engine more precisely — e.g. an AMD
   * Radeon user on the Vulkan backend reads "AMD GPU" instead of the
   * generic "GPU." Undefined when no vendor could be identified
   * (macOS, headless containers, exotic GPU drivers).
   */
  llamaCppDetectedVendor: z.enum(['amd', 'nvidia', 'intel']).optional(),
  /**
   * Backends whose bundled build crashed on this machine before the
   * engine ever became ready, and which backend resolution therefore
   * routed around this launch.
   *
   * Distinct from a user pin, and the distinction matters: with a pin,
   * `llamaCppBackend` differs from `llamaCppDetectedBackend` because the
   * user asked for that. Here it differs because a build we shipped does
   * not run on their hardware — which they did not ask for, cannot infer
   * from the two backend fields alone, and would otherwise only notice as
   * an unexplained drop in speed.
   *
   * Empty/undefined in the normal case. Entries clear themselves when the
   * offending binary is replaced (see `llama-quarantine.ts`).
   */
  llamaCppQuarantinedBackends: z.array(z.enum(['cuda', 'vulkan', 'metal', 'cpu'])).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Live memory pool used by local inference.
 *
 * `unified` covers Apple Silicon and other UMA devices where the accelerator
 * and CPU share system memory. `ram` is the same physical pool, but selected
 * because the active local backend is CPU-only rather than GPU-accelerated.
 */
export const MachineMemoryKindSchema = z.enum(['vram', 'unified', 'ram']);
export type MachineMemoryKind = z.infer<typeof MachineMemoryKindSchema>;

/**
 * Lightweight, authenticated machine-memory telemetry for status surfaces.
 *
 * On macOS, `gezelBytesObserved` is the combined physical footprint of gezeld
 * and same-home engine processes — the metric Activity Monitor uses, including
 * Metal-backed allocations. Other platforms retain the portable reservation
 * estimate because GPU APIs do not expose consistent per-process accounting.
 * `engineReservedBytes` stays separate: it is capacity planning, not observed
 * use.
 */
export const MachineMemoryUsageSchema = z.object({
  kind: MachineMemoryKindSchema,
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative().nullable(),
  /** Portable reservation + daemon-RSS fallback estimate. */
  gezelBytesEstimated: z.number().nonnegative(),
  /** Observed same-home process footprint when the platform exposes it. */
  gezelBytesObserved: z.number().nonnegative().nullable(),
  /** Gezel daemon + local-engine runtime overhead within the attributed total. */
  gezelInfraBytes: z.number().nonnegative(),
  /** Loaded model parameters, estimated from the installed model payloads. */
  gezelModelWeightsBytes: z.number().nonnegative(),
  /** KV cache, inference buffers, and other model working-set overhead. */
  gezelModelCacheBytes: z.number().nonnegative(),
  /** Capacity-broker reservation for local chat-model replicas. */
  engineReservedBytes: z.number().nonnegative(),
  gezelEngineProcessCount: z.number().int().nonnegative(),
  orphanedGezelEngineProcessCount: z.number().int().nonnegative(),
  otherBytes: z.number().nonnegative().nullable(),
  /** Reclaimable file cache, when the host exposes it separately from used RAM. */
  cachedBytes: z.number().nonnegative().nullable().optional(),
  freeBytes: z.number().nonnegative().nullable(),
  sampledAt: z.string(),
  source: z.enum(['device-health', 'system-memory', 'capacity-only']),
  deviceNames: z.array(z.string()),
});
export type MachineMemoryUsage = z.infer<typeof MachineMemoryUsageSchema>;

/**
 * Shareable machine profile for a user-authored bug report.
 *
 * The contract of this shape is that every field is safe to paste into a
 * PUBLIC GitHub issue: no absolute paths, no hostname, no username, no
 * session/gezel/project identifiers, no prompts, no transcripts, no log
 * tails, no credentials.
 *
 * GPU card model names ARE included. "NVIDIA GeForce RTX 4070" is a hardware
 * SKU, not an identifier — no serial, no UUID, no bus address — and it is the
 * single most triage-relevant fact for the native-engine crash class this
 * report exists to capture.
 *
 * The route parses its response through this schema on the way out, so a
 * field the handler assembles but does not declare here is stripped rather
 * than shipped. That strip is the privacy boundary, not a formality: adding
 * a field here is the deliberate act that the route's guard test watches.
 */
export const SystemDiagnosticsSchema = z.object({
  version: z.string(),
  sampledAt: z.string(),
  runtime: z.object({
    nodeVersion: z.string(),
    platform: z.string(),
    arch: z.string(),
    /** `os.release()` — kernel/build string, e.g. `24.5.0`, `10.0.26100`. */
    osRelease: z.string(),
    /** Native-binary subtree key, e.g. `darwin-arm64`. Null off shipped targets. */
    platformKey: z.string().nullable(),
  }),
  hardware: z.object({
    totalRamBytes: z.number().nonnegative(),
    gpuVramBytes: z.number().nonnegative().nullable(),
    /** Fast memory: VRAM on a discrete card, a RAM fraction otherwise. */
    usableBytes: z.number().nonnegative(),
    /**
     * What the capacity broker admits across every pool. Differs from
     * `usableBytes` on a discrete card (VRAM plus a system-RAM share), and a
     * memory bug report is unreadable without knowing which of the two a
     * refusal was measured against.
     */
    budgetBytes: z.number().nonnegative().optional(),
    source: z.enum(['darwin-unified', 'gpu-nvidia', 'gpu-vulkan', 'system-ram-fallback']),
    gpuVendor: z.enum(['amd', 'nvidia', 'intel']).optional(),
    /** Prose sentence — the same copy local-model onboarding shows. */
    description: z.string(),
    tier: z.enum(['tiny', 'small', 'medium', 'large']),
    /** Card model names as the engine reports them. No bus ids, no serials. */
    gpuDevices: z.array(
      z.object({
        name: z.string(),
        totalMiB: z.number().nonnegative(),
        computeCapability: z.string().optional(),
        driverVersion: z.string().optional(),
      }),
    ),
  }),
  engine: z.object({
    nativeRelease: z.string(),
    nativePinned: z.boolean(),
    /** Engine names resolvable by this daemon. Names only — never paths. */
    installedEngines: z.array(NativeEngineNameSchema),
    llamaCppBackend: z.enum(['cuda', 'vulkan', 'metal', 'cpu']).optional(),
    llamaCppDetectedBackend: z.enum(['cuda', 'vulkan', 'metal', 'cpu']).optional(),
    llamaCppBackendOverride: z.enum(['auto', 'cuda', 'vulkan', 'metal', 'cpu']).optional(),
    /** From `gezel-llama-build.json` beside the binary. */
    llamaCppRevision: z.string().optional(),
    llamaCppBuildBackend: z.string().optional(),
    cudaArchitectures: z.array(z.string()).optional(),
    cudaToolkit: z.string().optional(),
  }),
  models: z.object({
    defaultProvider: ProviderNameSchema,
    defaultModel: z.string().optional(),
    /**
     * Local chat models installed on this daemon. Catalog ids only, and
     * deliberately excluding Ollama: Ollama tags are user-authored
     * (`acme-corp/internal-7b:latest`) and can name an employer.
     */
    installed: z.array(
      z.object({
        id: z.string(),
        provider: z.enum(['llama-cpp', 'mlx', 'ds4']),
        parameterSize: z.string().optional(),
      }),
    ),
  }),
});
export type SystemDiagnostics = z.infer<typeof SystemDiagnosticsSchema>;

/**
 * Non-secret metadata about the user's GitHub auth state. The token itself
 * lives in the SecretStore (see `applyCredentialPatch`); this slot holds
 * the parts the UI wants to render without unmasking the token (login,
 * granted scopes, when it was acquired, whether it came from OAuth or a
 * manually-pasted PAT). Written by the OAuth device-flow completion
 * handler and cleared by sign-out.
 */
export const GitHubAuthMetaSchema = z.object({
  kind: z.enum(['pat', 'oauth']),
  login: z.string().optional(),
  name: z.string().optional(),
  avatarUrl: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  acquiredAt: z.string().optional(),
});
export type GitHubAuthMeta = z.infer<typeof GitHubAuthMetaSchema>;

/**
 * Per-scope external roots for folder externalization. When a field is
 * set, that scope's content lives outside `~/.gezel/` (e.g. on a
 * OneDrive folder so it syncs across machines and gets backed up).
 *
 * The path resolver in `paths.ts` consumes this on every per-scope
 * helper call. Some subdirectories deliberately stay local even when
 * their parent scope is externalized — see the `*LocalDir` helpers in
 * `paths.ts` for the exhaustive list. Configured via Settings → Folders;
 * mutated only by the move worker (the `PUT /api/config` route rejects
 * direct writes to this field — restart-required).
 */
export const ExternalFoldersSchema = z.object({
  documents: z.string().min(1).optional(),
  gezels: z.string().min(1).optional(),
  projects: z.string().min(1).optional(),
});
export type ExternalFolders = z.infer<typeof ExternalFoldersSchema>;

/**
 * Centralized security & compliance policy. The `level` is the
 * user-facing slider position; the five booleans are the authoritative
 * capability set the rest of the system enforces. A preset level
 * (`super-lockdown` / `lockdown` / `free`) keeps the booleans in lockstep
 * with {@link SECURITY_PRESETS}; `custom` is set automatically when the
 * user flips an individual toggle off-preset.
 *
 * Resolution and the preset table live in
 * `packages/core/src/security/policy.ts` — when this field is **absent**,
 * `resolveSecurityPolicy` returns the fail-safe `lockdown` posture. The
 * first-run migration persists `free` for an existing configured install
 * that predates this field, and `lockdown` for a genuinely new install.
 */
export const SecurityPolicySchema = z.object({
  level: z.enum(['super-lockdown', 'lockdown', 'free', 'custom']),
  /** Gate model Git/GitHub tools and script-declared shared-document writes. Project workspace writes use `project.allowGezelWrites`; artifacts and builtin document tools remain available. */
  allowFileEdits: z.boolean(),
  /** Expose non-local (cloud) chat providers — Copilot, OpenAI, Anthropic, the CLIs. When false, only local engines are offered. */
  allowExternalChat: z.boolean(),
  /** Allow model-initiated outbound services — web/Wikipedia search, URL fetch, toolset downloads. User-initiated HF model pulls are exempt. */
  allowExternalServices: z.boolean(),
  /** Allow model-initiated script execution — `script.run`, the code-execution tools, and craftbook script steps. App-driven npm/node/CLI/MCP runs are exempt. */
  allowScriptExecution: z.boolean(),
  /** Allow the desktop app's background network — currently the Electron auto-update check. */
  allowAppNetwork: z.boolean(),
});
export type SecurityPolicy = z.infer<typeof SecurityPolicySchema>;

/**
 * Admission policy for sustained native accelerator workloads.
 *
 * The policy is intentionally vendor-neutral. Runtime probes may obtain richer
 * telemetry from NVIDIA SMI, AMD SMI, ROCm SMI, or a future platform adapter,
 * but the decision surface stays the same for CUDA, Vulkan, ROCm, and Metal.
 * Missing telemetry is allowed by default so unsupported consumer devices do
 * not lose all on-device functionality; safety-sensitive unattended runs can
 * opt into `onTelemetryFailure: 'block'`.
 */
export const DeviceSafetyPolicySchema = z.object({
  mode: z.enum(['off', 'observe', 'guard']).optional(),
  maxStartTemperatureC: z.number().min(40).max(110).optional(),
  resumeTemperatureC: z.number().min(35).max(105).optional(),
  minThermalMarginC: z.number().min(0).max(40).optional(),
  pollIntervalMs: z.number().int().min(500).max(60_000).optional(),
  maxWaitMs: z.number().int().min(0).max(3_600_000).optional(),
  consecutiveHealthySamples: z.number().int().min(1).max(20).optional(),
  onTelemetryFailure: z.enum(['allow', 'block']).optional(),
});
export type DeviceSafetyPolicyConfig = z.infer<typeof DeviceSafetyPolicySchema>;

/**
 * Last-used document export settings.
 *
 * The UI keeps a localStorage cache for immediate toolbar rendering, but the
 * durable copy belongs in config.json because the embedded daemon may bind a
 * different loopback port on each launch (and localStorage is origin-scoped).
 */
export const DocumentExportOptionsSchema = z.object({
  format: z.enum(['docx', 'pdf', 'pptx', 'md', 'html']),
  themeId: z.string().min(1),
  transformStyle: z.string().min(1),
  pageSize: z.enum(['letter', 'a4']),
  htmlStyle: z.enum(['rendered', 'plain']),
  htmlBundle: z.enum(['single', 'zip']),
});
export type DocumentExportOptions = z.infer<typeof DocumentExportOptionsSchema>;

export const GezelConfigSchema = z.object({
  /** Default LLM provider. Missing → 'copilot' for backwards compatibility. */
  provider: ProviderNameSchema.optional(),
  /**
   * Idle timeout (ms) before the supervisor stops a running local LLM engine
   * (llama-cpp, mlx) to free VRAM. Applied to both `NativeEngineSupervisor`
   * instances; the freeze stage fires at half this value when set. Default
   * 30 min — matches `OLLAMA_TURN_TIMEOUT_MS`, the accepted ceiling for a
   * single local-engine turn. Users running on 27B+ models who legitimately
   * generate for longer (e.g. one-shot large-artifact Builder turns) can
   * raise the cap; users on tight memory who prefer aggressive reclaim can
   * drop it. Floor is 60s — anything lower starts thrashing the engine.
   */
  localEngineIdleTimeoutMs: z.number().int().min(60_000).optional(),
  /**
   * Cross-engine accelerator safety policy. `observe` records concerning
   * telemetry without delaying work; `guard` pauses admission until the device
   * cools and throttle signals clear. Defaults are resolved by the native
   * device-health module so the service and eval harness use identical rules.
   */
  deviceSafety: DeviceSafetyPolicySchema.optional(),
  /**
   * "Boring mode": when true, every UI surface, system prompt, and chat
   * event renders a gezel's `roleBasedName` (e.g. `visual-designer`)
   * instead of their friendly name (e.g. "Mira"). Titles like "Meester"
   * are dropped. Defaults to `false`.
   */
  roleBasedNameOnlyMode: z.boolean().optional(),
  /**
   * Whether poppetje avatars (the parametric character figures) are shown
   * across the UI — chat bubbles, the sidebar, project chips, home cards.
   * When false, those surfaces fall back to a legacy sigil or letter
   * avatar instead. The gezel-detail poppetje editor is unaffected.
   * Defaults to `true`.
   */
  showPoppetjes: z.boolean().optional(),
  /**
   * When true, the chat UI calls `/api/audio/synthesize` for each
   * completed assistant message and plays the resulting WAV using the
   * speaking gezel's per-character voice (see `GezelFrontmatter.voice`).
   * Defaults to `false` — narration is opt-in to avoid surprising users
   * with audio output the first time they open a chat.
   */
  narrateAssistantReplies: z.boolean().optional(),
  githubToken: z.string().optional(),
  /** Non-secret companion to `githubToken`. See {@link GitHubAuthMetaSchema}. */
  githubAuth: GitHubAuthMetaSchema.optional(),
  openaiApiKey: z.string().optional(),
  openaiOrganization: z.string().optional(),
  /** Anthropic API key for the `anthropic` provider. SecretStore-routed. */
  anthropicApiKey: z.string().optional(),
  /**
   * Google AI Studio API key, used by the `google-ai` image provider
   * (Nano Banana 2 / `gemini-3.1-flash-image-preview`). SecretStore-routed.
   */
  googleAiApiKey: z.string().optional(),
  /**
   * Image-generation provider selection. `'sd-cpp'` (default) uses the
   * local stable-diffusion.cpp sidecar; `'google-ai'` and `'openai'`
   * route to cloud APIs. `'mock'` is for tests and headless flows.
   */
  imageProvider: z.enum(['sd-cpp', 'google-ai', 'openai', 'mock']).optional(),
  /**
   * Default model id per cloud image provider. sd-cpp's default comes
   * from the on-disk install layout, not config, so it isn't here.
   */
  defaultImageModel: z
    .object({
      'google-ai': z.string().optional(),
      openai: z.string().optional(),
    })
    .optional(),
  /**
   * Cost confirmation behaviour for cloud image generation. `'ask'`
   * (default) prompts the user before each cloud call; `'always-allow'`
   * skips the prompt; `'snooze'` (future) silences for a window. The
   * gate is only consulted when the active provider is cloud — local
   * generations never prompt.
   */
  imageGenerationConfirmation: z
    .union([
      z.literal('always-allow'),
      z.literal('ask'),
      z.object({
        mode: z.literal('snooze'),
        until: z.string(),
      }),
    ])
    .optional(),
  /**
   * GPU memory tenancy for the local engines (llama-cpp, sd-cpp).
   *
   *   - `'auto'` (default) — pick `'coexist'` on Apple Silicon with
   *     ≥24 GB unified memory, `'swap'` everywhere else.
   *   - `'coexist'` — both engines stay loaded together. Right when
   *     the user has plenty of VRAM/unified memory.
   *   - `'swap'` — image generation evicts the LLM (and vice-versa)
   *     so the active engine has the GPU to itself. The evicted
   *     engine lazy-restarts on its next request, so the user sees
   *     a small one-time latency only on the turn after a swap.
   *
   * Only consulted when the active LLM provider is local (llama-cpp
   * / mlx / ollama) AND the active image provider is sd-cpp; cloud
   * combinations bypass the arbiter entirely.
   */
  gpuMemoryPolicy: z.enum(['auto', 'coexist', 'swap']).optional(),
  /**
   * Video-generation provider selection. `'diffusers'` (default) uses
   * the local bundled diffusers/PyTorch sidecar (LTX / WAN); `'mock'`
   * is for tests and headless flows. Cloud video providers are a future
   * addition — the enum is open for them.
   */
  videoProvider: z.enum(['diffusers', 'mock']).optional(),
  /**
   * Default video model id. The local engine's default otherwise comes
   * from the on-disk install layout (first installed model).
   */
  defaultVideoModel: z.string().optional(),
  /**
   * Cost/duration confirmation behaviour for video generation. `'ask'`
   * (default) prompts before each generation; `'always-allow'` skips the
   * prompt; `'snooze'` silences for a window. Local generations consult
   * this too because video is long-running and GPU-monopolizing —
   * unlike local image gen, an unprompted multi-minute job that evicts
   * the chat model is a surprise worth gating.
   */
  videoGenerationConfirmation: z
    .union([
      z.literal('always-allow'),
      z.literal('ask'),
      z.object({
        mode: z.literal('snooze'),
        until: z.string(),
      }),
    ])
    .optional(),
  /**
   * Image-recognition engine selection. `'llama-cpp'` (default) runs a small
   * local vision model under its own supervisor; `'mock'` is for tests and
   * headless flows. Distinct from `imageProvider`, which *generates* images.
   */
  recognitionProvider: z.enum(['llama-cpp', 'mlx', 'mock']).optional(),
  /** Catalog id of the vision model. Falls back to the recommended entry. */
  defaultRecognitionModel: z.string().optional(),
  recognition: z
    .object({
      /**
       *   - `'auto'` (default) — describe locally only when the chat model
       *     genuinely can't see images.
       *   - `'always'` — describe locally even for vision-capable models.
       *     The cost lever: a local 4B pass is cheaper than shipping pixels
       *     to a frontier model, and no bytes leave the machine.
       *   - `'off'` — never run recognition.
       */
      mode: z.enum(['auto', 'always', 'off']).optional(),
      modes: z.array(RecognitionModeSchema).optional(),
      /**
       * Beyond this, the remaining images get static metadata only. A chat
       * turn is not a batch job — bulk work belongs in the MCP tool or the
       * idle-gated indexer.
       */
      maxImagesPerTurn: z.number().int().min(1).max(16).optional(),
      timeoutMsPerImage: z.number().int().min(5_000).optional(),
      maxDigestChars: z.number().int().min(200).optional(),
      /**
       * Images above this many megapixels skip the model. llama.cpp's mtmd
       * tiles large inputs into a token explosion, and there is no image
       * resizer in the dependency tree to downscale first.
       */
      maxMegapixels: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Per-model opt-in for native vision (`--mmproj` at launch), keyed by
   * catalog id. Absent means off.
   *
   * Off by default because loading a projector makes llama-server 501 on slot
   * save/restore, which latches disk-KV prefix caching off for that model
   * process-wide — costing cached session resume on *every* text turn, image
   * or not. Users who want image fidelity more than resume latency opt in per
   * model; everyone else gets the recognition pre-step, which is uniform
   * across engines including ds4.
   */
  nativeVision: z.record(z.string(), z.boolean()).optional(),
  /** Optional bearer token used by the webhook channel. Never stored in config.json —
   *  routed to SecretStore by the config PUT handler. */
  webhookBearerToken: z.string().optional(),
  /** Optional "user:pass" used by the webhook channel (base64-encoded at send
   *  time). Never stored in config.json — routed to SecretStore. */
  webhookBasicAuth: z.string().optional(),
  /** Brave Search API key for the `web_search` MCP tool. SecretStore-routed. */
  braveSearchApiKey: z.string().optional(),
  /** Tavily API key for the `web_search` MCP tool (stretch). SecretStore-routed. */
  tavilyApiKey: z.string().optional(),
  /**
   * Ollama server base URL. Defaults to http://localhost:11434 when unset.
   * No credential — Ollama is unauthenticated.
   */
  ollamaBaseUrl: z.string().optional(),
  /**
   * When true (the default), Gezel will try to launch a locally-installed
   * Ollama app if a connection probe fails. Up to three launch attempts.
   * Set to false to keep Ollama lifecycle entirely under the user's control.
   */
  autoStartOllama: z.boolean().optional(),
  /** Default model ID per provider. Optional; providers fall back to their own defaults. */
  defaultModel: z
    .object({
      copilot: z.string().optional(),
      openai: z.string().optional(),
      anthropic: z.string().optional(),
      'anthropic-cli': z.string().optional(),
      'codex-cli': z.string().optional(),
      ollama: z.string().optional(),
      'llama-cpp': z.string().optional(),
      mlx: z.string().optional(),
      ds4: z.string().optional(),
      // A namespaced `remote:<remoteId>/<model>` default. Rarely set — remote
      // models are normally pinned per-gezel — but present so the per-provider
      // default lookup stays total over ProviderName.
      remote: z.string().optional(),
    })
    .optional(),
  /** Default reasoning effort per provider, for models that support it. */
  defaultReasoningEffort: z
    .object({
      copilot: z.string().optional(),
      openai: z.string().optional(),
      anthropic: z.string().optional(),
      'anthropic-cli': z.string().optional(),
      'codex-cli': z.string().optional(),
      ollama: z.string().optional(),
      'llama-cpp': z.string().optional(),
      mlx: z.string().optional(),
      ds4: z.string().optional(),
      remote: z.string().optional(),
    })
    .optional(),
  /**
   * Install-wide per-model tuning override. Keyed by catalog model id
   * (e.g. `gemma4-26b`, `qwen3.6`). When a session resolves its model
   * id, this map is consulted as a layer BETWEEN the per-gezel
   * frontmatter override and the catalog manifest's recommended
   * defaults. Effective resolution order, highest wins:
   *
   *   1. gezel frontmatter `tuning`
   *   2. `config.modelTuning[modelId]`  ← this field
   *   3. catalog manifest `tuning`
   *   4. provider built-in default
   *
   * Useful when the user wants a global "always run Gemma 4 with
   * temperature 0.7" without editing each gezel individually. Sparse
   * — only set fields override; unset fields fall through to the
   * catalog default.
   */
  modelTuning: z.record(z.string(), ChatModelTuningSchema).optional(),
  /**
   * Persisted fitness records from the per-model competence trial
   * (proeve), keyed `"<provider>:<modelId>"`. Deliberately loose
   * (`z.unknown()` values): `Store.readConfig` fails the WHOLE config
   * when any field fails to parse, so a hand-mangled or
   * future-versioned record must never brick the install. The strict
   * shape (`ModelFitnessRecordSchema` in schemas/model-fitness.ts) is
   * enforced per entry by the service's ModelFitnessManager, which
   * skips invalid entries on read.
   */
  modelFitness: z.record(z.string(), z.unknown()).optional(),
  /**
   * Remote model execution — serving THIS device's models to paired client
   * devices over the LAN. OFF by default; enabling it binds a second,
   * routable listener (the loopback listener is untouched). See
   * `packages/service/src/remotes/`. The pairing/identity trust and per-device
   * tokens are independent of this toggle — this only controls whether the
   * inference-only `/v1/remote/*` surface is reachable off-box.
   */
  remoteServing: z
    .object({
      enabled: z.boolean().default(false),
      /** Interface to bind the LAN listener to. Default `0.0.0.0`. */
      bindAddress: z.string().optional(),
      /** Port for the LAN listener. Default 6229 (loopback stays on 6228). */
      port: z.number().int().positive().optional(),
      /**
       * How remote turns compete with this device's own local work in the
       * provider queue. `equal` (default) → interactive lane like local;
       * `below-local` → background lane so local always drains first;
       * `above-local` → remote favored.
       */
      priority: z.enum(['equal', 'below-local', 'above-local']).optional(),
      /** GB of model budget reserved for local work; remote loads can't evict into it. */
      reserveLocalGb: z.number().nonnegative().optional(),
      /** Catalog/model ids remote clients may use. Omit → all installed. */
      allowModels: z.array(z.string()).optional(),
      /** Per-tenant resource caps. */
      limits: z
        .object({
          maxConcurrentPerDevice: z.number().int().positive().optional(),
          maxChatPerDevice: z.number().int().positive().optional(),
          requestsPerMinute: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * Boekwachter review pass (per-file cliffs notes, issues, 1-10 health).
   * ON by default when a local enrich model is configured — same best-effort,
   * local-only stance as enrichment summaries; reviews queue strictly behind
   * summaries so search coverage never slows. `GEZEL_FILE_REVIEWS=0` is the
   * env off-switch (used by index-bench control arms).
   */
  fileReviews: z
    .object({
      enabled: z.boolean().default(true),
      /** classify.ts file kinds to skip, e.g. ['config']. */
      disabledKinds: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Install-wide per-model **preset** selection. Keyed by catalog model
   * id (same key space as {@link modelTuning}); value is a tuning
   * profile id (e.g. `thinking-coding`, `creative`). When a session
   * resolves its model id, this map supplies a default profile the
   * resolver walks against the model's `tuning.profiles` map.
   *
   * Precedence between presets:
   *   1. gezel frontmatter `tuningProfile`  ← per-gezel pick wins
   *   2. `config.modelTuningProfile[modelId]`  ← this field
   *
   * The resolved profile then layers BETWEEN `installDefault` (the
   * explicit-value override above) and the catalog base — same slot as
   * the per-gezel profile, so a custom override at the install level
   * still wins over the preset's sampling values. Unknown / unmatched
   * profile ids are silently ignored (forward-compat with future
   * canonical ids).
   */
  modelTuningProfile: z.record(z.string(), z.string()).optional(),
  /**
   * The gezel currently designated as "meester" — the team concierge.
   * See packages/service/src/meester/prompt.ts.
   */
  meesterGezelId: z.string().optional(),
  /**
   * The gezel currently designated as "klerk" — the workshop scribe.
   * Handles utility text generation (about.md drafts, rewrites, session
   * summaries, memory consolidation) so users can route grunt work to
   * a different model than their conversational gezels. See
   * packages/service/src/klerk/prompt.ts.
   */
  klerkGezelId: z.string().optional(),
  /**
   * The gezel currently designated as "boekwachter" — the workshop's
   * index-keeper. This is the preferred worker when a project includes
   * them in its `gezelIds` roster. A project without any Boekwachter on
   * that roster keeps structural indexing, but opts out of AI summaries,
   * reviews, rollups, and digests.
   */
  boekwachterGezelId: z.string().optional(),
  /**
   * The gezel currently designated as "keurmeester" — the quality
   * inspector summoned when a small/local model's recovery machinery
   * gives up. Runs on a frontier provider (see `config.keurmeester`).
   * See packages/service/src/keurmeester/prompt.ts.
   */
  keurmeesterGezelId: z.string().optional(),
  /**
   * The public OpenAI-compatible facade (`/v1/*` + `/ollama/v1/*`) that
   * third-party apps (VS Code, browser tools) call. Managed from
   * Settings → Connected Apps.
   *
   *   - `enabled` — master switch. `false` gates the inference routes
   *     AND new app registrations with `403 openai_endpoints_disabled`;
   *     already-issued tokens stay stored but are refused while off.
   *     Unset/`true` → on (per-app consent remains the primary gate).
   *   - `servingGezelId` — optional override for the fallback gezel who
   *     answers when a caller's `model` string is missing from gezel's
   *     namespace (e.g. a hardcoded "gpt-4o"). Resolved like a
   *     `gezel:<id>` target: persona + provider/model tuning apply.
   *     Unset or stale → the Meester (then the first available gezel),
   *     so public inference always has a gezel-backed fallback.
   *   - `supportingBehaviors` — whether `/v1` sessions get the resolved
   *     per-model behavior PROFILE (ramble detection, preamble folding,
   *     transcript shaping, family-specific fixes). Unset/`true` → on.
   *     `false` → plain serving: persona + model + TUNING (sampling,
   *     thinking/instruct folds) still apply — tuning is "what the
   *     model is", not a behavior — but no runtime interventions.
   *   - `emulateOllama` — host an UNAUTHENTICATED Ollama-compatible
   *     listener on loopback port 11434 so apps that auto-discover
   *     Ollama find gezel. Default OFF and deliberately opt-in: the
   *     Ollama ecosystem's contract is no-auth plain HTTP, so any
   *     local process can run inference through it without the
   *     Connected Apps consent flow. The daemon refuses to bind when
   *     something (usually real Ollama) already owns the port.
   */
  openaiEndpoints: z
    .object({
      enabled: z.boolean().optional(),
      servingGezelId: z.string().optional(),
      supportingBehaviors: z.boolean().optional(),
      emulateOllama: z.boolean().optional(),
    })
    .optional(),
  /**
   * Ollama-only: override the `num_ctx` sent on every /api/chat request.
   * Unset → service picks a parameter-size-aware default (8192 baseline).
   */
  ollamaNumCtx: z.number().int().positive().optional(),
  /**
   * Ollama-only: how many seconds of mid-stream silence are allowed
   * before the watchdog aborts the turn. Default 300s. Bump higher
   * (e.g. 600+) for reasoning models that produce long silent
   * thinking phases between visible tokens, or for big models on
   * slow / shared GPU hardware. Lower it if you'd rather catch
   * stalls faster on a healthy setup. Pre-first-byte cap is a
   * separate knob (see {@link ollamaPreFirstByteIdleSec}).
   */
  ollamaStreamingIdleSec: z.number().int().positive().optional(),
  /**
   * Ollama-only: how many seconds the model is allowed to spend on
   * cold-start load + prompt prefill before producing its first
   * visible token. Default 300s. Bump higher (e.g. 600+) for big
   * models with heavy system prompts or reasoning models that do
   * long silent thinking phases before any output. The "Ollama
   * probe" reported "model still loaded" but the abort fired at
   * 180s mid-prefill on a 30B+ qwen3 model — that's why the
   * default is 5 min now. Lower for fast-startup models on dedicated
   * hardware if you want the watchdog tighter.
   */
  ollamaPreFirstByteIdleSec: z.number().int().positive().optional(),
  /**
   * Ollama-only: total wall-clock cap for one chat turn, in
   * minutes. Counts from the moment the queue slot is acquired
   * until the model produces its final reply (or the cap fires).
   * Default 30 min. Distinct from the two idle caps above —
   * those reset on activity; this one ticks down regardless.
   * Bump higher for genuinely long-running tool-heavy turns; the
   * idle caps will still catch real stalls inside the bigger
   * window.
   */
  ollamaTurnTimeoutMin: z.number().int().positive().optional(),
  /**
   * Ollama-only: max tokens the model is allowed to generate per turn.
   * Maps to Ollama's `options.num_predict`. Ollama's own default (128)
   * is too small for reasoning + chat — small local models emit
   * `done` with no visible content because the first 128 tokens were
   * entirely silent thinking. Gezel default is 4096; bump higher if
   * you're seeing empty bubbles with `done_reason: "length"` in the
   * logs.
   */
  ollamaNumPredict: z.number().int().positive().optional(),
  /**
   * Ollama-only: whether to enable the model's reasoning/thinking
   * mode. Maps to Ollama's top-level `think` flag (0.4+). When unset,
   * the service auto-decides based on model family — reasoning models
   * (qwq, deepseek-r1, qwen3-thinking, gpt-oss) default to `false` so
   * their chain-of-thought doesn't silently consume the `num_predict`
   * budget. Force `true` to capture thinking as streamed deltas, or
   * `false` to skip reasoning entirely. On the request side
   * (`UpdateConfigRequest`) the field also accepts `null` as a
   * reset-to-auto signal; the store strips it before persistence so
   * the on-disk / read-side shape stays `true | false | undefined`.
   */
  ollamaThink: z.boolean().optional(),
  /**
   * llama-cpp-only (Phase 1 MVP): absolute path to a single GGUF file
   * that the supervised `llama-server` will load. Until Phase 2 lands a
   * proper model catalog, this is the user's one knob for picking a
   * model. Point it at a file on disk (Hugging Face download, custom
   * quant, whatever) and the supervisor passes it to `llama-server
   * --model`. Environment override: `GEZEL_LLAMA_CPP_MODEL`.
   */
  llamaCppModelPath: z.string().optional(),
  /**
   * llama-cpp-only: base URL of an already-running `llama-server` the
   * service should talk to instead of supervising its own child
   * process. Useful in dev when iterating on llama.cpp itself
   * (`llama-server --model ... --port 18080`) or when the user points
   * Gezel at a shared LAN instance. When unset, the Electron
   * supervisor spawns the bundled binary on an ephemeral port.
   */
  llamaCppBaseUrl: z.string().optional(),
  /**
   * llama-cpp-only: context window (tokens) the supervised llama-server
   * boots with. Passed as `--ctx-size` at launch. Also drives the
   * pre-turn context-pressure check in `ChatManager` — when the
   * estimated prompt approaches this limit, older messages get
   * collapsed into a synthetic compaction-summary bubble (same path
   * as Ollama). Unset → default of 16384, which is a generous working
   * window for 2–8B local models without burning VRAM on an unused
   * 128k allocation. Raise for long coding sessions on capable
   * hardware; lower on memory-constrained machines.
   */
  llamaCppNumCtx: z.number().int().positive().optional(),
  /**
   * ds4-only: base URL of an already-running `ds4-server` to talk to
   * instead of supervising the bundled binary. Mirrors `llamaCppBaseUrl`
   * — the testable dev path (`ds4-server --model … --port 8000`). Env
   * override: `GEZEL_DS4_SERVER_URL`.
   */
  ds4BaseUrl: z.string().optional(),
  /**
   * ds4-only: explicit GGUF path passed to `ds4-server --model`. Only
   * antirez's DeepSeek-V4 GGUFs load (ds4 is not a general GGUF runner).
   * Env override: `GEZEL_DS4_MODEL`.
   */
  ds4ModelPath: z.string().optional(),
  /**
   * ds4-only: context window (tokens) `ds4-server` boots with (`--ctx`).
   * DeepSeek V4 supports up to 1M; the server offloads cold KV to SSD via
   * its own `--kv-disk-dir`. Unset → 128K on ordinary workstations and
   * 256K only on machines with at least 192 GiB of memory.
   */
  ds4NumCtx: z.number().int().positive().optional(),
  /**
   * ds4-only: stream MoE expert weights from SSD instead of full residency
   * (`--ssd-streaming`). Streaming is the safe default. `false` is honored
   * only when the selected GGUF plus a fixed runtime/OS reserve fits a local
   * unified-memory target; otherwise the service keeps streaming enabled.
   */
  ds4SsdStreaming: z.boolean().optional(),
  /**
   * ds4-only: routed-expert SSD-streaming cache budget in GiB
   * (`--ssd-streaming-cache-experts NGB`). The working-set ceiling that
   * decouples ds4's resident footprint from the on-disk weight size — and
   * what the capacity broker bills for this engine. Unset → the selected
   * model's catalog recommendation. Manual values are clamped to preserve
   * runtime/OS headroom.
   */
  ds4CacheExpertsGb: z.number().positive().optional(),
  /**
   * llama-cpp-only: mid-stream idle cap (seconds). After this many
   * seconds with no SSE chunk arriving, the in-flight chat completion
   * is aborted with an idle-stall error so the runtime publishes
   * `done`, the engine pill clears, and the user can retry. Default
   * 300 (5 min) is set inside the provider; raise for legitimately
   * slow models that need more headroom mid-generation, lower if
   * you'd rather cut losses sooner. Mirrors `ollamaStreamingIdleSec`.
   */
  llamaCppStreamingIdleSec: z.number().int().positive().optional(),
  /**
   * llama-cpp-only: pre-first-byte idle cap (seconds). Covers cold
   * model load, prompt prefill, and the first-token wait. Separate
   * from `llamaCppStreamingIdleSec` so a slow first-chunk on a 30B-
   * class model doesn't trip the streaming-idle watchdog meant for
   * mid-generation silence. Default 300s.
   */
  llamaCppPreFirstByteIdleSec: z.number().int().positive().optional(),
  /**
   * llama-cpp-only: force a specific backend variant instead of letting
   * the Electron supervisor auto-detect (CUDA → Vulkan → CPU on
   * Windows/Linux, Metal-only on Mac). `'auto'` (or unset) keeps the
   * auto-detect behavior. Useful for:
   *   - Falling back to Vulkan/CPU on a CUDA-capable machine when the
   *     CUDA bundle has a problem (driver mismatch, missing transitive
   *     DLL, OOM with full layer offload).
   *   - Reproducing user-reported bugs across backends without
   *     uninstalling drivers.
   *   - Pinning a slower-but-safer backend for benchmarks.
   *
   * Read by the supervisor at app boot — changes take effect on next
   * launch (the supervisor decides which bundled binary to point at
   * before the service starts). The Settings UI surfaces this with a
   * "restart required" hint.
   */
  llamaCppBackendOverride: z.enum(['auto', 'cuda', 'vulkan', 'metal', 'cpu']).optional(),
  /**
   * When the on-device engine binary (llama-server) is missing, may the
   * daemon download it on demand from the pinned native release? Default
   * (unset) = enabled. Set `false` for air-gapped / bandwidth-constrained
   * installs — on-device chat then surfaces an actionable "install the
   * engine" error instead of auto-downloading. Explicit downloads via
   * Settings / `POST /api/engines/binaries/:engine/ensure` always work.
   */
  autoDownloadEngines: z.boolean().optional(),
  /**
   * How strictly a downloaded engine binary's code signature is enforced:
   *   - `require` (default) — reject anything not validly signed on
   *     Windows/macOS. Linux remains checksum-anchored.
   *   - `prefer` — verify if signed, allow explicitly unsigned upstream
   *     binaries with a warning.
   *   - `off` — skip the check (bundled archive sha256 still gates).
   * Unset = `require`.
   */
  engineSignaturePolicy: z.enum(['off', 'prefer', 'require']).optional(),
  /**
   * KV-cache quantization for llama-server. Halves cache memory at a
   * minor accuracy cost — frees up RAM for longer contexts and more
   * concurrent slots. Default `q8_0` is the well-trodden balance:
   * essentially indistinguishable quality, ~50% memory savings vs.
   * f16. Operators on small models with sensitive attention can opt
   * out via `f16`; q4_0 is for the truly memory-starved.
   *
   * Maps to llama-server's `--cache-type-k` / `--cache-type-v` flags;
   * we always set both to the same value (asymmetric KV quant rarely
   * helps and complicates pressure math).
   */
  llamaCppKvCacheType: z.enum(['f16', 'q8_0', 'q4_0']).optional(),
  /**
   * Pin llama-server's weights into RAM via `--mlock`. Prevents the
   * OS from paging weight pages out under memory pressure — turns
   * "model load took 8s" into "first token in 200ms" after a long
   * idle. Cost: pinned pages can't back other apps when the system
   * is genuinely out of memory.
   *
   * Default `false` (mlock off). Power users with abundant RAM and a
   * single dedicated chat workflow can flip this on; we don't
   * auto-detect because the trade-off is workload-specific.
   */
  llamaCppMlock: z.boolean().optional(),
  /**
   * Flash Attention mode for llama-server (`--flash-attn on|off|auto`).
   * On modern Metal/CUDA/Vulkan builds FA is meaningfully faster
   * (especially at long contexts) and is effectively required for the
   * fast path under quantized KV cache (our `q8_0` default). b9843's
   * own default is `auto`.
   *
   * Accepts the tri-state string (`'on' | 'off' | 'auto'`) or a legacy
   * boolean for back-compat: `true` → force on, `false`/unset → leave
   * to the server default (`auto`). The launcher additionally forces
   * `on` when the KV cache is quantized and this is unset — see
   * `buildLlamaCppEngineArgs`.
   */
  llamaCppFlashAttn: z.union([z.boolean(), z.enum(['on', 'off', 'auto'])]).optional(),
  /**
   * Override llama-server's GPU-layer offload (`--n-gpu-layers`). b9843
   * defaults to `auto` (with `--fit on`), which right-sizes the layer
   * count to device memory by DROPPING whole layers to CPU. Set an
   * explicit count to pin it, or `-1` for `all` (force full offload —
   * pair with `llamaCppCpuMoe`/`llamaCppNCpuMoe` to keep a big MoE's
   * experts in system RAM while every attention/dense layer stays on
   * the GPU). Unset = inherit b9843's `auto`/`--fit`.
   */
  llamaCppNGpuLayers: z.number().int().min(-1).optional(),
  /**
   * Keep ALL Mixture-of-Experts weights in system RAM (`--cpu-moe`),
   * streaming experts from RAM while attention/dense/shared layers run
   * on the GPU. The lever for running a big MoE (qwen3.6-35b-a3b,
   * gpt-oss-120b, …) on a constrained-VRAM discrete GPU. Pair with
   * `llamaCppNGpuLayers: -1`. For a partial split use `llamaCppNCpuMoe`
   * instead. Default unset (off). Phase v2's offload planner sets this
   * automatically when a model won't otherwise fit VRAM.
   */
  llamaCppCpuMoe: z.boolean().optional(),
  /**
   * Keep the MoE weights of only the FIRST N layers in system RAM
   * (`--n-cpu-moe N`) — the granular form of `llamaCppCpuMoe`. Spills
   * just enough expert layers to fit VRAM, keeping the rest (and all
   * attention) on the GPU. Ignored when `llamaCppCpuMoe` is set (all
   * experts already on CPU). Default unset.
   */
  llamaCppNCpuMoe: z.number().int().min(0).optional(),
  /**
   * Minimum chunk size for cross-request prompt-prefix KV reuse via
   * KV-shifting (`--cache-reuse N`), on top of the always-on prompt
   * cache. Big prefill savings when a new request shares a long prefix
   * (stable system prompt + history) with a cached one. Default when
   * unset: `256` (auto-on — near-zero risk, meaningful multi-turn
   * speedup). Set `0` to disable.
   *
   * The engine may still refuse it: `--cache-reuse` needs a context that
   * can KV-shift, which rules out a windowed SWA cache (Gemma — see
   * `llamaCppSwaFull`) and hybrid-attention models (Qwen 3.5/3.6) outright.
   * Note this is only PARTIAL, position-shifted reuse; exact-prefix reuse
   * via `cache_prompt` is always on and already does the heavy lifting
   * (measured 2026-07-31: median prompt-eval 593 tokens against 38–52K
   * token prompts on gemma4-26b-q4).
   */
  llamaCppCacheReuse: z.number().int().min(0).optional(),
  /**
   * Use a full-size SWA (sliding-window-attention) KV cache
   * (`--swa-full`) for SWA models (Gemma family). Trades memory for
   * fewer recomputes at long context. Default unset (off — llama-server
   * uses the memory-efficient windowed cache).
   *
   * Also the PRECONDITION for `llamaCppCacheReuse` on these models:
   * llama-server tests whether the loaded context can KV-shift and, for a
   * windowed SWA cache, it cannot — so it logs `cache_reuse is not
   * supported by this context, it will be disabled` and drops the flag no
   * matter what `cacheReuse` is set to. Measured 2026-07-31 on
   * gemma4-e4b-q4 at 64K context: windowed = 8,772 MB RSS + cache_reuse
   * refused; `--swa-full` = 11,415 MB RSS (+30%) + cache_reuse accepted.
   * Qwen 3.5/3.6 cannot KV-shift at all (hybrid attention) and this flag
   * does not help them.
   */
  llamaCppSwaFull: z.boolean().optional(),
  /**
   * Override llama-server's generation thread count (`--threads`).
   * Default unset (server picks, usually physical core count). Mostly
   * relevant on the CPU backend / big-NUMA boxes.
   */
  llamaCppThreads: z.number().int().positive().optional(),
  /**
   * Override llama-server's logical batch size (`--batch-size`, prompt
   * processing). Larger can speed prompt ingest on big GPUs at a memory
   * cost. Default unset (server default 2048).
   */
  llamaCppBatchSize: z.number().int().positive().optional(),
  /**
   * Speculative-decoding mode (`--spec-type`). These algorithms verify
   * drafted tokens against the target distribution and are designed to be
   * lossless, but experimental model/backend pairs must still be A/B tested.
   * `ngram-mod`/`ngram-simple` need no draft model; `draft-mtp`/
   * `draft-eagle3` use a model prediction head; `draft-simple` needs a
   * separate `llamaCppDraftModelPath`. Default unset (off).
   */
  llamaCppSpecType: z
    .enum([
      'none',
      'draft-mtp',
      'draft-eagle3',
      'draft-dflash',
      'draft-simple',
      'ngram-mod',
      'ngram-simple',
      'ngram-map-k',
      'ngram-map-k4v',
      'ngram-cache',
    ])
    .optional(),
  /**
   * Absolute path to a draft-model GGUF for `--spec-type draft-simple`
   * (`--spec-draft-model`). Only used when `llamaCppSpecType` is
   * `draft-simple`. Default unset.
   */
  llamaCppDraftModelPath: z.string().optional(),
  /**
   * Number of tokens to draft per step for speculative decoding
   * (`--spec-draft-n-max`). Default unset (server default 3).
   */
  llamaCppSpecDraftNMax: z.number().int().positive().optional(),
  /**
   * Escape hatch for any llama-server flag not first-classed above.
   * Keys are flag names (with or without leading `--`); values become
   * the flag's argument. A `true` value emits a bare flag (`--foo`);
   * `false` omits it. Applied LAST, so it overrides the first-class
   * flags on conflict. For power users: `--override-tensor`,
   * `--override-kv`, `--rope-scale`, `--numa`, `--direct-io`,
   * `--no-mmap`, `--metrics`, `--sleep-idle-seconds`, …
   *
   * Example: `{ "numa": "distribute", "override-tensor": "\\.ffn_.*_exps\\.=CPU", "metrics": true }`
   */
  llamaCppExtraArgs: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  /**
   * Override llama-server's `--ubatch-size` (the inner microbatch).
   * Smaller values reduce peak memory at a small throughput cost
   * (sensible for tiny models on memory-tight machines); larger
   * values can boost throughput on big GPUs. Default unset (server
   * picks per-backend).
   */
  llamaCppUbatchSize: z.number().int().positive().optional(),
  /**
   * mlx-only: base URL of an already-running `mlx_lm.server` the service
   * should talk to instead of supervising its own child. Same role as
   * `llamaCppBaseUrl` — dev iteration or LAN-shared setups. When unset,
   * the supervisor spawns `mlx_lm.server` via UvRuntime's managed venv.
   */
  mlxBaseUrl: z.string().optional(),
  /**
   * mlx-only: explicit model directory path — overrides catalog-based
   * model resolution. Useful when pointing mlx_lm.server at a
   * hand-downloaded HuggingFace repo checkout.
   */
  mlxModelPath: z.string().optional(),
  /**
   * mlx-only: optional managed context limit. MLX has no fixed-context
   * launch allocation, so the default is the selected model's native catalog
   * window (64K fallback when unknown). Set this only to impose a lower cap.
   */
  mlxNumCtx: z.number().int().positive().optional(),
  /**
   * mlx-only: per-venv pip-install spec for mlx-lm. Pin here so mlx-lm
   * upgrades don't silently break first-run installs. Default
   * `mlx-lm` (unpinned) when unset — UvRuntime recreates the venv if
   * this value changes across boots.
   */
  mlxPackageSpec: z.string().optional(),
  /**
   * MLX-only: bits to quantize the KV cache to. **Default 0 (off).**
   *
   * Originally shipped default-on at 4 bits as a Phase 0 latency win,
   * but mlx-vlm raises `NotImplementedError: RotatingKVCache
   * Quantization NYI` mid-stream whenever a prompt approaches the
   * model's context limit (the rotating cache kicks in for those, and
   * its `to_quantized` isn't implemented). That's exactly the workload
   * we care about — long Meester sessions with deep history — so the
   * crash hits real users hardest. Defaulting off until either upstream
   * implements rotating-cache quantization or we add a `--max-kv-size`
   * pre-flight that pins the cache to a non-rotating variant. Operators
   * with short sessions can opt in here.
   *
   * Useful values: 4 (best speedup, requires non-rotating cache),
   * 6 (compromise), 8 (mild speedup, near-zero quality impact).
   */
  mlxKvBits: z.number().int().min(0).max(8).optional(),
  /**
   * MLX-only: tokens per prefill chunk. Smaller values reduce peak
   * memory during prefill (useful on tight unified-memory machines)
   * at the cost of throughput; larger values can speed up prefill
   * for very long prompts. Maps to the wrapped server's
   * `--prefill-step-size`. Default 2048 — sane balance for the
   * 4–8B Apple Silicon model class. Operators on tight RAM (8 GB)
   * may dial down to 1024; operators on M-Ultra-class hosts with
   * abundant unified memory can push to 4096+ for faster cold-start
   * prefill.
   */
  mlxPrefillStepSize: z.number().int().positive().optional(),
  /**
   * Total RAM budget (GB) for resident local-engine processes
   * combined. Used by the CapacityBroker to decide whether to spawn
   * a new engine or evict an LRU one. Unset = auto-derive as
   * `min(systemRamGB * 0.6, 96)`. Hard-set to a low number on
   * tight-RAM hosts to keep gezel from monopolizing memory; raise
   * on Mac Studio / 128 GB machines that want the pool to keep
   * multiple models warm. Explicit `null` clears the override and
   * returns the broker to the auto-derived value.
   */
  localEngineMemoryGb: z.number().positive().nullable().optional(),
  /**
   * Per-model clone count, keyed by catalog `modelId`. Missing keys
   * default to 1 (one resident replica). Drives the warm-pool
   * pre-spawn at boot and the reconcileEnginePool path when the
   * user changes the Settings clone-count picker. Example:
   * `{ "gemma4-26b": 2, "qwen3.6": 1 }` keeps two Gemma replicas
   * and one Qwen replica resident concurrently — assuming the
   * capacity broker has the headroom (it's the final arbiter).
   */
  localEngineReplicas: z.record(z.string(), z.number().int().min(0)).optional(),
  /**
   * Hard ceiling per model for the Settings clone-count picker.
   * Defaults to 4. Defense-in-depth against a fat-finger config
   * value; the broker is still the final arbiter when budget runs
   * out.
   */
  localEngineReplicasMax: z.number().int().positive().optional(),
  /**
   * Read-only summary of the last Python runtime resolution. Written
   * by UvRuntime on first successful `ensureVenv`; surfaced in Settings
   * so users can see which Python is powering their MLX runtime.
   * Unset when no MLX venv has ever been provisioned.
   */
  pythonRuntime: z
    .object({
      source: z.enum(['system-uv', 'system-python', 'bundled-uv']),
      installerPath: z.string().optional(),
      uvVersion: z.string().optional(),
      pythonVersion: z.string().optional(),
      resolvedAt: z.string().optional(),
    })
    .optional(),
  /**
   * First-run bootstrap bookkeeping for the on-device default-provider
   * flow. When absent, `bootstrapOnDeviceFirstRun` runs on service
   * start: picks a Gemma 4 tier based on detected hardware, flips
   * `provider` to llama-cpp (or `mlx` on Apple Silicon), and kicks off
   * the model download. Set to true once the bootstrap has attempted
   * (success OR failure) so we don't pester the user on every boot.
   *
   * Users who explicitly set `provider` before first boot (Settings
   * UI, config edit) skip first-run entirely — presence of any
   * provider choice is treated as "user has opinions, don't override."
   */
  firstRunCompleted: z.boolean().optional(),
  /**
   * Centralized security & compliance posture. See
   * {@link SecurityPolicySchema}. Absent → resolves fail-safe to `lockdown`.
   * The first-run migration writes `free` for a configured legacy install
   * and `lockdown` for a genuinely new install, so normal operation quickly
   * replaces absence with an explicit policy.
   */
  securityPolicy: SecurityPolicySchema.optional(),
  /**
   * Human-readable error from the last first-run install attempt, if
   * it failed. The Home view surfaces this with a "Retry" button;
   * clearing it retries on next boot (or the user can install
   * manually from Settings → On-device and ignore this field).
   */
  firstRunInstallError: z.string().optional(),
  /**
   * Copilot-only: total wall-clock cap for one chat turn, in minutes.
   * Default 3 min (the service-side `CHAT_TURN_TIMEOUT_MS`). Bump for
   * tool-heavy gezels that run long chains of shell/playwright/MCP
   * calls without emitting reply text between them — the idle
   * watchdog only rescues silence when there's already buffered
   * output, so long tool loops can legitimately eat the whole budget.
   */
  copilotTurnTimeoutMin: z.number().int().positive().optional(),
  /**
   * Max concurrent LLM turns per provider. Caps how many `sendAndWait`
   * calls run at once against a given backend. Interactive user sends
   * jump ahead of queued background work (memory extraction, task
   * handoffs, nudges) within the same slot budget.
   *
   * Defaults:
   *   - `ollama: 1` — local, GPU-memory-bound. Raise to 2–3 if you've
   *     tuned Ollama's `num_parallel` and have GPU headroom.
   *   - `copilot: 10` / `openai: 10` — cloud, rate-limit-bound
   *     upstream. Low enough that a 50-task batch drains gracefully
   *     (10 streaming bubbles at once is busy but manageable) and
   *     doesn't fight the provider's own rate limits.
   */
  providerConcurrency: z
    .object({
      copilot: z.number().int().min(1).optional(),
      openai: z.number().int().min(1).optional(),
      anthropic: z.number().int().min(1).optional(),
      'anthropic-cli': z.number().int().min(1).optional(),
      'codex-cli': z.number().int().min(1).optional(),
      ollama: z.number().int().min(1).optional(),
      'llama-cpp': z.number().int().min(1).optional(),
      mlx: z.number().int().min(1).optional(),
      ds4: z.number().int().min(1).optional(),
    })
    .optional(),
  /**
   * Per-engine prompt-cache memory budget in MB. Caps the
   * SessionCacheController's tracked usage before LRU eviction kicks
   * in. When unset, the controller picks a tiered default from system
   * RAM (1/2/4/8 GB across <16/16-32/32-64/≥64 GB systems) — see
   * `cache/budget.ts`. Operators with unusual setups tune up via
   * Settings → On-device → Advanced.
   */
  cacheBudgetMb: z
    .object({
      mlx: z.number().int().min(64).optional(),
      'llama-cpp': z.number().int().min(64).optional(),
    })
    .optional(),
  /**
   * Bound on disk-persisted MLX prompt cache. The wrapped server saves
   * evicted entries (and warmed gezel-prefixes) to
   * `<home>/engines/mlx/cache/<modelFingerprint>/<cacheId>.safetensors`
   * so the next supervisor boot or new sibling session can mmap-load
   * the prefix in milliseconds instead of paying full prefill cost.
   * LRU pruning runs on each save when total disk usage exceeds this
   * cap. 0 disables pruning (operator manages disk space themselves).
   * Default 8 GB — generous for several large sessions.
   */
  mlxDiskCacheBudgetMb: z.number().int().min(0).optional(),
  /**
   * Bound on disk-persisted llama.cpp slot caches. Mirrors
   * `mlxDiskCacheBudgetMb`: llama-server's slot save/restore writes
   * `<home>/engines/llama-cpp/slots/<modelHash>/<sessionId>.bin` files
   * that survive supervisor restarts. LRU pruning runs as session
   * caches are saved; 0 disables. Default 8 GB.
   */
  llamaCppDiskCacheBudgetMb: z.number().int().min(0).optional(),
  /**
   * Layered prompt-prefix caching (experimental; A/B-gated).
   *
   * When enabled, `buildInstructions` emits a *purely stable* system
   * message ordered `[model-universal][gezel][project]` and moves the
   * volatile band (workspace files, task, recall, active-task anchor)
   * out of the system message — the context block becomes a frozen
   * message after the tool block, the recency anchor a per-turn user
   * prelude. This makes the wire prefix `[stable system][tools]`
   * reusable across sessions/gezels, and the cache adapters key on
   * cumulative layer hashes (`prefix-model/gezel/gp-<hash>`) instead of
   * the whole-prompt hash. Default OFF — when off, the system message is
   * byte-identical to the legacy single-band ordering.
   *
   * Scope & defaults: this is a LOCAL-ENGINE optimization and never
   * applies to cloud providers (they'd drop the volatile band). When
   * `enabled` is unset it defaults per-engine — ON for `llama-cpp`
   * (perf-proven, no regression) and OFF for `mlx` (wired + unit-tested
   * but not yet validated end-to-end). Set `enabled: true` to opt MLX in
   * too, or `false` to disable both. The `GEZEL_LAYERED_PREFIX_CACHE` env
   * var (`1`/`true`/`0`/`false`) overrides config — used as the eval A/B
   * toggle.
   */
  layeredPrefixCache: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  /**
   * Opportunistic batched inference (experimental; A/B-gated).
   *
   * When enabled for a batching-capable local engine, concurrent chat
   * turns may share the engine's parallel KV slots instead of running
   * strictly one at a time. The per-provider queue switches to the
   * "adaptive" interactive policy: ≥2 genuinely-concurrent interactive
   * turns (e.g. two panes) co-occupy slots, while one slot is reserved so
   * an arriving live turn never waits behind a background cohort.
   *
   * Scope & defaults: a LOCAL-ENGINE optimization, default ON for both
   * supervised engines, sized by a shared RAM-tier slot heuristic (1 under
   * 16 GB ⇒ effectively serial, up to 4 on workstation-class RAM). llama.cpp
   * serves its `--parallel N` slots with continuous batching; MLX runs its
   * wrapped server with `--max-concurrency N` (one mlx_lm BatchGenerator,
   * static-wave batching). Set `enabled: false` to force the serial path on
   * both, or use the `GEZEL_BATCHED_INFERENCE` env var (`1`/`true`/`0`/`false`)
   * as the eval A/B toggle. `providerConcurrency[engine]` overrides the slot
   * count verbatim.
   */
  batchedInference: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  /**
   * Tuning knobs for the per-provider request queue.
   *   - `affinity`: when true (the default), the queue prefers
   *     dispatching items that share a session / gezel with recently
   *     running items. Keeps the local-model KV cache warm for
   *     batched work. Disable only to debug FIFO behavior.
   */
  providerQueue: z
    .object({
      affinity: z.boolean().optional(),
    })
    .optional(),
  /**
   * Tuning for the TaskRunner — the layer that paces phase-handoff
   * dispatches so a voorman advancing 50 tasks at once produces a
   * controlled drain rather than 50 simultaneous LLM calls.
   *   - `tickIntervalMs`: how often the runner wakes to check for
   *     pending handoffs it can dispatch. Default 5000ms.
   */
  taskRunner: z
    .object({
      tickIntervalMs: z.number().int().min(500).optional(),
    })
    .optional(),
  /**
   * Fail-fast per-task token/request budget (Theme F). A cumulative ceiling
   * on a task's UNATTENDED spend (a genuine user message resets it), tripping
   * a soft nudge then the existing pause-for-help path so a doomed task stops
   * burning 3–7× the wall-clock instead of spinning to the ceiling.
   *   - `enabled` / `softNudge` / `hardPause`: master + per-stage switches (all default on).
   *   - `scale`: uniform multiplier on every default limit (operator dial).
   *   - `limits`: per-tier overrides (unset fields fall back to defaults × scale).
   * Tier-scaled: a tiny model gets more headroom (it needs more turns for the
   * same work). See providers-adjacent `chat/task-budget.ts` for the defaults.
   */
  taskBudget: z
    .object({
      enabled: z.boolean().optional(),
      softNudge: z.boolean().optional(),
      hardPause: z.boolean().optional(),
      scale: z.number().positive().optional(),
      limits: z
        .record(
          z.enum(['tiny', 'small', 'medium', 'large', 'cloud']),
          z
            .object({
              softTurns: z.number().int().positive().optional(),
              hardTurns: z.number().int().positive().optional(),
              softOutputTokens: z.number().int().positive().optional(),
              hardOutputTokens: z.number().int().positive().optional(),
            })
            .partial(),
        )
        .optional(),
    })
    .optional(),
  /**
   * Idle step supervisor (`TaskScheduler.sweepStuckSteps`). The runner
   * dispatches one turn per step ACTIVATION; if that turn ends without the
   * assignee producing the deliverable or calling `advance_task_step` (it
   * parked on a consultation, aborted, or just stopped), nothing otherwise
   * re-drives the step — it sits active forever. This sweep is the safety
   * net: for an active, non-terminal step whose assignee is idle and which
   * has gone silent past `stallMs`, it first AUTO-ADVANCES when the
   * deliverable already clears the gate, else RE-NUDGES the assignee in
   * their own session — up to `maxRedrives` times, then pauses the task for
   * a human. Gated by engagement mode (off under `reactive`/`off`, like
   * cron ticks) and by per-project ambient-work status. `enabled` defaults
   * true; set false to restore the old "one dispatch, then silence"
   * behavior.
   */
  stuckStep: z
    .object({
      enabled: z.boolean().optional(),
      /** Idle time before a silent step is eligible for re-drive. Default 8 min. */
      stallMs: z.number().int().positive().optional(),
      /** Autonomous re-pokes before the task pauses for a human. Default 3. */
      maxRedrives: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Auto-recall: inject top-N relevant memories into the system prompt at
   * the start of each new session. Default on. `topK` caps how many hits
   * are injected; `minScore` filters out weak matches.
   */
  autoRecall: z
    .object({
      enabled: z.boolean().optional(),
      topK: z.number().int().positive().optional(),
      minScore: z.number().optional(),
    })
    .optional(),
  /**
   * Auto-summarize: distill a session into project memory when it's
   * archived or has been idle past `idleHours`. The summarization itself
   * runs through the provider/model specified here; falls back to the
   * session's own provider when unset.
   */
  summarization: z
    .object({
      enabled: z.boolean().optional(),
      provider: ProviderNameSchema.optional(),
      model: z.string().optional(),
      minUserTurns: z.number().int().positive().optional(),
      idleHours: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Memory lifecycle. `maintenance` controls the periodic Klerk-driven
   * compaction of aged daily memory files; `lessons` controls the
   * gezel-scope lessons distillation injected into the system prompt.
   * Both default to enabled.
   */
  memory: z
    .object({
      maintenance: z
        .object({
          enabled: z.boolean().optional(),
          /**
           * Only days at least this old are compacted. Min 2 is the
           * extraction-race invariant: appends only ever touch today's
           * file, so compaction and extraction stay disjoint even
           * across a midnight rollover.
           */
          olderThanDays: z.number().int().min(2).optional(),
          /** Skip compaction when the eligible window has fewer entries. */
          minEntries: z.number().int().positive().optional(),
        })
        .optional(),
      lessons: z
        .object({
          enabled: z.boolean().optional(),
          /** Hard cap on the distilled lessons document. */
          maxChars: z.number().int().positive().optional(),
          /** How many days of gezel-scope notes feed each distillation. */
          lookbackDays: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * The global search index (`~/.gezel/index/global.db`) — FTS mirrors of
   * session transcripts, the history log, and the documents library. All
   * default to enabled; `enabled` is the master switch. Disabling only stops
   * the writer — sources of truth are untouched and search falls back to
   * scans (history) or empty results (sessions/documents).
   */
  searchIndex: z
    .object({
      enabled: z.boolean().optional(),
      sessions: z.boolean().optional(),
      history: z.boolean().optional(),
      documents: z.boolean().optional(),
    })
    .optional(),
  /**
   * Weekly "what changed" project digests, generated by the Klerk from
   * commits + history events + session activity and written to the project's
   * artifacts drawer under reports/. Default on; also gated by engagement
   * mode (proactive only), like memory maintenance.
   */
  digest: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  /**
   * The meester's occasional status report — headline + dashboard for
   * the Home greeting band, plus follow-up draft tasks. Runs as the
   * meester gezel when the install is idle, capped per day, and only
   * when projects meaningfully changed since the last run. Default on;
   * gated by engagement mode (proactive, or scheduled during night
   * shift). Manual runs via `POST /api/meester-status/run` bypass the
   * budget and idle gates.
   */
  meesterStatus: z
    .object({
      enabled: z.boolean().optional(),
      /** Automatic runs per local calendar day. Default 4. */
      maxRunsPerDay: z.number().int().min(1).max(24).optional(),
      /** How recent project activity must be to count as "changed". Default 24. */
      changeWindowHours: z.number().positive().optional(),
    })
    .optional(),
  /**
   * Gezel growth (purposeful gamification). XP accrues from deduplicated
   * learning signals; level-ups offer evidence-grounded trait / tuning /
   * cosmetic choices the user must approve — nothing is applied without
   * consent. Default ON. Ambient recomputation rides the memory
   * compactor's daily sweep (so it also pauses when memory maintenance
   * or proactive engagement is off); the explicit refresh endpoint is
   * always available.
   */
  growth: z.object({ enabled: z.boolean().optional() }).optional(),
  /**
   * Keurmeester supervision — when a small/local model spins or goes
   * off the rails and the existing recovery machinery (continuation
   * nudges, stuck-step redrives, gates) has exhausted its budget, a
   * frontier model is consulted to diagnose and intervene. Off by
   * default: consults send conversation/task excerpts to the configured
   * cloud provider, so enabling is an explicit, consented choice —
   * local-model users may have chosen local precisely for privacy.
   */
  keurmeester: z
    .object({
      enabled: z.boolean().optional(),
      /** Explicit frontier consult target. Must be a non-local provider. */
      providerName: z.string().optional(),
      model: z.string().optional(),
      /** Permit the bounded takeover rung of the ladder. Default true. */
      allowTakeover: z.boolean().optional(),
      /** Consult budget per chat session. Default 2. */
      maxConsultsPerSession: z.number().int().positive().optional(),
      /** Consult budget per task. Default 3. */
      maxConsultsPerTask: z.number().int().positive().optional(),
      /** Minimum gap between consults on the same session. Default 5 min. */
      cooldownMs: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * Global defaults for ambient voorman nudges on active projects. Each
   * project can override any of these via `project.nudgeConfig`. Defaults
   * applied when unset (see `packages/service/src/tasks/scheduler.ts`):
   *   rapidIntervalMs:            5 * 60_000      (5 min)
   *   slowIntervalMs:             6 * 60 * 60_000 (6 h)
   *   recentActivityWindowMs:     60 * 60_000     (1 h)
   *   rapidAttemptsBeforeBackoff: 3
   */
  projectNudge: z
    .object({
      enabled: z.boolean().optional(),
      rapidIntervalMs: z.number().int().positive().optional(),
      slowIntervalMs: z.number().int().positive().optional(),
      recentActivityWindowMs: z.number().int().positive().optional(),
      rapidAttemptsBeforeBackoff: z.number().int().positive().optional(),
      firstNudgeGraceMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /**
   * Verbose diagnostics — full tool-call args + responses, bridge
   * startup failures with stacks, scheduler cadence reasoning, memory
   * extraction bodies. Off by default; flip on when troubleshooting a
   * specific issue and off again afterward. Output goes to stdout
   * (captured in `~/.gezel/logs/service-YYYY-MM-DD.log`); a small
   * subset also lands in the History view under `debug.*` kinds.
   */
  debugMode: z.boolean().optional(),
  /**
   * When `true`, advanced/power-user surfaces are revealed in the UI —
   * currently the "Scripts" area link in the sidebar. Off by default so
   * the default navigation stays focused. Toggled from Settings → About →
   * Advanced.
   */
  showAdvancedFeatures: z.boolean().optional(),
  /**
   * Debug-only opt-in: when `true`, the service rewrites every
   * template-derived gezel's `about.md` back to the prose its catalog
   * template ships on each boot — discarding any local edits. Bespoke
   * (LLM-authored) gezels have no template to reset to and are left
   * untouched. Off by default. Read once at startup in
   * `startService` (packages/service/src/service.ts); the same reset can
   * be triggered on demand via `POST /api/gezels/reset-templates`.
   */
  resetTemplatesOnStartup: z.boolean().optional(),
  /**
   * Global "panic button" controlling how much AI activity is allowed.
   *   - `proactive` (default): everything on — proactive prompts,
   *     anti-stall nudges, voorman/meester health checks, cross-gezel
   *     `message_gezel`, scheduled crons.
   *   - `scheduled`: reactive + scheduled crons. No proactive nudges
   *     and no cross-gezel messaging from gezels; chat still works.
   *   - `reactive`: chat only. No scheduled jobs. No nudges. No
   *     cross-gezel messaging from gezels.
   *   - `off`: AI disabled — chat composer is inactive, HTTP chat
   *     sends return 403, schedulers short-circuit. In-flight turns
   *     finish; the pending-sends queue is canceled on transition.
   * Degrading to scheduled/reactive does NOT kill the in-flight
   * queue — it drains normally. Only `off` stops the drain.
   */
  aiEngagementMode: z.enum(['proactive', 'scheduled', 'reactive', 'off']).optional(),
  /**
   * Whether the desktop app shows a persistent system-tray / menu-bar
   * icon. The tray is the locus for notifications, the engagement-mode
   * toggle, and quick actions; on Windows/Linux it also keeps the app
   * resident when the window is closed (close-to-tray). On by default —
   * `false` disables the tray and restores plain quit-on-close. Read by
   * the Electron main process (packages/app/src/tray.ts), not the
   * service. Absent = enabled.
   */
  showSystemTray: z.boolean().optional(),
  /**
   * Whether the packaged desktop app checks GitHub release metadata for
   * updates when it launches. On by default. `false` suppresses only the
   * automatic launch check; the user-initiated "Check for updates" tray
   * action remains available (subject to the security policy).
   *
   * Read by the Electron main process, not the service. Absent = enabled.
   */
  autoUpdateChecks: z.boolean().optional(),
  /**
   * When the system tray is enabled, controls what the window's close
   * (Red X) button does on Windows/Linux. Off by default → close-to-tray
   * (the window hides and Gezel stays resident in the tray). When `true`,
   * the close button quits the entire app and removes the tray icon
   * instead. Only meaningful when `showSystemTray` is enabled; ignored on
   * macOS, which keeps the app alive on window-all-closed regardless. Read
   * by the Electron main process (packages/app/src/main.ts), not the
   * service. Absent = disabled (close-to-tray).
   */
  quitOnClose: z.boolean().optional(),
  /**
   * Persisted UI theme preference. Server-side because Electron's
   * embedded service binds an ephemeral port every launch — the same
   * install lands on `http://127.0.0.1:55555` one boot and `:44444`
   * the next, and `localStorage` is keyed by origin so a localStorage-
   * only pref strands itself on the previous port. The renderer keeps
   * a localStorage cache for fast first paint, but this field is the
   * source of truth across boots.
   */
  themePref: z.enum(['system', 'light', 'dark']).optional(),
  /**
   * Last-used document export settings. This is the cross-boot source of
   * truth for the editor's quick-export action; see
   * `DocumentExportOptionsSchema`.
   */
  documentExportOptions: DocumentExportOptionsSchema.optional(),
  /**
   * Which side of the window the primary navigation sidebar
   * (projects / gezellen / documents / …) sits on. Server-side for the
   * same reason as `themePref` — the embedded service rebinds an
   * ephemeral port each launch and `localStorage` is keyed by origin, so
   * a localStorage-only pref would strand on the previous boot's port.
   * The renderer keeps a localStorage cache for fast first paint; this is
   * the cross-boot source of truth. Absent = `right` (the default); only
   * an explicit `left` opts out.
   */
  sidebarSide: z.enum(['left', 'right']).optional(),
  /**
   * Whether the Home "workshop" greeting band is collapsed to its single
   * status row. Server-side for the same reason as `themePref` — the
   * embedded service rebinds an ephemeral port each launch and
   * `localStorage` is keyed by origin, so a localStorage-only pref would
   * strand on the previous boot's port. Absent = expanded (default).
   */
  homeGreetingCollapsed: z.boolean().optional(),
  /**
   * Workshop tempo — how frenetic the meester/voorman's proactive
   * behavior feels. Only has any effect when `aiEngagementMode` is
   * `proactive`; gated behaviors read intervals + prompt text from
   * the tempo instead of the bare defaults. The three graded tiers
   * stay in Dutch to match the gezel vocabulary:
   *   - `gezellig` — cozy. Long gaps between nudges, gentle tone.
   *   - `bedrijvig` (default) — "busy in a good way." Current cadence.
   *   - `druk` — pressured. Short gaps, direct tone.
   *   - `dolle-boel` — tiny gaps, all-caps prompts.
   */
  workshopTempo: z.enum(['gezellig', 'bedrijvig', 'druk', 'dolle-boel']).optional(),
  /**
   * Night Shift — a nightly window during which deferred, idle-friendly
   * batch work runs (boekwachter enrichment, code scanning, the bundled
   * daily meester oversight review). Tasks flagged `nightShift.enabled`
   * only dispatch while the shift is ON; interactive and scheduled work
   * always preempts them. The shift activates inside `window` (local
   * hours, wraps midnight) and latches OFF once no pending night-shift
   * work remains, restarting next night.
   *
   *   - `enabled` — master toggle. Absent = on.
   *   - `window` — local start/end hour. Absent = 22:00 → 06:00.
   *   - `keepAwakeWhileRunning` — hold a power-save blocker so the machine
   *     does not sleep while night-shift work is in flight (all OS).
   *   - `wakeOnStart` — schedule an OS wake at window start so a sleeping
   *     machine comes up for the shift (macOS `pmset` only; no-op else).
   *   - `modelOverride` — optional Night Shift provider/model defaults.
   *     Disabled or absent inherits the ordinary install defaults. Per-gezel
   *     provider/model pins still win because this remains a default, not a
   *     forced routing rule.
   *
   * Read by `NightShiftManager` (window/enable), the task/chat and index
   * enrichment paths (model defaults), and the Electron main process
   * (power flags, via the power-intent poll).
   */
  nightShift: z
    .object({
      enabled: z.boolean().optional(),
      window: z
        .object({
          startHour: z.number().int().min(0).max(23),
          endHour: z.number().int().min(0).max(23),
        })
        .optional(),
      keepAwakeWhileRunning: z.boolean().optional(),
      wakeOnStart: z.boolean().optional(),
      modelOverride: z
        .object({
          enabled: z.boolean().optional(),
          provider: ProviderNameSchema.optional(),
          model: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  /**
   * Tool-filtering policy for MCP tool calls exposed to a gezel. When
   * active, the service narrows the tool surface to what a gezel's
   * `role` typically needs, stripping the long tail of unrelated tools
   * before they reach the model. This cuts several kilobytes of JSON
   * schema out of every request — critical for small local models
   * where each tool schema competes with conversation for context,
   * but also a sensible default that keeps big-model turns focused.
   *
   *   - `always`: filter every session by role.
   *   - `never`: expose every available tool to every gezel.
   *   - `small-model`: filter only when the active model's parameter
   *     size is under 5B (local providers only).
   *
   * Default when unset: `always`. Tier-1 OpenAI accounts hit TPM
   * caps on the first message when the full ~60-tool surface is
   * sent every turn, so the filter applies cloud-side too. Users
   * who genuinely want the full surface can set `'never'`. Copilot
   * sessions route through the Copilot SDK which owns its own MCP
   * wiring; filtering there is a future refinement.
   */
  toolFilterMode: z.enum(['always', 'never', 'small-model']).optional(),
  /**
   * Communication channels — user-chosen transports that gezels can
   * send messages over to reach the user outside the app window.
   * Per-channel credentials (webhook bearer/basic auth) live in
   * SecretStore, not in this file.
   */
  channels: ChannelsConfigSchema.optional(),
  /**
   * Copilot-only install-level default: when true, new Copilot sessions
   * deny the CLI's built-in tools (bash, web_fetch, file ops, grep) and
   * force the model to work through our MCP tools. Per-gezel override
   * lives in `GezelFrontmatter.sandboxCopilot`. Missing defaults to true;
   * explicit false is the deliberate unrestricted-SDK escape hatch.
   */
  sandboxCopilot: z.boolean().optional(),
  /**
   * Settings for the `anthropic-cli` provider — the wrapper that drives
   * the local `claude` CLI per chat turn. Auth is whatever the CLI is
   * already logged in with on this host; no API key field here.
   *
   *   - `binaryPath`: explicit override of the `claude` executable. When
   *     unset, the provider resolves it from `$PATH`.
   *   - `manageRuntimeFiles` (default true): write a per-session
   *     `.mcp.json` to `~/.gezel/runtime/anthropic-cli/...` and pass it
   *     via `--mcp-config` so gezel-mcp tools (memories, tasks, team
   *     management, documents, history) are visible to Claude. Setting
   *     this to false skips the MCP wiring and runs Claude with only
   *     its built-in tools.
   *   - `defaultPermissionMode` (default `acceptEdits`): per-install
   *     fallback when a gezel hasn't set `claudePermissionMode` on its
   *     frontmatter. Forwarded as `--permission-mode <value>`.
   *   - `extraModels`: extend the hardcoded model list (e.g. to pin a
   *     newly-released id ahead of an app update).
   */
  anthropicCli: z
    .object({
      binaryPath: z.string().optional(),
      manageRuntimeFiles: z.boolean().optional(),
      defaultPermissionMode: z
        .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
        .optional(),
      extraModels: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
      /**
       * Number of long-lived `claude` subprocesses to keep warm at once.
       * Each pool slot holds one stream-json child process pinned to a
       * specific chat session — turn 2+ of a session skips the
       * ~1–2 sec cold-start tax. When N+1 sessions need slots, the
       * least-recently-used worker is evicted (skipping any worker
       * mid-turn). More slots = lower per-turn latency for parallel
       * gezel-to-gezel work; more memory (each `claude` process can be
       * 100–200 MB resident). Default 4.
       */
      poolSize: z.number().int().min(1).max(32).optional(),
      /**
       * Seconds a warm worker can sit idle before being shut down to
       * free memory. Resets on every turn. Default 600 (10 min) —
       * mirrors `NativeEngineSupervisor`'s idle convention.
       */
      workerIdleSec: z.number().int().min(60).max(3600).optional(),
    })
    .optional(),
  /**
   * Settings for the `codex-cli` provider — the wrapper that drives
   * OpenAI's `codex` CLI (`@openai/codex`) per chat turn. Like the
   * `anthropic-cli` provider, auth is whatever the CLI is already set
   * up with on this host (either `codex login` for ChatGPT-account
   * auth, or an `OPENAI_API_KEY` / `CODEX_API_KEY` in the user's
   * environment); no API key field here. Each turn spawns a fresh
   * `codex exec` (or `codex exec resume <thread_id>` for follow-ups)
   * subprocess — Codex CLI has no streaming-stdin equivalent to
   * Claude's `--input-format stream-json`, so there's no warm worker
   * pool. The Rust binary's spawn cost is small enough that this is
   * fine.
   *
   *   - `binaryPath`: explicit override of the `codex` executable.
   *     When unset, the provider resolves it from `$PATH`.
   *   - `manageRuntimeFiles` (default true): write a per-session
   *     `CODEX_HOME` directory containing `config.toml` (instructions,
   *     model, MCP servers, reasoning effort) and a symlink to the
   *     user's `~/.codex/auth.json` if it exists. Setting this to
   *     false runs `codex exec` against the user's default
   *     `~/.codex/` and skips the gezel-mcp wiring.
   *   - `defaultPermissionMode` (default `acceptEdits`): per-install
   *     fallback when a gezel hasn't set `claudePermissionMode` on
   *     its frontmatter. Mapped onto Codex's two-axis sandbox /
   *     approval model: `default` and `acceptEdits` →
   *     `--sandbox workspace-write --ask-for-approval never`; `plan` →
   *     `--sandbox read-only --ask-for-approval never`;
   *     `bypassPermissions` → `--dangerously-bypass-approvals-and-sandbox`.
   *   - `defaultReasoningEffort`: per-install fallback for Codex's
   *     `model_reasoning_effort` config knob. Forwarded as `-c
   *     model_reasoning_effort="<effort>"`; supported values remain
   *     model-dependent.
   *   - `extraModels`: extend the hardcoded model list (e.g. to pin
   *     a newly-released id ahead of an app update).
   *   - `extraConfigOverrides`: power-user escape hatch — extra
   *     `-c <key>=<value>` flags appended verbatim to every `codex
   *     exec` invocation. Use sparingly; the values are JSON-parsed
   *     by Codex.
   */
  codexCli: z
    .object({
      binaryPath: z.string().optional(),
      manageRuntimeFiles: z.boolean().optional(),
      defaultPermissionMode: z
        .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
        .optional(),
      defaultReasoningEffort: z
        .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
        .optional(),
      extraModels: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
      extraConfigOverrides: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /**
   * Execution density — how much orchestration scaffolding wraps a task.
   *
   *  - `scaffold` (default): the full `meester → voorman → specialists`
   *    crew with granular per-step craftbooks. Right for raw-completion
   *    local models, where gezel's loop IS the agent.
   *  - `flat`: route concrete asks to a single generalist (`start_job` →
   *    solo "ambachtsman", which already collapses the craftbook onto the
   *    one specialist). Right for self-orchestrating providers (codex-cli,
   *    anthropic-cli, copilot) that bring their own agent loop — the crew
   *    + granular steps are mostly redundant overhead for them (eval data:
   *    ~3.5 gezels/scenario, output ≈1–2% of token traffic).
   *  - `auto` (**the default**, including when unset): pick by provider —
   *    `flat` for self-orchestrating providers (codex-cli/anthropic-cli/
   *    copilot), `scaffold` otherwise. Local + raw-cloud providers are
   *    unaffected. Set `scaffold` explicitly to force the full crew on a
   *    frontier provider (the escape hatch).
   *
   * The quality gates stay the universal floor across all densities — that
   * is what makes `flat` safe. Validated by the flat-vs-scaffold
   * A/B (codex-cli: equal pass rate, materially fewer tokens).
   */
  executionDensity: z.enum(['auto', 'flat', 'scaffold']).optional(),
  /**
   * Whether the `@playwright/mcp` system toolset should launch Chromium
   * in headless mode. Default `true` — avoids a visible Chrome window
   * popping up every time a gezel uses `browser_*` tools. Set to `false`
   * to watch the browser while debugging automation. Applies only when
   * the toolset is in use; no effect when the toolset isn't installed.
   */
  playwrightHeadless: z.boolean().optional(),
  /**
   * Allow/deny globs evaluated by the `fetch_url` MCP tool. Default
   * behavior with both unset: every URL is allowed. When `allow` is
   * populated, only matching URLs are allowed. `deny` always wins
   * when both match. Glob syntax is standard shell (`*`, `**`, etc.);
   * matched against the full URL string.
   */
  fetchUrl: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Configuration for the `web_search` MCP tool. `provider` picks the
   * active backend; `fallbackProvider` runs when the primary is
   * unavailable (missing key, transport error). When both unset,
   * `web_search` defaults to `wikipedia` — zero key, always available.
   *
   * `allow` / `deny` are glob-matched against the *query string* (not
   * URLs); use them for abuse prevention. Empty defaults are fine.
   */
  webSearch: z
    .object({
      provider: z.enum(['brave', 'wikipedia', 'tavily', 'mock']).optional(),
      fallbackProvider: z.enum(['brave', 'wikipedia', 'tavily']).optional(),
      defaultLimit: z.number().int().min(1).max(20).optional(),
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Recently-opened projects, newest-first. Deprecated — superseded by
   * `recentTabs`, which carries projects alongside gezels, documents,
   * and tasks. Kept for one-shot boot-time migration; new writes go to
   * `recentTabs`.
   */
  projectMru: z
    .array(
      z.object({
        id: z.string(),
        at: z.number(),
      }),
    )
    .optional(),
  /**
   * Last N items the user clicked, across all four entity kinds. Two
   * fields drive behavior:
   *  - `at` (epoch ms) is `lastAccessedAt`, used **only** for LRU
   *    eviction at the cap.
   *  - `order` is the stable left-to-right tab position. Assigned when
   *    a tab is first opened; never changed by re-clicks. Drag-rearrange
   *    (future) will rewrite `order` values directly.
   * Display fields (name, icon) are NOT stored — resolved live at render
   * time so renames don't leave stale labels in the bar.
   */
  recentTabs: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('project'),
          id: z.string(),
          at: z.number(),
          order: z.number(),
        }),
        z.object({
          kind: z.literal('gezel'),
          id: z.string(),
          at: z.number(),
          order: z.number(),
        }),
        z.object({
          kind: z.literal('document'),
          path: z.string(),
          at: z.number(),
          order: z.number(),
        }),
        z.object({
          kind: z.literal('task'),
          ref: z.string(),
          at: z.number(),
          order: z.number(),
        }),
        z.object({
          kind: z.literal('area'),
          area: z.enum([
            'projects',
            'gezels',
            'documents',
            'tasks',
            'scripts',
            'history',
            'settings',
            'benchmarks',
          ]),
          at: z.number(),
          order: z.number(),
        }),
      ]),
    )
    .optional(),
  /**
   * External-folder configuration. When unset, all data lives under
   * `~/.gezel/` (the local-first default). When a per-scope field is
   * set, that scope's content lives at the configured absolute path.
   * Mutated only by the folders move worker; never written directly
   * via the config PUT endpoint. See {@link ExternalFoldersSchema}.
   */
  externalFolders: ExternalFoldersSchema.optional(),
});

export const RecentTabAreaSchema = z.enum([
  'projects',
  'gezels',
  'documents',
  'tasks',
  'craftbooks',
  'scripts',
  'history',
  'settings',
  // In-app eval-running panel ("Benchmarks"). Lives alongside the
  // other top-level areas so users can launch + review benchmark
  // runs without leaving the app.
  'benchmarks',
  // Built-in documentation (TOC + articles, served by /api/handboek).
  'handboek',
]);
export type RecentTabArea = z.infer<typeof RecentTabAreaSchema>;

/**
 * `pinned: true` exempts a tab from MRU eviction. The cap stays the
 * same for unpinned tabs; pinned tabs can grow the list past it.
 * Optional / absent = unpinned.
 */
export const RecentTabSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('project'),
    id: z.string(),
    at: z.number(),
    order: z.number(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('gezel'),
    id: z.string(),
    at: z.number(),
    order: z.number(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('document'),
    path: z.string(),
    at: z.number(),
    order: z.number(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('task'),
    ref: z.string(),
    at: z.number(),
    order: z.number(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('area'),
    area: RecentTabAreaSchema,
    at: z.number(),
    order: z.number(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('script'),
    projectId: z.string(),
    name: z.string(),
    /** Library scope the editor loads from; absent = the project's own scripts. */
    scope: z.enum(['standard', 'user']).optional(),
    at: z.number(),
    order: z.number(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('craftbook'),
    id: z.string(),
    /** Which catalog the book lives in. `local` is editable; others are read-only. */
    source: z.enum(['bundled', 'local', 'project']).optional(),
    at: z.number(),
    order: z.number(),
    pinned: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('craftbook-script'),
    craftbookId: z.string(),
    name: z.string(),
    at: z.number(),
    order: z.number(),
    pinned: z.boolean().optional(),
  }),
]);
export type RecentTab = z.infer<typeof RecentTabSchema>;
export type GezelConfig = z.infer<typeof GezelConfigSchema>;

/** Request shape for PUT /api/config. Mirrors `GezelConfig` but
 *  widens select fields to accept explicit `null` as a
 *  reset-to-default signal — the store treats null as "delete the
 *  key" so the on-disk read shape stays narrow. */
export const UpdateConfigRequestSchema = GezelConfigSchema.extend({
  ollamaThink: z.boolean().nullable().optional(),
  firstRunInstallError: z.string().nullable().optional(),
  // llama-cpp Advanced overrides the Settings UI can reset to their
  // default. The read/on-disk shape stays non-null (`.optional()`); the
  // request side accepts `null` so picking the default sentinel (Auto /
  // q8_0 / Off) clears a previously-pinned value. `writeConfig` strips
  // the null before persistence. Without this, sending `undefined` is
  // dropped by JSON.stringify and the field can never be un-pinned.
  llamaCppBaseUrl: z.string().nullable().optional(),
  llamaCppModelPath: z.string().nullable().optional(),
  llamaCppBackendOverride: z.enum(['auto', 'cuda', 'vulkan', 'metal', 'cpu']).nullable().optional(),
  llamaCppKvCacheType: z.enum(['f16', 'q8_0', 'q4_0']).nullable().optional(),
  llamaCppFlashAttn: z.union([z.boolean(), z.enum(['on', 'off', 'auto'])]).nullable().optional(),
  llamaCppSpecType: z
    .enum([
      'none',
      'draft-mtp',
      'draft-eagle3',
      'draft-dflash',
      'draft-simple',
      'ngram-mod',
      'ngram-simple',
      'ngram-map-k',
      'ngram-map-k4v',
      'ngram-cache',
    ])
    .nullable()
    .optional(),
  llamaCppCpuMoe: z.boolean().nullable().optional(),
  llamaCppSwaFull: z.boolean().nullable().optional(),
  // MLX Advanced overrides the Settings UI can reset to their default —
  // same reset-on-null contract as the llama-cpp fields above.
  mlxBaseUrl: z.string().nullable().optional(),
  mlxModelPath: z.string().nullable().optional(),
  mlxPackageSpec: z.string().nullable().optional(),
  mlxKvBits: z.number().int().min(0).max(8).nullable().optional(),
  /**
   * Direct mutation is rejected by the route — the move worker is the
   * only writer, immediately before triggering a service restart. The
   * schema accepts the shape (with nullable variants) so the worker can
   * reuse the same code path.
   */
  externalFolders: z
    .object({
      documents: z.string().min(1).nullable().optional(),
      gezels: z.string().min(1).nullable().optional(),
      projects: z.string().min(1).nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type UpdateConfigRequest = z.infer<typeof UpdateConfigRequestSchema>;

export const ListGezelsResponseSchema = z.object({
  gezels: z.array(GezelSummarySchema),
});

export const CreateGezelRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  role: z.string().optional(),
  /**
   * Optional gender (`male` / `female` / `non-binary`). When omitted the
   * service derives one from the name's gendered pool with a small flat
   * chance of non-binary regardless of name. Pass explicitly when the
   * caller already paired a name with a gender (UI form, or the
   * `pickRandomNameWithGender` helper) so the NB share isn't re-rolled.
   */
  gender: GezelGenderSchema.optional(),
  model: z.string().optional(),
  /**
   * The gezel's about.md — injected verbatim into their system prompt.
   * MCP's `create_gezel` tool requires this with a min length. UI flows
   * (where an icon + about are generated asynchronously) may omit and
   * the service fills in a placeholder; those code paths always follow
   * up with an explicit `updateGezelAbout` once generation completes.
   */
  about: z.string().optional(),
});

export const GezelResponseSchema = GezelDetailSchema;

/**
 * Character-sheet payload returned by every growth route (GET and all
 * mutations) — mutating responses return the full refreshed payload so
 * the UI swaps state in atomically.
 */
export const GezelGrowthResponseSchema = z.object({
  state: GezelGrowthStateSchema,
  /** XP needed for the NEXT level — the progress-bar denominator. */
  nextLevelXp: z.number().int(),
  /** Active traits from frontmatter (the authoritative set). */
  activeTraits: z.array(GezelTraitSchema),
  /**
   * Adopted-but-missing-from-frontmatter trait ids — a wholesale
   * gezel.md save (squisq editor) can silently drop a trait; the UI
   * surfaces these as "lost to an edit".
   */
  driftedTraitIds: z.array(z.string()),
});
export type GezelGrowthResponse = z.infer<typeof GezelGrowthResponseSchema>;

export const AcceptGrowthProposalRequestSchema = z.object({
  proposalId: z.string().min(1),
});
export type AcceptGrowthProposalRequest = z.infer<typeof AcceptGrowthProposalRequestSchema>;

export const DeclineGrowthLevelUpRequestSchema = z.object({
  /** Omit to skip the whole level (all trait proposals → declined). */
  proposalId: z.string().min(1).optional(),
});
export type DeclineGrowthLevelUpRequest = z.infer<typeof DeclineGrowthLevelUpRequestSchema>;

export const UpdateGezelMarkdownRequestSchema = z.object({
  source: z.string(),
});

export const UpdateGezelAboutRequestSchema = z.object({
  source: z.string(),
});

export const RenameGezelRequestSchema = z.object({
  name: z.string().min(1),
});
export type RenameGezelRequest = z.infer<typeof RenameGezelRequestSchema>;

/**
 * Replace the `defaults` map on a fixed-function gezel's frontmatter.
 * `tool` and `promptKey` are template-owned — only `defaults` is
 * editable from the UI today. Pass `null` to clear all defaults.
 */
export const UpdateGezelFixedFunctionDefaultsRequestSchema = z.object({
  defaults: z.record(z.string(), z.unknown()).nullable(),
});
export type UpdateGezelFixedFunctionDefaultsRequest = z.infer<
  typeof UpdateGezelFixedFunctionDefaultsRequestSchema
>;

export const UpdateGezelSettingsRequestSchema = z.object({
  /** `null` clears the override and lets the gezel inherit the global default. */
  provider: ProviderNameSchema.nullable().optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  /** `null` clears the per-gezel num_ctx override. */
  numCtx: z.number().int().positive().nullable().optional(),
  /** `null` inherits the global autoRecall default. */
  autoRecall: z.boolean().nullable().optional(),
  /** `null` clears the chat bubble font override. */
  font: z.string().nullable().optional(),
  /** `null` inherits the install-level `GezelConfig.sandboxCopilot`. */
  sandboxCopilot: z.boolean().nullable().optional(),
  /** `null` inherits the install-level `config.anthropicCli.defaultPermissionMode`. */
  claudePermissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .nullable()
    .optional(),
  /**
   * `null` clears the per-gezel sampling/reasoning/structured-output
   * override; the gezel falls back to the catalog manifest's recommended
   * defaults. A value replaces the override wholesale.
   */
  tuning: ChatModelTuningSchema.nullable().optional(),
  /**
   * Canonical tuning-profile id (e.g. `thinking-coding`). `null` clears
   * the selection (revert to template default or "automatic"). The
   * resolver applies the profile as a layer between installDefault and
   * catalog base — see `tuning-profile-registry.ts`.
   */
  tuningProfile: TuningProfileIdSchema.nullable().optional(),
  /**
   * When `true`, the UI renders the gezel's custom `icon.svg` instead of
   * their parametric poppetje. `null` clears the override (default —
   * render poppetje).
   */
  iconOverride: z.boolean().nullable().optional(),
  /**
   * Per-gezel override of `config.recognition.mode`. `null` clears it
   * (inherit the install default).
   */
  recognition: z.enum(['auto', 'always', 'off']).nullable().optional(),
});
export type UpdateGezelSettingsRequest = z.infer<typeof UpdateGezelSettingsRequestSchema>;

export const GenerateGezelIconRequestSchema = z.object({
  instruction: z.string().optional(),
});
export type GenerateGezelIconRequest = z.infer<typeof GenerateGezelIconRequestSchema>;

export const GenerateGezelAboutRequestSchema = z.object({
  role: z.string().optional(),
});

export const ModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  supportsReasoning: z.boolean().optional(),
  reasoningEfforts: z.array(z.string()).optional(),
  defaultReasoningEffort: z.string().optional(),
  contextWindow: z.number().optional(),
  /**
   * Whether the model supports structured tool / function calling. Cloud
   * providers can assume true for their current chat models; Ollama sets
   * this per-model via a family-prefix allowlist so the UI can warn when
   * a gezel is pinned to a non-tool-capable local model.
   */
  supportsTools: z.boolean().optional(),
  /** Short human-friendly size hint (Ollama's `details.parameter_size`, etc). */
  parameterSize: z.string().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ListModelsResponseSchema = z.object({
  provider: ProviderNameSchema,
  models: z.array(ModelInfoSchema),
});
export type ListModelsResponse = z.infer<typeof ListModelsResponseSchema>;
export type GenerateGezelAboutRequest = z.infer<typeof GenerateGezelAboutRequestSchema>;

export const UpdateGezelIconRequestSchema = z.object({
  svg: z.string(),
});
export type UpdateGezelIconRequest = z.infer<typeof UpdateGezelIconRequestSchema>;

export const GezelIconHistoryEntrySchema = z.object({
  timestamp: z.string(),
  svg: z.string(),
});
export const GezelIconHistoryResponseSchema = z.object({
  current: z.string().nullable(),
  history: z.array(GezelIconHistoryEntrySchema),
});
export type GezelIconHistoryResponse = z.infer<typeof GezelIconHistoryResponseSchema>;

export const RevertGezelIconRequestSchema = z.object({
  timestamp: z.string(),
});
export type RevertGezelIconRequest = z.infer<typeof RevertGezelIconRequestSchema>;

/**
 * Body for `PUT /api/gezels/:id/poppetje` — replace the gezel's
 * appearance struct. The server forces `key` back to the gezel id
 * regardless of what's posted so the wood-grain seed stays anchored.
 */
export const UpdateGezelPoppetjeRequestSchema = z.object({
  poppetje: PoppetjeSchema,
});
export type UpdateGezelPoppetjeRequest = z.infer<typeof UpdateGezelPoppetjeRequestSchema>;

/**
 * Body for `POST /api/gezels/:id/poppetje/reroll` — draw a fresh seed
 * for this gezel's appearance. The optional `seed` is for deterministic
 * tests; production callers leave it unset.
 */
export const RerollGezelPoppetjeRequestSchema = z.object({
  seed: z.number().int().optional(),
});
export type RerollGezelPoppetjeRequest = z.infer<typeof RerollGezelPoppetjeRequestSchema>;

export const RewriteTextContextSchema = z.enum([
  'about',
  'chat-composer',
  'task-description',
  'generic',
]);
export type RewriteTextContext = z.infer<typeof RewriteTextContextSchema>;

export const RewriteTextRequestSchema = z.object({
  text: z.string(),
  context: RewriteTextContextSchema.optional(),
  instruction: z.string().optional(),
  // If true, the input is just a fragment of a larger document and the
  // rewriter should return a matching fragment (no added headings etc.).
  isSelection: z.boolean().optional(),
  // Optional contextual hints the rewriter can use when the input text
  // is empty (synthesize-from-scratch) or thin: a short subject line
  // (e.g. task title, gezel name) and a longer parent-context blob
  // (e.g. project description). Both are advisory.
  subject: z.string().optional(),
  parentContext: z.string().optional(),
});
export type RewriteTextRequest = z.infer<typeof RewriteTextRequestSchema>;

export const RewriteTextResponseSchema = z.object({
  text: z.string(),
});
export type RewriteTextResponse = z.infer<typeof RewriteTextResponseSchema>;

export const WriteDocumentRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type WriteDocumentRequest = z.infer<typeof WriteDocumentRequestSchema>;

const DocumentMediaExportPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) => {
      const normalized = value.replace(/\\/g, '/');
      return (
        !normalized.startsWith('/') &&
        !/^[A-Za-z]:\//.test(normalized) &&
        normalized.split('/').every((segment) => segment !== '..')
      );
    },
    { message: 'must be a relative path without .. segments' },
  );

export const DocumentMediaExportSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('documents') }),
  z.object({
    kind: z.literal('project-artifacts'),
    projectId: z.string().trim().min(1),
  }),
]);
export type DocumentMediaExportSource = z.infer<typeof DocumentMediaExportSourceSchema>;

/**
 * Body for native MP4/GIF document export. The daemon renders the supplied
 * current editor text while resolving media sidecars from the selected
 * document's Store-backed directory.
 */
export const DocumentMediaExportRequestSchema = z.object({
  markdown: z.string().max(5_000_000),
  selectedFile: DocumentMediaExportPathSchema,
  format: z.enum(['mp4', 'gif']),
  source: DocumentMediaExportSourceSchema,
});
export type DocumentMediaExportRequest = z.infer<typeof DocumentMediaExportRequestSchema>;

export const CreateDocumentFolderRequestSchema = z.object({
  path: z.string().min(1),
});
export type CreateDocumentFolderRequest = z.infer<typeof CreateDocumentFolderRequestSchema>;

export const RenameDocumentRequestSchema = z.object({
  fromPath: z.string().trim().min(1),
  toPath: z.string().trim().min(1),
});
export type RenameDocumentRequest = z.infer<typeof RenameDocumentRequestSchema>;

export const ChatHistoryResponseSchema = z.object({
  gezelId: z.string(),
  messages: z.array(ChatMessageSchema),
});
export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponseSchema>;

export const SendChatRequestSchema = z.object({
  message: z.string().min(1),
  /**
   * Optional project scope. When set, the message lands in (or
   * creates) a session for `{gezelId, projectId}` instead of the
   * gezel's default-project session. Used by code paths that want to
   * drop a message into a specific project's chat (e.g. the
   * `self-correction-broken-js` eval setup hook seeds work into
   * `broken-counter` rather than `default`). Without this field, the
   * route was silently dropping projectId via Zod strip-unknowns and
   * always routing to `default` regardless of what the caller passed.
   */
  projectId: z.string().optional(),
  expectedDeliverable: ExpectedDeliverableSchema.optional(),
});
export type SendChatRequest = z.infer<typeof SendChatRequestSchema>;

export const SendChatResponseSchema = z.object({
  accepted: z.literal(true),
  gezelId: z.string(),
});
export type SendChatResponse = z.infer<typeof SendChatResponseSchema>;

/**
 * Message one gezel from another. `fromGezelId` / `fromSessionId` identify
 * the sender; `fromSessionId` gates whether the reply flows back into the
 * sender's inbox. `projectId` defaults to the sender's project.
 */
export const MessageGezelRequestSchema = z.object({
  fromGezelId: z.string().min(1),
  fromSessionId: z.string().optional(),
  projectId: z.string().optional(),
  text: z.string().min(1),
  /**
   * Shape-of-deliverable hint persisted on the target's session so
   * their consultation-mode addendum knows whether to default to
   * chat reply or file deliverable. See `ExpectedDeliverableSchema`.
   */
  expectedDeliverable: ExpectedDeliverableSchema.optional(),
});
export type MessageGezelRequest = z.infer<typeof MessageGezelRequestSchema>;

export const MessageGezelResponseSchema = z.object({
  accepted: z.literal(true),
  sessionId: z.string(),
  toGezelId: z.string(),
  toGezelName: z.string(),
  /** True when an identical file handoff was already pending and was joined. */
  deduplicated: z.boolean().optional(),
});
export type MessageGezelResponse = z.infer<typeof MessageGezelResponseSchema>;

/**
 * Ensure a gezel capable of the given job-title exists, creating one if
 * the roster + gilde templates don't already have a fit. The single-tool
 * shape collapses the list→check→create sequence voormen routinely get
 * wrong into a single idempotent call.
 */
export const EnsureGezelRequestSchema = z.object({
  jobTitle: z.string().min(1),
  preferredName: z.string().optional(),
});
export type EnsureGezelRequest = z.infer<typeof EnsureGezelRequestSchema>;

export const EnsureGezelResponseSchema = z.object({
  gezelId: z.string(),
  name: z.string(),
  role: z.string(),
  action: z.enum(['reused', 'created-from-gilde', 'created-bespoke']),
  matchScore: z.number().optional(),
  templateId: z.string().optional(),
  alternatives: z.array(z.string()).optional(),
});
export type EnsureGezelResponse = z.infer<typeof EnsureGezelResponseSchema>;

/**
 * One candidate for the `@`-mention popover in the chat composer.
 * `group` is a sort/label hint — project chats return candidates in
 * three groups (`voorman`, `assignees`, `team`) so the UI can render
 * section headers without re-deriving the roster.
 */
export const MentionCandidateSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /**
   * Kebab-case role-based slug for the gezel. Carried through so the
   * `@`-popover can filter on it and surface both names in the row.
   */
  roleBasedName: z.string().optional(),
  group: z.enum(['voorman', 'assignees', 'team']).optional(),
});
export type MentionCandidate = z.infer<typeof MentionCandidateSchema>;

export const ListMentionCandidatesResponseSchema = z.object({
  candidates: z.array(MentionCandidateSchema),
});
export type ListMentionCandidatesResponse = z.infer<typeof ListMentionCandidatesResponseSchema>;

/**
 * One row in the per-gezel project picker (Gezel screen → Chat tab).
 * `precedence` reflects WHY this project is in the list — it's the same
 * heuristic used to pick a project for an `@mention` from Meester chat.
 */
export const ProjectForGezelSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  /**
   * Why the project is shown:
   *   - `voorman` — the gezel runs this project
   *   - `assignment` — the gezel is on an active task / phase here
   *   - `session` — they have a non-archived chat session here
   *   - `fallback` — `default` always appears so the dropdown is never empty
   */
  precedence: z.enum(['voorman', 'assignment', 'session', 'fallback']),
  /** Most recent session activity for this gezel in this project, when any. */
  lastActivityAt: z.string().optional(),
});
export type ProjectForGezel = z.infer<typeof ProjectForGezelSchema>;

export const ListProjectsForGezelResponseSchema = z.object({
  projects: z.array(ProjectForGezelSchema),
});
export type ListProjectsForGezelResponse = z.infer<typeof ListProjectsForGezelResponseSchema>;

/**
 * `POST /api/questions` — gezel-side question creation. The MCP tool
 * fills in `gezelId` / `sessionId` / `projectId` from its env-var
 * bridge; clients other than MCP can also post directly (debugging).
 */
export const AskQuestionRequestSchema = z.object({
  projectId: z.string(),
  gezelId: z.string(),
  sessionId: z.string(),
  prompt: z.string().min(1),
  choices: z.array(z.string()).max(20).optional(),
  allowWriteIn: z.boolean().optional(),
  multiSelect: z.boolean().optional(),
  taskRef: TaskRefSchema.optional(),
  documentPath: z.string().optional(),
});
export type AskQuestionRequest = z.infer<typeof AskQuestionRequestSchema>;

export const AskQuestionResponseSchema = z.object({
  questionId: z.string(),
  /**
   * True when the runtime suppressed this call because the session
   * already has an unanswered, intent-less question card — i.e. the
   * gezel re-asked before the user answered the previous one. No new
   * card is created; `questionId` points at the existing one. The MCP
   * tool turns this into a "stop re-asking, end your turn" corrective so
   * a looping model doesn't keep stacking near-duplicate cards.
   */
  deduped: z.boolean().optional(),
});
export type AskQuestionResponse = z.infer<typeof AskQuestionResponseSchema>;

/**
 * `POST /api/permissions/request-and-wait` — synchronous tool-permission
 * gate used by the Claude CLI provider's `--permission-prompt-tool` hook.
 * gezel-mcp posts the request when Claude CLI asks for permission to run
 * an MCP tool; the service creates a `tool-permission` question, blocks
 * the HTTP response until the user answers Allow / Deny, and returns the
 * verdict in the shape Claude CLI expects.
 *
 * The blocking lives entirely on the server side — the call has a
 * generous timeout (default 10 minutes) so the user has time to come
 * back to the app and respond. The client (gezel-mcp) just waits.
 */
export const RequestPermissionRequestSchema = z.object({
  projectId: z.string(),
  gezelId: z.string(),
  sessionId: z.string(),
  toolName: z.string().min(1),
  toolInput: z.record(z.string(), z.unknown()),
});
export type RequestPermissionRequest = z.infer<typeof RequestPermissionRequestSchema>;

/**
 * Response shape mirrors Claude Code's `--permission-prompt-tool`
 * contract verbatim: `behavior: 'allow'` carries the (possibly
 * modified) input the CLI should run with; `behavior: 'deny'` carries
 * a short message the CLI feeds back to the model so it knows why the
 * call didn't go through.
 */
export const RequestPermissionResponseSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.string(), z.unknown()),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string(),
  }),
]);
export type RequestPermissionResponse = z.infer<typeof RequestPermissionResponseSchema>;

/**
 * `POST /api/asks/request-and-wait` — synchronous gezel-to-gezel
 * consultation. The asking gezel's MCP tool (`ask_gezel`) blocks on this
 * endpoint until the target gezel produces a reply (or the call fails).
 *
 * Distinct from the existing `message_gezel` async path: there's no
 * follow-up turn on the asker's side — the target's reply text is
 * returned directly as the tool result, so the asking gezel can use it
 * inline within their current turn.
 *
 * Deadlock protection lives in ChatManager (`askGezelAndWait`):
 *   - cycles in the in-flight ask graph are rejected with `cycle`
 *   - chains deeper than `maxDepth` (default 5) are rejected with `depth`
 *   - idle timeout defaults to 5 min; DS4/frontier local targets use a
 *     15 min floor so slow first action is not mistaken for a dead ask
 *
 * `fromSessionId`/`fromGezelId` are required so the deadlock detector
 * can build the call graph; one-shot callers can't use this tool.
 */
export const RequestAskRequestSchema = z.object({
  fromGezelId: z.string().min(1),
  fromSessionId: z.string().min(1),
  toGezelIdOrName: z.string().min(1),
  projectId: z.string().optional(),
  question: z.string().min(1),
  /** Idle budget (ms). Clamped to [10s, 30min]; default 5 min, with a 15 min DS4/frontier-local floor. */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Optional task to scope the consultation session to. Same shape as
   * `ChatSession.taskRef` — `<projectId>/<num>`. When set, the
   * consultation session is created with this `taskRef` (and optional
   * `stepId`), which injects the task's description, status, and
   * notes into the target gezel's system prompt — same pipeline that
   * powers task-handoff sessions. When unset, the route falls back to
   * the asker's session's `taskRef` if it has one, so a gezel mid-task
   * who asks for help gets that context inherited automatically.
   */
  taskRef: z.string().optional(),
  /** Optional step id within `taskRef`. Ignored when taskRef is unset. */
  stepId: z.string().optional(),
  /**
   * Shape-of-deliverable hint persisted on the consultation session so
   * the target's consultation-mode addendum knows whether to default
   * to chat reply (the historical default — fine for short Q&A) or
   * to file deliverable (right for long-form reviews / analyses).
   * See `ExpectedDeliverableSchema`.
   */
  expectedDeliverable: ExpectedDeliverableSchema.optional(),
});
export type RequestAskRequest = z.infer<typeof RequestAskRequestSchema>;

export const RequestAskResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('reply'),
    /** The target gezel's assistant text. */
    text: z.string(),
    toGezelId: z.string(),
    toGezelName: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    outcome: z.literal('error'),
    /**
     * Why the ask failed. Discriminator values map to specific
     * conditions the calling gezel can branch on:
     *   - `cycle`: A → B (and B is currently asking A directly or transitively).
     *   - `depth`: A → B would push the chain past the max-depth cap.
     *   - `self`: A tried to ask itself.
     *   - `not-found`: target gezel doesn't exist.
     *   - `engagement-off`: AI engagement mode forbids cross-gezel work.
     *   - `timeout`: target didn't reply within the call's timeout.
     *   - `target-error`: target's turn failed (provider error, etc.).
     *   - `target-deleted`: target's session was deleted mid-ask.
     *   - `delivery-failed`: couldn't seed the target's session.
     */
    reason: z.enum([
      'cycle',
      'depth',
      'self',
      'not-found',
      'engagement-off',
      'timeout',
      'target-error',
      'target-deleted',
      'delivery-failed',
    ]),
    message: z.string(),
  }),
]);
export type RequestAskResponse = z.infer<typeof RequestAskResponseSchema>;

/**
 * `POST /api/questions/:id/answer` — user submits a structured answer.
 * At least one of `selectedChoices`, `writeIn`, `declined`, or
 * `silentSkip` must be set. `declined` and `silentSkip` are distinct:
 * `declined` triggers a "proceed with defaults" follow-up turn,
 * `silentSkip` just closes the card with no follow-up.
 */
export const AnswerQuestionRequestSchema = z.object({
  selectedChoices: z.array(z.number().int().min(0)).optional(),
  writeIn: z.string().optional(),
  declined: z.boolean().optional(),
  silentSkip: z.boolean().optional(),
  /** Per-package decisions for `npm-install-approval` questions. */
  npmInstallDecisions: z.array(NpmInstallApprovalDecisionSchema).optional(),
});
export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionRequestSchema>;

export const ListQuestionsResponseSchema = z.object({
  questions: z.array(QuestionSchema),
});
export type ListQuestionsResponse = z.infer<typeof ListQuestionsResponseSchema>;

/**
 * Resolve-and-read for project artifacts. Agents frequently guess paths
 * (pass the basename alone, or include a redundant `artifacts/` prefix);
 * this endpoint tries the exact path first, then falls back to a
 * case-insensitive basename walk. Ambiguous matches surface candidates
 * so the agent can disambiguate on the next call.
 */
export const ResolveArtifactResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('found'),
    content: z.string(),
    path: z.string(),
    fuzzy: z.boolean(),
  }),
  z.object({
    kind: z.literal('ambiguous'),
    candidates: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('missing'),
  }),
]);
export type ResolveArtifactResponse = z.infer<typeof ResolveArtifactResponseSchema>;

/**
 * Slice options for `read_artifact`. At most one of `lines` / `head` /
 * `tail` should be set; combining them is a caller bug we don't
 * actively reject (the implementation picks the first non-undefined
 * in priority `lines` → `head` → `tail`).
 */
export const ReadArtifactSliceOptsSchema = z.object({
  lines: z.object({ start: z.number().int().min(1), count: z.number().int().min(0) }).optional(),
  head: z.number().int().min(0).optional(),
  tail: z.number().int().min(0).optional(),
});
export type ReadArtifactSliceOpts = z.infer<typeof ReadArtifactSliceOptsSchema>;

/**
 * Response shape for `read_artifact` when slice options are passed.
 * Adds `linesReturned` / `totalLines` / `bytesReturned` / `totalBytes`
 * / `hasMore` so the model can paginate without guessing where the
 * file ends. Backwards compatible: callers that pass no opts get a
 * `found` shape with the slice fields covering the full file.
 */
export const ReadArtifactSliceResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('found'),
    content: z.string(),
    path: z.string(),
    fuzzy: z.boolean(),
    linesReturned: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    bytesReturned: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  }),
  z.object({
    kind: z.literal('ambiguous'),
    candidates: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('missing'),
  }),
]);
export type ReadArtifactSliceResponse = z.infer<typeof ReadArtifactSliceResponseSchema>;

/**
 * Request body for `grep_artifact`. `pattern` is a JS RegExp source
 * string; `caseInsensitive` defaults to true (the model rarely cares
 * about exact case). `contextLines` adds N surrounding lines per
 * match; `maxMatches` caps the result so a runaway `.*` pattern
 * can't dump the whole file back through.
 */
export const GrepArtifactRequestSchema = z.object({
  path: z.string().min(1),
  pattern: z.string().min(1),
  caseInsensitive: z.boolean().optional(),
  contextLines: z.number().int().min(0).max(10).optional(),
  maxMatches: z.number().int().min(1).max(100).optional(),
});
export type GrepArtifactRequest = z.infer<typeof GrepArtifactRequestSchema>;

export const GrepArtifactResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('found'),
    matches: z.array(
      z.object({
        lineNumber: z.number().int().min(1),
        line: z.string(),
        contextBefore: z.array(z.string()).optional(),
        contextAfter: z.array(z.string()).optional(),
      }),
    ),
    totalMatches: z.number().int().nonnegative(),
    totalLines: z.number().int().nonnegative(),
    truncated: z.boolean(),
    path: z.string(),
    fuzzy: z.boolean(),
  }),
  z.object({
    kind: z.literal('ambiguous'),
    candidates: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('missing'),
  }),
  z.object({
    kind: z.literal('invalid-pattern'),
    error: z.string(),
  }),
]);
export type GrepArtifactResponse = z.infer<typeof GrepArtifactResponseSchema>;

/**
 * Status of the system-toolset bootstrap (Playwright install + Chromium
 * download). Streamed via SSE from `GET /api/system-toolsets/status` and
 * rendered as pills in the Home screen HealthPanel.
 */
export const SystemBootstrapStatusSchema = z.object({
  phase: z.enum([
    'idle',
    'installing-toolsets',
    'downloading-browser',
    'ready',
    // Terminal non-error state the bootstrap publishes when the shipped
    // manifest is entirely placeholders (dev build before pins exist).
    // Distinct from `error` — nothing failed, but nothing installed,
    // and gezel flows depending on system toolsets won't work. UI
    // renders this as a warning, not green.
    'setup-incomplete',
    'error',
  ]),
  currentToolset: z.string().optional(),
  browserProgress: z
    .object({
      bytesDownloaded: z.number(),
      bytesTotal: z.number().nullable(),
    })
    .optional(),
  error: z.string().optional(),
  updatedAt: z.string(),
});
export type SystemBootstrapStatus = z.infer<typeof SystemBootstrapStatusSchema>;

/**
 * Lifecycle of the lazy MLX Python venv. Surfaced as a header pill so
 * users see a "warming up" signal while uv installs torch / mlx-vlm
 * wheels (1–5 min on first install) instead of a hung chat. Streamed
 * via SSE from `GET /api/mlx/runtime/status/stream`.
 */
export const MlxRuntimeStatusSchema = z.object({
  phase: z.enum(['idle', 'provisioning', 'ready', 'error']),
  message: z.string().optional(),
  error: z.string().optional(),
  updatedAt: z.string(),
});
export type MlxRuntimeStatus = z.infer<typeof MlxRuntimeStatusSchema>;

/**
 * Event streamed while the in-app Copilot login flow runs (the
 * `POST /api/system/copilot-login` endpoint). Fronts an `@github/copilot
 * login` subprocess: stdout/stderr lines relay back verbatim, `exit`
 * signals completion, `error` signals failure to spawn. The UI renders
 * the lines in a terminal-like pane and re-queries
 * `/api/system/copilot-user` after a clean exit.
 */
export const CopilotLoginEventSchema = z.union([
  z.object({ kind: z.literal('stdout'), line: z.string() }),
  z.object({ kind: z.literal('stderr'), line: z.string() }),
  z.object({ kind: z.literal('exit'), code: z.number() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type CopilotLoginEvent = z.infer<typeof CopilotLoginEventSchema>;

/**
 * Progress from a user-triggered on-demand system-toolset install
 * (`POST /api/system-toolsets/:toolsetId/install`).
 *
 * Deliberately separate from {@link SystemBootstrapStatusSchema}: that one
 * is boot health, a single global phase with no job identity. This one
 * belongs to one install the user asked for, and an in-flight copy of it
 * must never move the Home health pill.
 *
 * `log` carries raw pnpm output for the details pane — chunk-sized, not
 * necessarily one line each.
 */
export const SystemToolsetInstallEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('phase'),
    phase: z.enum(['resolving', 'downloading', 'extracting', 'installing-deps', 'publishing']),
  }),
  z.object({
    type: z.literal('progress'),
    bytesWritten: z.number().nonnegative(),
    /** 0 when the registry sent no `content-length`. */
    totalBytes: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal('retrying'),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    reason: z.string(),
  }),
  z.object({ type: z.literal('log'), line: z.string() }),
  z.object({ type: z.literal('done'), installPath: z.string(), version: z.string() }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);
export type SystemToolsetInstallEvent = z.infer<typeof SystemToolsetInstallEventSchema>;

/** Phases an on-demand system-toolset install moves through, in order. */
export type SystemToolsetInstallPhase = Extract<
  SystemToolsetInstallEvent,
  { type: 'phase' }
>['phase'];

/**
 * Server-owned snapshot of one on-demand install, replayed to every new
 * subscriber so a late SSE connection doesn't render a blank progress bar.
 */
export const SystemToolsetInstallSnapshotSchema = z.object({
  toolsetId: z.string(),
  version: z.string(),
  startedAt: z.string(),
  phase: z.enum(['resolving', 'downloading', 'extracting', 'installing-deps', 'publishing']),
  bytesWritten: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  retrying: z
    .object({
      attempt: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      delayMs: z.number().nonnegative(),
      reason: z.string(),
    })
    .optional(),
  /** Tail of the pnpm output, capped so replay stays cheap. */
  log: z.array(z.string()),
  finished: z.boolean(),
  error: z.string().optional(),
  installPath: z.string().optional(),
});
export type SystemToolsetInstallSnapshot = z.infer<typeof SystemToolsetInstallSnapshotSchema>;

/**
 * Whether GitHub Copilot can be used on this device, and how we got there.
 *
 * The Copilot SDK is an on-demand system toolset, so "is it available?" is a
 * ladder, not a boolean on disk: an explicit `COPILOT_CLI_PATH`, then our own
 * managed install, then a Copilot CLI the user installed themselves. The last
 * rung is why this exists — someone who ran `npm i -g @github/copilot` must
 * never be offered a second copy.
 */
export const CopilotAvailabilitySchema = z.object({
  /** The single boolean every "should we offer Copilot?" gate reads. */
  available: z.boolean(),
  /** Which rung answered, or null when none did. */
  source: z.enum(['env', 'managed', 'path']).nullable(),
  /** Our managed install specifically, independent of the other rungs. */
  managed: z.enum(['current', 'outdated', 'absent']),
  /** Version on disk, when `managed !== 'absent'`. */
  installedVersion: z.string().optional(),
  /** Version this build pins. */
  pinnedVersion: z.string(),
  /** Package root of the managed install, for the `copilot login` hint. */
  installDir: z.string().optional(),
  /** Path of a CLI found via `COPILOT_CLI_PATH` or PATH, for display. */
  cliPath: z.string().optional(),
  /** True when a managed install exists but this build pins a different version. */
  updateAvailable: z.boolean(),
});
export type CopilotAvailability = z.infer<typeof CopilotAvailabilitySchema>;

export const ListProjectsResponseSchema = z.object({
  projects: z.array(
    ProjectSchema.extend({
      /** Deep-pass architecture note, present only on `?rollup=1` requests
       *  for projects whose index has been enriched. Truncated ~400 chars. */
      architecture: z.string().optional(),
    }),
  ),
});

/**
 * Project creation. `about` and `missionObjectives` are required at the
 * MCP boundary so voormen landing on a project have real context to work
 * from. `description` stays as the optional one-liner for list views.
 *
 * Persistence: `about` and `missionObjectives` are written to
 * `documents/about.md` + `documents/missionObjectives.md` at creation
 * time (see `Store.createProject`). `getProject` reads them back lazily
 * so the first read after creation returns them populated.
 */
export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  // about/missionObjectives are *encouraged, not required* at the wire level.
  // The New Project dialog still enforces the 60/40 richness minimums for the
  // blank/GitHub flows (where the user is authoring context from scratch), but
  // the "from folder" flow deliberately skips them — a folder project draws its
  // context from the files themselves (an AGENTS.md/CLAUDE.md is auto-read into
  // About), so forcing the user to type a paragraph first is pure friction.
  about: z
    .string()
    .optional()
    .describe(
      "A few paragraphs about who this project is for, what's in scope, what's explicitly out of scope. " +
        'First thing any gezel reads when they join the project.',
    ),
  missionObjectives: z
    .string()
    .optional()
    .describe('Concrete success criteria — usually a bullet list. What does "done" look like?'),
  /**
   * Project shape. `crew` (default) → traditional voorman-coordinates-
   * specialists. `solo` → a "job": one specialist (the ambachtsman) does
   * everything themselves; team-management tools are filtered out for
   * sessions on this project.
   */
  mode: z.enum(['crew', 'solo']).optional(),
  /**
   * Opt out of structural and content indexing for this project's workspace.
   * Missing/true keeps the historical indexing behavior.
   */
  indexingEnabled: z.boolean().optional(),
  /**
   * Optional GitHub repo to associate with the project at creation. When
   * present, the URL is persisted into `project.github.url` and a
   * background clone is kicked off; the project lands ready-to-use on
   * disk by the time the user opens its GitHub tab.
   */
  github: z
    .object({
      url: z.string().url(),
    })
    .optional(),
});

export const UpdateProjectRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  /** null clears the external working directory (falls back to internal). */
  workingDir: z.string().nullable().optional(),
  /** null clears the voorman. */
  voormanGezelId: z.string().nullable().optional(),
  /** When passed, written to documents/about.md inside the project. */
  about: z.string().optional(),
  /** When passed, written to documents/missionObjectives.md inside the project. */
  missionObjectives: z.string().optional(),
  /** Patch the github association. `null` unlinks. Pass an object with `url`
   *  to link or change the repo, or with only `branch` to switch the
   *  tracked branch. `checkoutDir` and `lastSyncedAt` are managed by the
   *  service and ignored here. */
  github: z
    .union([
      z.null(),
      z.object({
        url: z.string().url().optional(),
        branch: z.string().optional(),
      }),
    ])
    .optional(),
  /** Opt-in to allow gezels to modify files in this project's workspace.
   *  Only consulted when `workingDir` is set (external repo); internal
   *  workspaces are always writable. */
  allowGezelWrites: z.boolean().optional(),
  /**
   * Per-project override of the ambient Meester-to-voorman progress-check
   * cadence. The supplied object replaces the stored override, so callers
   * updating one field should preserve any other fields they care about.
   */
  nudgeConfig: ProjectNudgeConfigSchema.optional(),
  /** Replace the project's optional-tab visibility overrides. */
  tabVisibility: ProjectTabVisibilitySchema.optional(),
  /**
   * Enable or disable structural and content indexing for this workspace.
   * Chat history, memories, and shared-document indexing are unaffected.
   */
  indexingEnabled: z.boolean().optional(),
  /**
   * Project-level operational status. `active` (default) lets ambient
   * gezel work flow; `readonly` and `inactive` pause meester nudges,
   * auto-phase-advance handoffs, cron-tick recording, and boot-time
   * rehydration. `stable` is the same ambient-pause as those, but is the
   * lifecycle-owned "finished/at rest" state — set automatically when a
   * project's last active task closes and cleared when task work
   * resumes. Chat remains functional in all states.
   */
  status: z.enum(['active', 'readonly', 'inactive', 'stable']).optional(),
  /** Per-project override of the `run_nodejs_script` wall-clock timeout. */
  workspaceScriptTimeoutMs: z
    .number()
    .int()
    .min(30_000)
    .max(30 * 60_000)
    .optional(),
  /**
   * Explicit list of named credentials this project may resolve at
   * runtime (e.g. "github.token"). Credentials are stored globally
   * in the `SecretStore`; this list is the per-project grant so the
   * same credential can be shared across projects the user has
   * authorized. `[]` revokes all grants.
   */
  grantedCredentials: z.array(z.string()).optional(),
  /**
   * Replace advanced HTTPS-origin bindings for toolset credentials. Built-in
   * provider and webhook destinations are controlled by the service.
   */
  credentialAllowedOrigins: z.record(z.string(), z.array(HttpsOriginSchema)).optional(),
  /**
   * Explicit override of the project's type (an id from the project-type
   * taxonomy). Drives which craftbooks the rail suggests. `null` clears the
   * override and falls back to auto-detection.
   */
  projectTypeId: z.string().nullable().optional(),
  /**
   * Merge values into the project's shared configuration bag (see core
   * `project-properties.ts`). Empty-string values delete the key; keys
   * not mentioned are untouched.
   */
  properties: z.record(z.string(), z.string()).optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

/**
 * Apply a custom project type to an existing project. See
 * docs/project-types.md — the service resolves the type from the catalog and
 * runs the instantiation engine.
 */
export const ApplyProjectTypeRequestSchema = z.object({
  /** Catalog id of the project type to apply. */
  typeId: z.string().min(1),
  /** Explicit version pin; default = catalog's auto-resolved latest. */
  version: z.string().optional(),
  /** Param values collected at adoption, substituted into templates + seed files. */
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ApplyProjectTypeRequest = z.infer<typeof ApplyProjectTypeRequestSchema>;

/** One declared schedule's materialization outcome (see `schedulesCreated`). */
export const ScheduleMaterializationSchema = z.object({
  /** Host task ref (`projectId/num`). */
  ref: z.string(),
  craftbook: z.string(),
  cron: z.string(),
  consent: z.enum(['ask', 'auto', 'disabled']),
  status: z.enum(['active', 'paused']),
  /** False on an idempotent re-apply that matched an existing host. */
  created: z.boolean(),
});
export type ScheduleMaterialization = z.infer<typeof ScheduleMaterializationSchema>;

/**
 * What applying a project type materialized, plus what it deferred to later
 * phases (toolsets, script-tools, Output pages, schedules). The instantiation
 * engine's return shape; surfaced verbatim to callers.
 */
export const AppliedProjectTypeSchema = z.object({
  typeId: z.string(),
  version: z.string(),
  source: z.string(),
  gezelsCreated: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      templateId: z.string(),
      voorman: z.boolean(),
    }),
  ),
  scriptsInstalled: z.array(z.string()),
  workspaceSeeded: z.array(z.string()),
  /** Toolset ids registered into the project scope on adoption (http-mcp — just a URL). */
  toolsetsInstalled: z.array(z.string()),
  /**
   * Names of the type's script-backed tools. Type-owned references (the
   * copy-vs-reference rule): nothing installs — sessions resolve the
   * binding from `projectType` provenance and register the tools live.
   */
  toolsBound: z.array(z.string()),
  /**
   * Craftbooks newly copy-installed into the project this apply (with
   * provenance sidecars). A clean re-apply reports [] here — unchanged
   * copies are skipped, user-modified copies are left alone.
   */
  craftbooksInstalled: z.array(z.string()),
  /**
   * Schedule hosts materialized (or matched) for the type's `schedules[]`.
   * `status` reflects the consent rule — only `consent:'auto'` arms on
   * adoption; `created:false` marks an idempotent re-apply match.
   */
  schedulesCreated: z.array(ScheduleMaterializationSchema),
  aboutRendered: z.boolean(),
  missionRendered: z.boolean(),
  deferred: z.object({
    /**
     * Toolsets the type declares that were NOT auto-registered — npm-package
     * (needs a consent-gated code download) and builtin (needs a per-gezel
     * group unlock). Install these explicitly. http-mcp toolsets install on
     * adoption and appear in `toolsetsInstalled` instead.
     */
    toolsets: z.array(z.string()),
    /** Declared craftbook ids that failed to resolve or install. */
    craftbooks: z.array(z.string()),
    pages: z.boolean(),
    /** Count of declared schedules that failed to materialize. */
    schedules: z.number(),
  }),
});
export type AppliedProjectType = z.infer<typeof AppliedProjectTypeSchema>;

/**
 * Atomically create a project from a catalog project type. Unlike the legacy
 * client-side create-then-apply sequence, the service does not publish the
 * project until the type has been completely materialized.
 */
export const CreateTypedProjectRequestSchema = CreateProjectRequestSchema.pick({
  name: true,
  description: true,
  mode: true,
}).extend({
  projectType: ApplyProjectTypeRequestSchema,
});
export type CreateTypedProjectRequest = z.infer<typeof CreateTypedProjectRequestSchema>;

export const CreateTypedProjectResponseSchema = z.object({
  project: ProjectDetailSchema,
  applied: AppliedProjectTypeSchema,
});
export type CreateTypedProjectResponse = z.infer<typeof CreateTypedProjectResponseSchema>;

// ── Git operations (per-project, host-agnostic) ─────────────────────

export const GitStatusResponseSchema = z.object({
  github: ProjectGitHubSchema.optional(),
  /** Whether a checkout exists on disk at github.checkoutDir. */
  exists: z.boolean(),
  /** Whether the checkout's `origin` remote matches `github.url`. */
  originMatches: z.boolean().optional(),
  /** Current local branch (HEAD), if exists. */
  branch: z.string().optional(),
  /** Repo default branch, when already detected and cached (never triggers network). */
  defaultBranch: z.string().optional(),
  /** Commits ahead of upstream, if known. */
  ahead: z.number().int().optional(),
  /** Commits behind upstream, if known. */
  behind: z.number().int().optional(),
  /** Working tree dirty (uncommitted changes), if known. */
  dirty: z.boolean().optional(),
  /** Number of changed files in the working tree (renames count once). */
  changesCount: z.number().int().optional(),
  /** Number of files with unresolved merge conflicts. */
  conflictedCount: z.number().int().optional(),
  /** True while a merge started by Sync is waiting on conflict resolution. */
  mergeInProgress: z.boolean().optional(),
  /** True when the current branch has an upstream (or matching origin ref). */
  hasUpstream: z.boolean().optional(),
  /** True when the github toolset has a stored PAT. */
  hasPat: z.boolean(),
  /**
   * Where GitHub credentials come from: a stored toolset PAT, the
   * GH_TOKEN/GITHUB_TOKEN env vars, the signed-in GitHub CLI, or nothing.
   */
  credentialSource: z.enum(['pat', 'env', 'gh', 'none']),
});
export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;
export type GitHubCredentialSource = GitStatusResponse['credentialSource'];

export const GitCloneResponseSchema = z.object({
  ok: z.literal(true),
  checkoutDir: z.string(),
  branch: z.string().optional(),
  /** True when a pre-existing repo at workingDir was adopted. */
  adopted: z.boolean(),
});
export type GitCloneResponse = z.infer<typeof GitCloneResponseSchema>;

export const GitBranchSwitchRequestSchema = z.object({
  branch: z.string().min(1),
  /**
   * When true, create the branch from current HEAD (`git checkout -b`).
   * When false/undefined, switch to an existing branch (`git checkout`).
   */
  create: z.boolean().optional(),
});
export type GitBranchSwitchRequest = z.infer<typeof GitBranchSwitchRequestSchema>;

export const GitBranchesResponseSchema = z.object({
  /** Local branches that exist in the checkout. */
  local: z.array(z.string()),
  /** Remote branches under `origin/` with the prefix stripped. Already
   *  deduped against `local` so the UI can render both groups without
   *  double-listing branches that have a tracking pair. */
  remote: z.array(z.string()),
  /** Currently-checked-out branch, when there is one. Undefined in detached HEAD. */
  current: z.string().optional(),
});
export type GitBranchesResponse = z.infer<typeof GitBranchesResponseSchema>;

export const GitFetchResponseSchema = z.object({
  ok: z.literal(true),
  /** True when `git fetch` advanced any ref. */
  fetched: z.boolean(),
});
export type GitFetchResponse = z.infer<typeof GitFetchResponseSchema>;

export const GitCommitRequestSchema = z.object({
  message: z.string().min(1),
  /** Allow committing with no changes. Defaults to false. */
  allowEmpty: z.boolean().optional(),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequestSchema>;

export const GitCommitResponseSchema = z.object({
  ok: z.literal(true),
  sha: z.string(),
  filesChanged: z.number().int(),
});
export type GitCommitResponse = z.infer<typeof GitCommitResponseSchema>;

export const GitPushResponseSchema = z.object({
  ok: z.literal(true),
  pushed: z.boolean(),
  /** When push didn't land, the broad reason class. */
  rejected: z.enum(['non-fast-forward', 'auth', 'unknown']).optional(),
});
export type GitPushResponse = z.infer<typeof GitPushResponseSchema>;

export const GitHubPullSummarySchema = z.object({
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  draft: z.boolean(),
  updatedAt: z.string(),
  url: z.string(),
});
export type GitHubPullSummary = z.infer<typeof GitHubPullSummarySchema>;

export const ListGitHubPullsResponseSchema = z.object({
  pulls: z.array(GitHubPullSummarySchema),
});
export type ListGitHubPullsResponse = z.infer<typeof ListGitHubPullsResponseSchema>;

export const GitHubPullDetailSchema = GitHubPullSummarySchema.extend({
  body: z.string(),
  state: z.string(),
  merged: z.boolean(),
  mergeable: z.boolean().nullable().optional(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
});
export type GitHubPullDetail = z.infer<typeof GitHubPullDetailSchema>;

export const GitHubPullFileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changes: z.number().int(),
  /** Truncated unified diff hunk, if returned by GitHub. */
  patch: z.string().optional(),
  /** Prior path when `status === 'renamed'`. */
  previousFilename: z.string().optional(),
});
export type GitHubPullFile = z.infer<typeof GitHubPullFileSchema>;

export const ListGitHubPullFilesResponseSchema = z.object({
  files: z.array(GitHubPullFileSchema),
});
export type ListGitHubPullFilesResponse = z.infer<typeof ListGitHubPullFilesResponseSchema>;

export const GitHubPullCommentSchema = z.object({
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** 'issue' = top-level PR comment, 'review' = inline code review comment. */
  kind: z.enum(['issue', 'review']),
  /** For review comments: the file path being commented on. */
  path: z.string().optional(),
});
export type GitHubPullComment = z.infer<typeof GitHubPullCommentSchema>;

export const ListGitHubPullCommentsResponseSchema = z.object({
  comments: z.array(GitHubPullCommentSchema),
});
export type ListGitHubPullCommentsResponse = z.infer<typeof ListGitHubPullCommentsResponseSchema>;

export const GitHubPullDiffResponseSchema = z.object({
  number: z.number().int(),
  diff: z.string(),
});
export type GitHubPullDiffResponse = z.infer<typeof GitHubPullDiffResponseSchema>;

export const GitHubCreateCommentRequestSchema = z.object({
  body: z.string().min(1),
});
export type GitHubCreateCommentRequest = z.infer<typeof GitHubCreateCommentRequestSchema>;

export const GitHubCreateCommentResponseSchema = z.object({
  id: z.number(),
  url: z.string(),
});
export type GitHubCreateCommentResponse = z.infer<typeof GitHubCreateCommentResponseSchema>;

export const GitHubCreatePullRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  head: z.string().min(1),
  base: z.string().min(1),
  draft: z.boolean().optional(),
});
export type GitHubCreatePullRequest = z.infer<typeof GitHubCreatePullRequestSchema>;

export const GitHubCreatePullResponseSchema = z.object({
  number: z.number().int(),
  url: z.string(),
});
export type GitHubCreatePullResponse = z.infer<typeof GitHubCreatePullResponseSchema>;

export const GitHubWorkflowRunSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  createdAt: z.string(),
  url: z.string(),
});
export type GitHubWorkflowRun = z.infer<typeof GitHubWorkflowRunSchema>;

export const ListGitHubWorkflowRunsResponseSchema = z.object({
  runs: z.array(GitHubWorkflowRunSchema),
});
export type ListGitHubWorkflowRunsResponse = z.infer<typeof ListGitHubWorkflowRunsResponseSchema>;

export const GitHubCheckStatusResponseSchema = z.object({
  state: z.enum(['success', 'failure', 'pending', 'unknown']),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      url: z.string().optional(),
    }),
  ),
});
export type GitHubCheckStatusResponse = z.infer<typeof GitHubCheckStatusResponseSchema>;

// ── GitHub tab: changes / sync / merge (per-project) ─────────────────

export const GitChangeKindSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'conflicted',
]);
export type GitChangeKind = z.infer<typeof GitChangeKindSchema>;

export const GitWorkingChangeSchema = z.object({
  /** Path relative to the checkout root, forward slashes. */
  path: z.string(),
  /** For renames: the previous path. */
  oldPath: z.string().optional(),
  kind: GitChangeKindSchema,
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  binary: z.boolean().optional(),
});
export type GitWorkingChange = z.infer<typeof GitWorkingChangeSchema>;

export const GitChangesResponseSchema = z.object({
  changes: z.array(GitWorkingChangeSchema),
  /** Total number of changed files before the listing cap. */
  total: z.number().int(),
  truncated: z.boolean(),
});
export type GitChangesResponse = z.infer<typeof GitChangesResponseSchema>;

export const GitFileDiffResponseSchema = z.object({
  path: z.string(),
  kind: GitChangeKindSchema,
  oldPath: z.string().optional(),
  binary: z.boolean(),
  truncated: z.boolean(),
  /** Unified diff text. Absent for binary files. */
  diff: z.string().optional(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
});
export type GitFileDiffResponse = z.infer<typeof GitFileDiffResponseSchema>;

export const GitDiscardRequestSchema = z
  .object({
    /** Specific files to restore to their last-saved state. */
    paths: z.array(z.string().min(1)).min(1).optional(),
    /** Discard every change in the working tree. */
    all: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.all) !== Boolean(v.paths?.length), {
    message: 'Pass exactly one of `paths` or `all`.',
  });
export type GitDiscardRequest = z.infer<typeof GitDiscardRequestSchema>;

export const GitDiscardResponseSchema = z.object({
  ok: z.literal(true),
  discarded: z.number().int(),
});
export type GitDiscardResponse = z.infer<typeof GitDiscardResponseSchema>;

export const GitLogEntrySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  author: z.string(),
  email: z.string().optional(),
  /** ISO-8601 author date. */
  date: z.string(),
  subject: z.string(),
  filesChanged: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type GitLogEntry = z.infer<typeof GitLogEntrySchema>;

export const GitLogResponseSchema = z.object({
  commits: z.array(GitLogEntrySchema),
  hasMore: z.boolean(),
});
export type GitLogResponse = z.infer<typeof GitLogResponseSchema>;

export const GitCommitDetailResponseSchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  author: z.string(),
  date: z.string(),
  subject: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      additions: z.number().int().optional(),
      deletions: z.number().int().optional(),
      binary: z.boolean().optional(),
    }),
  ),
  /** Unified diff of the whole commit (may be empty for clean merges). */
  diff: z.string().optional(),
  truncated: z.boolean(),
});
export type GitCommitDetailResponse = z.infer<typeof GitCommitDetailResponseSchema>;

export const GitSyncStateSchema = z.enum([
  'synced',
  'needs-save',
  'conflicts',
  'auth',
  'offline',
  'error',
]);
export type GitSyncState = z.infer<typeof GitSyncStateSchema>;

export const GitSyncResponseSchema = z.object({
  state: GitSyncStateSchema,
  /** Commits received from GitHub this sync. */
  pulled: z.number().int(),
  /** Commits sent to GitHub this sync. */
  pushed: z.number().int(),
  /** True when a merge commit was created to combine histories. */
  merged: z.boolean().optional(),
  branch: z.string().optional(),
  conflictedFiles: z.array(z.string()).optional(),
  /** Human-readable detail for `state: 'error'`. */
  message: z.string().optional(),
});
export type GitSyncResponse = z.infer<typeof GitSyncResponseSchema>;

export const GitConflictKindSchema = z.enum([
  'both-modified',
  'both-added',
  'deleted-by-us',
  'deleted-by-them',
]);
export type GitConflictKind = z.infer<typeof GitConflictKindSchema>;

export const GitConflictFileSchema = z.object({
  path: z.string(),
  kind: GitConflictKindSchema,
});
export type GitConflictFile = z.infer<typeof GitConflictFileSchema>;

export const GitMergeStateResponseSchema = z.object({
  inMerge: z.boolean(),
  conflicts: z.array(GitConflictFileSchema),
});
export type GitMergeStateResponse = z.infer<typeof GitMergeStateResponseSchema>;

export const GitConflictVersionsResponseSchema = z.object({
  path: z.string(),
  /** Common-ancestor content. Absent when both sides added the file. */
  base: z.string().optional(),
  /** The local ("keep mine") side. Absent when deleted locally. */
  ours: z.string().optional(),
  /** The remote ("keep GitHub's") side. Absent when deleted on GitHub. */
  theirs: z.string().optional(),
  binary: z.boolean(),
  /** True when a side exceeded the content cap — contents omitted. */
  tooLarge: z.boolean(),
});
export type GitConflictVersionsResponse = z.infer<typeof GitConflictVersionsResponseSchema>;

export const GitResolveConflictRequestSchema = z
  .object({
    path: z.string().min(1),
    choice: z.enum(['mine', 'theirs', 'custom']),
    /** Full file content; required when `choice` is `custom`. */
    content: z.string().optional(),
  })
  .refine((v) => v.choice !== 'custom' || v.content !== undefined, {
    message: '`content` is required when choice is `custom`.',
  });
export type GitResolveConflictRequest = z.infer<typeof GitResolveConflictRequestSchema>;

export const GitResolveConflictResponseSchema = z.object({
  ok: z.literal(true),
  /** Conflicted files still unresolved after this resolution. */
  remaining: z.number().int(),
});
export type GitResolveConflictResponse = z.infer<typeof GitResolveConflictResponseSchema>;

export const GitCompleteMergeRequestSchema = z.object({
  message: z.string().optional(),
});
export type GitCompleteMergeRequest = z.infer<typeof GitCompleteMergeRequestSchema>;

export const GitCompleteMergeResponseSchema = z.object({
  ok: z.literal(true),
  sha: z.string(),
});
export type GitCompleteMergeResponse = z.infer<typeof GitCompleteMergeResponseSchema>;

export const GitAbandonMergeResponseSchema = z.object({
  ok: z.literal(true),
});
export type GitAbandonMergeResponse = z.infer<typeof GitAbandonMergeResponseSchema>;

export const GitSuggestMessageResponseSchema = z.object({
  message: z.string(),
});
export type GitSuggestMessageResponse = z.infer<typeof GitSuggestMessageResponseSchema>;

export const GitAiMergeRequestSchema = z.object({
  path: z.string().min(1),
});
export type GitAiMergeRequest = z.infer<typeof GitAiMergeRequestSchema>;

export const GitAiMergeResponseSchema = z.object({
  path: z.string(),
  /** Proposed merged file content — a preview, never auto-applied. */
  merged: z.string(),
});
export type GitAiMergeResponse = z.infer<typeof GitAiMergeResponseSchema>;

// ── Code review (git change-set reviews) ────────────────────────────
// Pure local-git feature (no GitHub API involved), hence the unprefixed
// CodeReview* names — the SecurityFinding* precedent for project routes.

export const CodeReviewKindSchema = z.enum(['commit', 'pr']);
export type CodeReviewKind = z.infer<typeof CodeReviewKindSchema>;

/**
 * Persisted lifecycle only. "Paused / needs attention" is a live *task*
 * condition derived at read time (see {@link CodeReviewSchema}), never
 * persisted — the settle hook is the record's single writer after start.
 */
export const CodeReviewStatusSchema = z.enum(['running', 'complete', 'canceled', 'error']);
export type CodeReviewStatus = z.infer<typeof CodeReviewStatusSchema>;

/** The durable per-project review record (code-reviews.json rows). */
export const CodeReviewRecordSchema = z.object({
  /** Sortable id: `{kind}-{YYYYMMDD-HHmmss}-{4 hex}`. */
  id: z.string().min(1),
  kind: CodeReviewKindSchema,
  status: CodeReviewStatusSchema,
  createdAt: z.string(),
  settledAt: z.string().optional(),
  outcome: z.enum(['complete', 'canceled']).optional(),
  /** Status `error` only — why the review record was abandoned. */
  error: z.string().optional(),
  /** The review task, as "{projectId}/{num}". */
  taskRef: z.string().min(1),
  /** Reviewer gezel the task was assigned to. */
  gezelId: z.string().optional(),
  /** Branch under review at snapshot time ("(detached)" for a commit review off-branch). */
  branch: z.string(),
  headSha: z.string(),
  /** pr: "origin/<defaultBranch>"; commit: "HEAD". */
  baseRef: z.string().optional(),
  /** pr: the merge-base sha. */
  baseSha: z.string().optional(),
  filesChanged: z.number().int(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  /** pr only — commits on the branch beyond the base. */
  commitCount: z.number().int().optional(),
  /** File list hit MAX_CHANGE_ENTRIES. */
  filesTruncated: z.boolean(),
  /** changes.diff hit the review diff cap. */
  diffTruncated: z.boolean(),
  /** Artifact paths (relative to the project artifacts drawer). */
  manifestPath: z.string(),
  diffPath: z.string(),
  reportPath: z.string(),
});
export type CodeReviewRecord = z.infer<typeof CodeReviewRecordSchema>;

/** Wire shape: the record enriched with live task-derived fields (best-effort). */
export const CodeReviewSchema = CodeReviewRecordSchema.extend({
  taskStatus: z.enum(['draft', 'paused', 'active', 'complete', 'canceled']).optional(),
  /** True when the review task is paused (e.g. gate maxAttempts exhausted). */
  needsAttention: z.boolean().optional(),
  activeStepName: z.string().optional(),
  stepsTotal: z.number().int().optional(),
  stepsComplete: z.number().int().optional(),
  assigneeName: z.string().optional(),
});
export type CodeReview = z.infer<typeof CodeReviewSchema>;

export const StartCodeReviewRequestSchema = z.object({
  kind: CodeReviewKindSchema,
});
export type StartCodeReviewRequest = z.infer<typeof StartCodeReviewRequestSchema>;

export const StartCodeReviewResponseSchema = z.object({
  ok: z.literal(true),
  review: CodeReviewSchema,
});
export type StartCodeReviewResponse = z.infer<typeof StartCodeReviewResponseSchema>;

export const ListCodeReviewsResponseSchema = z.object({
  reviews: z.array(CodeReviewSchema),
});
export type ListCodeReviewsResponse = z.infer<typeof ListCodeReviewsResponseSchema>;

export const CodeReviewResponseSchema = CodeReviewSchema;
export type CodeReviewResponse = z.infer<typeof CodeReviewResponseSchema>;

export const CancelCodeReviewResponseSchema = z.object({
  ok: z.literal(true),
  review: CodeReviewSchema,
});
export type CancelCodeReviewResponse = z.infer<typeof CancelCodeReviewResponseSchema>;

/**
 * The snapshot manifest written to `reviews/<reviewId>/manifest.json` in
 * the project artifacts drawer — the reviewer gezel's stable input. The
 * unified diff lives beside it (`diffFile`); for branch reviews the
 * commit list is embedded here (no separate commits file).
 */
export const CodeReviewManifestSchema = z.object({
  version: z.literal(1),
  reviewId: z.string().min(1),
  kind: CodeReviewKindSchema,
  projectId: z.string().min(1),
  createdAt: z.string(),
  branch: z.string(),
  headSha: z.string(),
  /** pr: "origin/<defaultBranch>"; commit: "HEAD". */
  baseRef: z.string(),
  /** pr: merge-base sha; commit: the head sha itself. */
  baseSha: z.string(),
  files: z.array(GitWorkingChangeSchema),
  totalFiles: z.number().int(),
  filesTruncated: z.boolean(),
  /** Sibling diff file name (always "changes.diff"). */
  diffFile: z.string(),
  diffChars: z.number().int(),
  diffTruncated: z.boolean(),
  /** pr only — newest first, capped at 200. */
  commits: z.array(GitLogEntrySchema).optional(),
  commitsTruncated: z.boolean().optional(),
  /** Human-readable caveats (offline fetch, binary files excluded, …). */
  notes: z.array(z.string()),
});
export type CodeReviewManifest = z.infer<typeof CodeReviewManifestSchema>;

export const ProjectResponseSchema = ProjectDetailSchema;

export const InstallPackageRequestSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
});

export const InstallPackageResponseSchema = z.object({
  project: ProjectDetailSchema,
  log: z.string(),
});

/**
 * Scripts defined in the project workspace's `package.json`. Keys are
 * script names (`build`, `test`, `lint`, …), values the script bodies.
 * `packageManager` is parsed from `package.json#packageManager` when set
 * — informational only today.
 */
export const ListPackageScriptsResponseSchema = z.object({
  scripts: z.record(z.string(), z.string()),
  packageManager: z.string().optional(),
});
export type ListPackageScriptsResponse = z.infer<typeof ListPackageScriptsResponseSchema>;

/**
 * Shared outcome shape for the two command-execution tools. Mirrors
 * `runWorkspaceScript`'s result envelope, plus approval-flow fields for
 * first-use gating.
 *
 *  - `approvalPending` / `questionId`: the gezel called the tool on a
 *    script/bin the user hasn't approved yet. A question was posted;
 *    the turn should end. A follow-up seed arrives when the user answers.
 *  - `declined`: the user previously declined this script/bin — don't retry.
 */
const RunWorkspaceCommandResponseSchema = z.object({
  ok: z.boolean(),
  code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  timedOut: z.boolean(),
  error: z.string().optional(),
  approvalPending: z.boolean().optional(),
  questionId: z.string().optional(),
  declined: z.string().optional(),
  resolvedBinPath: z.string().optional(),
});

export const RunPackageScriptRequestSchema = z.object({
  script: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type RunPackageScriptRequest = z.infer<typeof RunPackageScriptRequestSchema>;
export const RunPackageScriptResponseSchema = RunWorkspaceCommandResponseSchema;
export type RunPackageScriptResponse = z.infer<typeof RunPackageScriptResponseSchema>;

export const RunNpxRequestSchema = z.object({
  bin: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type RunNpxRequest = z.infer<typeof RunNpxRequestSchema>;
export const RunNpxResponseSchema = RunWorkspaceCommandResponseSchema;
export type RunNpxResponse = z.infer<typeof RunNpxResponseSchema>;

/**
 * Aggregated approval state for a project — what the user has explicitly
 * approved or declined for `npm_install`, `run_package_script`, and
 * `run_npx`. Powers the per-project Approvals UI: the user can see at
 * a glance which packages and commands their gezels are trusted to
 * invoke without re-prompting, and (eventually) revoke decisions.
 *
 * `npmShipped` is the gezel-bundled allowlist of common-and-safe
 * packages — pre-approved on every install with no per-project entry
 * needed. Surfaced here so the user knows why some packages installed
 * silently.
 */
export const ProjectApprovalsResponseSchema = z.object({
  npmApproved: z.array(
    z.object({
      package: z.string(),
      version: z.string(),
      at: z.string(),
      approvedBy: z.enum(['user', 'shipped']),
    }),
  ),
  npmDeclined: z.array(
    z.object({
      package: z.string(),
      version: z.string(),
      at: z.string(),
    }),
  ),
  scriptApprovals: z.record(z.string(), z.enum(['approved', 'declined'])),
  npxApprovals: z.record(z.string(), z.enum(['approved', 'declined'])),
  npmShipped: z.array(
    z.object({
      package: z.string(),
      allowedVersions: z.array(z.string()),
    }),
  ),
});
export type ProjectApprovalsResponse = z.infer<typeof ProjectApprovalsResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ── Tool-bridge endpoints ─────────────────────────────────────────────
// Server-side implementations of cross-platform "bash-ish" and network
// tools the MCP server exposes to gezels. The MCP subprocess is thin —
// it validates args locally then hits the service, which owns policy
// (URL allow/deny, project workspace scoping, etc.) and can emit
// history events uniformly with the rest of the tool surface.

export const FetchUrlRequestSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .optional(),
});
export type FetchUrlRequest = z.infer<typeof FetchUrlRequestSchema>;

export const FetchUrlResponseSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  /** Populated when the body decoded cleanly as text. */
  body: z.string().optional(),
  /** Populated instead of `body` when the content was binary. */
  bodyBase64: z.string().optional(),
  mimeType: z.string().optional(),
  truncated: z.boolean(),
});
export type FetchUrlResponse = z.infer<typeof FetchUrlResponseSchema>;

export const WebSearchRequestSchema = z.object({
  query: z.string().min(1).max(400),
  /** 1..20. Route normalizes; provider may return fewer results. */
  limit: z.number().int().min(1).max(20).optional(),
  /** Restrict to recently-published pages. Honored by Brave; Wikipedia ignores. */
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  /** ISO-3166 country bias (e.g. "us"). Brave-only. */
  country: z.string().length(2).optional(),
  /** BCP-47 language code (e.g. "en"). Honored by Brave + Wikipedia. */
  language: z.string().min(2).max(8).optional(),
});
export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;

export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  domain: z.string(),
  /** ISO 8601 when the backend supplies it. */
  publishedAt: z.string().optional(),
  source: z.enum(['brave', 'wikipedia', 'tavily', 'mock']),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/**
 * `wikipedia_search` request — narrower than {@link WebSearchRequestSchema}
 * because the Wikipedia corpus is timeless (no `freshness`) and language-
 * keyed by article corpus rather than country (no `country`).
 */
export const WikipediaSearchRequestSchema = z.object({
  query: z.string().min(1).max(400),
  limit: z.number().int().min(1).max(20).optional(),
  /** BCP-47 language code; selects the Wikipedia corpus. */
  language: z.string().min(2).max(8).optional(),
});
export type WikipediaSearchRequest = z.infer<typeof WikipediaSearchRequestSchema>;

export const WebSearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  /** Identifier of the provider that actually answered. */
  source: z.enum(['brave', 'wikipedia', 'tavily', 'mock']),
  /** Echo of the input query for at-a-glance debug. */
  query: z.string(),
  /** Round-trip duration in milliseconds. */
  durationMs: z.number().int().nonnegative(),
});
export type WebSearchResponse = z.infer<typeof WebSearchResponseSchema>;

export const SearchFilesRequestSchema = z.object({
  pattern: z.string().min(1),
  /** Path prefix (relative to project workspace). Defaults to project root. */
  path: z.string().optional(),
  /** Glob filter for filenames (e.g. `**\/*.ts`). Applied post-walk. */
  glob: z.string().optional(),
  caseInsensitive: z.boolean().optional(),
  /** When true, treat pattern as a literal string (escape regex metacharacters). */
  literal: z.boolean().optional(),
  maxResults: z.number().int().positive().max(1000).optional(),
});
export type SearchFilesRequest = z.infer<typeof SearchFilesRequestSchema>;

export const SearchFilesMatchSchema = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  text: z.string(),
});
export type SearchFilesMatch = z.infer<typeof SearchFilesMatchSchema>;

export const SearchFilesResponseSchema = z.object({
  matches: z.array(SearchFilesMatchSchema),
  truncated: z.boolean(),
  engine: z.enum(['ripgrep', 'javascript']),
});
export type SearchFilesResponse = z.infer<typeof SearchFilesResponseSchema>;

export const FindFilesRequestSchema = z.object({
  glob: z.string().min(1),
  path: z.string().optional(),
  caseInsensitive: z.boolean().optional(),
  maxResults: z.number().int().positive().max(5000).optional(),
});
export type FindFilesRequest = z.infer<typeof FindFilesRequestSchema>;

export const FindFilesResponseSchema = z.object({
  files: z.array(z.string()),
  truncated: z.boolean(),
});
export type FindFilesResponse = z.infer<typeof FindFilesResponseSchema>;

// ── code-intel (workspace code intelligence) ────────────────────────────────
// Every result carries 1-based inclusive line ranges so the model's next move
// is a precise `read_file(path, { startLine, endLine })` — see the plan's
// "shared result conventions".

export const CodeSymbolSchema = z.object({
  /** Stable id `path#name` for multi-step flows. */
  id: z.string(),
  name: z.string(),
  /** function | method | class | interface | type | enum | h1..h6 | … */
  kind: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  signature: z.string().optional(),
  /** Enclosing container (e.g. the class a method belongs to). */
  parent: z.string().optional(),
});
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;

export const OutlineFileRequestSchema = z.object({
  path: z.string().min(1),
});
export type OutlineFileRequest = z.infer<typeof OutlineFileRequestSchema>;

export const OutlineFileResponseSchema = z.object({
  path: z.string(),
  lang: z.string().nullable(),
  summary: z.string().nullable().optional(),
  symbols: z.array(CodeSymbolSchema),
  totalLines: z.number().int().nonnegative(),
  /** index = from the persisted index; live = extracted on demand. */
  engine: z.enum(['index', 'live', 'unavailable']),
  truncated: z.boolean(),
  /** Boekwachter review for this file@hash; absent until the review pass ran. */
  review: FileReviewWireSchema.optional(),
});
export type OutlineFileResponse = z.infer<typeof OutlineFileResponseSchema>;

export const FindSymbolRequestSchema = z.object({
  name: z.string().min(1),
  kind: z.string().optional(),
  maxResults: z.number().int().positive().max(200).optional(),
});
export type FindSymbolRequest = z.infer<typeof FindSymbolRequestSchema>;

export const FindSymbolResponseSchema = z.object({
  matches: z.array(CodeSymbolSchema.extend({ path: z.string() })),
  truncated: z.boolean(),
  engine: z.enum(['index', 'unavailable']),
});
export type FindSymbolResponse = z.infer<typeof FindSymbolResponseSchema>;

export const ReadSymbolRequestSchema = z.object({
  name: z.string().min(1),
  /** Disambiguate when the same name is defined in several files. */
  path: z.string().optional(),
});
export type ReadSymbolRequest = z.infer<typeof ReadSymbolRequestSchema>;

export const ReadSymbolResponseSchema = z.object({
  found: z.boolean(),
  path: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  signature: z.string().optional(),
  source: z.string().optional(),
});
export type ReadSymbolResponse = z.infer<typeof ReadSymbolResponseSchema>;

export const FindReferencesRequestSchema = z.object({
  name: z.string().min(1),
  glob: z.string().optional(),
  maxResults: z.number().int().positive().max(500).optional(),
});
export type FindReferencesRequest = z.infer<typeof FindReferencesRequestSchema>;

export const FindReferencesResponseSchema = z.object({
  references: z.array(
    z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() }),
  ),
  truncated: z.boolean(),
  /** v1 is lexical (identifier match), labelled honestly. */
  engine: z.enum(['ripgrep', 'javascript']),
});
export type FindReferencesResponse = z.infer<typeof FindReferencesResponseSchema>;

// ── file-context (per-symbol intelligence for the file viewer) ──────────────
// Structured FACTS only — hosts (the Map file viewer, the vscode extension)
// compose their own markdown from these via `composeFileContext` in
// core/src/code-intel. Dependency attribution is honest about its limits:
// symbol-level inbound comes from named import bindings (JS/TS; best-effort
// Python); default/namespace/unrecorded imports count as whole-file.

export const FileContextRequestSchema = z.object({
  path: z.string().min(1),
});
export type FileContextRequest = z.infer<typeof FileContextRequestSchema>;

export const FileContextFindingSchema = z.object({
  ruleId: z.string(),
  category: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  /** 1-based line, null when whole-file. */
  line: z.number().int().positive().nullable(),
  title: z.string(),
  source: z.string(),
});
export type FileContextFinding = z.infer<typeof FileContextFindingSchema>;

export const FileContextImporterSchema = z.object({
  path: z.string(),
  /** True when the importer names this symbol explicitly; false = whole-file
   *  (namespace/default import, or a language without recorded bindings). */
  viaBinding: z.boolean(),
});
export type FileContextImporter = z.infer<typeof FileContextImporterSchema>;

export const SymbolContextSchema = z.object({
  name: z.string(),
  kind: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  signature: z.string().optional(),
  parent: z.string().optional(),
  importedBy: z.array(FileContextImporterSchema),
  importedByTruncated: z.boolean(),
  /** Imported bindings lexically referenced inside this symbol's range. */
  uses: z.array(
    z.object({
      /** Local identifier as referenced in this file. */
      name: z.string(),
      /** Repo-relative path when resolved in-repo, else the raw package specifier. */
      from: z.string(),
      inRepo: z.boolean(),
    }),
  ),
  /** Sibling symbols in this file whose ranges lexically reference this name. */
  usedInFileBy: z.array(z.string()),
  findings: z.array(FileContextFindingSchema),
  /** LLM one-liner; absent until enrichment has covered this file@hash. */
  summary: z.string().optional(),
});
export type SymbolContext = z.infer<typeof SymbolContextSchema>;

export const FileContextResponseSchema = z.object({
  path: z.string(),
  lang: z.string().nullable(),
  totalLines: z.number().int().nonnegative(),
  /** File-level LLM summary (same row outline-file surfaces), when enriched. */
  summary: z.string().nullable(),
  importedBy: z.array(
    z.object({
      path: z.string(),
      /** Exported names the importer takes ([] = whole-file import only). */
      names: z.array(z.string()),
    }),
  ),
  importedByTruncated: z.boolean(),
  imports: z.array(
    z.object({
      specifier: z.string(),
      /** Repo-relative resolved target, null when external/unresolved. */
      resolvedPath: z.string().nullable(),
      names: z.array(z.string()),
      default: z.boolean(),
      namespace: z.boolean(),
    }),
  ),
  /** Findings outside every symbol range (incl. line-less findings). */
  fileFindings: z.array(FileContextFindingSchema),
  symbols: z.array(SymbolContextSchema),
  symbolsTruncated: z.boolean(),
  /** index = persisted index; live = symbols extracted on demand; unavailable = no index. */
  engine: z.enum(['index', 'live', 'unavailable']),
  /** Boekwachter review for this file@hash; absent until the review pass ran. */
  review: FileReviewWireSchema.optional(),
});
export type FileContextResponse = z.infer<typeof FileContextResponseSchema>;

// ── file reviews (boekwachter cliffs notes + issues + health) ───────────────

export const FileReviewRequestSchema = z.object({
  path: z.string().min(1),
});
export type FileReviewRequest = z.infer<typeof FileReviewRequestSchema>;

export const FileReviewResponseSchema = z.object({
  path: z.string(),
  found: z.boolean(),
  /** True when the file is indexed but its current hash has no review yet. */
  pending: z.boolean().optional(),
  review: FileReviewWireSchema.optional(),
});
export type FileReviewResponse = z.infer<typeof FileReviewResponseSchema>;

export const ListFileIssuesRequestSchema = z.object({
  severity: FileReviewIssueSeveritySchema.optional(),
  category: z.string().optional(),
  /** Repo-relative path prefix filter. */
  path: z.string().optional(),
  maxResults: z.number().int().positive().max(1000).optional(),
});
export type ListFileIssuesRequest = z.infer<typeof ListFileIssuesRequestSchema>;

export const ListFileIssuesResponseSchema = z.object({
  issues: z.array(
    z.object({
      path: z.string(),
      severity: FileReviewIssueSeveritySchema,
      category: z.string(),
      message: z.string(),
      line: z.number().int().positive().optional(),
    }),
  ),
  counts: z.object({
    total: z.number().int().nonnegative(),
    bySeverity: z.record(z.string(), z.number().int().nonnegative()),
    byCategory: z.record(z.string(), z.number().int().nonnegative()),
  }),
  truncated: z.boolean(),
  indexed: z.boolean(),
  /** Coverage denominators — "3 issues across 40/312 reviewed files" reads
   *  very differently from "3 issues"; keep the tool honest mid-sweep. */
  reviewedFiles: z.number().int().nonnegative(),
  eligibleFiles: z.number().int().nonnegative(),
});
export type ListFileIssuesResponse = z.infer<typeof ListFileIssuesResponseSchema>;

export const MapRepoRequestSchema = z.object({
  path: z.string().optional(),
});
export type MapRepoRequest = z.infer<typeof MapRepoRequestSchema>;

export const MapRepoResponseSchema = z.object({
  root: z.string(),
  languages: z.array(z.object({ lang: z.string(), fileCount: z.number().int().nonnegative() })),
  areas: z.array(
    z.object({
      path: z.string(),
      fileCount: z.number().int().nonnegative(),
      purpose: z.string().optional(),
    }),
  ),
  entryPoints: z.array(z.string()),
  keyFiles: z.array(z.string()),
  fileCount: z.number().int().nonnegative(),
  /** false when the index hasn't been built yet (areas/languages may be empty). */
  indexed: z.boolean(),
  /** Project-level architecture note from the deep-pass rollup, when generated. */
  architecture: z.string().optional(),
  /** Review-pass rollup (aggregates only); omitted until any file is reviewed. */
  health: z
    .object({
      reviewedFiles: z.number().int().nonnegative(),
      eligibleFiles: z.number().int().nonnegative(),
      /** Mean 1-10 health across reviewed files, one decimal. */
      avgHealth: z.number(),
      majorIssues: z.number().int().nonnegative(),
      minorIssues: z.number().int().nonnegative(),
      worstFiles: z
        .array(
          z.object({
            path: z.string(),
            health: z.number().int().min(1).max(10),
            reason: z.string().optional(),
          }),
        )
        .max(5),
    })
    .optional(),
});
export type MapRepoResponse = z.infer<typeof MapRepoResponseSchema>;

// ── file-map (the Village: a folder tree as a 1890–1915 settlement) ─────────

/** A rectangle in map-space (arbitrary units; the renderer fits to viewport). */
export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

/** A neighborhood — a folder, drawn as a padded box enclosing its blocks. */
export const MapDistrictSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  rect: RectSchema,
  label: z.string(),
  depth: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  weight: z.number().nonnegative(),
  color: z.string().optional(),
  /** Reserved label plate in world coords — the renderer draws the district
   *  label here and never guesses a position. Present on display districts. */
  labelPlate: RectSchema.optional(),
  /** Label for a collapsed pass-through folder chain, relative to the parent
   *  display district (e.g. 'service/src'). Absent ⇒ don't label this
   *  district — collapsed chains are labeled exactly once. */
  displayLabel: z.string().optional(),
});
export type MapDistrict = z.infer<typeof MapDistrictSchema>;

/** Health + zoning verdicts for a block — facts plus server-computed policy.
 *  The renderer maps `vibe`/`zone` to decoration 1:1 and never re-derives
 *  thresholds, so policy can evolve without client changes. */
export const MapBlockHealthSchema = z.object({
  /** Static security findings on this file (all severities). */
  findings: z.number().int().nonnegative(),
  maxSeverity: z.enum(['critical', 'high', 'medium', 'low', 'info']).nullable(),
  /** How many in-repo files import this one / it imports. */
  fanIn: z.number().int().nonnegative(),
  fanOut: z.number().int().nonnegative(),
  /** Groundskeeping verdict: drives trees vs weeds in the yard. */
  vibe: z.enum(['lush', 'tidy', 'plain', 'scruffy', 'blighted']),
  /** Dependency-role zoning: drives the building type (roof treatment).
   *  civic = hub everyone imports; commercial = widely shared; industrial =
   *  big machinery by LoC; residential = leaf consumers. */
  zone: z.enum(['residential', 'commercial', 'civic', 'industrial']),
  /** Transitive import centrality (PageRank over the resolved import graph,
   *  max-normalized so the top hub is 1.0). Absent when there are no edges. */
  importance: z.number().min(0).max(1).optional(),
  /** Commits touching this file in the churn window (window length rides in
   *  `FileMapResponse.signals.churnWindowDays`). Absent when git is
   *  unavailable for the workspace. */
  churn: z.number().int().nonnegative().optional(),
});
export type MapBlockHealth = z.infer<typeof MapBlockHealthSchema>;

/** How urban the ground under a block is. See `MapBlockSchema.settlement`. */
export const SettlementSchema = z.enum(['hamlet', 'village', 'town', 'city']);
export type Settlement = z.infer<typeof SettlementSchema>;

/**
 * A block — a file. Size ∝ lines of code; `state` drives construction/rubble.
 *
 * Five orthogonal signals drive the renderer, each answering a different
 * question. Keep them separate — collapsing any two makes the settlement read
 * as one undifferentiated mass:
 *
 * | field              | question                                | renders as              |
 * |--------------------|-----------------------------------------|-------------------------|
 * | `health.zone`      | what does this file *do*?               | archetype family        |
 * | `levels`           | how important is this *file*?           | storeys                 |
 * | `landmark`         | which few files are the *skyline*?      | guildhall / town hall   |
 * | `health.vibe`      | how well *kept* is it?                  | trees vs weeds          |
 * | `urbanity`         | what kind of *place* is it standing in? | ground, materials, surroundings |
 */
export const MapBlockSchema = z.object({
  id: z.string(),
  districtId: z.string(),
  rect: RectSchema,
  label: z.string(),
  weight: z.number().nonnegative(),
  kind: z.string().nullable().optional(),
  lang: z.string().nullable().optional(),
  state: z.enum(['live', 'new', 'tombstoned']),
  buildingCount: z.number().int().nonnegative(),
  /** A PR-overlay placeholder for a file the PR adds that isn't indexed yet
   *  ("new construction") — drawn dashed and excluded from codebase stats. */
  phantom: z.boolean().optional(),
  /** ISO timestamp of the block's first placement on the map (persisted
   *  across builds). Drives the age lens; null on pre-timestamp layouts. */
  placedAt: z.string().nullable().optional(),
  /** The parcel containing the footprint (`rect`) plus yard margins — the
   *  collision/persistence unit. Frozen across builds; the footprint regrows
   *  inside it (clamped, so a huge file saturates instead of overlapping). */
  lot: RectSchema.optional(),
  /** Health/zoning verdicts (absent on tombstones and pre-health payloads). */
  health: MapBlockHealthSchema.optional(),
  /** Storeys, 1..5 — server policy from importance + LoC + churn. The
   *  renderer maps levels to extrusion 1:1 and never re-derives. Absent on
   *  tombstones, phantoms, and pre-V3 payloads. */
  levels: z.number().int().min(1).max(5).optional(),
  /** Skyline landmark: the centrality-ranked head of the civic zone. Gets a
   *  plaza in the layout and landmark treatment in the renderer. */
  landmark: z.boolean().optional(),
  /** Last git commit touching this file (ISO). The age lens prefers this
   *  over `placedAt`. Absent when git is unavailable. */
  lastTouchedAt: z.string().optional(),
  /** Urbanity of the ground under this parcel, 0..1 — server policy blending
   *  downtown proximity, local build density, and NEIGHBORHOOD importance,
   *  capped by project size. Deliberately continuous: the renderer LERPS with
   *  it (prop density, vegetation, wall hue mix, bay rhythm) and never compares
   *  it to a constant. Absent on tombstones, phantoms, and pre-V6 payloads.
   *
   *  It samples the neighborhood, never this block's own importance — that
   *  already drives `levels`, and counting it twice makes the core an
   *  undifferentiated wall of tall civic buildings. */
  urbanity: z.number().min(0).max(1).optional(),
  /** Bucketed `urbanity` — the ONLY input to categorical choices (paving,
   *  wall/roof material, within-family archetype pick, hedge vs fence vs
   *  curb). Thresholds live in the service; never re-derive them client-side
   *  from `urbanity`, or they drift the first time the policy is tuned. */
  settlement: SettlementSchema.optional(),
});
export type MapBlock = z.infer<typeof MapBlockSchema>;

/** A building — one function/class/symbol inside a block. */
export const MapBuildingSchema = z.object({
  id: z.string(),
  blockId: z.string(),
  rect: RectSchema,
  /** Normalized [0,1] on an ABSOLUTE log scale over the symbol's line span
   *  (floored so every building is visible) — comparable across files, unlike
   *  the pre-v5 per-file-relative value. Renderers map it to extrusion. */
  height: z.number().nonnegative(),
  /** Line span of the symbol (absent on pre-v5 payloads). */
  lines: z.number().int().positive().optional(),
  /** 1-based source range of the symbol (absent on pre-v6 payloads). */
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  label: z.string(),
  kind: z.string(),
});
export type MapBuilding = z.infer<typeof MapBuildingSchema>;

/** A street — the materialized gap between sibling folders / parcel rows.
 *  tier 0 = avenue between top-level packages … 3 = lane/alley in a folder. */
export const MapStreetSchema = z.object({
  id: z.string(),
  /** Axis-aligned; w > h ⇒ a horizontal street. */
  rect: RectSchema,
  tier: z.number().int().min(0).max(3),
  /** Folder whose interior this street runs through; null at the map root. */
  districtId: z.string().nullable(),
});
export type MapStreet = z.infer<typeof MapStreetSchema>;

/** A plaza or green — reserved open ground the layout never builds on.
 *  `plaza` fronts a landmark block; `green` fills a district's leftover
 *  packing space so neighborhoods breathe. */
export const MapPlazaSchema = z.object({
  id: z.string(),
  districtId: z.string().nullable(),
  rect: RectSchema,
  kind: z.enum(['plaza', 'green']),
  /** The landmark block this plaza fronts (absent for greens). */
  blockId: z.string().optional(),
});
export type MapPlaza = z.infer<typeof MapPlazaSchema>;

/** A road — a dependency/affinity edge between two blocks. */
export const MapRoadSchema = z.object({
  a: z.string(),
  b: z.string(),
  affinity: z.number(),
  source: z.enum(['import', 'embedding', 'mixed']),
  bidirectional: z.boolean(),
});
export type MapRoad = z.infer<typeof MapRoadSchema>;

export const MapPrChangeSchema = z.object({
  blockId: z.string(),
  change: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  fromPath: z.string().optional(),
});
export type MapPrChange = z.infer<typeof MapPrChangeSchema>;
export const MapPrOverlaySchema = z.object({
  prNumber: z.number().int().optional(),
  title: z.string().optional(),
  changedBlocks: z.array(MapPrChangeSchema),
});
export type MapPrOverlay = z.infer<typeof MapPrOverlaySchema>;

/** Map-level parameters of the urbanity field, so the renderer can do ambient
 *  effects (haze toward downtown, traffic falloff) without re-deriving policy. */
export const MapUrbanitySchema = z.object({
  /** Importance-weighted downtown centroid, world coords. */
  center: z.object({ x: z.number(), y: z.number() }),
  /** Weighted radius of gyration — the falloff scale of the field. */
  radius: z.number().positive(),
  /** Project-size cap multiplied into every block's urbanity: a small repo is
   *  uniformly rural but keeps its internal contrast shape. */
  ceiling: z.number().min(0).max(1),
  peak: z.number().min(0).max(1),
  median: z.number().min(0).max(1),
  /** The settlement's overall register, bucketed from `peak`. */
  settlement: SettlementSchema,
  /** Live blocks the field was computed over. */
  fileCount: z.number().int().nonnegative(),
});
export type MapUrbanity = z.infer<typeof MapUrbanitySchema>;

/**
 * Which slice of a code project to map. `core` is the default and excludes test
 * files (they're large, symbol-less, and drown out the real code); `tests` maps
 * only the test files as their own separate "city"; `all` places those two
 * stable cities beside each other without re-laying out either one. JSON/data
 * files are always excluded from code maps regardless of scope.
 */
export const FileMapScopeSchema = z.enum(['core', 'tests', 'all']);
export type FileMapScope = z.infer<typeof FileMapScopeSchema>;

export const FileMapRequestSchema = z.object({
  domain: z.enum(['code', 'docs', 'data']).optional(),
  scope: FileMapScopeSchema.optional(),
  /** When set, overlay this pull request's changed files onto the map. */
  pr: z.number().int().positive().optional(),
});
export type FileMapRequest = z.infer<typeof FileMapRequestSchema>;

export const FileMapResponseSchema = z.object({
  domain: z.string(),
  root: z.string(),
  bounds: RectSchema,
  builtAt: z.string(),
  /** false when the index hasn't been built yet (everything else may be empty). */
  indexed: z.boolean(),
  districts: z.array(MapDistrictSchema),
  blocks: z.array(MapBlockSchema),
  buildings: z.array(MapBuildingSchema),
  roads: z.array(MapRoadSchema),
  /** Paved streets between folders/rows (absent on pre-street layouts). */
  streets: z.array(MapStreetSchema).optional(),
  /** Plazas and greens (absent on pre-v5 layouts). */
  plazas: z.array(MapPlazaSchema).optional(),
  overlay: MapPrOverlaySchema.optional(),
  /** Urbanity-field parameters (absent on pre-V6 layouts). */
  urbanity: MapUrbanitySchema.optional(),
  /** Signal provenance for lenses/legends. */
  signals: z
    .object({
      gitAvailable: z.boolean(),
      churnWindowDays: z.number().int().positive(),
    })
    .optional(),
});
export type FileMapResponse = z.infer<typeof FileMapResponseSchema>;

// ── doc-intel (converted-document intelligence) ─────────────────────────────

export const SearchDocsRequestSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(100).optional(),
});
export type SearchDocsRequest = z.infer<typeof SearchDocsRequestSchema>;

export const SearchDocsResponseSchema = z.object({
  results: z.array(
    z.object({
      /** Original document path (e.g. jobs/resume.docx). */
      sourcePath: z.string(),
      /** Converted markdown path under .gezel/files/…_files/. */
      markdownPath: z.string(),
      lineStart: z.number().int().positive(),
      snippet: z.string(),
    }),
  ),
  engine: z.enum(['fts', 'unavailable']),
  truncated: z.boolean(),
});
export type SearchDocsResponse = z.infer<typeof SearchDocsResponseSchema>;

export const ReadDocAsMarkdownRequestSchema = z.object({
  path: z.string().min(1),
});
export type ReadDocAsMarkdownRequest = z.infer<typeof ReadDocAsMarkdownRequestSchema>;

export const ReadDocAsMarkdownResponseSchema = z.object({
  found: z.boolean(),
  sourcePath: z.string().optional(),
  markdownPath: z.string().optional(),
  markdown: z.string().optional(),
  truncated: z.boolean(),
});
export type ReadDocAsMarkdownResponse = z.infer<typeof ReadDocAsMarkdownResponseSchema>;

// ── search_code (semantic + keyword hybrid) ─────────────────────────────────

export const SearchCodeRequestSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(['auto', 'semantic', 'keyword']).optional(),
  maxResults: z.number().int().positive().max(100).optional(),
});
export type SearchCodeRequest = z.infer<typeof SearchCodeRequestSchema>;

export const SearchCodeResponseSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      lineStart: z.number().int().positive(),
      lineEnd: z.number().int().positive(),
      kind: z.string(),
      name: z.string().optional(),
      snippet: z.string(),
      score: z.number(),
      source: z.enum(['vector', 'fts']),
    }),
  ),
  engine: z.enum(['hybrid', 'semantic', 'fts', 'unavailable']),
  truncated: z.boolean(),
});
export type SearchCodeResponse = z.infer<typeof SearchCodeResponseSchema>;

// ── security-intel (static security analysis over the index) ─────────────────
// The deterministic built-in scan runs in the index hot path; the whole-repo
// `security_scan` refresh (reachability + opportunistic OSS tools) is on-demand.
// Every finding carries a real file + 1-based line so the model's next move is a
// precise read — same convention as code-intel.

export const SecuritySeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type SecuritySeverityWire = z.infer<typeof SecuritySeveritySchema>;

export const SecuritySourceSchema = z.enum(['builtin', 'semgrep', 'osv', 'gitleaks']);
export const SecurityFindingStatusSchema = z.enum(['open', 'in_progress', 'resolved']);
export type SecurityFindingStatus = z.infer<typeof SecurityFindingStatusSchema>;

export const SecurityFindingSchema = z.object({
  /** Stable identity across re-scans; used for lifecycle actions. */
  fingerprint: z.string().min(1),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  ruleId: z.string(),
  category: z.string(),
  severity: SecuritySeveritySchema,
  source: SecuritySourceSchema,
  title: z.string(),
  evidence: z.string().optional(),
  status: SecurityFindingStatusSchema,
  /** Task currently handling this finding, when delegated to a gezel. */
  taskRef: TaskRefSchema.optional(),
});
export type SecurityFindingWire = z.infer<typeof SecurityFindingSchema>;

const FindingCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  bySeverity: z.record(z.string(), z.number().int().nonnegative()),
  byCategory: z.record(z.string(), z.number().int().nonnegative()),
  bySource: z.record(z.string(), z.number().int().nonnegative()),
});

export const SecurityScanRequestSchema = z.object({
  /** Run opportunistic OSS tools (semgrep/osv-scanner/gitleaks) when present. Default true. */
  useExternalTools: z.boolean().optional(),
});
export type SecurityScanRequest = z.infer<typeof SecurityScanRequestSchema>;

export const SecurityScanResponseSchema = z.object({
  ran: z.boolean(),
  engines: z.array(z.string()),
  toolsAvailable: z.object({
    semgrep: z.boolean(),
    osvScanner: z.boolean(),
    gitleaks: z.boolean(),
    npm: z.boolean(),
  }),
  findingCounts: FindingCountsSchema,
  dependencies: z.number().int().nonnegative(),
  advisories: z.number().int().nonnegative(),
});
export type SecurityScanResponse = z.infer<typeof SecurityScanResponseSchema>;

export const ScanFindingsRequestSchema = z.object({
  severity: SecuritySeveritySchema.optional(),
  category: z.string().optional(),
  path: z.string().optional(),
  source: SecuritySourceSchema.optional(),
  maxResults: z.number().int().positive().max(1000).optional(),
});
export type ScanFindingsRequest = z.infer<typeof ScanFindingsRequestSchema>;

export const ScanFindingsResponseSchema = z.object({
  findings: z.array(SecurityFindingSchema),
  counts: FindingCountsSchema,
  truncated: z.boolean(),
  indexed: z.boolean(),
});
export type ScanFindingsResponse = z.infer<typeof ScanFindingsResponseSchema>;

export const ResolveSecurityFindingRequestSchema = z.object({
  fingerprint: z.string().min(1),
});
export type ResolveSecurityFindingRequest = z.infer<typeof ResolveSecurityFindingRequestSchema>;

export const ResolveSecurityFindingResponseSchema = z.object({
  resolved: z.boolean(),
});
export type ResolveSecurityFindingResponse = z.infer<typeof ResolveSecurityFindingResponseSchema>;

export const DelegateSecurityFindingRequestSchema = z.object({
  fingerprint: z.string().min(1),
});
export type DelegateSecurityFindingRequest = z.infer<typeof DelegateSecurityFindingRequestSchema>;

export const DelegateSecurityFindingResponseSchema = z.object({
  finding: SecurityFindingSchema,
  taskRef: TaskRefSchema,
  gezelId: z.string(),
  gezelName: z.string(),
  enqueued: z.boolean(),
});
export type DelegateSecurityFindingResponse = z.infer<typeof DelegateSecurityFindingResponseSchema>;

const AttackSurfaceSchema = z.object({
  entryPoints: z.array(z.string()),
  routes: z.array(z.string()),
  authBoundaries: z.array(z.string()),
  secretTouchpoints: z.array(z.string()),
  taintSources: z.array(z.object({ path: z.string(), count: z.number().int().positive() })),
});

export const MapAttackSurfaceResponseSchema = AttackSurfaceSchema.extend({
  root: z.string(),
  indexed: z.boolean(),
});
export type MapAttackSurfaceResponse = z.infer<typeof MapAttackSurfaceResponseSchema>;

export const SecurityDependencySchema = z.object({
  name: z.string(),
  ecosystem: z.string(),
  version: z.string().nullable(),
  direct: z.boolean(),
  advisoryIds: z.array(z.string()),
  maxSeverity: SecuritySeveritySchema.nullable(),
  license: z.string().nullable(),
});
export type SecurityDependency = z.infer<typeof SecurityDependencySchema>;

export const ListDependenciesResponseSchema = z.object({
  dependencies: z.array(SecurityDependencySchema),
  total: z.number().int().nonnegative(),
  withAdvisories: z.number().int().nonnegative(),
  /** false until `security_scan` has populated the inventory. */
  scanned: z.boolean(),
});
export type ListDependenciesResponse = z.infer<typeof ListDependenciesResponseSchema>;

export const SecurityOverviewResponseSchema = z.object({
  indexed: z.boolean(),
  /** true once security_scan has run (dependency inventory / tool findings present). */
  scanned: z.boolean(),
  findings: FindingCountsSchema,
  attackSurface: z.object({
    entryPoints: z.number().int().nonnegative(),
    routes: z.number().int().nonnegative(),
    authBoundaries: z.number().int().nonnegative(),
    secretTouchpoints: z.number().int().nonnegative(),
    taintSources: z.number().int().nonnegative(),
  }),
  dependencies: z.object({
    total: z.number().int().nonnegative(),
    withAdvisories: z.number().int().nonnegative(),
  }),
  /** Categories recurring across many files — candidate systemic themes to investigate. */
  systemicCandidates: z.array(
    z.object({
      category: z.string(),
      fileCount: z.number().int().positive(),
      findingCount: z.number().int().positive(),
      severity: SecuritySeveritySchema,
    }),
  ),
});
export type SecurityOverviewResponse = z.infer<typeof SecurityOverviewResponseSchema>;

export const TraceTaintRequestSchema = z.object({
  /** Workspace-relative file to trace reachability around. */
  file: z.string().min(1),
  /** Import-graph hops to walk each direction. Default 3. */
  maxHops: z.number().int().positive().max(8).optional(),
});
export type TraceTaintRequest = z.infer<typeof TraceTaintRequestSchema>;

export const TraceTaintResponseSchema = z.object({
  file: z.string(),
  found: z.boolean(),
  /** Files that transitively import `file` (its blast radius / upstream callers). */
  upstream: z.array(z.string()),
  /** Files `file` transitively imports (downstream). */
  downstream: z.array(z.string()),
  /** Taint-source findings in `file` + upstream. */
  taintSources: z.array(SecurityFindingSchema),
  /** Sink findings in `file` + downstream. */
  sinks: z.array(SecurityFindingSchema),
  /** Honest description of what this reachability is (import-graph proximity, not precise dataflow). */
  note: z.string(),
});
export type TraceTaintResponse = z.infer<typeof TraceTaintResponseSchema>;

// ── unified search (cross-project quick-open + content) ──────────────────────

/**
 * Result kinds the titlebar search box returns, in display-group order:
 * name/quick-open matches first (`project`/`gezel`/`file`/`document`), then the
 * heavier content matches (`content`/`symbol`/`memory`). The renderer groups by
 * `kind`; the backend ranks within and across groups via `score`.
 */
export const UNIFIED_SEARCH_RESULT_KINDS = [
  'project',
  'gezel',
  'file',
  'document',
  'content',
  'symbol',
  'memory',
  'session',
] as const;

export const UnifiedSearchResultKindSchema = z.enum(UNIFIED_SEARCH_RESULT_KINDS);
export type UnifiedSearchResultKind = z.infer<typeof UnifiedSearchResultKindSchema>;

export const UnifiedSearchResultSchema = z.object({
  kind: UnifiedSearchResultKindSchema,
  /** Stable identity for React keys + dedup (kind-scoped). */
  id: z.string(),
  /** Primary label shown in the palette (project name, file basename, …). */
  title: z.string(),
  /** Secondary line (path, project name, gezel role, …). */
  subtitle: z.string().optional(),
  /** Content/snippet preview for content/doc/memory hits. */
  snippet: z.string().optional(),
  /** Owning project (absent for global documents + global gezels). */
  projectId: z.string().optional(),
  /** Project name for display when `projectId` is set. */
  projectName: z.string().optional(),
  /** Relative path within the project workspace/artifacts, or a document path. */
  path: z.string().optional(),
  /** Which file root `path` lives in — drives how the UI opens it. */
  source: z.enum(['workspace', 'artifacts']).optional(),
  /** 1-based line for content/symbol hits. */
  line: z.number().int().positive().optional(),
  /** Owning gezel for session hits — lets the palette navigate without parsing ids. */
  gezelId: z.string().optional(),
  /** Merged relevance score (higher = better). */
  score: z.number(),
});
export type UnifiedSearchResult = z.infer<typeof UnifiedSearchResultSchema>;

export const UnifiedSearchRequestSchema = z.object({
  query: z.string().min(1).max(400),
  /** 'names' = quick-open catalog only (instant); 'full' = catalog + content. */
  mode: z.enum(['names', 'full']).optional(),
  maxResults: z.number().int().positive().max(100).optional(),
});
export type UnifiedSearchRequest = z.infer<typeof UnifiedSearchRequestSchema>;

export const UnifiedSearchResponseSchema = z.object({
  results: z.array(UnifiedSearchResultSchema),
  /** True when the content fan-out hit its cap or a source errored/timed out. */
  truncated: z.boolean(),
});
export type UnifiedSearchResponse = z.infer<typeof UnifiedSearchResponseSchema>;

// ── global index search (sessions + documents) ──────────────────────────────

export const SearchSessionsRequestSchema = z.object({
  q: z.string().min(1).max(400),
  gezel: z.string().optional(),
  project: z.string().optional(),
  maxResults: z.number().int().positive().max(100).optional(),
});
export type SearchSessionsRequest = z.infer<typeof SearchSessionsRequestSchema>;

export const SessionSearchResultSchema = z.object({
  sessionId: z.string(),
  gezelId: z.string(),
  projectId: z.string(),
  title: z.string(),
  snippet: z.string(),
  /** 1-based index of the first message in the matched transcript chunk. */
  messageStart: z.number().int().positive(),
  lastActivityAt: z.string(),
  archived: z.boolean(),
});
export type SessionSearchResult = z.infer<typeof SessionSearchResultSchema>;

export const SearchSessionsResponseSchema = z.object({
  results: z.array(SessionSearchResultSchema),
  /** 'fts' when the global index answered; 'unavailable' when sqlite is off. */
  engine: z.enum(['fts', 'unavailable']),
});
export type SearchSessionsResponse = z.infer<typeof SearchSessionsResponseSchema>;

export const SearchDocumentsRequestSchema = z.object({
  q: z.string().min(1).max(400),
  maxResults: z.number().int().positive().max(100).optional(),
});
export type SearchDocumentsRequest = z.infer<typeof SearchDocumentsRequestSchema>;

export const DocumentSearchResultSchema = z.object({
  path: z.string(),
  lineStart: z.number().int().positive(),
  snippet: z.string(),
});
export type DocumentSearchResult = z.infer<typeof DocumentSearchResultSchema>;

export const SearchDocumentsResponseSchema = z.object({
  results: z.array(DocumentSearchResultSchema),
  engine: z.enum(['fts', 'unavailable']),
});
export type SearchDocumentsResponse = z.infer<typeof SearchDocumentsResponseSchema>;

// ── image-intel ─────────────────────────────────────────────────────────────

export const SearchImagesRequestSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(100).optional(),
});
export type SearchImagesRequest = z.infer<typeof SearchImagesRequestSchema>;

export const SearchImagesResponseSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      format: z.string().optional(),
      caption: z.string().optional(),
      score: z.number(),
    }),
  ),
  engine: z.enum(['fts', 'unavailable']),
  truncated: z.boolean(),
});
export type SearchImagesResponse = z.infer<typeof SearchImagesResponseSchema>;

export const FindSimilarImagesRequestSchema = z.object({
  path: z.string().min(1),
  maxResults: z.number().int().positive().max(100).optional(),
});
export type FindSimilarImagesRequest = z.infer<typeof FindSimilarImagesRequestSchema>;

export const FindSimilarImagesResponseSchema = z.object({
  results: z.array(z.object({ path: z.string(), score: z.number() })),
  /** vector = CLIP neighbours; unavailable = no image embeddings yet. */
  engine: z.enum(['vector', 'unavailable']),
  truncated: z.boolean(),
});
export type FindSimilarImagesResponse = z.infer<typeof FindSimilarImagesResponseSchema>;

export const DescribeFolderRequestSchema = z.object({
  path: z.string().optional(),
});
export type DescribeFolderRequest = z.infer<typeof DescribeFolderRequestSchema>;

export const DescribeFolderResponseSchema = z.object({
  path: z.string(),
  imageCount: z.number().int().nonnegative(),
  formats: z.array(z.object({ format: z.string(), count: z.number().int() })),
  dimensions: z
    .object({
      minWidth: z.number().int(),
      maxWidth: z.number().int(),
      minHeight: z.number().int(),
      maxHeight: z.number().int(),
    })
    .nullable(),
  samples: z.array(z.string()),
  captioned: z.number().int().nonnegative(),
});
export type DescribeFolderResponse = z.infer<typeof DescribeFolderResponseSchema>;

// ── entity-intel (meta-boekwachter) ─────────────────────────────────────────

export const FindEntityRequestSchema = z.object({
  query: z.string().optional(),
  kind: z.string().optional(),
  maxResults: z.number().int().positive().max(200).optional(),
});
export type FindEntityRequest = z.infer<typeof FindEntityRequestSchema>;

export const EntitySchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  label: z.string(),
  canonical: z.string(),
  mentions: z.number().int().nonnegative(),
});
export type Entity = z.infer<typeof EntitySchema>;

export const FindEntityResponseSchema = z.object({
  entities: z.array(EntitySchema),
  engine: z.enum(['index', 'unavailable']),
});
export type FindEntityResponse = z.infer<typeof FindEntityResponseSchema>;

export const ListEntityMentionsRequestSchema = z.object({
  entity: z.string().min(1),
  maxResults: z.number().int().positive().max(500).optional(),
});
export type ListEntityMentionsRequest = z.infer<typeof ListEntityMentionsRequestSchema>;

export const ListEntityMentionsResponseSchema = z.object({
  found: z.boolean(),
  entity: z.object({ kind: z.string(), label: z.string() }).optional(),
  mentions: z.array(
    z.object({ path: z.string(), line: z.number().int().optional(), date: z.string().optional() }),
  ),
});
export type ListEntityMentionsResponse = z.infer<typeof ListEntityMentionsResponseSchema>;

export const DiffFilesRequestSchema = z
  .object({
    leftPath: z.string().optional(),
    leftText: z.string().optional(),
    rightPath: z.string().optional(),
    rightText: z.string().optional(),
    contextLines: z.number().int().min(0).max(20).optional(),
  })
  .refine((d) => (d.leftPath || d.leftText) && (d.rightPath || d.rightText), {
    message: 'Provide {leftPath|leftText} and {rightPath|rightText}.',
  });
export type DiffFilesRequest = z.infer<typeof DiffFilesRequestSchema>;

export const DiffFilesResponseSchema = z.object({
  /** Unified diff body. Empty string when the inputs are identical. */
  diff: z.string(),
  identical: z.boolean(),
});
export type DiffFilesResponse = z.infer<typeof DiffFilesResponseSchema>;

export const ReadImageBase64RequestSchema = z.object({
  path: z.string().min(1),
  /** When true, resolve against the project artifacts directory first. */
  artifact: z.boolean().optional(),
});
export type ReadImageBase64Request = z.infer<typeof ReadImageBase64RequestSchema>;

export const ReadImageBase64ResponseSchema = z.object({
  path: z.string(),
  mimeType: z.string(),
  base64: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type ReadImageBase64Response = z.infer<typeof ReadImageBase64ResponseSchema>;

export const ArchiveListRequestSchema = z.object({
  path: z.string().min(1),
  maxEntries: z.number().int().positive().max(5000).optional(),
});
export type ArchiveListRequest = z.infer<typeof ArchiveListRequestSchema>;

export const ArchiveEntrySchema = z.object({
  name: z.string(),
  size: z.number().int().nonnegative(),
  isDirectory: z.boolean(),
});
export type ArchiveEntry = z.infer<typeof ArchiveEntrySchema>;

export const ArchiveListResponseSchema = z.object({
  format: z.enum(['zip', 'tar', 'tar.gz']),
  entries: z.array(ArchiveEntrySchema),
  truncated: z.boolean(),
});
export type ArchiveListResponse = z.infer<typeof ArchiveListResponseSchema>;

export const ArchiveExtractRequestSchema = z.object({
  path: z.string().min(1),
  /** Destination path, relative to the project workspace. */
  outputPath: z.string().min(1),
});
export type ArchiveExtractRequest = z.infer<typeof ArchiveExtractRequestSchema>;

export const ArchiveExtractResponseSchema = z.object({
  format: z.enum(['zip', 'tar', 'tar.gz']),
  extractedCount: z.number().int().nonnegative(),
  destination: z.string(),
});
export type ArchiveExtractResponse = z.infer<typeof ArchiveExtractResponseSchema>;

/**
 * `run_git` supports a narrow allowlist of read-only subcommands. Write
 * ops (add, commit, push, reset, rebase) are deliberately excluded —
 * gezels that need to commit should use the github workflow or ask the
 * user. The extended arg list is validated server-side against a
 * per-subcommand allowlist so `git log --format=%H | sh` style
 * injection paths are blocked at parse time.
 */
export const RunGitRequestSchema = z.object({
  subcommand: z.enum(['status', 'log', 'diff', 'show', 'blame', 'branch', 'rev-parse', 'ls-files']),
  args: z.array(z.string()).max(32).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});
export type RunGitRequest = z.infer<typeof RunGitRequestSchema>;

export const RunGitResponseSchema = z.object({
  code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  timedOut: z.boolean(),
});
export type RunGitResponse = z.infer<typeof RunGitResponseSchema>;

// ── GitHub OAuth device flow ───────────────────────────────────────────

/**
 * Result of starting a device-flow login. The UI shows `userCode` to
 * the user, opens `verificationUri` in their browser, and polls with
 * `deviceCode` every `interval` seconds until either `expiresIn`
 * elapses or the user completes the auth in their browser.
 */
export const GitHubLoginStartResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  /** Seconds between polls; honor `slow_down` by adding 5s on the fly. */
  interval: z.number().int().positive(),
  /** Total seconds the user has to complete the flow. */
  expiresIn: z.number().int().positive(),
});
export type GitHubLoginStartResponse = z.infer<typeof GitHubLoginStartResponseSchema>;

export const GitHubIdentitySchema = z.object({
  login: z.string(),
  name: z.string().optional(),
  avatarUrl: z.string().optional(),
});
export type GitHubIdentity = z.infer<typeof GitHubIdentitySchema>;

export const GitHubLoginPollRequestSchema = z.object({
  deviceCode: z.string(),
});
export type GitHubLoginPollRequest = z.infer<typeof GitHubLoginPollRequestSchema>;

/**
 * Outcome of a single poll. `pending` and `slow_down` mean keep polling;
 * `expired` and `denied` are terminal failures; `success` returns the
 * fetched identity (and the token has been persisted to the SecretStore
 * by the time this returns).
 */
export const GitHubLoginPollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('slow_down') }),
  z.object({ status: z.literal('expired') }),
  z.object({ status: z.literal('denied'), error: z.string().optional() }),
  z.object({
    status: z.literal('success'),
    identity: GitHubIdentitySchema,
    scopes: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal('not_configured'),
    error: z.string(),
  }),
]);
export type GitHubLoginPollResponse = z.infer<typeof GitHubLoginPollResponseSchema>;

export const GitHubIdentityResponseSchema = z.union([
  GitHubIdentitySchema.extend({ signedIn: z.literal(true) }),
  z.object({ signedIn: z.literal(false) }),
]);
export type GitHubIdentityResponse = z.infer<typeof GitHubIdentityResponseSchema>;

// ── GitHub repo listing (authenticated user's accessible repos) ──────

/**
 * Lightweight summary used by the New Project dialog's repo-picker
 * dropdown. Includes the bits we need to render a suggestion list:
 * full name (owner/repo), HTTPS clone URL, optional description, and
 * a privacy flag so the UI can render a small lock for private repos.
 */
export const GitHubRepoSummarySchema = z.object({
  fullName: z.string(),
  url: z.string(),
  description: z.string().optional(),
  private: z.boolean().optional(),
  pushedAt: z.string().optional(),
});
export type GitHubRepoSummary = z.infer<typeof GitHubRepoSummarySchema>;

export const GitHubReposResponseSchema = z.object({
  repos: z.array(GitHubRepoSummarySchema),
});
export type GitHubReposResponse = z.infer<typeof GitHubReposResponseSchema>;

// ── GitHub repo preview (URL → metadata + README) ──────────────────────

export const GitHubRepoPreviewRequestSchema = z.object({
  url: z.string(),
});
export type GitHubRepoPreviewRequest = z.infer<typeof GitHubRepoPreviewRequestSchema>;

export const GitHubRepoPreviewResponseSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  canonicalUrl: z.string(),
  defaultBranch: z.string().optional(),
  description: z.string().optional(),
  topics: z.array(z.string()).optional(),
  language: z.string().optional(),
  /** README contents, truncated to keep the one-shot prompt manageable. */
  readme: z.string(),
  readmeTruncated: z.boolean(),
});
export type GitHubRepoPreviewResponse = z.infer<typeof GitHubRepoPreviewResponseSchema>;

// ── Project about/mission preview (LLM draft from repo) ────────────────

export const ProjectAboutPreviewRequestSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string(),
  description: z.string().optional(),
  topics: z.array(z.string()).optional(),
  /** Already truncated. The generator does not re-truncate. */
  readme: z.string(),
});
export type ProjectAboutPreviewRequest = z.infer<typeof ProjectAboutPreviewRequestSchema>;

export const ProjectAboutPreviewResponseSchema = z.object({
  about: z.string(),
  missionObjectives: z.string(),
});
export type ProjectAboutPreviewResponse = z.infer<typeof ProjectAboutPreviewResponseSchema>;

/**
 * Peek at a local folder before it becomes a project, for the New Project
 * dialog's "from folder" flow. The service reads the folder's basename (the
 * suggested project name) and, when present, an agent doc at the root
 * (AGENTS.md / CLAUDE.md / agent.md) to pre-fill About.
 */
export const ProjectFolderPreviewRequestSchema = z.object({
  path: z.string().min(1),
});
export type ProjectFolderPreviewRequest = z.infer<typeof ProjectFolderPreviewRequestSchema>;

export const ProjectFolderPreviewResponseSchema = z.object({
  /** The folder's basename — suggested as the project name. */
  name: z.string(),
  /** Contents of the folder's agent doc (capped), when one was found. */
  about: z.string().optional(),
  /** The filename About was read from (e.g. "AGENTS.md"), when found. */
  source: z.string().optional(),
});
export type ProjectFolderPreviewResponse = z.infer<typeof ProjectFolderPreviewResponseSchema>;

// ── Workspace index (commands + files + token index) ─────────────────

/**
 * One runnable command discovered in a workspace. Sources we scan:
 *   - `npm-script`:        entries in package.json `scripts` block
 *   - `workspace-script`:  files in the project's `scripts/` folder
 *   - `vscode-launch`:     configurations in `.vscode/launch.json`
 *   - `bin`:               binaries in `node_modules/.bin/`
 *
 * `run` is the shell-paste form — what we copy to clipboard when the
 * user clicks the row in the Commands panel.
 */
export const DiscoveredCommandSchema = z.object({
  name: z.string(),
  kind: z.enum(['npm-script', 'workspace-script', 'vscode-launch', 'bin']),
  /** Relative path or origin file the command came from. */
  source: z.string(),
  /** Shell-paste form. e.g. `npm run test` or `./scripts/deploy.sh`. */
  run: z.string(),
  description: z.string().optional(),
});
export type DiscoveredCommand = z.infer<typeof DiscoveredCommandSchema>;

export const WorkspaceIndexMetaSchema = z.object({
  /** Bumped when the on-disk index shape changes — forces a re-scan. */
  version: z.number().int(),
  scannedAt: z.string(),
  /** Absolute path that was scanned (the resolved workspace dir). */
  root: z.string(),
  durationMs: z.number().int(),
  fileCount: z.number().int(),
  commandCount: z.number().int(),
  /** Number of commands for which the indexer extracted a typed shape
   *  (oclif manifests today; future help-parsed + AI-inferred sources
   *  later). Optional so legacy index files parse. */
  shapeCount: z.number().int().optional(),
});
export type WorkspaceIndexMeta = z.infer<typeof WorkspaceIndexMetaSchema>;

/** One CLI flag/option as captured by the shape extractor. */
export const FlagSpecSchema = z.object({
  name: z.string(),
  /** Short form, e.g. `'f'` for `-f`. */
  char: z.string().length(1).optional(),
  /** `'boolean'` for flags that take no value, `'option'` otherwise. */
  type: z.enum(['boolean', 'option']),
  description: z.string().optional(),
  required: z.boolean().optional(),
  /** Stringified default — oclif allows arbitrary types; we serialize. */
  default: z.string().optional(),
  /** Enum-style choices when the flag is constrained. */
  options: z.array(z.string()).optional(),
  multiple: z.boolean().optional(),
});
export type FlagSpec = z.infer<typeof FlagSpecSchema>;

/** One positional argument as captured by the shape extractor. */
export const ArgSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  options: z.array(z.string()).optional(),
});
export type ArgSpec = z.infer<typeof ArgSpecSchema>;

/**
 * Structured shape for a runnable command — synopsis, flags, args,
 * direct-child subcommands. Keyed in `shapes.json` by the rendered
 * command name (e.g. `gh`, `gh pr`). Stored only when the indexer
 * extracted real data; rows without a shape entry render with the
 * stock single-line description.
 */
export const CommandShapeSchema = z.object({
  /** Where the shape came from. Future: `'help-parsed'`, `'ai-inferred'`. */
  source: z.literal('oclif'),
  /** Package name + version the shape was extracted from. */
  package: z.string(),
  packageVersion: z.string().optional(),
  /** Short one-line; oclif's `summary` when present, else first line of `description`. */
  summary: z.string().optional(),
  description: z.string().optional(),
  /** Direct children only — nested subcommands stay in the manifest, not promoted. */
  subcommands: z
    .array(
      z.object({
        name: z.string(),
        fullName: z.string(),
        summary: z.string().optional(),
      }),
    )
    .optional(),
  flags: z.array(FlagSpecSchema).optional(),
  args: z.array(ArgSpecSchema).optional(),
  /** Usage line as the manifest carries it (often a one-liner). */
  usage: z.string().optional(),
  /** Manifest examples, capped at 5 to keep payloads tight. */
  examples: z.array(z.string()).optional(),
});
export type CommandShape = z.infer<typeof CommandShapeSchema>;

export const WorkspaceCommandShapesSchema = z.object({
  shapes: z.record(z.string(), CommandShapeSchema),
});
export type WorkspaceCommandShapes = z.infer<typeof WorkspaceCommandShapesSchema>;

export const WorkspaceIndexStatusSchema = z.object({
  /**
   *   - `fresh`    — index exists and is younger than the staleness threshold
   *   - `stale`    — index exists but older than threshold; re-scan pending
   *   - `indexing` — a scan is in flight right now
   *   - `never`    — no index on disk yet
   *   - `disabled` — this project explicitly opted out of workspace indexing
   */
  state: z.enum(['fresh', 'stale', 'indexing', 'never', 'disabled']),
  meta: WorkspaceIndexMetaSchema.optional(),
  /**
   * True when the structural index is fresh but the background AI scan
   * (content enrichment — per-file summaries + embeddings) still has files
   * left to process. Drives the "index up to date, AI scan pending" (amber)
   * pill state. Only meaningful when `state === 'fresh'`; omitted otherwise.
   */
  aiScanPending: z.boolean().optional(),
  /**
   * Enrichment coverage. `summarized` counts real summaries (summaries
   * table), not the enrichment gate — the gate also carries failed-attempt
   * rows awaiting a capped retry. Present when a content index exists on
   * disk.
   */
  enrichment: z
    .object({
      eligible: z.number().int().nonnegative(),
      summarized: z.number().int().nonnegative(),
      embedded: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
      /** The embedding model that built these vectors (index `meta` stamp). */
      embedModel: z.string().optional(),
      /**
       * Review-pass coverage. Deliberately NOT folded into `aiScanPending`:
       * the amber pill means "search not ready", and reviews lag summaries by
       * design. `reviewed` counts any successful review on the current file
       * hash; `stale` are reviews whose rubric has since changed (still
       * served, lazily refreshed); `pending` excludes attempt-capped files.
       */
      reviews: z
        .object({
          eligible: z.number().int().nonnegative(),
          reviewed: z.number().int().nonnegative(),
          stale: z.number().int().nonnegative(),
          pending: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .optional(),
});
export type WorkspaceIndexStatus = z.infer<typeof WorkspaceIndexStatusSchema>;

/**
 * On-demand enrichment drive ("study now"): one bounded pass per request —
 * the caller loops until `drained`. Complements the idle-gated background
 * loop; still respects the boekwachter task's pause.
 */
export const DriveIndexEnrichmentRequestSchema = z.object({
  maxFiles: z.number().int().positive().max(25).optional(),
  budgetMs: z.number().int().positive().max(60_000).optional(),
  /** Run the folder/architecture rollup pass once the file tier drains. */
  areas: z.boolean().optional(),
  /** Run the review pass (cliffs notes + issues + health) once drained. */
  reviews: z.boolean().optional(),
});
export type DriveIndexEnrichmentRequest = z.infer<typeof DriveIndexEnrichmentRequestSchema>;

export const DriveIndexEnrichmentResponseSchema = z.object({
  paused: z.boolean(),
  files: z.number().int().nonnegative(),
  summarized: z.number().int().nonnegative(),
  embedded: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  areasUpdated: z.number().int().nonnegative(),
  architectureUpdated: z.boolean(),
  /** Files reviewed by this pass (0 when `reviews` wasn't requested). */
  reviewed: z.number().int().nonnegative().optional(),
  /** Files still awaiting review at the end of this pass. */
  reviewPending: z.number().int().nonnegative().optional(),
  /** True when the file tier had no work left at the end of this pass. */
  drained: z.boolean(),
});
export type DriveIndexEnrichmentResponse = z.infer<typeof DriveIndexEnrichmentResponseSchema>;

/**
 * A compact view of one night-shift task for the Night Shift status menu —
 * enough to tell the user what the shift is (or will be) working on without
 * loading the full task.
 */
export const NightShiftTaskBriefSchema = z.object({
  ref: z.string(),
  title: z.string(),
  projectName: z.string(),
  /** Name of the task's current (active) step, when it has one. */
  stepName: z.string().optional(),
});
export type NightShiftTaskBrief = z.infer<typeof NightShiftTaskBriefSchema>;

/** Live service-owned work performed during Night Shift, outside TaskRunner. */
export const NightShiftBackgroundWorkBriefSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  projectName: z.string().optional(),
});
export type NightShiftBackgroundWorkBrief = z.infer<typeof NightShiftBackgroundWorkBriefSchema>;

/**
 * What the night shift is doing right now: service-owned background work,
 * tasks with a turn in flight (`active`), and tasks genuinely present in the
 * runner queue (`upcoming`). All three are empty when no shift is running.
 */
export const NightShiftTasksResponseSchema = z.object({
  background: z.array(NightShiftBackgroundWorkBriefSchema),
  active: z.array(NightShiftTaskBriefSchema),
  upcoming: z.array(NightShiftTaskBriefSchema),
});
export type NightShiftTasksResponse = z.infer<typeof NightShiftTasksResponseSchema>;

/** One task last night's shift completed. */
export const NightShiftCompletedTaskSchema = z.object({
  ref: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  completedAt: z.string().optional(),
});
export type NightShiftCompletedTask = z.infer<typeof NightShiftCompletedTaskSchema>;

/** One report the shift produced, with its embedded-action tally. */
export const NightShiftReportSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  /** Artifacts-relative path. */
  path: z.string(),
  /** First H1, else the filename. */
  title: z.string(),
  writtenAt: z.string().optional(),
  actionCounts: z.object({
    total: z.number(),
    suggested: z.number(),
    fired: z.number(),
    applied: z.number(),
    dismissed: z.number(),
  }),
});
export type NightShiftReport = z.infer<typeof NightShiftReportSchema>;

/**
 * The morning review: what the most recent night window accomplished —
 * completed tasks and the reports they left, with per-report action
 * tallies. Powers the moon menu's "Done last night", the Home "Last
 * night" tab, and the synthesized morning question.
 */
export const NightShiftReviewResponseSchema = z.object({
  windowKey: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  tasksCompleted: z.array(NightShiftCompletedTaskSchema),
  reports: z.array(NightShiftReportSchema),
});
export type NightShiftReviewResponse = z.infer<typeof NightShiftReviewResponseSchema>;

export const WorkspaceCommandIndexSchema = z.object({
  meta: WorkspaceIndexMetaSchema,
  commands: z.array(DiscoveredCommandSchema),
  /**
   * Typed shape per command, keyed by the rendered command name.
   * Absent on projects with no shape-bearing commands (most non-Node
   * projects). Older clients ignore unknown fields, so adding this is
   * backward compatible.
   */
  shapes: z.record(z.string(), CommandShapeSchema).optional(),
});
export type WorkspaceCommandIndex = z.infer<typeof WorkspaceCommandIndexSchema>;

/**
 * One skill discovered in a project workspace — a gstack-style SKILL.md
 * file under `.claude/skills/`, `.gstack/skills/`, or `agents/skills/`.
 * The scanner parses the YAML frontmatter and the body, surfacing the
 * skill as a per-project ephemeral craftbook the user can invoke from
 * the CommandsPanel. Bash code blocks in the body are flagged as
 * advisory; gezel doesn't execute them.
 */
export const DiscoveredSkillSchema = z.object({
  /** Skill name (from frontmatter `name` or the directory). */
  name: z.string(),
  /** Where the SKILL.md lives, relative to the workspace root. */
  source: z.string(),
  /** Which install convention matched. */
  origin: z.enum(['claude', 'gstack', 'agents', 'other']),
  /** Frontmatter description, if present. */
  description: z.string().optional(),
  /** User-speech triggers — phrases that route to this skill. */
  triggers: z.array(z.string()).optional(),
  /** Frontmatter version, if present. */
  version: z.string().optional(),
  /**
   * Markdown body with frontmatter stripped — and, for generated skills
   * (gstack's AUTO-GENERATED marker), the injected host preamble stripped
   * too, so the capped text is the authored procedure. Capped.
   */
  body: z.string(),
  /** True when the AUTO-GENERATED template marker was present. */
  generated: z.boolean().optional(),
  /** True when the body contains bash/shell code blocks we can't execute. */
  hasShellScripts: z.boolean(),
  /**
   * Companion files shipped next to the SKILL.md (one directory level of
   * sections/, references/, templates/, scripts/, bin/). Never copied —
   * converted books cite these paths.
   */
  files: z
    .array(
      z.object({
        relPath: z.string(),
        kind: z.enum(['section', 'reference', 'template', 'script', 'bin', 'other']),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});
export type DiscoveredSkill = z.infer<typeof DiscoveredSkillSchema>;

export const WorkspaceSkillIndexSchema = z.object({
  skills: z.array(DiscoveredSkillSchema),
});
export type WorkspaceSkillIndex = z.infer<typeof WorkspaceSkillIndexSchema>;

/**
 * One workspace-root instruction file discovered by the indexer — the
 * conventions other AI harnesses drop in a repo: `AGENTS.md` (cross-harness
 * standard), `CLAUDE.md` (Claude Code), `.github/copilot-instructions.md`
 * (GitHub Copilot). The highest-precedence file present (AGENTS > CLAUDE >
 * copilot) becomes the project's `@project` gezel prompt. The `hash` lets
 * the sync engine skip re-derivation when nothing changed.
 */
export const DiscoveredInstructionSchema = z.object({
  /** Path relative to the workspace root, e.g. `AGENTS.md`. */
  source: z.string(),
  /** Which harness convention matched. */
  origin: z.enum(['agents', 'claude', 'copilot']),
  /** File contents, capped to keep the index small. */
  content: z.string(),
  /** sha256 of `content` — drives idempotent sync. */
  hash: z.string(),
  /** Last-modified time (ms) of the file, for cheap change detection. */
  mtimeMs: z.number(),
});
export type DiscoveredInstruction = z.infer<typeof DiscoveredInstructionSchema>;

export const WorkspaceInstructionIndexSchema = z.object({
  instructions: z.array(DiscoveredInstructionSchema),
});
export type WorkspaceInstructionIndex = z.infer<typeof WorkspaceInstructionIndexSchema>;

/**
 * Snapshot of everything the model would receive on the next turn for a
 * given session, plus the metadata that drove how the prompt was built.
 * Surfaced via `GET /api/sessions/:id/debug` and consumed by the UI's
 * debug-mode "copy debug bundle" button. Audience is engineers debugging
 * prompt issues; the shape is designed to be cheap to read after pasting
 * into another conversation.
 */
export const SessionDebugSnapshotSchema = z.object({
  sessionId: z.string(),
  providerName: z.string(),
  model: z.string().optional(),
  modelTier: z.enum(['tiny', 'small', 'medium', 'large', 'cloud']),
  parameterSize: z.string().optional(),
  /** True when the model id matches `MODEL_FAMILIES_LEAKING_REASONING`. */
  leaksUntaggedReasoning: z.boolean(),
  reasoningEffort: z.string().optional(),
  numCtx: z.number().optional(),
  /** Freshly-computed system prompt — what `buildInstructions` would emit RIGHT NOW. */
  systemPrompt: z.string(),
  /**
   * The volatile context layer — task/step/gate + other per-turn blocks
   * split out of the stable prompt prefix for cache reuse. For a
   * task-scoped session this is where `### Current task`, the step
   * procedure, and the phase-gate contract actually live; a bundle
   * without it shows a task session as if it had no task at all.
   */
  volatileContext: z.string().optional(),
  /**
   * True when this session's gezel has a non-empty `tools.md` that
   * fully replaced the auto-injected `## Tools available this turn`
   * block. Surfaced so the debug bundle can flag "this prompt's tool
   * listing is hand-authored — staleness is the gezel owner's
   * responsibility, not a runtime bug."
   */
  customToolsMd: z.boolean(),
  /**
   * Names of MCP tools currently registered on the session's bridge.
   * Disambiguates "salvage couldn't fire because no tools were known"
   * from "salvage didn't match" during prompt-debugging
   * investigations. Empty when no live session has been built (cold
   * snapshot pre-first-turn) or when the provider/session doesn't
   * expose a bridge (Copilot's SDK manages tools internally; cloud
   * providers without MCP). Populated for warm Ollama / llama-cpp /
   * MLX sessions whose MCP subprocess is up.
   */
  registeredTools: z.array(z.string()),
  /**
   * Recent messages in source order, sliced to the requested window.
   * Includes role + content + (optional) tool_calls — same shape used in
   * the chat transcript on disk, minus any provider-specific state.
   *
   * The window includes prior context up to and including the inspected
   * message AND any trailing assistant turns that ran before the next
   * user message — so a bundle copied from the empty-bubble symptom
   * still captures the 10-call cascade that ran in the next assistant
   * turn before the next user reply. Without that, the bundle reader
   * sees the symptom but not the cause.
   */
  recentMessages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system', 'tool']),
      content: z.string(),
      /**
       * Captured chain-of-thought (gpt-oss `<|channel|>analysis…<|end|>`,
       * Gemma channel-tagged blocks, `<think>…</think>`). Promoted off
       * the visible reply at commit time. Including it in the bundle is
       * essential when the visible content is empty / aborted —
       * otherwise the reader can't see what the model was actually
       * doing before it went silent or got killed.
       */
      reasoning: z.string().optional(),
      /**
       * Persistent warnings on the turn — fabrication detection, repeat-
       * tracker / failure-tracker abort messages ("`list_tasks` failed
       * 5 times in a row…"), context-loop halt notices. The screenshot's
       * red-banner copy lives here.
       */
      warnings: z.array(z.string()).optional(),
      /**
       * `'compaction-summary'` / `'context-loop-halt'` / `'turn-aborted'`
       * / `'growth-announcement'` / `'keurmeester-notice'` — marks the
       * turn as system-synthesized rather than a real model reply.
       * Useful so the bundle reader doesn't try to debug "why did the
       * model emit this" when the runtime emitted it. `'turn-aborted'`
       * is the catch-handler variant for when a provider threw mid-turn
       * (repeat-tracker, failure-tracker, etc). Keep in sync with
       * `ChatMessage.synthetic` in gezel.ts.
       */
      synthetic: z
        .enum([
          'compaction-summary',
          'context-loop-halt',
          'turn-aborted',
          'growth-announcement',
          'keurmeester-notice',
        ])
        .optional(),
      /**
       * Tool-call bodies the salvage layer couldn't parse — surfaced
       * here so a "model attempted N tool calls but couldn't form them"
       * warning has the actual shapes the model emitted alongside it.
       * The bundle reader can then see whether the failure was
       * `<|tool_call|>start_project{...}<tool_call|>` (one missing
       * pipe — would be a salvage-pipeline bug to fix), prose code
       * `start_project({...})` (model treating the call as decoration
       * — system-prompt bug), or something else entirely.
       */
      attemptedToolCalls: z
        .array(
          z.object({
            body: z.string(),
            reason: z.string().optional(),
          }),
        )
        .optional(),
      toolCalls: z
        .array(
          z.object({
            name: z.string(),
            argsSummary: z.string().optional(),
            success: z.boolean(),
            /**
             * Error message returned by the tool. Critical diagnostic
             * data — without it, "list_tasks failed 5 times" looks like
             * a mystery instead of "the model kept passing a project
             * name that doesn't resolve." Cap at a few hundred chars in
             * the formatter so a long stack doesn't drown the bundle.
             */
            errorMessage: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
  /**
   * On-disk pointers for deeper investigation past what fits in the
   * bundle: the full session transcript JSON, the logs directory, and —
   * for local engine providers — the engine log filename glob. The
   * bundle renders these as a "Where to dig deeper" section with grep
   * hints. Absent for cold snapshots / providers without a home dir.
   */
  diagnostics: z
    .object({
      /** Full turn-by-turn session record (every message, tool call, reasoning). */
      sessionRecordPath: z.string(),
      /** Directory holding the daemon + engine logs (`<home>/logs`). */
      logsDir: z.string(),
      /** Engine-log filename glob for local providers, e.g. `mlx-server-*.log`. */
      engineLogGlob: z.string().optional(),
    })
    .optional(),
  generatedAt: z.string(),
});
export type SessionDebugSnapshot = z.infer<typeof SessionDebugSnapshotSchema>;

export type ListGezelsResponse = z.infer<typeof ListGezelsResponseSchema>;
export type CreateGezelRequest = z.infer<typeof CreateGezelRequestSchema>;
export type GezelResponse = z.infer<typeof GezelResponseSchema>;
export type UpdateGezelMarkdownRequest = z.infer<typeof UpdateGezelMarkdownRequestSchema>;
export type UpdateGezelAboutRequest = z.infer<typeof UpdateGezelAboutRequestSchema>;
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;
export type InstallPackageRequest = z.infer<typeof InstallPackageRequestSchema>;
export type InstallPackageResponse = z.infer<typeof InstallPackageResponseSchema>;

// ── Surgical edit tools (replace_in_file / apply_patch / insert_at_marker) ──
//
// Layer 4: complement `write_file` / `append_to_file` for files that have
// already been written once. Token cost per edit is proportional to the
// change, not the size of the file. Every endpoint returns a unified
// diff alongside `ok: true` so the UI can render an inline before/after
// view under the tool-call row.

/**
 * Maximum bytes of unified-diff text we attach to history / tool-call
 * records. Patches that produce a larger diff still apply cleanly —
 * we just truncate the stored representation. Tune if it shows up.
 */
export const TOOL_CALL_DIFF_MAX_BYTES = 100_000;

/**
 * Server-side copy of a file from the project's artifacts drawer to its
 * workspace, preserving exact bytes. Models reach for this instead of
 * `read_artifact` + `write_file` when they need to relocate a binary
 * (image, PDF, audio, …) — the read+write round-trip goes through a
 * JSON string and corrupts non-UTF-8 content. The petshop
 * eval failure (4-byte `logo.png`) is the canonical case this prevents.
 */
export const CopyArtifactToWorkspaceRequestSchema = z.object({
  /** Path in the artifacts drawer (e.g. `pet-shop-website/generated/image-X.png`). */
  source: z.string().min(1),
  /** Destination path in the workspace (e.g. `assets/logo.png`). */
  dest: z.string().min(1),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type CopyArtifactToWorkspaceRequest = z.infer<typeof CopyArtifactToWorkspaceRequestSchema>;

export const CopyArtifactToWorkspaceResponseSchema = z.object({
  ok: z.literal(true),
  source: z.string(),
  dest: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type CopyArtifactToWorkspaceResponse = z.infer<typeof CopyArtifactToWorkspaceResponseSchema>;

/**
 * Shallow-clone a remote git repo into the project workspace. Exposes the
 * existing `runGit` plumbing as a tool surface — the gezel can call this
 * to materialize source for a code-review or analysis task without us
 * having to expose raw `git clone` execution. The destination path is
 * resolved INSIDE the project workspace (safeJoin-gated), so a malicious
 * `dest` like `../../etc` can't escape.
 *
 * URL must be HTTP/HTTPS only (no `git@github.com:` SSH form) so the
 * service doesn't depend on the host's SSH agent setup. `--depth 1` is
 * implied by the route; the model doesn't see commit history.
 */
export const FetchRepoRequestSchema = z.object({
  /** Public HTTP(S) git URL, e.g. `https://github.com/bendyline/squisq`. */
  url: z.string().url(),
  /** Destination directory inside the workspace. Empty / omitted → clone at workspace root. */
  dest: z.string().optional(),
  /**
   * Optional branch / tag / commit ref to check out. Forwarded as
   * `git clone --branch <branch>`. When unset, the remote's default
   * branch is used (typically `main`). Use this to fetch a PR head, a
   * release tag, or a specific commit SHA for review work.
   */
  branch: z.string().min(1).optional(),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type FetchRepoRequest = z.infer<typeof FetchRepoRequestSchema>;

export const FetchRepoResponseSchema = z.object({
  ok: z.literal(true),
  /** Workspace-relative path the repo landed at. */
  path: z.string(),
  /** Files copied (excludes `.git/`). */
  files: z.number().int().nonnegative(),
  /** Total bytes across those files. */
  bytes: z.number().int().nonnegative(),
});
export type FetchRepoResponse = z.infer<typeof FetchRepoResponseSchema>;

/**
 * Fetch a SHA-vs-SHA (or ref-vs-ref) diff from a public git repo into
 * the project workspace. The route does a `--filter=blob:none` partial
 * clone (full commit/tree metadata, blobs on demand), fetches both
 * refs, writes the unified diff at `workspace/<diffPath>`, and checks
 * out `headRef` in the working tree so reviewers have the "after"
 * source for context.
 *
 * `baseRef` / `headRef` accept anything `git fetch` understands —
 * branch names, tag names, or commit SHAs. GitHub allows fetching SHAs
 * that are reachable from any published ref; unpublished SHAs will fail
 * with a clear error.
 */
export const FetchDiffRequestSchema = z.object({
  url: z.string().url(),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  /** Destination directory for the checked-out head source. Empty / omitted → workspace root. */
  dest: z.string().optional(),
  /** Workspace path for the unified diff file. Default `diff.patch`. */
  diffPath: z.string().min(1).optional(),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type FetchDiffRequest = z.infer<typeof FetchDiffRequestSchema>;

export const FetchDiffResponseSchema = z.object({
  ok: z.literal(true),
  /** Workspace-relative path the head-revision source landed at. */
  path: z.string(),
  /** Workspace-relative path of the unified diff file. */
  diffPath: z.string(),
  /** Resolved commit SHAs for both refs (after fetch). */
  baseSha: z.string(),
  headSha: z.string(),
  /** Files counted in the checked-out head tree. */
  files: z.number().int().nonnegative(),
  /** Total bytes across those files. */
  bytes: z.number().int().nonnegative(),
  /** Bytes of the unified diff. */
  diffBytes: z.number().int().nonnegative(),
  /** Number of files changed in the diff (from `git diff --name-only`). */
  filesChanged: z.number().int().nonnegative(),
});
export type FetchDiffResponse = z.infer<typeof FetchDiffResponseSchema>;

export const ReplaceInProjectWorkspaceFileRequestSchema = z.object({
  path: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  /**
   * "exactlyOne" (default) — refuse if find matches zero or more than
   * one place. Pass a 1-based index to target a specific match, or
   * `"all"` to apply blanket renames.
   */
  occurrence: z.union([z.number().int().positive(), z.literal('all')]).optional(),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ReplaceInProjectWorkspaceFileRequest = z.infer<
  typeof ReplaceInProjectWorkspaceFileRequestSchema
>;

export const ApplyPatchToProjectWorkspaceFileRequestSchema = z.object({
  path: z.string().min(1),
  /**
   * Unified-diff body (git-style hunks with `@@ -L,N +L,N @@` headers
   * and `-`/`+`/` ` line prefixes). One file per call — multi-file
   * patches reject with a guidance error so models learn to issue one
   * call per touched file.
   */
  diff: z.string().min(1),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ApplyPatchToProjectWorkspaceFileRequest = z.infer<
  typeof ApplyPatchToProjectWorkspaceFileRequestSchema
>;

export const InsertAtMarkerInProjectWorkspaceFileRequestSchema = z.object({
  path: z.string().min(1),
  /** Literal substring that must appear exactly once in the file. */
  marker: z.string().min(1),
  content: z.string(),
  /** Where the new content lands relative to the marker. Defaults to `'after'`. */
  where: z.enum(['before', 'after']).optional(),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type InsertAtMarkerInProjectWorkspaceFileRequest = z.infer<
  typeof InsertAtMarkerInProjectWorkspaceFileRequestSchema
>;

export const ReplaceLinesInProjectWorkspaceFileRequestSchema = z.object({
  path: z.string().min(1),
  /** 1-based first line to replace (inclusive). Use the `N→` gutter from `read_file`. */
  startLine: z.number().int().positive(),
  /** 1-based last line to replace (inclusive). Equal to `startLine` to replace one line. */
  endLine: z.number().int().positive(),
  /**
   * Replacement text for the line range. May be empty (deletes the
   * range) or multi-line. Do NOT include the `N→` line-number gutter.
   */
  content: z.string(),
  gezelId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ReplaceLinesInProjectWorkspaceFileRequest = z.infer<
  typeof ReplaceLinesInProjectWorkspaceFileRequestSchema
>;

/**
 * Common response envelope for all three surgical-edit endpoints. The
 * unified diff is the same string the UI renders inline; the line
 * counts are pre-computed server-side so the chat bubble can show
 * `+12 −5` without re-parsing the diff. Capped at TOOL_CALL_DIFF_MAX_BYTES.
 */
export const WorkspaceEditResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
  diff: z.string(),
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  /** True when the diff was clipped to TOOL_CALL_DIFF_MAX_BYTES. */
  diffTruncated: z.boolean().optional(),
});
export type WorkspaceEditResponse = z.infer<typeof WorkspaceEditResponseSchema>;

// ── CLI/TUI direct MCP tool surface ──
// List + invoke a session's MCP tools outside the model loop. Backs the
// TUI "CLI mode": the same merged toolset the model would see, callable by
// name. Mounted at /api/sessions/:id/tools (see http/routes/mcp-tools.ts).

/** One MCP tool as exposed to the TUI tool picker (OpenAI function shape). */
export const McpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** JSON Schema for the tool's arguments. */
  parameters: z.record(z.string(), z.unknown()),
});
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;

export const ListSessionToolsResponseSchema = z.object({
  tools: z.array(McpToolInfoSchema),
});
export type ListSessionToolsResponse = z.infer<typeof ListSessionToolsResponseSchema>;

export const InvokeSessionToolRequestSchema = z.object({
  /** Tool arguments; validated against the tool's own schema by the bridge. */
  args: z.record(z.string(), z.unknown()).optional(),
});
export type InvokeSessionToolRequest = z.infer<typeof InvokeSessionToolRequestSchema>;

export const InvokeSessionToolResponseSchema = z.object({
  /** The tool's text result (wrapper-processed, output-capped). */
  text: z.string(),
  /** Any images the tool returned, as base64 + mime type. */
  images: z.array(z.object({ base64: z.string(), mimeType: z.string() })),
});
export type InvokeSessionToolResponse = z.infer<typeof InvokeSessionToolResponseSchema>;

// ── Deprecated aliases — Git/GitHub naming realignment ──
// Local-git wire shapes were renamed Github* → Git* (host-agnostic), and
// GitHub-web-service shapes Github* → GitHub* (capital H). These aliases keep
// the published surface compiling; removal is a future breaking release.

/** @deprecated Use {@link GitStatusResponseSchema}. */
export const GithubStatusResponseSchema = GitStatusResponseSchema;
/** @deprecated Use {@link GitStatusResponse}. */
export type GithubStatusResponse = GitStatusResponse;
/** @deprecated Use {@link GitCloneResponseSchema}. */
export const GithubCloneResponseSchema = GitCloneResponseSchema;
/** @deprecated Use {@link GitCloneResponse}. */
export type GithubCloneResponse = GitCloneResponse;
/** @deprecated Use {@link GitBranchSwitchRequestSchema}. */
export const GithubBranchSwitchRequestSchema = GitBranchSwitchRequestSchema;
/** @deprecated Use {@link GitBranchSwitchRequest}. */
export type GithubBranchSwitchRequest = GitBranchSwitchRequest;
/** @deprecated Use {@link GitBranchesResponseSchema}. */
export const GithubBranchesResponseSchema = GitBranchesResponseSchema;
/** @deprecated Use {@link GitBranchesResponse}. */
export type GithubBranchesResponse = GitBranchesResponse;
/** @deprecated Use {@link GitFetchResponseSchema}. */
export const GithubFetchResponseSchema = GitFetchResponseSchema;
/** @deprecated Use {@link GitFetchResponse}. */
export type GithubFetchResponse = GitFetchResponse;
/** @deprecated Use {@link GitCommitRequestSchema}. */
export const GithubCommitRequestSchema = GitCommitRequestSchema;
/** @deprecated Use {@link GitCommitRequest}. */
export type GithubCommitRequest = GitCommitRequest;
/** @deprecated Use {@link GitCommitResponseSchema}. */
export const GithubCommitResponseSchema = GitCommitResponseSchema;
/** @deprecated Use {@link GitCommitResponse}. */
export type GithubCommitResponse = GitCommitResponse;
/** @deprecated Use {@link GitPushResponseSchema}. */
export const GithubPushResponseSchema = GitPushResponseSchema;
/** @deprecated Use {@link GitPushResponse}. */
export type GithubPushResponse = GitPushResponse;
/** @deprecated Use {@link GitChangeKindSchema}. */
export const GithubChangeKindSchema = GitChangeKindSchema;
/** @deprecated Use {@link GitChangeKind}. */
export type GithubChangeKind = GitChangeKind;
/** @deprecated Use {@link GitWorkingChangeSchema}. */
export const GithubWorkingChangeSchema = GitWorkingChangeSchema;
/** @deprecated Use {@link GitWorkingChange}. */
export type GithubWorkingChange = GitWorkingChange;
/** @deprecated Use {@link GitChangesResponseSchema}. */
export const GithubChangesResponseSchema = GitChangesResponseSchema;
/** @deprecated Use {@link GitChangesResponse}. */
export type GithubChangesResponse = GitChangesResponse;
/** @deprecated Use {@link GitFileDiffResponseSchema}. */
export const GithubFileDiffResponseSchema = GitFileDiffResponseSchema;
/** @deprecated Use {@link GitFileDiffResponse}. */
export type GithubFileDiffResponse = GitFileDiffResponse;
/** @deprecated Use {@link GitDiscardRequestSchema}. */
export const GithubDiscardRequestSchema = GitDiscardRequestSchema;
/** @deprecated Use {@link GitDiscardRequest}. */
export type GithubDiscardRequest = GitDiscardRequest;
/** @deprecated Use {@link GitDiscardResponseSchema}. */
export const GithubDiscardResponseSchema = GitDiscardResponseSchema;
/** @deprecated Use {@link GitDiscardResponse}. */
export type GithubDiscardResponse = GitDiscardResponse;
/** @deprecated Use {@link GitLogEntrySchema}. */
export const GithubLogEntrySchema = GitLogEntrySchema;
/** @deprecated Use {@link GitLogEntry}. */
export type GithubLogEntry = GitLogEntry;
/** @deprecated Use {@link GitLogResponseSchema}. */
export const GithubLogResponseSchema = GitLogResponseSchema;
/** @deprecated Use {@link GitLogResponse}. */
export type GithubLogResponse = GitLogResponse;
/** @deprecated Use {@link GitCommitDetailResponseSchema}. */
export const GithubCommitDetailResponseSchema = GitCommitDetailResponseSchema;
/** @deprecated Use {@link GitCommitDetailResponse}. */
export type GithubCommitDetailResponse = GitCommitDetailResponse;
/** @deprecated Use {@link GitSyncStateSchema}. */
export const GithubSyncStateSchema = GitSyncStateSchema;
/** @deprecated Use {@link GitSyncState}. */
export type GithubSyncState = GitSyncState;
/** @deprecated Use {@link GitSyncResponseSchema}. */
export const GithubSyncResponseSchema = GitSyncResponseSchema;
/** @deprecated Use {@link GitSyncResponse}. */
export type GithubSyncResponse = GitSyncResponse;
/** @deprecated Use {@link GitConflictKindSchema}. */
export const GithubConflictKindSchema = GitConflictKindSchema;
/** @deprecated Use {@link GitConflictKind}. */
export type GithubConflictKind = GitConflictKind;
/** @deprecated Use {@link GitConflictFileSchema}. */
export const GithubConflictFileSchema = GitConflictFileSchema;
/** @deprecated Use {@link GitConflictFile}. */
export type GithubConflictFile = GitConflictFile;
/** @deprecated Use {@link GitMergeStateResponseSchema}. */
export const GithubMergeStateResponseSchema = GitMergeStateResponseSchema;
/** @deprecated Use {@link GitMergeStateResponse}. */
export type GithubMergeStateResponse = GitMergeStateResponse;
/** @deprecated Use {@link GitConflictVersionsResponseSchema}. */
export const GithubConflictVersionsResponseSchema = GitConflictVersionsResponseSchema;
/** @deprecated Use {@link GitConflictVersionsResponse}. */
export type GithubConflictVersionsResponse = GitConflictVersionsResponse;
/** @deprecated Use {@link GitResolveConflictRequestSchema}. */
export const GithubResolveConflictRequestSchema = GitResolveConflictRequestSchema;
/** @deprecated Use {@link GitResolveConflictRequest}. */
export type GithubResolveConflictRequest = GitResolveConflictRequest;
/** @deprecated Use {@link GitResolveConflictResponseSchema}. */
export const GithubResolveConflictResponseSchema = GitResolveConflictResponseSchema;
/** @deprecated Use {@link GitResolveConflictResponse}. */
export type GithubResolveConflictResponse = GitResolveConflictResponse;
/** @deprecated Use {@link GitCompleteMergeRequestSchema}. */
export const GithubCompleteMergeRequestSchema = GitCompleteMergeRequestSchema;
/** @deprecated Use {@link GitCompleteMergeRequest}. */
export type GithubCompleteMergeRequest = GitCompleteMergeRequest;
/** @deprecated Use {@link GitCompleteMergeResponseSchema}. */
export const GithubCompleteMergeResponseSchema = GitCompleteMergeResponseSchema;
/** @deprecated Use {@link GitCompleteMergeResponse}. */
export type GithubCompleteMergeResponse = GitCompleteMergeResponse;
/** @deprecated Use {@link GitAbandonMergeResponseSchema}. */
export const GithubAbandonMergeResponseSchema = GitAbandonMergeResponseSchema;
/** @deprecated Use {@link GitAbandonMergeResponse}. */
export type GithubAbandonMergeResponse = GitAbandonMergeResponse;
/** @deprecated Use {@link GitSuggestMessageResponseSchema}. */
export const GithubSuggestMessageResponseSchema = GitSuggestMessageResponseSchema;
/** @deprecated Use {@link GitSuggestMessageResponse}. */
export type GithubSuggestMessageResponse = GitSuggestMessageResponse;
/** @deprecated Use {@link GitAiMergeRequestSchema}. */
export const GithubAiMergeRequestSchema = GitAiMergeRequestSchema;
/** @deprecated Use {@link GitAiMergeRequest}. */
export type GithubAiMergeRequest = GitAiMergeRequest;
/** @deprecated Use {@link GitAiMergeResponseSchema}. */
export const GithubAiMergeResponseSchema = GitAiMergeResponseSchema;
/** @deprecated Use {@link GitAiMergeResponse}. */
export type GithubAiMergeResponse = GitAiMergeResponse;
/** @deprecated Use {@link GitHubAuthMetaSchema}. */
export const GithubAuthMetaSchema = GitHubAuthMetaSchema;
/** @deprecated Use {@link GitHubAuthMeta}. */
export type GithubAuthMeta = GitHubAuthMeta;
/** @deprecated Use {@link GitHubPullSummarySchema}. */
export const GithubPullSummarySchema = GitHubPullSummarySchema;
/** @deprecated Use {@link GitHubPullSummary}. */
export type GithubPullSummary = GitHubPullSummary;
/** @deprecated Use {@link GitHubPullDetailSchema}. */
export const GithubPullDetailSchema = GitHubPullDetailSchema;
/** @deprecated Use {@link GitHubPullDetail}. */
export type GithubPullDetail = GitHubPullDetail;
/** @deprecated Use {@link GitHubPullFileSchema}. */
export const GithubPullFileSchema = GitHubPullFileSchema;
/** @deprecated Use {@link GitHubPullFile}. */
export type GithubPullFile = GitHubPullFile;
/** @deprecated Use {@link GitHubPullCommentSchema}. */
export const GithubPullCommentSchema = GitHubPullCommentSchema;
/** @deprecated Use {@link GitHubPullComment}. */
export type GithubPullComment = GitHubPullComment;
/** @deprecated Use {@link GitHubPullDiffResponseSchema}. */
export const GithubPullDiffResponseSchema = GitHubPullDiffResponseSchema;
/** @deprecated Use {@link GitHubPullDiffResponse}. */
export type GithubPullDiffResponse = GitHubPullDiffResponse;
/** @deprecated Use {@link GitHubCreateCommentRequestSchema}. */
export const GithubCreateCommentRequestSchema = GitHubCreateCommentRequestSchema;
/** @deprecated Use {@link GitHubCreateCommentRequest}. */
export type GithubCreateCommentRequest = GitHubCreateCommentRequest;
/** @deprecated Use {@link GitHubCreateCommentResponseSchema}. */
export const GithubCreateCommentResponseSchema = GitHubCreateCommentResponseSchema;
/** @deprecated Use {@link GitHubCreateCommentResponse}. */
export type GithubCreateCommentResponse = GitHubCreateCommentResponse;
/** @deprecated Use {@link GitHubCreatePullRequestSchema}. */
export const GithubCreatePullRequestSchema = GitHubCreatePullRequestSchema;
/** @deprecated Use {@link GitHubCreatePullRequest}. */
export type GithubCreatePullRequest = GitHubCreatePullRequest;
/** @deprecated Use {@link GitHubCreatePullResponseSchema}. */
export const GithubCreatePullResponseSchema = GitHubCreatePullResponseSchema;
/** @deprecated Use {@link GitHubCreatePullResponse}. */
export type GithubCreatePullResponse = GitHubCreatePullResponse;
/** @deprecated Use {@link GitHubWorkflowRunSchema}. */
export const GithubWorkflowRunSchema = GitHubWorkflowRunSchema;
/** @deprecated Use {@link GitHubWorkflowRun}. */
export type GithubWorkflowRun = GitHubWorkflowRun;
/** @deprecated Use {@link GitHubCheckStatusResponseSchema}. */
export const GithubCheckStatusResponseSchema = GitHubCheckStatusResponseSchema;
/** @deprecated Use {@link GitHubCheckStatusResponse}. */
export type GithubCheckStatusResponse = GitHubCheckStatusResponse;
/** @deprecated Use {@link GitHubLoginStartResponseSchema}. */
export const GithubLoginStartResponseSchema = GitHubLoginStartResponseSchema;
/** @deprecated Use {@link GitHubLoginStartResponse}. */
export type GithubLoginStartResponse = GitHubLoginStartResponse;
/** @deprecated Use {@link GitHubIdentitySchema}. */
export const GithubIdentitySchema = GitHubIdentitySchema;
/** @deprecated Use {@link GitHubIdentity}. */
export type GithubIdentity = GitHubIdentity;
/** @deprecated Use {@link GitHubLoginPollRequestSchema}. */
export const GithubLoginPollRequestSchema = GitHubLoginPollRequestSchema;
/** @deprecated Use {@link GitHubLoginPollRequest}. */
export type GithubLoginPollRequest = GitHubLoginPollRequest;
/** @deprecated Use {@link GitHubLoginPollResponseSchema}. */
export const GithubLoginPollResponseSchema = GitHubLoginPollResponseSchema;
/** @deprecated Use {@link GitHubLoginPollResponse}. */
export type GithubLoginPollResponse = GitHubLoginPollResponse;
/** @deprecated Use {@link GitHubIdentityResponseSchema}. */
export const GithubIdentityResponseSchema = GitHubIdentityResponseSchema;
/** @deprecated Use {@link GitHubIdentityResponse}. */
export type GithubIdentityResponse = GitHubIdentityResponse;
/** @deprecated Use {@link GitHubRepoSummarySchema}. */
export const GithubRepoSummarySchema = GitHubRepoSummarySchema;
/** @deprecated Use {@link GitHubRepoSummary}. */
export type GithubRepoSummary = GitHubRepoSummary;
/** @deprecated Use {@link GitHubReposResponseSchema}. */
export const GithubReposResponseSchema = GitHubReposResponseSchema;
/** @deprecated Use {@link GitHubReposResponse}. */
export type GithubReposResponse = GitHubReposResponse;
/** @deprecated Use {@link GitHubRepoPreviewRequestSchema}. */
export const GithubRepoPreviewRequestSchema = GitHubRepoPreviewRequestSchema;
/** @deprecated Use {@link GitHubRepoPreviewRequest}. */
export type GithubRepoPreviewRequest = GitHubRepoPreviewRequest;
/** @deprecated Use {@link GitHubRepoPreviewResponseSchema}. */
export const GithubRepoPreviewResponseSchema = GitHubRepoPreviewResponseSchema;
/** @deprecated Use {@link GitHubRepoPreviewResponse}. */
export type GithubRepoPreviewResponse = GitHubRepoPreviewResponse;
/** @deprecated Use {@link ListGitHubPullsResponseSchema}. */
export const ListGithubPullsResponseSchema = ListGitHubPullsResponseSchema;
/** @deprecated Use {@link ListGitHubPullsResponse}. */
export type ListGithubPullsResponse = ListGitHubPullsResponse;
/** @deprecated Use {@link ListGitHubPullFilesResponseSchema}. */
export const ListGithubPullFilesResponseSchema = ListGitHubPullFilesResponseSchema;
/** @deprecated Use {@link ListGitHubPullFilesResponse}. */
export type ListGithubPullFilesResponse = ListGitHubPullFilesResponse;
/** @deprecated Use {@link ListGitHubPullCommentsResponseSchema}. */
export const ListGithubPullCommentsResponseSchema = ListGitHubPullCommentsResponseSchema;
/** @deprecated Use {@link ListGitHubPullCommentsResponse}. */
export type ListGithubPullCommentsResponse = ListGitHubPullCommentsResponse;
/** @deprecated Use {@link ListGitHubWorkflowRunsResponseSchema}. */
export const ListGithubWorkflowRunsResponseSchema = ListGitHubWorkflowRunsResponseSchema;
/** @deprecated Use {@link ListGitHubWorkflowRunsResponse}. */
export type ListGithubWorkflowRunsResponse = ListGitHubWorkflowRunsResponse;
/** @deprecated Use {@link GitHubCredentialSource}. */
export type GithubCredentialSource = GitHubCredentialSource;
