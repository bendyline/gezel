/**
 * Wire contract for remote model execution — the shared schema both ends of
 * the `/v1/remote/infer` link compile against.
 *
 * Device A's `RemoteSession` serializes a {@link RemoteInferRequest} and reads
 * back a stream of {@link RemoteInferFrame}s; Device B's route validates the
 * request, runs it through its existing provider + queue, and emits the frames.
 *
 * Deliberately self-contained (no imports from `../types.js`): a network
 * protocol should be versioned independently so an internal refactor can't
 * silently change the bytes on the wire. The mapping between these wire shapes
 * and the in-process `SessionOpts` / `ExternalToolCall` types lives in the
 * provider/session (A) and the route (B). Bump {@link PROTOCOL_VERSION} on any
 * breaking change; both ends negotiate via `/v1/identity` + the request field.
 */

import { z } from 'zod';

/** Incremented on any breaking change to the request or frame schemas. */
export const PROTOCOL_VERSION = 1;

/** One tool definition advertised to the remote model (OpenAI `function` shape). */
export const ExternalToolSpecWireSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()),
});
export type ExternalToolSpecWire = z.infer<typeof ExternalToolSpecWireSchema>;

/** One tool call the remote model emitted (B parsed it from engine output). */
export const ExternalToolCallWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Raw JSON-string arguments — the local bridge on A parses these. */
  arguments: z.string(),
});
export type ExternalToolCallWire = z.infer<typeof ExternalToolCallWireSchema>;

/** Prior transcript entry — mirrors `SessionOpts.priorMessages`. */
export const PriorMessageWireSchema = z.union([
  // Keep the richer assistant variant FIRST. Zod unions return the first
  // matching object and strip unknown fields; putting the plain assistant
  // shape first silently erased `toolCalls` at B's request boundary. That
  // left the broker with an orphaned role:tool result and made stateless
  // continuations look like a fresh turn to small models.
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(ExternalToolCallWireSchema),
    reasoning: z.string().optional(),
  }),
  z.object({ role: z.literal('tool'), content: z.string(), toolCallId: z.string() }),
  z.object({ role: z.enum(['user', 'assistant']), content: z.string() }),
]);
export type PriorMessageWire = z.infer<typeof PriorMessageWireSchema>;

/** Cumulative cache-prefix layers — mirrors `SystemPromptLayers`. */
export const SystemPromptLayersWireSchema = z.object({
  gezel: z.string(),
  project: z.string(),
});

/**
 * One inline image — mirrors `ImageAttachment`.
 *
 * `filename` is required to match the TS interface. It was optional here,
 * which let a peer relay an attachment that then violated `ImageAttachment` on
 * the receiving side. Attachments are written with a generated uuid name, so
 * there is never a legitimate case for omitting it.
 */
export const ImageAttachmentWireSchema = z.object({
  base64: z.string(),
  mimeType: z.string(),
  filename: z.string(),
});

/**
 * Queue hints A forwards so B's `ProviderQueue` schedules the remote turn the
 * same way it schedules a local one. `sessionId`/`gezelId` drive prompt-cache
 * affinity; B namespaces them by the authenticated origin device before use,
 * so A's raw ids ride here untouched. The abort signal is NOT on the wire — it
 * becomes the request's connection lifetime on B.
 */
export const WireQueueHintsSchema = z.object({
  lane: z.enum(['interactive', 'background']),
  sessionId: z.string().optional(),
  gezelId: z.string().optional(),
  projectId: z.string().optional(),
  actorLabel: z.string().optional(),
  job: z.string().optional(),
  affinity: z.boolean(),
});
export type WireQueueHints = z.infer<typeof WireQueueHintsSchema>;

/**
 * One stateless chat forward-pass. B persists none of this — A holds all
 * session/project state and sends the full transcript each turn.
 */
export const RemoteInferRequestSchema = z.object({
  protocolVersion: z.number(),
  /** B-native model id (A already stripped the `remote:<remoteId>/` prefix). */
  model: z.string(),
  systemMessage: z.string(),
  systemPromptLayers: SystemPromptLayersWireSchema.optional(),
  volatileContext: z.string().optional(),
  /** Current turn's user text — may be '' on a tool-result continuation. */
  prompt: z.string(),
  priorMessages: z.array(PriorMessageWireSchema).default([]),
  /** A's local bridge tool schemas — B advertises them, A executes them. */
  tools: z.array(ExternalToolSpecWireSchema).optional(),
  attachments: z.array(ImageAttachmentWireSchema).optional(),
  reasoningEffort: z.string().optional(),
  /** Resolved tuning (catalog + gezel override) — B maps onto its engine body. */
  tuning: z.record(z.string(), z.unknown()).optional(),
  queue: WireQueueHintsSchema,
});
export type RemoteInferRequest = z.infer<typeof RemoteInferRequestSchema>;

