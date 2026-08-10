import { z } from 'zod';
import { PoppetjeSchema } from '../poppetje/schema.js';
import { CodexPermissionModeCompatSchema } from './codex.js';
import { GezelGrowthSummarySchema } from './growth.js';
import { ChatModelTuningSchema } from './model-tuning.js';
import { QuestionSchema } from './question.js';
import { MessageImageDigestSchema } from './recognition.js';
import { SessionGpuTaskSchema } from './session-telemetry.js';
import { TuningProfileIdSchema } from './tuning-profile-registry.js';

/**
 * Agent frontmatter lives at the top of `agent.md`. It describes the agent's
 * identity and model configuration. Everything is optional except the name —
 * Gezel fills in reasonable defaults elsewhere.
 */
export const ProviderNameSchema = z.enum([
  'copilot',
  'openai',
  'anthropic',
  'anthropic-cli',
  'codex-cli',
  'ollama',
  'llama-cpp',
  'mlx',
  // DwarfStar/ds4 — antirez's DeepSeek-V4-specific engine. Like llama-cpp/mlx
  // it serves an OpenAI-compatible HTTP API from a supervised native binary,
  // but it only loads antirez's DeepSeek-V4 GGUFs and streams MoE experts from
  // SSD so a 284B model fits a 64GB Mac. GPU-only (Metal/CUDA); see the ds4
  // provider for the availability gating.
  'ds4',
  // Inference hosted on another paired gezel daemon ("remote models"). A
  // single enum arm fronts a family of paired servers; the specific server is
  // selected by the namespaced model id `remote:<remoteId>/<bLocalId>`. Like
  // the cloud providers, the turn loop + tools run locally — only the model
  // forward-pass is remoted — so `remote` is NOT a local provider.
  'remote',
]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

/**
 * Gezel gender — drives pronouns used when another gezel or the UI refers to
 * this one. It is deliberately not shown to the gezel itself. Three buckets
 * only; the picker assigns one at creation time from the gendered first-name
 * pools (with a ~4% non-binary conversion regardless of name).
 */
export const GezelGenderSchema = z.enum(['male', 'female', 'non-binary']);
export type GezelGender = z.infer<typeof GezelGenderSchema>;

/**
 * Providers that run the model on the user's machine rather than a
 * remote API. They share a family of behaviors that cloud providers
 * don't: we build the outgoing prompt from our locally-held message
 * history (no server-side compaction to rely on), we budget longer
 * turn timeouts for legitimately-slow big models, we throttle
 * memory-extraction so it doesn't dogpile the single-slot queue, and
 * we re-seed `priorMessages` on resume because there's no provider
 * session ID to hand back.
 *
 * Prefer this helper over hand-rolled disjunctions like
 * `p === 'ollama' || p === 'llama-cpp'` — adding a new local engine
 * should mean editing this list, not hunting down every site.
 */
export const LOCAL_PROVIDER_NAMES: readonly ProviderName[] = ['ollama', 'llama-cpp', 'mlx', 'ds4'];
export function isLocalProvider(name: ProviderName): boolean {
  return name === 'ollama' || name === 'llama-cpp' || name === 'mlx' || name === 'ds4';
}

/**
 * Fixed-function gezels skip the LLM entirely. When a chat message
 * comes in, the user text is forwarded straight to the named MCP tool
 * (`tool`) under the argument key `promptKey` (default `prompt`),
 * merged with `defaults` (everything else the tool needs — width,
 * height, model, etc.). The tool's text + image output becomes the
 * assistant message. There is no system prompt; `about.md` is not
 * written for these gezels and the LLM-config fields (`provider`,
 * `model`, `reasoningEffort`, etc.) are silently ignored.
 *
 * Presence of this object is the mode switch — no separate enum.
 * Templates declare it once; the user can edit `defaults` from the
 * gezel-edit dialog. The infrastructure is intentionally generic:
 * future templates can wire to any pass-through-shaped MCP tool
 * (`web_search`, `fetch_url`, …) by changing `tool` + `promptKey`.
 */
export const FixedFunctionConfigSchema = z.object({
  /** MCP tool name to forward to (e.g. `'generate_image'`). */
  tool: z.string().min(1),
  /** Argument key on the tool that receives the user's message text. */
  promptKey: z.string().min(1).default('prompt'),
  /** Defaults merged into every call; user text on `promptKey` always wins. */
  defaults: z.record(z.string(), z.unknown()).optional(),
});
export type FixedFunctionConfig = z.infer<typeof FixedFunctionConfigSchema>;

/**
 * One standing behavior trait. Adopted via the growth system's level-up
 * flow (`source: 'levelup'`) or hand-authored in the frontmatter
 * (`source: 'manual'` / absent).
 */
export const GezelTraitSchema = z.object({
  id: z.string(),
  /** One imperative second-person sentence, rendered as a prompt bullet. */
  text: z.string().min(1).max(200),
  adoptedAt: z.string(),
  source: z.enum(['levelup', 'manual']).optional(),
});
export type GezelTrait = z.infer<typeof GezelTraitSchema>;

export const GezelFrontmatterSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  role: z.string().optional(),
  /**
   * Kebab-case slug derived from `role` (or `gezel-N` when role is absent),
   * globally unique across the install. Collisions get `-2`, `-3`, …
   * suffixes. Backfilled at startup for legacy gezels. Used as a secondary
   * identifier for @-mentions and as the sole rendered identifier when
   * `config.roleBasedNameOnlyMode` is enabled.
   */
  roleBasedName: z.string().optional(),
  /**
   * One of `male` / `female` / `non-binary`. Assigned at creation time
   * from the matching gendered first-name pool (with a small chance of
   * non-binary regardless of name). Drives pronouns in UI copy and in prompt
   * references made by other gezels. It is not rendered into this gezel's
   * own prompt. Absent on legacy gezels, where references omit pronouns.
   */
  gender: GezelGenderSchema.optional(),
  model: z.string().optional(),
  provider: ProviderNameSchema.optional(),
  reasoningEffort: z.string().optional(),
  /**
   * Per-gezel sampling / reasoning / structured-output / tool-call overrides.
   * Sparse — only set fields override the catalog's recommended defaults.
   * Resolution order is gezel `tuning` > installDefault > selected
   * `tuningProfile` > catalog identity `tuning` > provider fallback. See
   * {@link ChatModelTuningSchema} for the full field list and dual-mode
   * (`samplingWhenThinking`) semantics.
   */
  tuning: ChatModelTuningSchema.optional(),
  /**
   * Named tuning preset this gezel uses against the active model. Models
   * declare which presets they implement under `tuning.profiles` in the
   * catalog manifest (e.g. `thinking-coding`, `thinking-general`, `instruct`,
   * `creative`). At request time the resolver applies the named profile as
   * a layer between `installDefault` and the model's base tuning; the
   * gezel's explicit `tuning` overrides still win per-leaf. Missing profiles
   * walk a canonical fallback chain (`thinking-coding → thinking-general →
   * instruct`). See `tuning-profile-registry.ts` for the canonical set.
   */
  tuningProfile: TuningProfileIdSchema.optional(),
  /**
   * Role/template-**suggested** tuning profile. Unlike `tuningProfile`
   * (an explicit per-gezel user pick that overrides the install preset),
   * this is a soft default a gilde template declares for its role. In the
   * resolution stack it sits BELOW both the per-gezel pick and the
   * install-wide preset, and ABOVE the app-wide fallback
   * (`thinking-general`): a gezel uses its role's suggestion unless the
   * user has explicitly chosen a profile (per-gezel or install preset).
   * Lets coordinator roles (meester / voorman / planner) default to a
   * low-temperature `thinking-precise` without locking the user out.
   */
  suggestedTuningProfile: TuningProfileIdSchema.optional(),
  tools: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  /**
   * When set, switches this gezel into "fixed-function" mode: chat
   * messages bypass the LLM and forward to the named MCP tool. See
   * {@link FixedFunctionConfigSchema}. The LLM-config fields above
   * (`model`, `provider`, etc.) are ignored for fixed-function gezels
   * and `about.md` is not used / not written.
   */
  fixedFunction: FixedFunctionConfigSchema.optional(),
  /** Ollama-only: override the context window (tokens) for this gezel. */
  numCtx: z.number().int().positive().optional(),
  /** When false, suppresses auto-recall on session start for this gezel. */
  autoRecall: z.boolean().optional(),
  /**
   * Chat bubble font id (one of `GEZEL_CHAT_FONTS[*].id`). When unset or
   * unrecognized, chat bubbles inherit the app default (Hanken Grotesk).
   */
  font: z.string().optional(),
  /**
   * Kokoro TTS voice id (one of `KOKORO_VOICES[*].id`, e.g. `af_heart`,
   * `bm_george`). Drives spoken audio rendering — `synthesize_speech`
   * defaults to this voice for the gezel. Assigned at creation time
   * from the gender-matched pool; users can override in the edit
   * dialog. Absent on legacy gezels — synthesize falls back to the
   * default voice (`af_heart`) when missing.
   */
  voice: z.string().optional(),
  /**
   * Provenance: the id of the gilde catalog template this gezel was
   * created from, if any. Written by exact-template or about-omitted
   * `create_gezel`, `ensure_gezel`'s template path, and the catalog route.
   * Absent on bespoke-generated or hand-authored gezels. The UI uses
   * this to offer "reset to original template" on the about editor.
   */
  templateId: z.string().optional(),
  /**
   * Provenance: the semver of the template version installed at create
   * time. Paired with `templateId`. Absent on gezels created before this
   * field existed — the "refresh template" UI treats absent as "unknown
   * source version" and offers a refresh to current latest without
   * comparing.
   */
  templateVersion: z.string().optional(),
  /**
   * Copilot-only: when true, deny the Copilot CLI's built-in tools
   * (bash, web_fetch, view, str_replace_editor, read_file, write_file,
   * grep, etc.) and force the model to work through our MCP tools. When
   * Unset inherits the install-level `GezelConfig.sandboxCopilot`, which
   * itself defaults to the sandboxed MCP surface.
   * Provider other than copilot: ignored.
   */
  sandboxCopilot: z.boolean().optional(),
  /**
   * `anthropic-cli`-only: per-gezel override for the Claude CLI permission
   * mode. Forwarded as `--permission-mode <value>` to each `claude` invocation.
   *   - `default`: prompt-aware mode the CLI uses outside scripted contexts.
   *   - `acceptEdits`: auto-approve file edits; Bash + other side-effecting
   *     tools still gate. Sensible default for a chat-driven gezel.
   *   - `plan`: read-only — useful for review-style gezels.
   *   - `bypassPermissions`: yolo — every tool call auto-approved including
   *     Bash. Reserve for builder gezels you trust to run shell commands.
   * When unset, inherits `config.anthropicCli.defaultPermissionMode` (which
   * itself defaults to `acceptEdits`). Other providers: ignored.
   */
  claudePermissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).optional(),
  /**
   * `codex-cli`-only execution posture. New writes use Plan / Edit /
   * Reviewed / Full; legacy Codex values remain readable for compatibility.
   * When unset, the project override and then install default apply.
   */
  codexPermissionMode: CodexPermissionModeCompatSchema.optional(),
  /**
   * When true and the gezel has a custom `icon.svg`, the UI renders that
   * abstract sigil instead of the parametric poppetje. Default (absent /
   * false) renders the poppetje everywhere. Toggled from Gezel Detail.
   */
  iconOverride: z.boolean().optional(),
  /**
   * Standing behavior traits, adopted through the growth system (or
   * hand-authored). Rendered as their own `### Traits` block in the
   * stable system-prompt prefix right after the about body. Capped at 8
   * visible slots; fully revertible (the user can retire any trait).
   * The frontmatter list is AUTHORITATIVE for what's active — growth.json
   * keeps the evidence-bearing adoption log.
   */
  traits: z.array(GezelTraitSchema).max(8).optional(),
  /**
   * Overrides `config.recognition.mode` for this gezel. A gezel whose job is
   * reading screenshots sets `always`; everyone else inherits.
   *
   * Deliberately a single enum rather than a mirror of the config object —
   * frontmatter is user-edited YAML, and a nested policy struct there is a
   * support burden. Native vision is a property of the model *install*, not of
   * the gezel, so it has no frontmatter counterpart.
   */
  recognition: z.enum(['auto', 'always', 'off']).optional(),
});
export type GezelFrontmatter = z.infer<typeof GezelFrontmatterSchema>;