// ---------------------------------------------------------------------------
// User-prepared prompt-cache operations — `POST /v1/remote/cache/*`.
// ---------------------------------------------------------------------------

/**
 * Pre-warm one user-owned session on B without giving B access to A's store.
 * A prepares the exact stable prompt bands, transcript, and advertised tool
 * schemas; B only renders/prefills them through its native provider.
 */
export const RemoteCacheWarmRequestSchema = z.object({
  protocolVersion: z.number(),
  /** B-native `<provider>:<model>` id. */
  model: z.string().min(1),
  /** A-owned id. B namespaces it by the authenticated origin before use. */
  sessionId: z.string().min(1),
  systemMessage: z.string(),
  systemPromptLayers: SystemPromptLayersWireSchema.optional(),
  volatileContext: z.string().optional(),
  priorMessages: z.array(PriorMessageWireSchema).default([]),
  tools: z.array(ExternalToolSpecWireSchema).optional(),
  tuning: z.record(z.string(), z.unknown()).optional(),
});
export type RemoteCacheWarmRequest = z.infer<typeof RemoteCacheWarmRequestSchema>;

export const RemoteCacheEvictRequestSchema = z.object({ sessionId: z.string().min(1) });
export type RemoteCacheEvictRequest = z.infer<typeof RemoteCacheEvictRequestSchema>;

// ---------------------------------------------------------------------------
// Pre-session admission — `POST /v1/remote/admit`.
// ---------------------------------------------------------------------------

/**
 * Ask B to resolve/load a model and report the context window it could
 * actually admit under current RAM/VRAM pressure. A uses this result before
 * constructing its system prompt and tool surface; model-catalog metadata is
 * only the requested/native ceiling and can be substantially larger.
 */
export const RemoteAdmissionRequestSchema = z.object({
  protocolVersion: z.number(),
  /** B-native `<provider>:<model>` id. */
  model: z.string(),
});
export type RemoteAdmissionRequest = z.infer<typeof RemoteAdmissionRequestSchema>;

export const RemoteAdmissionResponseSchema = z.object({
  model: z.string(),
  /** Post-admission, per-session context window in tokens. */
  contextWindow: z.number().int().positive(),
});
export type RemoteAdmissionResponse = z.infer<typeof RemoteAdmissionResponseSchema>;

// ---------------------------------------------------------------------------
// Streamed response frames (SSE `data:` payloads), discriminated on `type`.
// ---------------------------------------------------------------------------

/** Streamed text delta. */
export const DeltaFrameSchema = z.object({ type: z.literal('delta'), text: z.string() });
/** Live private-reasoning delta; kept separate from visible reply text. */
export const ReasoningDeltaFrameSchema = z.object({
  type: z.literal('reasoning_delta'),
  text: z.string(),
});
/** Live structured-tool argument fragment, used as a liveness signal on A. */
export const ToolArgsDeltaFrameSchema = z.object({
  type: z.literal('tool_args_delta'),
  name: z.string(),
  text: z.string(),
  index: z.number().int().nonnegative().optional(),
  id: z.string().optional(),
});
/** B received a non-content SSE frame from its native engine. */
export const WirePulseFrameSchema = z.object({ type: z.literal('wire_pulse') });
/** End-of-turn tool calls B parsed; B halts the turn and returns them to A. */
export const ToolCallFrameSchema = z.object({
  type: z.literal('tool_call'),
  calls: z.array(ExternalToolCallWireSchema),
});
/** Token accounting + context pressure, so A keeps compaction calibrated. */
export const UsageFrameSchema = z.object({
  type: z.literal('usage'),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number().optional(),
  durationMs: z.number().optional(),
  /** Tokens used vs B's context window, so A keeps compaction calibrated. */
  contextUtilization: z.object({ used: z.number(), limit: z.number() }).optional(),
});
/** Captured `<think>` reasoning, so A can populate getLastTurnReasoning. */
export const ReasoningFrameSchema = z.object({ type: z.literal('reasoning'), text: z.string() });
/** Non-fatal warning surfaced to A's session (e.g. ramble abort). */
export const WarningFrameSchema = z.object({ type: z.literal('warning'), message: z.string() });
/** B says the turn is queued behind others (drives A's "queued" UI). */
export const QueuedFrameSchema = z.object({
  type: z.literal('queued'),
  aheadOf: z.number().optional(),
});
/** Engine progress (model loading / prefill), passed through for UX. */
export const PhaseFrameSchema = z.object({
  type: z.literal('phase'),
  provider: z.enum(['llama-cpp', 'mlx', 'ds4']).optional(),
  phase: z.string(),
  detail: z.string().optional(),
  progress: z.number().optional(),
  ttftMs: z.number().int().nonnegative().optional(),
  /** Engine-exact running decode counters — see `engine_phase` in core. */
  outputTokens: z.number().int().nonnegative().optional(),
  tokensPerSec: z.number().nonnegative().optional(),
});
/** End-of-turn native-engine performance counters. */
export const TurnStatsFrameSchema = z.object({
  type: z.literal('turn_stats'),
  provider: z.enum(['llama-cpp', 'ollama', 'mlx', 'ds4']),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  tokensPerSec: z.number().nonnegative().optional(),
});
/** Native engine's static memory allocation, when available. */
export const EngineStatsFrameSchema = z.object({
  type: z.literal('engine_stats'),
  provider: z.enum(['llama-cpp', 'mlx', 'ds4']),
  ramAllocBytes: z.number().nonnegative(),
});
/** Terminal success. */
export const DoneFrameSchema = z.object({ type: z.literal('done') });
/** Terminal failure (model not loaded, engine error, abort). */
export const ErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Model discovery — `GET /v1/remote/models`.
// ---------------------------------------------------------------------------