/**
 * A section of an agent.md, extracted by heading. Sections can carry a template
 * annotation (e.g. `## System {[instruction]}`) that tells Gezel how to
 * interpret them.
 */
export const GezelSectionSchema = z.object({
  heading: z.string(),
  template: z.string().optional(),
  params: z.record(z.string(), z.string()).optional(),
  body: z.string(),
});
export type GezelSection = z.infer<typeof GezelSectionSchema>;

export const ParsedGezelSchema = z.object({
  frontmatter: GezelFrontmatterSchema,
  sections: z.array(GezelSectionSchema),
  source: z.string(),
});
export type ParsedGezel = z.infer<typeof ParsedGezelSchema>;

export const GezelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  role: z.string().optional(),
  /** Mirrors `GezelFrontmatter.roleBasedName`. */
  roleBasedName: z.string().optional(),
  /** Mirrors `GezelFrontmatter.gender`. */
  gender: GezelGenderSchema.optional(),
  model: z.string().optional(),
  provider: ProviderNameSchema.optional(),
  reasoningEffort: z.string().optional(),
  /** Mirrors `GezelFrontmatter.tuningProfile`. */
  tuningProfile: TuningProfileIdSchema.optional(),
  /** Mirrors `GezelFrontmatter.suggestedTuningProfile`. */
  suggestedTuningProfile: TuningProfileIdSchema.optional(),
  numCtx: z.number().int().positive().optional(),
  autoRecall: z.boolean().optional(),
  font: z.string().optional(),
  /** Mirrors `GezelFrontmatter.voice` — Kokoro TTS voice id. */
  voice: z.string().optional(),
  /** Mirrors `GezelFrontmatter.templateId` when the gezel came from a gilde template. */
  templateId: z.string().optional(),
  /** Mirrors `GezelFrontmatter.templateVersion`. */
  templateVersion: z.string().optional(),
  /** Mirrors `GezelFrontmatter.sandboxCopilot`. */
  sandboxCopilot: z.boolean().optional(),
  /** Mirrors `GezelFrontmatter.claudePermissionMode`. */
  claudePermissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).optional(),
  /** Mirrors `GezelFrontmatter.codexPermissionMode`. */
  codexPermissionMode: CodexPermissionModeCompatSchema.optional(),
  /**
   * Mirrors `GezelFrontmatter.fixedFunction`. Present means this gezel
   * skips the LLM and forwards messages to an MCP tool. The UI uses
   * its presence to render a sidebar badge, hide LLM controls in the
   * edit dialog, and replace the about pane with a "Forwards to: …"
   * affordance.
   */
  fixedFunction: FixedFunctionConfigSchema.optional(),
  icon: z.string().optional(),
  /**
   * The resolved poppetje character data for this gezel. Inlined on
   * every list/detail response so the UI can render the parametric SVG
   * figure without a follow-up round-trip. Generated from the gezel id
   * on first read; persisted thereafter (so re-rolling the catalog
   * later doesn't drift existing characters).
   */
  poppetje: PoppetjeSchema.optional(),
  /** Mirrors `GezelFrontmatter.iconOverride`. */
  iconOverride: z.boolean().optional(),
  /** Mirrors `GezelFrontmatter.recognition`. */
  recognition: z.enum(['auto', 'always', 'off']).optional(),
  /**
   * Where this gezel lives. `global` (the default when absent — back-compat
   * with every gezel on disk before this field existed) is the install-wide
   * roster under `~/.gezel/gezels/`. `project` is a project-local gezel
   * defined in a workspace `.gezel/` folder — its id is the encoded
   * `proj__<projectId>__<localId>` form (see `encodeProjectGezelId`). The UI
   * badges project-scoped gezels and the roster only surfaces them inside
   * their own project.
   */
  scope: z.enum(['global', 'project']).optional(),
  /**
   * Filesystem ownership boundary, distinct from `scope` above. Shared gezel
   * identity lives in the installer-managed machine root; chats, memories,
   * growth, credentials, and installed toolsets remain in the user home.
   */
  storageScope: z.enum(['user', 'machine-shared']).optional(),
  /** Mirrors `GezelFrontmatter.traits`. */
  traits: z.array(GezelTraitSchema).optional(),
  /**
   * Lightweight growth summary (level + pending level-up flag),
   * hydrated from growth.json and inlined on list/detail responses —
   * like `poppetje` — so the roster badge and Growth-tab dot render
   * without N+1 follow-up requests.
   */
  growth: GezelGrowthSummarySchema.optional(),
  updatedAt: z.string(),
});
export type GezelSummary = z.infer<typeof GezelSummarySchema>;

export const GezelDetailSchema = GezelSummarySchema.extend({
  parsed: ParsedGezelSchema,
  about: z.string(),
  /**
   * Optional contents of the per-gezel `tools.md` file. When present
   * (non-null), fully replaces the auto-injected `## Tools available
   * this turn` block in the system prompt. Power-user opt-in: the
   * gezel's owner accepts responsibility for keeping the listing
   * accurate as the install's registered tools evolve. `null` (the
   * default) means no override file exists and the runtime renders
   * the auto-block from the live MCP bridge.
   */
  toolsMd: z.string().nullable().default(null),
});
export type GezelDetail = z.infer<typeof GezelDetailSchema>;

/**
 * One MCP tool invocation captured during an assistant turn. Persisted on
 * the `ChatMessage` so the UI can still show "here's the tools/thinking
 * that produced this reply" after the stream has closed and the record
 * has been reloaded from disk.
 *
 * `argsSummary` is a short human-readable preview of the non-bulky
 * arguments (e.g. `gezel: "Maya"`, `path: "tests/x.spec.ts"`). Bulky
 * fields like `content` are omitted; values are truncated.
 */
/**
 * Image content blocks returned by an MCP tool result (most commonly
 * `browser_snapshot` / `browser_take_screenshot` from `@playwright/mcp`).
 * The provider's image persister writes the bytes into the project's
 * artifacts/ tree under a per-session subfolder and stores the resulting
 * relative path here. The UI fetches the bytes via the standard
 * `/api/projects/:id/artifacts/read?path=…&raw=1` endpoint.
 */
export const ToolCallImageSchema = z.object({
  /** Path relative to the project's artifacts/ root (e.g. `sessions/2026-04-19_143015_snake-test/tool-3-img-0.png`). */
  path: z.string(),
  /** MIME type of the image, used by the UI to set the right `<img>` src URL. */
  mimeType: z.string(),
});
export type ToolCallImage = z.infer<typeof ToolCallImageSchema>;

/**
 * Audio attachment surfaced alongside a tool call. Created by
 * `synthesize_speech` (TTS narration) and `transcribe_audio`'s caller
 * when they want the source audio rendered in the chat row.
 *
 * The bridge's audio persister writes the WAV bytes into the project's
 * artifacts/ tree (per-session subfolder, parallel to ToolCallImage)
 * and stores the resulting relative path here. The UI fetches the
 * bytes via the standard artifact-blob endpoint and renders an
 * `<audio>` widget.
 */
export const ToolCallAudioSchema = z.object({
  /** Path relative to the project's artifacts/ root. */
  path: z.string(),
  /** MIME type, e.g. `audio/wav`. */
  mimeType: z.string(),
  /** Duration in seconds when known — used by the UI to show length without preloading the blob. */
  durationSeconds: z.number().optional(),
  /** Voice id used to produce this audio (TTS only). */
  voice: z.string().optional(),
});
export type ToolCallAudio = z.infer<typeof ToolCallAudioSchema>;

/**
 * Video attachment surfaced alongside a tool call. Created by
 * `generate_video` (the local diffusers engine). Unlike images/audio the
 * bytes are NOT base64-embedded in the tool result — a multi-MB mp4 in
 * the transcript would be ruinous — so the tool reports the already-
 * written artifact PATH via MCP `structuredContent`, and the UI streams
 * it from the standard artifact-blob endpoint into a `<video>` player.
 */