/** One model B will serve to paired clients, with catalog metadata A applies. */
export const RemoteModelDescriptorSchema = z.object({
  /** B-native `<provider>:<model>` id (A re-namespaces it as `remote:<id>/…`). */
  id: z.string(),
  name: z.string(),
  modality: z.enum(['chat', 'image', 'video', 'audio-stt', 'audio-tts']),
  contextWindow: z.number().optional(),
  supportsTools: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  parameterSize: z.string().optional(),
  /** Whether the engine is currently warm/resident on B. */
  loaded: z.boolean().optional(),
});
export type RemoteModelDescriptor = z.infer<typeof RemoteModelDescriptorSchema>;

export const RemoteModelsResponseSchema = z.object({
  deviceId: z.string(),
  models: z.array(RemoteModelDescriptorSchema),
});
export type RemoteModelsResponse = z.infer<typeof RemoteModelsResponseSchema>;

/**
 * `POST /v1/remote/image/generate` — one stateless image generation. B runs
 * its image engine and returns the PNG bytes (base64); A persists into its own
 * project. Inputs/outputs mirror `ImageGenerationInput`/`Output` with Buffers
 * encoded as base64 for the wire.
 */
export const RemoteImageGenRequestSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  model: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  steps: z.number().optional(),
  seed: z.number().optional(),
  strength: z.number().optional(),
  inputImages: z.array(z.object({ data: z.string(), mimeType: z.string() })).optional(),
});
export type RemoteImageGenRequest = z.infer<typeof RemoteImageGenRequestSchema>;

/** `POST /v1/remote/video/generate` — one stateless video generation. */
export const RemoteVideoGenRequestSchema = z.object({
  prompt: z.string(),
  negativePrompt: z.string().optional(),
  model: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  numFrames: z.number().optional(),
  fps: z.number().optional(),
  steps: z.number().optional(),
  guidanceScale: z.number().optional(),
  seed: z.number().optional(),
  inputImage: z.object({ data: z.string(), mimeType: z.string() }).optional(),
});
export type RemoteVideoGenRequest = z.infer<typeof RemoteVideoGenRequestSchema>;

/** `POST /v1/remote/audio/transcribe` — speech-to-text. */
export const RemoteTranscribeRequestSchema = z.object({
  audio: z.object({ data: z.string(), mimeType: z.string() }),
  model: z.string().optional(),
  language: z.string().optional(),
});
export type RemoteTranscribeRequest = z.infer<typeof RemoteTranscribeRequestSchema>;

/** `POST /v1/remote/audio/synthesize` — text-to-speech. */
export const RemoteSynthesizeRequestSchema = z.object({
  text: z.string(),
  voice: z.string().optional(),
  model: z.string().optional(),
  speed: z.number().optional(),
});
export type RemoteSynthesizeRequest = z.infer<typeof RemoteSynthesizeRequestSchema>;

export const RemoteInferFrameSchema = z.discriminatedUnion('type', [
  DeltaFrameSchema,
  ReasoningDeltaFrameSchema,
  ToolArgsDeltaFrameSchema,
  WirePulseFrameSchema,
  ToolCallFrameSchema,
  UsageFrameSchema,
  ReasoningFrameSchema,
  WarningFrameSchema,
  QueuedFrameSchema,
  PhaseFrameSchema,
  TurnStatsFrameSchema,
  EngineStatsFrameSchema,
  DoneFrameSchema,
  ErrorFrameSchema,
]);
export type RemoteInferFrame = z.infer<typeof RemoteInferFrameSchema>;