export const ToolCallVideoSchema = z.object({
  /** Path relative to the project's artifacts/ root (e.g. `generated/video-123.mp4`). */
  path: z.string(),
  /** MIME type, e.g. `video/mp4`. */
  mimeType: z.string(),
  /** Optional poster-frame artifact path for the `<video poster>` attribute. */
  posterPath: z.string().optional(),
});
export type ToolCallVideo = z.infer<typeof ToolCallVideoSchema>;

export const ChatMessageToolCallSchema = z.object({
  name: z.string(),
  durationMs: z.number(),
  success: z.boolean(),
  errorMessage: z.string().optional(),
  /** File path the tool touched, for the References pane. */
  path: z.string().optional(),
  /** Ordered file paths touched by a batched filesystem tool. */
  paths: z.array(z.string()).optional(),
  /** Compact, human-readable one-liner ("→ Freja: update the game loop · file: workspace/index.html"). */
  argsSummary: z.string().optional(),
  /**
   * The tool call's FULL arguments, rendered as readable text (field by
   * field, bulky values shown in full — not truncated like
   * `argsSummary`). Surfaced in the UI behind an expand + copy so a user
   * can verify exactly what a handoff/edit actually sent without digging
   * through the debug log. Capped (~100 KB) server-side; longer blobs get
   * a truncation marker. Same exposure stance as `argsSummary` — MCP tool
   * arguments are not a secret vector in this codebase (secrets live in
   * the toolset-config path), so this is not separately redacted.
   */
  argsFull: z.string().optional(),
  /** Short full response, or a bounded beginning/end summary for a long response. */
  resultText: z.string().optional(),
  /** True when `resultText` is a bounded summary rather than the complete response. */
  resultTruncated: z.boolean().optional(),
  /** Image artifacts the tool returned (e.g. browser_snapshot screenshots). */
  images: z.array(ToolCallImageSchema).optional(),
  /** Audio artifacts the tool returned (e.g. synthesize_speech WAV). */
  audios: z.array(ToolCallAudioSchema).optional(),
  /** Video artifacts the tool returned (e.g. generate_video mp4). */
  videos: z.array(ToolCallVideoSchema).optional(),
  /**
   * Unified diff describing the change a surgical-edit tool made
   * (`replace_in_file`, `apply_patch`, `insert_at_marker`). Used by the UI
   * to render an inline diff under the tool-call row. Capped at ~100KB
   * server-side; larger diffs are truncated with a marker line.
   */
  diff: z.string().optional(),
  addedLines: z.number().int().nonnegative().optional(),
  removedLines: z.number().int().nonnegative().optional(),
});
export type ChatMessageToolCall = z.infer<typeof ChatMessageToolCallSchema>;

/**
 * A single turn in an agent chat. Stored in memory while a chat session is
 * active; dropped when the session ends or the daemon restarts.
 *
 * `from` is set when a message was injected by another gezel via
 * `messageGezel` — the role stays `'user'` so provider schemas work
 * unchanged, but the UI uses this metadata to render the bubble as an
 * inter-gezel handoff rather than a human composer turn.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: z.string(),
  from: z
    .object({
      gezelId: z.string(),
      gezelName: z.string(),
    })
    .optional(),
  /**
   * Artifact paths (relative to the project's `artifacts/` directory)
   * the assistant reply referenced in its body text. Populated on save
   * by the server-side reference parser, and used by the chat UI to
   * render a chip row under the bubble and to linkify inline code spans
   * that match a real artifact. Back-stops Copilot's tool-call
   * blindspot and any "AI wrote a file outside the MCP tools" paths.
   */
  referencedArtifacts: z.array(z.string()).optional(),
  /**
   * Task refs (`<projectId>/<num>`) the assistant reply mentioned. Same
   * shape as `referencedArtifacts` — populated on save, gated on the
   * ref actually existing in the task store, surfaced in the chat
   * bubble as click-through chips. Catches the common "I created task
   * gezel-ux-roadmap/2" mention so the user can jump to it without
   * scrolling the body for the ref.
   */
  referencedTasks: z.array(z.string()).optional(),
  /**
   * Tool calls the assistant fired during this turn. Populated on the
   * final assistant message; the UI renders them as a collapsible
   * "thinking" expando above the reply body so the user can still see
   * what ran even after the live stream has closed.
   */
  toolCalls: z.array(ChatMessageToolCallSchema).optional(),
  /**
   * Phase announcements the model emitted via Copilot's `report_intent`
   * tool during this turn. Each entry carries the intent label and an
   * `afterChars` offset into `content` marking where (in the final
   * reply) the intent fired. The UI splices them back in as horizontal
   * dividers at those offsets so long multi-phase turns are visually
   * segmented. `content` itself stays free of intent text — model
   * replay and history export are unaffected. Copilot-only; other
   * providers don't emit these.
   */
  intents: z
    .array(
      z.object({
        label: z.string(),
        afterChars: z.number().int().min(0),
      }),
    )
    .optional(),
  /**
   * Set when the assistant turn invoked `ask_user_question`. Lets the
   * chat UI correlate the question card with the exact bubble that
   * asked it, mirroring how `toolCalls` is captured. The Question
   * itself lives in the per-project questions file; this id is just
   * the foreign key.
   */
  pendingQuestionId: z.string().optional(),
  /**
   * Marks the message as a system-generated synthesis rather than a real
   * model turn.
   *
   * - `'compaction-summary'` — emitted by the in-flight compaction path
   *   that replaces older messages with a single synthesized "[Earlier
   *   in this conversation: …]" assistant message to keep the prompt
   *   under Ollama's context window.
   * - `'context-loop-halt'` — runtime ended a runaway tool-loop turn
   *   gracefully and recorded a placeholder so the loop wouldn't keep
   *   re-entering.
   * - `'turn-aborted'` — provider threw mid-turn (repeat-tracker,
   *   failure-tracker, or any other unhandled error). Without this
   *   record the drained tool calls and the abort warning would only
   *   live in the client-side streaming slot — refreshing or copying a
   *   debug bundle would lose them. Content is whatever streamed
   *   (often empty); the abort message lives in `warnings`.
   * - `'growth-announcement'` — deterministic level-up announcement the
   *   growth engine appends to the gezel's most recent session ("I just
   *   reached level N…"). First-person and factually true, but not a
   *   real model turn.
   * - `'keurmeester-notice'` — the Keurmeester stepped in on a stalled
   *   turn: one-line diagnosis + what was done, dropped into the thread
   *   before the granted recovery continuation runs.
   *
   * UI renders these as muted bubbles; the model sees them as normal
   * assistant turns (the role label is what matters to the API).
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
   * Display flag: the model sees this message as normal history, but the
   * chat transcript UI never renders a bubble for it. Set on
   * machine-authored facilitation seeds that would only be noise to the
   * reader — e.g. a project-type page's `reaction` seed ("[Checkers page]:
   * Your opponent played c3-d4. Board now: …") when the reaction opts in
   * via `hideSeed`. Unlike `synthetic` (a muted-but-visible bubble), a
   * `hidden` message is dropped entirely: `Store.listTimeline` filters it
   * from loaded transcripts and the live-timeline handler skips its bubble
   * while still opening the assistant's streaming slot.
   */
  hidden: z.boolean().optional(),
  /**
   * This user message was delivered from the session's mid-turn queue
   * as a nudge — typed while the previous turn was still streaming and
   * held until it finished (contiguous nudges merge into one message).
   * Display-only marker: the model sees a normal user turn; the UI
   * renders a small "nudged" chip on the bubble.
   */
  nudge: z.boolean().optional(),
  /**
   * Persistent warnings attached to this assistant turn — fabricated
   * tool-use detection, degraded provider state, etc. The streaming
   * `warning` events show during the live render but vanish when the
   * slot is replaced by the persisted message; this field carries the
   * same text into history so the bubble keeps showing the banner on
   * reload. Populated by the chat manager just before `events.publish`
   * fires the `complete` event.
   */
  warnings: z.array(z.string()).optional(),
  /**
   * Chain-of-thought captured during this turn. Local providers
   * (ollama, llama-cpp, mlx) extract `<think>…</think>` /
   * `<reasoning>…</reasoning>` tagged blocks during commit so they
   * don't pollute the visible reply; Copilot captures its
   * `assistant.reasoning_delta` stream; Anthropic captures
   * `thinking_delta` events. All stash the text here so the chat
   * bubble can render it behind a collapsed "Thinking" expander
   * instead of dropping it when the live stream closes. OpenAI
   * Responses hides reasoning server-side and leaves this unset.
   * Empty / whitespace-only captures are dropped.
   */
  reasoning: z.string().optional(),
  /**
   * Observed wall-clock span of the streamed private-reasoning trace,
   * measured from the first `reasoning_delta` to the last. Optional
   * because older messages and providers that only expose reasoning at
   * commit time have no trustworthy phase timing.
   */
  reasoningDurationMs: z.number().int().nonnegative().optional(),
  /**
   * Tool-call bodies the model emitted that the salvage layer
   * couldn't parse — the literal text from `<|tool_call|>` markers
   * (or prose-shaped `name(args)` attempts) that failed both the
   * structured-call channel AND the repair pipeline. Surfaced here so
   * a debug bundle for "model attempted a tool call but couldn't form
   * it correctly" turns can show what the model actually produced.
   * Without this the diagnostic disappears into provider logs.
   *
   * Populated by the MLX provider when retry budget exhausts. Other
   * providers may add their own equivalents later. Truncated to a few
   * hundred chars per body in the populator so a long fabricated body
   * doesn't blow up the session file.
   */
  attemptedToolCalls: z
    .array(
      z.object({
        body: z.string(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  /**
   * Text descriptions of images this message embedded, for models that can't
   * see. `content` keeps the user's literal markdown (so the thumbnail still
   * renders and the composer can round-trip it); the digest rides alongside and
   * is spliced into the model-visible text at send time and again on every
   * history replay.
   *
   * This has to be persisted rather than injected per-turn: `priorMessages` is
   * rebuilt from the session record for every stateless provider, so an
   * ephemeral digest would make a turn-1 screenshot vanish by turn 5 — after a
   * daemon restart, a provider reset, or a context-pressure rebuild — leaving
   * the model replaying a bare `![](attachments/9f3.png)`.
   */
  recognizedImages: z.array(MessageImageDigestSchema).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * Machine-readable classification of a failed turn, carried beside the
 * human-readable `error` string on the chat event and persisted alongside
 * `ChatSession.lastTurnError`.
 *
 * Without this every field a structured error class carries — the incident
 * id, the engine, the crash class, the launch configuration that produced
 * it — is flattened into `Error.message` at the wire boundary and has to be
 * scraped back out of prose. The bug-report dialog reads this instead.
 *
 * Additive and fully optional: existing consumers read only `error`,
 * sessions written before this field simply lack it, and an older daemon
 * reading a newer session strips the key (Zod objects strip unknown
 * properties) rather than failing to parse.
 *
 * `code` is an open string, not an enum, so a daemon that learns a new
 * failure class cannot break a UI built against an older core. Known
 * values: `native-engine-crash`, `turn-aborted`, `capacity-denied` — plus
 * any Node errno, which arrives for free because Node system errors already
 * carry a string `.code`.
 */
export const ChatTurnErrorDetailSchema = z.object({
  code: z.string().max(64).optional(),
  /** Component that failed — a provider name (`llama-cpp`) or a subsystem. */
  engine: z.string().max(64).optional(),
  /** Correlation key, also written into the engine's own incident log. */
  incidentId: z.string().max(64).optional(),
  /** Native crash class from the exit snapshot, e.g. `cuda-out-of-memory`. */
  panicKind: z.string().max(64).optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().max(32).nullable().optional(),
  /**
   * Request-independent launch facts copied from the crash snapshot, which
   * is contractually free of prompts, tool arguments, and secrets. Bounded
   * by the extractor. A machine profile cannot reconstruct which model at
   * which context size with which KV type crashed; this can.
   */
  diagnostics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type ChatTurnErrorDetail = z.infer<typeof ChatTurnErrorDetailSchema>;

/**
 * Server-sent events on the chat stream — same pattern as TaskEvent.
 * `delta` messages land while the model is still streaming; `complete`
 * marks the final assistant message; `done` closes the stream.
 */
export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), content: z.string() }),
  /**
   * Live private-reasoning tokens (ds4's think phase), streamed on their
   * own channel so they never mix into the visible `delta` stream, the
   * committed reply body, or the external API-compat forwarders. The UI
   * renders them as a distinct "thinking" block that collapses into the
   * committed message's reasoning expander once `complete` lands.
   */
  z.object({ type: z.literal('reasoning_delta'), content: z.string() }),
  z.object({ type: z.literal('complete'), message: ChatMessageSchema }),
  /**
   * Emitted right after the user's message is appended to the session
   * record. The legacy session-scoped UI inserted user messages locally
   * before POSTing, so it didn't need this — but the project + global
   * envelope streams need it so the interleaved timeline can render the
   * user's bubble immediately, before any assistant deltas.
   */
  z.object({ type: z.literal('user_message'), message: ChatMessageSchema }),
  /**
   * Emitted when the assistant invokes an MCP tool (OpenAI + Mock paths
   * only — Copilot runs tools inside its subprocess, invisible to us).
   * The UI surfaces these as "thinking" breadcrumbs.
   */
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    durationMs: z.number(),
    success: z.boolean(),
    errorMessage: z.string().optional(),
    /**
     * File path the tool touched (if any). Set for tools that take a `path`
     * argument: readFile, writeFile, read_artifact, write_artifact,
     * read_document, write_document. Lets the UI build a References panel
     * without guessing.
     */
    path: z.string().optional(),
    /** Ordered file paths touched by a batched filesystem tool. */
    paths: z.array(z.string()).optional(),
    /**
     * Compact human-readable preview of the non-bulky arguments. Example:
     * `gezel: "Maya", message: "what's the status of..."`. Values are
     * truncated and bulky fields like `content` are omitted. Used by the
     * UI to render a useful in-progress tool line instead of just the
     * tool name.
     */
    argsSummary: z.string().optional(),
    /** Full, readable args for the expand + copy affordance. See the persisted `ChatMessageToolCall.argsFull`. */
    argsFull: z.string().optional(),
    /** Short full response, or a bounded beginning/end summary. */
    resultText: z.string().optional(),
    /** True when `resultText` is a bounded summary rather than the complete response. */
    resultTruncated: z.boolean().optional(),
    /**
     * Image artifacts the tool returned (most commonly browser screenshots).
     * Paths are relative to the project's artifacts/ root and resolved
     * to URLs by the UI via the artifact-read endpoint.
     */
    images: z.array(ToolCallImageSchema).optional(),
    /**
     * Audio artifacts the tool returned (synthesize_speech narrations,
     * voice memos transcribed via transcribe_audio). Same artifact-path
     * resolution as `images`.
     */
    audios: z.array(ToolCallAudioSchema).optional(),
    /**
     * Video artifacts the tool returned (`generate_video`). Same
     * artifact-path resolution as `images`; rendered as a `<video>`
     * player in the chat row.
     */
    videos: z.array(ToolCallVideoSchema).optional(),
    /**
     * Unified diff describing the change a surgical-edit tool made
     * (`replace_in_file`, `apply_patch`, `insert_at_marker`). Streams to the
     * UI mid-turn so the chat bubble can render an inline diff under
     * the tool-call row even before the assistant message is finalized.
     */
    diff: z.string().optional(),
    addedLines: z.number().int().nonnegative().optional(),
    removedLines: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('error'),
    error: z.string(),
    // Not `detail` — three sibling variants in this union already use that
    // name for free-form progress prose, and one union with two meanings for
    // one key is a trap.
    errorDetail: ChatTurnErrorDetailSchema.optional(),
  }),
  /**
   * The running turn was intentionally stopped through the cancellation
   * surface. This is terminal for the live UI, but is deliberately not an
   * error: it must not poison the session or render failure recovery UI.
   */
  z.object({ type: z.literal('cancelled') }),
  z.object({ type: z.literal('done') }),
  /**
   * Emitted when a turn ends up waiting in the provider queue for more
   * than a brief grace period (~200ms). `aheadOf` is an approximate
   * count of turns that will dispatch before this one. The UI replaces
   * its "thinking" indicator with a numbered place-in-line diagram
   * until the first `delta` or the wait clears. Sub-threshold waits don't
   * emit this event — avoids flashing the indicator on the happy path
   * where the queue is empty.
   */
  z.object({ type: z.literal('queued'), aheadOf: z.number().int().min(0) }),
  /**
   * Ollama-only: emitted for each bare framing chunk that arrives
   * on the wire without visible content / tool_calls — the
   * housekeeping pings some Ollama versions stream between actual
   * tokens. Lets the UI accumulate "···" dots in the streaming
   * bubble so the user can see "Ollama is alive on the wire" even
   * when the model isn't producing visible output. Reset on the
   * next real `delta`, `tool`, or `complete`.
   */
  z.object({ type: z.literal('wire_pulse') }),
  /**
   * Live tool-argument stream. Fired while the model is generating a
   * structured tool call — most visibly a multi-minute `write_file`
   * whose argument tokens never appear as visible `delta`s, so without
   * this channel the only signal is the accumulating wire-pulse count.
   * `name` is the tool being called ('' until the name chunk arrives);
   * `content` is the raw argument-text chunk (JSON fragments — file
   * content mid-write). The UI accumulates these into a dimmed live
   * "working" block (same pattern as `reasoning_delta`) and drops the
   * block when the corresponding `tool` event lands.
   */
  z.object({ type: z.literal('tool_args_delta'), name: z.string(), content: z.string() }),
  /**
   * Emitted when a provider tells us it's still doing work — even though
   * no visible text/tool event has arrived. Today this is wired from
   * Copilot's `session.thinking_start` / `session.thinking_stop` events,
   * which fire during server-side reasoning that otherwise looks like
   * silence. The UI treats heartbeats as activity so the "silent for Xs"
   * banner doesn't climb while the model is legitimately thinking.
   * Optional `label` carries a short phase hint ('thinking', 'tool',
   * etc.) that the streaming bubble can surface as a status line.
   */
  z.object({ type: z.literal('heartbeat'), label: z.string().optional() }),
  /**
   * Provider-side warning surfaced mid-turn (e.g. Copilot rate-limit,
   * context pressure, degraded mode). The UI renders these inline on
   * the streaming bubble so the user sees them immediately instead of
   * only finding out when the turn completes or times out.
   */
  z.object({
    type: z.literal('warning'),
    message: z.string(),
    /**
     * Optional in-app destination for a warning's inline action. Kept
     * deliberately narrow: warnings are still readable prose when an older
     * client ignores this additive field.
     */
    action: z
      .object({
        kind: z.literal('settings'),
        section: z.enum(['llamaCpp', 'mlx', 'ds4']),
      })
      .optional(),
  }),
  /**
   * Copilot-only: the model announced a phase transition via its
   * `report_intent` built-in tool (e.g. "Building cart checkout
   * flow"). UI inserts a horizontal-rule divider with the label into
   * the streaming bubble at the arrival position, then persists the
   * offset on the final assistant message so completed bubbles render
   * the same segmentation on reload.
   */
  z.object({ type: z.literal('intent'), label: z.string() }),
  /**
   * Emitted when a new message is enqueued on the per-session queue
   * because the session already has a turn in flight. The timeline
   * renders a "ghost bubble" under the session's streaming bubble
   * showing the queued text preview. Cleared via `queue_removed`.
   */
  z.object({
    type: z.literal('queue_enqueued'),
    queueId: z.string(),
    preview: z.string(),
    enqueuedAt: z.string(),
    /**
     * The entry was queued as a mid-turn nudge — the ghost bubble labels
     * it "nudge" and contiguous nudges merge into one turn on drain.
     * Full text is deliberately NOT on the event (it re-publishes on
     * every coalesce/edit); the edit affordance fetches it lazily via
     * `GET /api/sessions/:id/queue`.
     */
    nudge: z.boolean().optional(),
  }),
  /**
   * Emitted when a queued entry leaves the queue — either because
   * it started running (`reason: 'started'`, the next `user_message`
   * event follows for the same queueId / session) or because it was
   * dropped without running (`reason: 'canceled'` via user action,
   * `reason: 'rejected'` via session archive / delete / shutdown).
   */
  z.object({
    type: z.literal('queue_removed'),
    queueId: z.string(),
    reason: z.enum(['started', 'canceled', 'rejected']),
  }),
  /**
   * Local-provider context policy: emitted when accumulated conversation
   * exceeds a safety fraction of the session's effective model context.
   * The UI may suggest starting fresh because this event is never emitted
   * for a first-turn standing system/tool prefix.
   */
  z.object({
    type: z.literal('context_warning'),
    estimatedTokens: z.number(),
    numCtx: z.number(),
    model: z.string(),
  }),
  /**
   * Local-provider context policy: emitted right after in-flight compaction collapses
   * older messages into a single synthesized "[Earlier in this
   * conversation: …]" assistant bubble. The UI swaps the warning banner
   * for a "compacted" variant and refreshes the visible timeline (older
   * bubbles are now gone from disk).
   */
  z.object({
    type: z.literal('context_compacted'),
    removedCount: z.number().int().nonnegative(),
    model: z.string(),
  }),
  /**
   * Emitted when the chat manager detects a self-chat / compaction loop —
   * the same user-initiated send has already triggered N compactions, which
   * means the model is regenerating the same prompt → context-pressure →
   * compaction cycle without making progress. The pipeline halts the turn
   * so the user can intervene; the UI surfaces a "looks stuck" banner.
   */
  z.object({
    type: z.literal('context_loop'),
    compactionsThisSend: z.number().int().positive(),
    reason: z.string(),
  }),
  /**
   * Emitted when the Keurmeester (frontier quality inspector) steps in
   * on a struggling session — diagnosis delivered, action applied. The
   * UI renders a "stepped in" notice on the thread; the full case
   * record lives under `~/.gezel/keurmeester/cases/` keyed by caseId.
   */
  z.object({
    type: z.literal('keurmeester_intervention'),
    caseId: z.string(),
    gezelId: z.string(),
    gezelName: z.string(),
    action: z.string(),
    summary: z.string(),
  }),
  /**
   * Emitted once per session the first time auto-recall runs, so the UI
   * can render a "pulled N memories from prior work" chip above the first
   * assistant reply.
   */
  z.object({
    type: z.literal('recall_applied'),
    hitCount: z.number(),
    query: z.string(),
  }),
  /**
   * Emitted when a gezel posts a structured question via the
   * `ask_user_question` MCP tool. The UI re-fetches its pending
   * questions on this event so the in-chat card, Home pane, and Home
   * tab badge all light up together.
   */
  z.object({ type: z.literal('question_asked'), question: QuestionSchema }),
  /**
   * Emitted when the user submits (or declines) an answer. The UI
   * uses the same fan-out as `question_asked` to refresh every
   * surface; the chat bubble's pending card collapses to its
   * answered state.
   */
  z.object({ type: z.literal('question_answered'), question: QuestionSchema }),
  /**
   * A durable task audit event, fanned onto the project's live stream after
   * it has been appended to History. This keeps lightweight clients (most
   * notably the CLI) current without polling task files or inventing a
   * second task lifecycle bus. `task.tick` heartbeats are intentionally not
   * published; this channel is for user-meaningful changes.
   */
  z.object({
    type: z.literal('task_event'),
    eventId: z.string(),
    kind: z.string(),
    summary: z.string(),
    at: z.string(),
    taskRef: z.string().optional(),
  }),
  /**
   * Emitted when a gezel crosses a growth level threshold and a pending
   * level-up is created. The UI refreshes growth badges/dots and raises
   * a single calm OS notification when the window is hidden.
   */
  z.object({
    type: z.literal('growth_level_up'),
    gezelId: z.string(),
    gezelName: z.string(),
    toLevel: z.number().int(),
  }),
  /**
   * llama-cpp-only: lifecycle phase of the supervised on-device engine
   * for this turn. Fills the gap between "user sent a message" and
   * "first token arrives" — long enough (up to 60-180s on a cold start)
   * that a bare "thinking" spinner reads as hung.
   *
   * Phases:
   *   - `starting`: supervisor spawned llama-server; waiting for `/health`.
   *   - `loading_model`: llama-server is mapping GGUF weights into
   *     memory / compiling Metal shaders. `progress` (0-1) is set when
   *     the stdout parser can extract a percentage.
   *   - `prefill`: request dispatched, waiting for first token.
   *   - `generating`: first token arrived; streaming in progress.
   *   - `ready`: engine is up and idle between turns. Used primarily
   *     to clear stale status labels; not expected to render prominently.
   *
   * `detail` is free-form nerdy text (e.g. "loading layer 28/40",
   * "Metal shader compile") — the UI can surface it verbatim under
   * the phase label so users who want to know what's happening can
   * see, without cluttering the happy-path status line.
   */
  z.object({
    type: z.literal('engine_phase'),
    provider: z.enum(['llama-cpp', 'mlx', 'ds4']),
    phase: z.enum(['starting', 'loading_model', 'prefill', 'generating', 'ready']),
    detail: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    ttftMs: z.number().int().nonnegative().optional(),
  }),
  /**
   * Per-turn telemetry for locally-hosted providers (llama-cpp +
   * Ollama). Emitted once at turn end with the concrete token counts
   * the UI needs for a speed readout — input tokens, output tokens,
   * wall-clock duration, and tokens-per-second on the generation
   * phase. UI accumulates these in a rolling window to show an
   * average tok/s over the last N turns.
   *
   * Cloud providers (Copilot / OpenAI) don't emit this — their usage
   * is tracked differently (`UsageSummary` via `/api/usage`); the
   * local speed metric isn't meaningful when the latency is
   * dominated by network round-trips.
   */
  z.object({
    type: z.literal('turn_stats'),
    provider: z.enum(['llama-cpp', 'ollama', 'mlx', 'ds4']),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    /** Generation speed in tokens/sec — completionTokens / generationSeconds. */
    tokensPerSec: z.number().nonnegative().optional(),
  }),
  /**
   * Static engine-level metrics that don't change during a session —
   * total memory allocated for model weights + KV cache, reported
   * after the supervised engine finishes loading. llama-cpp only
   * today; Ollama doesn't expose this via its HTTP surface.
   *
   * Emitted once per engine lifecycle, fan-out identical to
   * `engine_phase` (every session waiting on the same supervisor
   * startup gets a copy).
   */
  z.object({
    type: z.literal('engine_stats'),
    provider: z.enum(['llama-cpp', 'mlx', 'ds4']),
    /** Total bytes allocated across all GGUF buffers + KV cache. */
    ramAllocBytes: z.number().nonnegative(),
  }),
  /**
   * VRAM tenancy change — a non-LLM workload has taken (or released)
   * the GPU. Fires for the local image generator (sd-cpp), the video
   * generator, and the local image-recognition engine; in the future
   * the same event will surface STT / TTS engines that share the pool.
   *
   * The user-visible point of these events: when the chat session
   * has issued a `generate_image` tool call, the LLM is actually
   * paused (and in `swap` policy, evicted from VRAM) while sd-server
   * runs. Without this signal the bubble would just say "thinking"
   * for 30+ seconds — actively wrong, and the silence-watchdog would
   * fire a "still working — silent for X seconds" reassurance that
   * doesn't apply.
   *
   * Lifecycle: a `started` event when the workload begins, optional
   * `progress` events while the engine reports per-step advancement
   * (sd-server emits `|==> | 3/20 - 18.20s/it` per sampling step), and
   * a paired `ended` event when it finishes (or errors). The UI treats
   * all three as activity signals, so the silence timer resets across
   * the swap.
   *
   * `prompt` carries the user-facing narrative for the workload — for
   * image_generation, the prompt the model passed to `generate_image`.
   * It's set on `started` so the bubble can show "Designing: <prompt>"
   * instead of just dots while sd-server runs. `progress` (0-1) and
   * `step`/`totalSteps` drive a real progress bar; `secondsPerStep`
   * lets the UI show an ETA.
   */
  z.object({
    type: z.literal('gpu_swap'),
    state: z.enum(['started', 'progress', 'ended']),
    /**
     * Shared with session telemetry so a new workload can't light up the
     * bubble while staying invisible to stall detection.
     *
     * `image_recognition` carries no `progress` — llama-server emits no
     * per-step ticks for a single vision decode, and a fabricated bar reads
     * worse than a spinner. It still has to ride this event rather than a log
     * line, because the silence watchdog treats `gpu_swap` as an activity
     * signal; without it a 6s vision pass trips "still working — silent for X
     * seconds", which reads as a bug.
     */
    task: SessionGpuTaskSchema,
    detail: z.string().optional(),
    prompt: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    step: z.number().int().nonnegative().optional(),
    totalSteps: z.number().int().positive().optional(),
    secondsPerStep: z.number().nonnegative().optional(),
  }),
  /**
   * The turn is parked inside a synchronous `ask_gezel` /
   * `ask_specialist` consultation — this gezel's model is idle, blocked
   * on a reply from another gezel. Without this signal the asker's
   * bubble keeps showing the last "Thinking it through" label and looks
   * indistinguishable from the specialist that's actually doing the
   * work, so the user can't tell where the ball is.
   *
   * Lifecycle mirrors `gpu_swap`: a `started` event when the ask is
   * registered (before the question is even delivered), a paired
   * `ended` when the reply arrives, times out, or errors. The UI treats
   * both as activity (the silence watchdog shouldn't fire — the wait is
   * expected, not a stall) and, while `started` is unpaired, dims the
   * bubble and swaps the active "thinking" status for a passive
   * "Waiting on <name>".
   *
   * `targetGezelName` is the already-display-formatted name of the
   * gezel being consulted (role-based-name mode is resolved service-
   * side, same as the `ask_gezel` tool result), so the UI can render
   * it verbatim.
   */
  z.object({
    type: z.literal('awaiting_gezel'),
    state: z.enum(['started', 'ended']),
    targetGezelName: z.string(),
  }),
  /**
   * A new project was created (via the New Project dialog, the
   * `start_project` macro, or any other path through
   * `POST /api/projects`). Emitted on the project + global streams so
   * always-mounted surfaces — the left sidebar PROJECTS list in
   * particular — can fold the project in immediately instead of waiting
   * for the next manual refresh / tab-focus poll. Not a renderable
   * timeline event (like `growth_level_up`); the chat surfaces ignore it.
   */
  z.object({
    type: z.literal('project_created'),
    projectId: z.string(),
    name: z.string(),
  }),
  /**
   * A project was deleted (via the Project Actions menu, or an equivalent
   * path through `DELETE /api/projects/:id`). Emitted on the project +
   * global streams so always-mounted surfaces — the left sidebar PROJECTS
   * list and the Projects view rail — drop the row immediately instead of
   * waiting for the next manual refresh / tab-focus poll. Not a renderable
   * timeline event; the chat surfaces ignore it.
   */
  z.object({
    type: z.literal('project_deleted'),
    projectId: z.string(),
    name: z.string(),
  }),
  /**
   * A new shared gezel joined the global roster. Emitted on the global
   * stream for every Store-backed creation path (including ensure_gezel),
   * so always-mounted roster surfaces can refresh immediately. Project-local
   * gezels deliberately do not emit this event because they do not belong in
   * the global Gezellen list.
   */
  z.object({
    type: z.literal('gezel_created'),
    gezelId: z.string(),
    name: z.string(),
  }),
  /**
   * Global (project-less) signal that Night Shift mode flipped ON/OFF.
   * Emitted by `NightShiftManager` on every state transition so the UI
   * menu pill reflects the live state. `source` is the active driver
   * (scheduled window vs. a manual shift), null when inactive.
   */
  z.object({
    type: z.literal('night_shift'),
    active: z.boolean(),
    source: z.enum(['scheduled', 'manual']).nullable(),
  }),
  /**
   * Global signal from the meester status generator. `started` fires
   * when a run begins (manual runs show "Meester is writing…"),
   * `ended` when a fresh report landed on disk, `failed` when the run
   * produced nothing usable — the Home greeting refetches on the
   * terminal states instead of polling.
   */
  z.object({
    type: z.literal('meester_status'),
    state: z.enum(['started', 'ended', 'failed']),
    generatedAt: z.string().optional(),
  }),
  /**
   * Global (history-free) heartbeat from the boekwachter indexing loops —
   * workspace scans, AI enrichment batches, weekly digests. Drives the live
   * indicator pill; complements (doesn't replace) the polled per-project
   * index status. `pending` = files still awaiting AI enrichment when known.
   */
  z.object({
    type: z.literal('index_progress'),
    phase: z.enum(['scan', 'enrich', 'review', 'digest']),
    state: z.enum(['started', 'progress', 'ended']),
    projectId: z.string().optional(),
    detail: z.string().optional(),
    pending: z.number().int().nonnegative().optional(),
    /** The concrete autonomous gezel doing this work, when the project has one. */
    gezelId: z.string().optional(),
    /** Snapshot of their display name so transient progress remains human-readable. */
    gezelName: z.string().optional(),
  }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

/**
 * Project-scoped + global SSE streams emit envelopes so listeners can
 * disambiguate which session/gezel/project produced the event. The bare
 * per-session stream (`/events/chat?session=`) keeps emitting `ChatEvent`
 * for back-compat — only the multiplexed streams use this shape.
 */
export const ChatEventEnvelopeSchema = z.object({
  sessionId: z.string(),
  gezelId: z.string(),
  projectId: z.string(),
  event: ChatEventSchema,
});
export type ChatEventEnvelope = z.infer<typeof ChatEventEnvelopeSchema>;
