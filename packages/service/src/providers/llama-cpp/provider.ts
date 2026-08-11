/**
 * LlamaCppProvider — talks to a local `llama-server` binary over HTTP.
 * The server speaks OpenAI-compatible `/v1/chat/completions` with SSE
 * streaming and standard tool-calling when launched with `--jinja`.
 *
 * Session model is stateless (like Ollama): we keep the full transcript
 * in memory and resend it each turn. `ProviderSessionState` is empty —
 * the session record on disk is the source of truth.
 *
 * Lifecycle of the llama-server process itself is managed by a
 * {@link NativeEngineSupervisor}: lazy-start on first turn, idle-stop,
 * health-watch, restart budget. The provider asks `ensureRunning()`
 * before each turn and `markUsed()` afterwards. A dev / LAN mode
 * without a supervisor (just a `baseUrl`) is also supported for when
 * the user runs their own llama-server.
 *
 * Each provider INSTANCE serves a single model (one llama-server
 * process); multi-model is handled a layer up by the engine pool
 * (`providers/native/provider-pool.ts`), which keys instances by
 * `{provider, modelId, replicaIdx}` and spools/evicts them under a
 * memory budget. An evicted instance is `disposed` — it must never
 * lazily respawn its process (see {@link shutdown}).
 */

import * as os from 'node:os';
import { WORKSPACE_READ_MAX_FILES, createLogger, leaksUntaggedReasoning } from '@bendyline/gezel';
import { Agent, fetch as undiciFetch } from 'undici';
import type { TurnRambleDetectionConfig } from '../../model-profile/behaviors/turn-ramble-detection.js';
import {
  extractReasoningWithProfile,
  profileBehaviorConfig,
  profileHasBehavior,
} from '../../model-profile/runtime.js';
import { LLAMA_CPP_TUNING_MAP, applyTuning } from '../../model-profile/tuning.js';
import type { ResolvedModelProfile } from '../../model-profile/types.js';
import { prepareSalvagedCodeBlocks } from '../code-block-salvage.js';
import { DeliverableReadPaceTracker } from '../deliverable-read-pacing.js';
import {
  extractDirectFileWorkPrerequisiteReadPaths,
  extractDirectFileWorkTargetPath,
  extractSingleFileSourceRepairTargetPath,
  hasDirectFileDeliverableWording,
  hasExplicitFullFileRewriteWording,
  isSingleFileSourceRepairRequest,
} from '../direct-file-work-prompt.js';
import type { GpuArbiter } from '../gpu-arbiter.js';
import {
  appendCapTruncationHintToRejectedWrite,
  appendTruncationHintToToolResult,
  findClaudeInvokeToolCallSpans,
  findGemmaNativeToolCallSpans,
  findHermesFunctionToolCallSpans,
  findProseToolCallSpans,
  findShellToolCallSpans,
  findTruncatedJsonEnvelope,
  findTruncatedProseToolCall,
  findUnrecognizedToolEnvelope,
  findXmlTagToolCallSpans,
  foldPostActionRumination,
  foldPreToolPreamble,
  isWriteShapedToolName,
  parseJsonEnvelopeToolCalls,
  salvageWriteShapedTruncation,
  stripClaudeInvokeToolCallsFromText,
  stripGemmaNativeToolCallsFromText,
  stripHermesFunctionToolCallsFromText,
  stripJsonEnvelopesFromText,
  stripProseToolCallsFromText,
  stripShellToolCallsFromText,
  stripXmlTagToolCallsFromText,
} from '../local-tool-call-salvage.js';
import { McpBridgePool } from '../mcp-bridge-pool.js';
import { capToolOutput, computeToolBudgetChars } from '../mcp-bridge.js';
import type {
  NativeEngineExitSnapshot,
  NativeEngineLaunch,
  NativeEngineLifecycleSnapshot,
  NativeEngineSupervisor,
} from '../native/supervisor.js';
import { isSseComment, readSseEvents } from '../openai-compatible/sse.js';
import { ProviderQueue, defaultAmbientQuietMs, runInQueue } from '../queue.js';
import { RambleDetector } from '../ramble-detector.js';
import { type EnginePhaseEvent, StreamingSessionBase } from '../streaming-session.js';
import { terminalToolClosingText } from '../terminal-tool-policy.js';
import { coerceToolCallArgs } from '../tool-arg-schema-coercion.js';
import { ToolFailureTracker } from '../tool-failure-tracker.js';
import { ToolRepeatTracker } from '../tool-repeat-tracker.js';
import type {
  BatchCapability,
  EngineLaunchSnapshot,
  ExternalToolCall,
  ExternalToolSpec,
  ImageAttachment,
  LLMProvider,
  LLMSession,
  ModelInfo,
  ProviderSessionState,
  SendAndWaitOpts,
  SessionOpts,
} from '../types.js';
import { buildTurnUsage } from '../usage-builder.js';
import type { LlamaCppLogFile } from './log.js';
import { type StartupPhase, classifyStartupLine } from './stdout-parser.js';
import {
  isLlamaCppGrammarParseError,
  normalizeJsonSchemaForLlamaCpp,
  simplifyJsonSchemaForLlamaCpp,
  stripJsonSchemaPatternsForLlamaCpp,
} from './tool-grammar.js';

const log = createLogger('llama-cpp');

export class NativeEngineCrashedError extends Error {
  readonly code = 'native-engine-crash';
  readonly engine = 'llama-cpp';
  readonly incidentId: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly panicKind?: NativeEngineExitSnapshot['panicKind'];
  readonly diagnostics?: NativeEngineExitSnapshot['diagnostics'];

  constructor(
    readonly snapshot: NativeEngineExitSnapshot,
    cause?: unknown,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    const detail = snapshot.panicKind
      ? ` (${snapshot.panicKind})`
      : snapshot.signal
        ? ` (${snapshot.signal})`
        : '';
    // An unrunnable build is not a transient fault, so it must not be
    // described as one. "It will restart on the next request" is true of
    // a CUDA OOM and actively misleading here: the restart reproduces
    // the crash byte-for-byte. Say what happened and what changes.
    const unrunnable = snapshot.panicKind === 'illegal-instruction' && !snapshot.reachedReady;
    const outcome = unrunnable
      ? 'This build cannot run on this machine — it uses CPU instructions this processor does not ' +
        'support, or faulted inside GPU library startup. Gezel will switch to another engine ' +
        'backend on the next request.'
      : 'It will restart on the next request.';
    super(
      `[llama-cpp] on-device engine crashed${detail}; incident=${snapshot.incidentId}. ` +
        `${outcome}${causeMessage ? ` Transport reported: ${causeMessage}` : ''}`,
      { cause },
    );
    this.name = 'NativeEngineCrashedError';
    this.incidentId = snapshot.incidentId;
    this.exitCode = snapshot.code;
    this.signal = snapshot.signal;
    if (snapshot.panicKind) this.panicKind = snapshot.panicKind;
    if (snapshot.diagnostics) this.diagnostics = { ...snapshot.diagnostics };
  }
}

/**
 * Parse an env-var override expressed as positive integer milliseconds.
 * Returns null when unset, empty, or non-positive — callers use
 * `?? defaultMs` to fall through cleanly. Lives at module scope so the
 * constructor body stays readable.
 */
function parseEnvMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isGemmaChannelProfile(profile: ResolvedModelProfile | undefined): boolean {
  return profile?.style.family === 'gemma' && profile.style.reasoningFormat === 'channel';
}

/**
 * Hard ceiling on tool-call loop rounds per turn. Mirrors Ollama's
 * cap — real exploration flows chain dozens of reads; 96 leaves room
 * for the long tail without letting a runaway model spin forever.
 */
const MAX_TOOL_LOOP_TURNS = 96;

/**
 * Default total wall-clock budget for one `sendAndWait` call. Callers
 * (ChatManager, TaskRunner) typically pass their own via `opts.timeoutMs`.
 */
const DEFAULT_TIMEOUT_MS = 120_000;
// This is a floor, not a preferred cap. A model with a larger catalog
// `sampling.maxTokens` keeps that larger value; models with no tuning land
// on this fallback. Keep the fallback bounded for small local models, and
// give large/code-heavy models an explicit catalog value instead.
const IMMEDIATE_FILE_WRITE_MIN_TOKENS = 4_096;
// Max automatic append_to_file continuations after an immediate-write
// truncation before bailing with the partial. Mirrors the MLX provider:
// on EOS-flush of a write_file larger than the per-turn token cap, we
// surface append_to_file and loop until the tail lands or we hit this cap,
// instead of bailing on an incomplete file the weak model never finished.
const MAX_IMMEDIATE_WRITE_CONTINUATIONS = 6;
// Minimal append_to_file surfaced ONLY during a write-continuation (the
// base immediate-write surface is write_file-only). Lets the model emit a
// truncated file's tail rather than re-writing the whole file.
const APPEND_TO_FILE_CONTINUATION_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'append_to_file',
    description:
      'Append text to the END of an existing workspace file. Use this to write the remaining tail of a file whose previous write_file was truncated mid-content. Do not repeat content already on disk — start exactly where the file currently ends.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path of the file to append to.' },
        content: {
          type: 'string',
          description: 'Text appended verbatim at the current end of the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
};
const IMMEDIATE_FILE_WRITE_TEXT_ABORT_CHARS = 4_096;
const IMMEDIATE_FILE_WRITE_PROMPT_SUFFIX =
  '\n\n[Local-model rescue: make this a compact first pass. Your entire visible output should be one `write_file` tool call. Prioritize a complete, runnable file over decorative extras; include every requested behavior and any named asset path. Do not include planning prose.]';
const SCENARIO_FILE_REPAIR_MAX_TOKENS = 4_096;
const SCENARIO_FILE_REPAIR_TEXT_ABORT_CHARS = 2_048;
// Extended prose cap for repair turns that legitimately restate whole-file
// content: an explicit full-rewrite ask, or a buffer already mid-payload
// (unclosed code fence / inline tool-call markup). Wild-caught on
// craftbook-audiobook-master-pack (gemma4-e2b): the 2048-char abort truncated
// a full-file JSON rewrite mid-repair, converting a salvageable rewrite into
// a no-mutation corrective. Deferring until the payload closes lets the
// ramble-recovery code-block salvage promote the completed payload to a
// write_file; the extended cap keeps the anti-poisoning bound.
const SCENARIO_FILE_REPAIR_PAYLOAD_TEXT_ABORT_CHARS = 8_192;
const SCENARIO_FILE_REPAIR_PROMPT_SUFFIX =
  '\n\n[Local-model repair mode: your next output must start with one tool call, not planning prose. Follow the concrete tool instruction in the scenario-check message: if it names `append_to_file`, call `append_to_file`; if it names `replace_in_file`, call `replace_in_file`; if it names `write_file({ path: "...", content: ... })`, call `write_file` for that named path with the corrected complete content. For non-source documents, expand or patch the named document file; do not fall back to `index.html`. Do not reply with verification prose.]';
const PREREQUISITE_REPAIR_READ_PROMPT_SUFFIX =
  '\n\n[Local-model provenance-read mode: this repair explicitly requires successful reads before any final claim mutation. While the read-only tool surface is active, call `read_file` for one of the remaining allowed source paths immediately. Do not plan, summarize, or edit early. After every required source read succeeds, the tool surface will switch to file mutations for the grounded repair.]';
const SCENARIO_SOURCE_REPAIR_PROMPT_SUFFIX =
  '\n\n[Local-model source repair mode: the source file already exists. Preserve passing behavior and fix only the newest named failing check. Treat `Signals that did not fire` / `missing=[...]` as the to-do list; signals that fired are already passing and should not be renamed, recased, or polished. Repair compiler or syntax errors before behavioral failures so the next check sees a valid program. A duplicate-identifier error means delete one duplicate declaration; for example, an object literal must not contain both a data property and a getter with the same name. If a failure list names a missing field or behavior, implement that named requirement now. Use `read_file` if you need current snippets or line numbers, then patch with `replace_in_file` or `replace_lines` for the smallest relevant snippet/range. Do not re-emit the whole file with `write_file` unless the check explicitly requires a complete rewrite or the runtime escalates after repeated repair failures.]';
const SCENARIO_SOURCE_REPAIR_PATCH_PROMPT_SUFFIX =
  '\n\n[Local-model source patch mode: you already read the current source this repair turn. Your next output must start with `replace_in_file` or `replace_lines` for the smallest snippet/range that satisfies the newest missing signal or failing check. If the check reports a compiler or syntax error, fix that error first. For a duplicate identifier, remove one duplicate declaration instead of rewriting the surrounding behavior; an object literal cannot keep both a data property and a getter with the same name. Do not edit signals listed as fired; do not rename, recase, or polish already-passing controls while the missing signal remains absent.]';
const CROSS_FILE_COMPILER_DEPENDENCY_READ_PROMPT_SUFFIX =
  '\n\n[Local-model dependency refresh: the compiler failure depends on a type or identifier defined outside the checked file. Your next output must be one `read_file` call for the existing source file that defines or exports that symbol. Do not guess its fields, property types, import path, or a replacement type name. Do not restore any draft that produced an earlier compiler error in this repair sequence.]';
const SCENARIO_SOURCE_FULL_REWRITE_PROMPT_SUFFIX =
  '\n\n[Local-model source rewrite mode: the newest check explicitly requires a complete whole-file rewrite. Your next output must start with `write_file` for the named source file and include the complete corrected contents. Do not read, patch, append, or reply in prose before writing.]';
const SCENARIO_FULL_REWRITE_PROMPT_SUFFIX =
  '\n\n[Local-model full-file rewrite mode: the newest check explicitly requires a complete whole-file rewrite. Your next output must start with `write_file` for the named checked file and include the complete corrected contents. Do not read, patch, append, or reply in prose before writing.]';
const SCENARIO_SOURCE_REWRITE_FALLBACK_PROMPT_SUFFIX =
  '\n\n[Local-model source rewrite fallback: repeated repair attempts did not change the source file. Your next output must start with `write_file` for the relevant source file and include the complete corrected contents. Do not read or try another guessed patch before writing.]';
const SCENARIO_SOURCE_REWRITE_REFRESH_PROMPT_SUFFIX =
  '\n\n[Local-model source rewrite refresh: the repair is escalating to a complete rewrite, but your prior source view may now be stale. Read the exact target source file once now. After that read succeeds, rewrite from those current bytes; do not invent imports, dependencies, APIs, or surrounding code that are not present in the fresh read.]';
const EXISTING_SOURCE_EDIT_MAX_TOKENS = 2_048;
const EXISTING_SOURCE_EDIT_PROMPT_SUFFIX =
  '\n\n[Local-model edit mode: preserve working behavior and implement the requested delta with workspace tools. Treat the newest user/scenario message as the delta; target its newest named requirement and preserve older passing behavior without polishing it. Start with `read_file` only if you have not inspected the target file yet; otherwise start with one edit tool call. Prefer `replace_in_file` or `replace_lines` for small changes. Use `write_file` only when emitting complete corrected file contents. Do not include planning prose.]';
const EXISTING_SOURCE_EDIT_PATCH_PROMPT_SUFFIX =
  '\n\n[Local-model patch mode: you already inspected the current source this turn. Your next output must start with `replace_lines` or `replace_in_file` for the smallest relevant range/snippet that satisfies the newest named requirement or failing check. Do not re-emit the whole file with `write_file`.]';
const DIRECT_FILE_WORK_MAX_TOKENS = 4_096;
// After reads, the model often emits the entire deliverable as write_file
// arguments. Keep this high enough for JSON/CSV outputs; 1k truncated DS4.
const DIRECT_FILE_WORK_AFTER_READ_MAX_TOKENS = 4_096;
const DIRECT_FILE_WORK_SCRIPT_HELPER_PATH = 'scripts/clean_data.mjs';
const CONSTRAINED_TOOL_NO_SIGNAL_CHUNK_LIMIT = 32;
const CONSTRAINED_TOOL_REASONING_CHAR_LIMIT = 1_024;
const CONSTRAINED_TOOL_NO_SIGNAL_MS = 45_000;
// DeepSeek R1 keeps emitting private reasoning even when constrained turns
// request thinking=false. GPT-OSS has a separate native reasoning-effort
// control, but even its low setting benefits from the same bounded allowance.
// Keep the normal guard tight for models that honor no-think mode.
const EXPANDED_CONSTRAINED_TOOL_REASONING_CHAR_LIMIT = 3_072;
const EXPANDED_CONSTRAINED_TOOL_NO_SIGNAL_MS = 90_000;

function isDeepSeekR1Model(model: string | undefined): boolean {
  return model === 'deepseek-r1-8b-q4';
}

function isGptOss20bModel(model: string | undefined): boolean {
  return model === 'gpt-oss-20b-q4';
}

// Muse Glimmer's template has no no-think mode at all — only a
// `reasoning_strength` dial, which constrained turns already pull down to
// `low` (see disableThinkingForConstrainedTurn). Even there it plans past the
// tight budget on a whole-file deliverable: measured 2026-08-10 on the
// tictactoe eval, the turn aborted at 1025 reasoning chars against the 1024
// limit. Same shape as the GPT-OSS note above — a native depth control that
// still wants the bounded allowance rather than the strict one. Prefix-matched
// so sibling quants (dynamic / q8) inherit it.
function isMuseGlimmerModel(model: string | undefined): boolean {
  return model?.startsWith('muse-glimmer') === true;
}

function needsExpandedConstrainedToolReasoning(model: string | undefined): boolean {
  return isDeepSeekR1Model(model) || isGptOss20bModel(model) || isMuseGlimmerModel(model);
}

export function constrainedToolReasoningCharLimitForModel(model: string): number {
  return needsExpandedConstrainedToolReasoning(model)
    ? EXPANDED_CONSTRAINED_TOOL_REASONING_CHAR_LIMIT
    : CONSTRAINED_TOOL_REASONING_CHAR_LIMIT;
}

export function constrainedToolNoSignalMsForModel(model: string | undefined): number {
  return needsExpandedConstrainedToolReasoning(model)
    ? EXPANDED_CONSTRAINED_TOOL_NO_SIGNAL_MS
    : CONSTRAINED_TOOL_NO_SIGNAL_MS;
}
const DIRECT_FILE_WORK_PROMPT_SUFFIX =
  '\n\n[Local-model file-work mode: this turn has a concrete workspace file deliverable. Use reads only to inspect required inputs, then write the named output file. Do not answer with a plan or paste file contents in chat. The turn is not complete until `write_file`, `append_to_file`, `replace_in_file`, `replace_lines`, or a workspace-writing `run_nodejs_script` has succeeded.]';
const DIRECT_FILE_WORK_AFTER_READ_PROMPT_SUFFIX =
  '\n\n[Local-model write-now mode: you already inspected the relevant inputs. Your next output must start with a workspace mutation. Use `write_file` for small direct deliverables; use a helper script when the output is a derived data file and `run_nodejs_script` is exposed. Do not call `read_file`, `read_files`, `list_dir`, `stat`, or `validate` again before writing.]';
const DIRECT_FILE_WORK_PREREQUISITE_READ_PROMPT_SUFFIX =
  '\n\n[Local-model prerequisite-read mode: the request explicitly names source files. Read every named source successfully before writing the output. While sources remain, call only `read_file`; after the final source read, the tool surface will switch to file mutations.]';
const DOM_NULL_REPAIR_PROMPT_SUFFIX =
  '\n\n[DOM null repair: the browser error says code read or set a property on `null`. That usually means a selector/id/class in JavaScript does not exist in the HTML shell yet, or the code runs before that node exists. Before editing, compare `getElementById(...)` / `querySelector(...)` names in the JS modules against actual `id` / `class` attributes in the HTML. Patch the mismatch or move initialization after the DOM nodes exist; do not rewrite unrelated passing behavior.]';
// A surgical patch never needs the 4K whole-file budget — stage 2
// (immediate-write) owns whole-file rewrites.
const GATE_SURGICAL_EDIT_MAX_TOKENS = 2_048;
const GATE_SURGICAL_EDIT_PROMPT_SUFFIX =
  '\n\n[Local-model gate patch mode: the deliverable exists and failed named checks. Your next output must start with `replace_in_file` (or `replace_lines`) making the smallest edit that clears the FIRST failing check. Copy the `find` text from the file content you already produced this session. Do not re-emit the whole file, do not read, do not reply in prose.]';
const SCENARIO_FILE_REPAIR_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'read_files',
  'list_dir',
  'stat',
  'validate',
  'replace_in_file',
  'replace_lines',
  'write_file',
  'append_to_file',
]);
const SCENARIO_FILE_REPAIR_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'read_files',
  'list_dir',
  'stat',
  'validate',
]);
const SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'replace_in_file',
  'replace_lines',
  'write_file',
  'append_to_file',
]);
const EXISTING_SOURCE_EDIT_PATCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  'replace_in_file',
  'replace_lines',
]);
const SCENARIO_SOURCE_REPAIR_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'validate',
  'replace_in_file',
  'replace_lines',
]);
const DIRECT_FILE_WORK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'read_files',
  'list_dir',
  'stat',
  'validate',
  'make_dir',
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'run_nodejs_script',
]);
const DIRECT_FILE_WORK_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'read_files',
  'list_dir',
  'stat',
  'validate',
]);
const DIRECT_FILE_WORK_MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
  'run_nodejs_script',
]);
const SCRIPTED_DIRECT_FILE_WORK_PROMPT_RE =
  /\b(?:write|create|generate|use|run)\s+(?:a\s+)?(?:node(?:\.js)?\s+)?script\b|\bnode\s+script\b|\bscript\s+and\s+run\b/i;
const SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT = 2;

/**
 * Fetch for local llama-server calls with undici's built-in 5-minute
 * headers/body timeouts disabled. llama-server can spend longer than
 * that in cold prefill before sending the first SSE byte; the provider
 * already owns the real turn deadlines via AbortController.
 */
let cachedPatientFetch: typeof fetch | undefined;
export function createLlamaCppPatientFetch(): typeof fetch {
  if (!cachedPatientFetch) {
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    cachedPatientFetch = ((
      url: Parameters<typeof undiciFetch>[0],
      init?: Parameters<typeof undiciFetch>[1],
    ) => undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
  }
  return cachedPatientFetch;
}

/**
 * Default context window (tokens) for sessions handed out by this
 * provider when `opts.numCtx` is not passed. Bumped 32K → 49K → 65K
 * as the matrix-3 petshop ran into a
 * second OOM at 49K. Kept in lockstep with ChatManager's
 * `PREFERRED_CTX_DEFAULT` — see the long comment block there for
 * the petshop-OOM rationale and KV-cache memory budget.
 */
const DEFAULT_NUM_CTX = 65_536;

/**
 * Messages kept in memory for this session. Matches the Chat
 * Completions schema so we can pass the list straight into the
 * request body without per-turn transformation.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  /**
   * Verbatim private reasoning captured from this assistant turn's SSE
   * `reasoning_content` channel. Only attached when the provider was
   * built with `replayReasoningContent` (ds4): ds4-server re-renders
   * replayed assistant turns as `<think>{reasoning_content}</think>` and
   * compares the result token-by-token against its live KV cache, so
   * echoing the exact bytes back is what keeps agentic continuations on
   * the cached path instead of a minutes-long full-tail re-prefill.
   */
  reasoning_content?: string;
  /**
   * Images the user attached to this turn. Held in their decoded form rather
   * than pre-serialized so the in-memory history stays plain-string `content`
   * — every compaction, replay, and reasoning-strip path reads `.content` as
   * text. {@link toWireMessages} converts these at the request boundary.
   */
  attachments?: ImageAttachment[];
}

/** OpenAI-compatible typed content, which is what llama-server actually reads. */
type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface WireMessage extends Omit<ChatMessage, 'content' | 'attachments'> {
  content: string | null | WireContentPart[];
}

/**
 * Expand attached images into typed content parts.
 *
 * This replaced an Ollama-shaped `images: string[]` field that llama-server
 * silently ignored — so no local model could see a pasted screenshot even when
 * launched with `--mmproj`, and the two catalog models that do ship a
 * projector were paying its prompt-cache cost for nothing.
 *
 * Messages without attachments are returned BY REFERENCE, not copied. The
 * per-turn nudge logic appends to `userMsg.content` in place after the request
 * body has been assembled, relying on the body holding the same objects as
 * `this.messages` — copying here silently dropped every nudge.
 */
export function toWireMessages(messages: ReadonlyArray<ChatMessage>): WireMessage[] {
  return messages.map((m) => {
    if (!m.attachments) return m;
    if (m.attachments.length === 0) {
      const { attachments: _empty, ...rest } = m;
      return rest;
    }
    const { attachments, content, ...rest } = m;
    return {
      ...rest,
      content: [
        { type: 'text' as const, text: content ?? '' },
        ...attachments.map((a) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${a.mimeType};base64,${a.base64}` },
        })),
      ],
    };
  });
}

/**
 * Apply {@link toWireMessages} at serialization time.
 *
 * Deliberately called inside `JSON.stringify(...)` rather than when the body
 * is built: everything between those two points may still mutate the message
 * list in place.
 */
function withWireMessages(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as ChatMessage[] | undefined;
  if (!messages?.some((m) => m.attachments?.length)) return body;
  return { ...body, messages: toWireMessages(messages) };
}

export {
  isLlamaCppGrammarParseError,
  normalizeJsonSchemaForLlamaCpp,
  simplifyJsonSchemaForLlamaCpp,
  stripJsonSchemaPatternsForLlamaCpp,
} from './tool-grammar.js';

interface ChatCompletionTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

function hasJsonSchemaPatternsForLlamaCpp(tools: ChatCompletionTool[]): boolean {
  return tools.some(
    (tool) =>
      stripJsonSchemaPatternsForLlamaCpp(tool.function.parameters) !== tool.function.parameters,
  );
}

type ToolGrammarFallback = 'none' | 'strip-patterns' | 'simplified' | 'permissive';

function applyToolGrammarFallback(
  tools: ChatCompletionTool[],
  fallback: ToolGrammarFallback,
): ChatCompletionTool[] {
  if (fallback === 'none') return tools;
  return tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      parameters:
        fallback === 'strip-patterns'
          ? stripJsonSchemaPatternsForLlamaCpp(tool.function.parameters)
          : fallback === 'simplified'
            ? simplifyJsonSchemaForLlamaCpp(tool.function.parameters)
            : { type: 'object' },
    },
  }));
}

function chatCompletionToolName(tool: ChatCompletionTool): string | undefined {
  return tool.function.name;
}

function hasWriteFileTool(tools: ChatCompletionTool[] | undefined): boolean {
  return tools?.some((tool) => chatCompletionToolName(tool) === 'write_file') ?? false;
}

function writeFileOnlyTools(tools: ChatCompletionTool[] | undefined): ChatCompletionTool[] {
  const writeFile = tools?.find((tool) => chatCompletionToolName(tool) === 'write_file');
  return writeFile ? [writeFile] : [];
}

function readFileOnlyTools(tools: ChatCompletionTool[] | undefined): ChatCompletionTool[] {
  const readFile = tools?.find((tool) => chatCompletionToolName(tool) === 'read_file');
  return readFile ? [readFile] : [];
}

/**
 * Paths whose complete contents reached the model in one workspace-read call.
 * `read_files` status rows are emitted in request order, so map by index rather
 * than parsing an unescaped path back out of model-facing prose. A bridge-level
 * truncation invalidates the whole batch: later file bodies may not have reached
 * the model even when their source-side status row said `complete`.
 */
export function completeWorkspaceReadPaths(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): string[] {
  if (output.startsWith('ERROR:') || output.includes('…[tool output truncated:')) return [];
  if (toolName === 'read_file') {
    if (typeof args.path !== 'string') return [];
    const ranged = args.startLine !== undefined || args.endLine !== undefined;
    if (ranged && !/^\[read_file [^\n]* complete\]/.test(output)) return [];
    return [normalizeWorkspacePathForCompare(args.path)];
  }
  if (toolName !== 'read_files') return [];

  const requested: Array<string | undefined> = Array.isArray(args.paths)
    ? args.paths.map((path) => (typeof path === 'string' ? path : undefined))
    : Array.isArray(args.files)
      ? args.files.map((item) =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).path === 'string'
            ? ((item as Record<string, unknown>).path as string)
            : undefined,
        )
      : [];
  const statusLines = (output.split('\n\n', 1)[0] ?? '').split('\n').slice(1);
  return requested.slice(0, WORKSPACE_READ_MAX_FILES).flatMap((path, index) => {
    if (!path) return [];
    const statusPrefix = `${index + 1} OK `;
    const line = statusLines.find((candidate) => candidate.indexOf(statusPrefix) === 0);
    const complete =
      line?.match(
        /\slines=(?:none|\d+-\d+)\s+totalLines=(?:\?|\d+)(\s+complete)?(?:\s+nextStartLine=\d+)?$/,
      )?.[1] !== undefined;
    return complete ? [normalizeWorkspacePathForCompare(path)] : [];
  });
}

function isImmediateFileWritePrompt(
  prompt: string,
  context: { toolSurfaceIsWriteFileOnly: boolean },
): boolean {
  const urgentWriteNow =
    prompt.includes('There is still **no `index.html`** in the workspace') ||
    prompt.includes('Stop reading/planning and write the file now:') ||
    prompt.includes('Do not end your turn until `write_file`') ||
    prompt.includes('First move: create the workspace deliverable') ||
    isDirectCreateSourceWritePrompt(prompt) ||
    prompt.includes('workspace/index.html');
  const explicitDeliverableRecovery =
    /\bnext\s+tool\s+call\s+should\s+(?:write|repair|write\s+or\s+repair)\b[\s\S]{0,180}\bworkspace\s+deliverable\b/i.test(
      prompt,
    ) ||
    (/\bprevious\s+turn\s+aborted\b/i.test(prompt) &&
      /\bworkspace\s+deliverable\b/i.test(prompt) &&
      /\bwrite_file\b/.test(prompt));
  if (urgentWriteNow) return true;
  if (explicitDeliverableRecovery) return true;
  return (
    context.toolSurfaceIsWriteFileOnly &&
    /\[Deliverable expected as a FILE at `[^`]+`/i.test(prompt)
  );
}

export function isImmediateFileWriteTurn(
  prompt: string,
  tools: ChatCompletionTool[] | undefined,
): boolean {
  if (!hasWriteFileTool(tools)) return false;
  if (isScenarioFileRepairPrompt(prompt)) return false;
  return isImmediateFileWritePrompt(prompt, { toolSurfaceIsWriteFileOnly: tools?.length === 1 });
}

export function isScenarioFileRepairTurn(
  prompt: string,
  tools: ChatCompletionTool[] | undefined,
): boolean {
  if (!tools || tools.length === 0) return false;
  const names = tools
    .map((tool) => chatCompletionToolName(tool))
    .filter((name): name is string => !!name);
  if (!isScenarioFileRepairPrompt(prompt)) return false;
  return (
    names.includes('write_file') && names.some((name) => SCENARIO_FILE_REPAIR_TOOL_NAMES.has(name))
  );
}

export function isExistingSourceEditTurn(
  prompt: string,
  tools: ChatCompletionTool[] | undefined,
): boolean {
  if (!tools || tools.length === 0) return false;
  if (isScenarioFileRepairPrompt(prompt)) return false;
  const names = tools
    .map((tool) => chatCompletionToolName(tool))
    .filter((name): name is string => !!name);
  if (!names.some((name) => SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES.has(name))) return false;
  if (!names.every((name) => SCENARIO_FILE_REPAIR_TOOL_NAMES.has(name))) return false;
  if (isRevisionForWorkspaceFilePrompt(prompt)) return true;
  if (isSingleFileSourceRepairRequest(prompt)) return true;
  if (
    !/\b(?:modify|update|change|add|switch|remove|continue evolving|refactor|edit)\b/i.test(prompt)
  ) {
    return false;
  }
  if (!/\b(?:existing|same)\b(?:\s+[\w'-]+){0,5}\s+(?:codebase|file|app|project)\b/i.test(prompt)) {
    return false;
  }
  return /`?[\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md)`?/i.test(prompt);
}

function isRevisionForWorkspaceFilePrompt(prompt: string): boolean {
  return /^\s*Revision\s+\d+\s+for\s+`?[\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md)`?\s*:/i.test(
    prompt,
  );
}

/**
 * The gate-escalation ladder's stage-1 turn: a `GATE_TARGETED_EDIT:`
 * marker from `buildStageOneNudge` (tasks/gate-escalation.ts — the single
 * producer, feeding the task, scheduler, and chat delivery channels).
 * First-move mode: unlike the sibling repair modes there is no read
 * precondition — the failing file's content is already in-context from
 * the attempt the gate just rejected. Loses to scenario-repair
 * structurally; stage-2 (`GATE_FULL_REWRITE`) trips immediate-write
 * instead, never this. MLX/Ollama have no equivalent — the marker is
 * inert prompt text there, which is acceptable (steering without
 * mechanics).
 */
export function isGateSurgicalEditTurn(
  prompt: string,
  tools: ChatCompletionTool[] | undefined,
): boolean {
  if (!prompt.includes('GATE_TARGETED_EDIT:')) return false;
  if (isScenarioFileRepairPrompt(prompt)) return false;
  // Artifact-surface stage-1 directives repair through `write_artifact`
  // (the drawer has no patch tool) — clamping that turn to the workspace
  // patch tools would strand it.
  if (prompt.includes('write_artifact')) return false;
  const names = (tools ?? [])
    .map((tool) => chatCompletionToolName(tool))
    .filter((name): name is string => !!name);
  return names.includes('replace_in_file') || names.includes('replace_lines');
}

function hasDirectFileWorkToolSurface(tools: ChatCompletionTool[] | undefined): boolean {
  if (!tools || tools.length === 0) return false;
  const names = tools
    .map((tool) => chatCompletionToolName(tool))
    .filter((name): name is string => !!name);
  if (!names.includes('write_file')) return false;
  return names.every((name) => DIRECT_FILE_WORK_TOOL_NAMES.has(name));
}

export function isDirectFileWorkTurn(
  prompt: string,
  tools: ChatCompletionTool[] | undefined,
): boolean {
  if (isScenarioFileRepairPrompt(prompt)) return false;
  return hasDirectFileWorkToolSurface(tools) && hasDirectFileDeliverableWording(prompt);
}

function isScenarioFileRepairPrompt(prompt: string): boolean {
  return (
    /\[runtime check(?:\s+[^\]]+)?\]\s+I\s+(?:opened|re-opened)\s+`[^`]+`\s+(?:in\s+a\s+headless\s+browser|after\s+your\s+latest\s+edit)\./i.test(
      prompt,
    ) ||
    /\[runtime check(?:\s+[^\]]+)?\]\s+You've now rewritten\s+`[^`]+`\s+\d+\s+time\(s\)/i.test(
      prompt,
    ) ||
    /\[scenario check\]\s+I looked at\s+`[^`]+`\s+and\s+the\s+success\s+criteria\s+aren't\s+met\s+yet\./i.test(
      prompt,
    )
  );
}

const MAX_PREREQUISITE_REPAIR_READ_PATHS = 8;
const PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT = 2;

/**
 * Extract a bounded source-read contract from an explicit read-before-edit
 * scenario repair. The clause must order named reads before a later mutation;
 * ordinary repair prompts that merely mention `read_file` do not qualify.
 */
export function extractPrerequisiteRepairReadPaths(prompt: string): string[] {
  if (!isScenarioFileRepairPrompt(prompt)) return [];
  const orderedClause =
    /\bfirst\s+(?:(?:call|use)\s+`?read_file`?\s+(?:on\s+)?|(?:re-)?read\s+)([\s\S]{1,700}?)(?:[.,;]\s*then\s+(?:patch|edit|revise|rewrite|update|write|record|replace|append)|\s+before\s+(?:patching|editing|revising|rewriting|updating|writing|recording|replacing|appending))\b/i.exec(
      prompt,
    )?.[1] ??
    /\bbefore\s+(?:patching|editing|revising|rewriting|updating|writing|recording|replacing|appending)\b[\s,:-]+([\s\S]{1,700}?)(?=[.;]\s*(?:then\s+)?(?:patch|edit|revise|rewrite|update|write|record|replace|append)\b)/i.exec(
      prompt,
    )?.[1];
  if (!orderedClause) return [];

  const paths =
    orderedClause.match(
      /(?:[\w.-]+\/)*[\w.-]+\.(?:html?|css|mjs|cjs|js|jsx|ts|tsx|json|md|csv|tsv|txt|ya?ml)\b/gi,
    ) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeWorkspacePathForCompare(path).toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalizeWorkspacePathForCompare(path));
  }
  return unique.length > 0 && unique.length <= MAX_PREREQUISITE_REPAIR_READ_PATHS ? unique : [];
}

function remainingPrerequisiteRepairReadPaths(
  requiredPaths: readonly string[],
  readPaths: readonly string[],
): string[] {
  const read = new Set(
    readPaths.map((path) => normalizeWorkspacePathForCompare(path).toLowerCase()),
  );
  return requiredPaths.filter(
    (path) => !read.has(normalizeWorkspacePathForCompare(path).toLowerCase()),
  );
}

function isSourceFileScenarioRepairPrompt(prompt: string): boolean {
  if (!isScenarioFileRepairPrompt(prompt)) return false;
  const target = scenarioRepairTargetPath(prompt);
  if (target) return /\.(?:html?|css|mjs|cjs|jsx?|tsx?)$/i.test(target);
  return /`?[\w./-]+\.(?:html?|css|mjs|cjs|jsx?|tsx?)(?=`|\b)/i.test(prompt);
}

function scenarioRepairTargetPath(prompt: string): string | null {
  return (
    /\[scenario check\]\s+I looked at\s+`([^`]+)`\s+and\s+the\s+success\s+criteria\s+aren't\s+met\s+yet\./i.exec(
      prompt,
    )?.[1] ??
    /\[runtime check(?:\s+[^\]]+)?\]\s+I\s+(?:opened|re-opened)\s+`([^`]+)`\s+(?:in\s+a\s+headless\s+browser|after\s+your\s+latest\s+edit)\./i.exec(
      prompt,
    )?.[1] ??
    /\[runtime check(?:\s+[^\]]+)?\]\s+You've now rewritten\s+`([^`]+)`\s+\d+\s+time\(s\)/i.exec(
      prompt,
    )?.[1] ??
    null
  );
}

function scenarioRepairPostReadMutationTargetPath(prompt: string): string | null {
  return (
    /POST_READ_MUTATION_TARGET:[\s\S]{0,500}?\bmutate exactly\s+`([^`]+)`/i.exec(prompt)?.[1] ??
    null
  );
}

function isDomNullRuntimeRepairPrompt(prompt: string): boolean {
  return /Cannot\s+(?:read|set)\s+propert(?:y|ies)\s+of\s+null/i.test(prompt);
}

function buildScenarioRepairNoMutationNudge(
  knownToolNames: ReadonlySet<string>,
  context: {
    readOnlyCalls: number;
    readFilePaths: readonly string[];
    failedMutationCalls?: number;
    noMutationNudges?: number;
  } = {
    readOnlyCalls: 0,
    readFilePaths: [],
  },
): string {
  const mutationTools = [...SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES].filter((name) =>
    knownToolNames.has(name),
  );
  const menu =
    mutationTools.length > 0
      ? mutationTools.map((name) => `\`${name}\``).join(', ')
      : '`write_file`';
  if (context.readOnlyCalls > 0) {
    const readPathText =
      context.readFilePaths.length > 0
        ? ` You already read ${context.readFilePaths.map((path) => `\`${path}\``).join(', ')}.`
        : '';
    const failedMutationCalls =
      'failedMutationCalls' in context && typeof context.failedMutationCalls === 'number'
        ? context.failedMutationCalls
        : 0;
    const noMutationNudges =
      'noMutationNudges' in context && typeof context.noMutationNudges === 'number'
        ? context.noMutationNudges
        : 0;
    const mustMutateNow =
      failedMutationCalls > 0 || context.readOnlyCalls >= 2 || noMutationNudges >= 2;
    if (mustMutateNow) {
      let writeInstruction: string;
      if ((failedMutationCalls > 0 || noMutationNudges >= 2) && knownToolNames.has('write_file')) {
        writeInstruction =
          'Your next response must START with `write_file` for the relevant source file with the complete corrected file contents.';
      } else if (knownToolNames.has('replace_lines')) {
        writeInstruction =
          'Your next response must START with `replace_lines` for the smallest relevant line range in the source file.';
      } else if (knownToolNames.has('replace_in_file')) {
        writeInstruction =
          'Your next response must START with `replace_in_file` for the smallest unique source snippet that needs changing.';
      } else if (knownToolNames.has('write_file')) {
        writeInstruction =
          'Your next response must START with `write_file` for the relevant source file with the complete corrected file contents.';
      } else {
        writeInstruction = `Your next response must START with one mutation tool call (${menu}) for the relevant source file.`;
      }
      const failedText =
        failedMutationCalls > 0
          ? ' A previous surgical edit failed, so another guessed patch is unlikely to land.'
          : '';
      return `[system] Your repair turn ended after diagnostic reads/prose but no workspace file changed.${readPathText}${failedText} Do not read again. ${writeInstruction} Do not describe the fix until after that tool succeeds.`;
    }
    const canRead = [...SCENARIO_FILE_REPAIR_READ_ONLY_TOOL_NAMES].some((name) =>
      knownToolNames.has(name),
    );
    const diagnosticAllowance = canRead
      ? ' If those reads did not show the cause, make exactly one more targeted read of the directly related source file that owns the failing behavior, then mutate.'
      : '';
    return `[system] Your repair turn ended after diagnostic reads/prose but no workspace file changed.${readPathText}${diagnosticAllowance} If you already know the cause, your next response must START with one mutation tool call (${menu}) for the relevant source file. Do not describe the fix until after that tool succeeds.`;
  }
  return `[system] Your repair turn ended without changing any workspace file. Read/validate/prose did not fix the failing check. Your next response must START with one mutation tool call (${menu}) for the relevant source file. Do not describe the fix until after that tool succeeds.`;
}

function buildPrerequisiteRepairReadNudge(context: {
  remainingPaths: readonly string[];
  noProgressNudges: number;
}): string {
  const nextPath = context.remainingPaths[0];
  const remaining = context.remainingPaths.map((path) => `\`${path}\``).join(', ');
  const retry =
    context.noProgressNudges >= PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT
      ? 'This is the final automatic source-read retry.'
      : 'Continue the bounded source-gathering phase now.';
  return `[system] This repair explicitly requires successful source reads before any file mutation. Remaining required source(s): ${remaining}. ${retry} Your next response must START with \`read_file({ path: "${nextPath}" })\`. Do not plan, summarize, or edit the deliverable until every listed read succeeds; after the last required read, the tool surface will switch to file mutations.`;
}

function buildDirectFileWorkPrerequisiteReadNudge(context: {
  remainingPaths: readonly string[];
  noProgressNudges: number;
}): string {
  const nextPath = context.remainingPaths[0];
  const remaining = context.remainingPaths.map((path) => `\`${path}\``).join(', ');
  const retry =
    context.noProgressNudges >= PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT
      ? 'This is the final automatic source-read retry.'
      : 'Continue the bounded source-gathering phase now.';
  return `[system] This file deliverable explicitly requires successful source reads before writing. Remaining required source(s): ${remaining}. ${retry} Your next response must START with \`read_file({ path: "${nextPath}" })\`. Do not plan, summarize, or write the output until every listed read succeeds; after the last required read, the tool surface will switch to file mutations.`;
}

function buildImmediateFileWriteNoMutationNudge(context: {
  targetPath: string | null;
  noMutationNudges?: number;
}): string {
  const target = context.targetPath
    ? ` The required output file is \`${context.targetPath}\`.`
    : '';
  const retryText =
    (context.noMutationNudges ?? 0) > 1
      ? 'This is the final automatic retry.'
      : 'Retry immediately.';
  return `[system] Your required file-write turn produced no \`write_file\` tool call.${target} ${retryText} Your next response must START with \`write_file\` for the required file, with the complete file contents in the \`content\` argument. Do not describe the result until after that tool succeeds.`;
}

function buildDirectFileWorkNoMutationNudge(
  knownToolNames: ReadonlySet<string>,
  context: {
    targetPath: string | null;
    readOnlyCalls: number;
    readFilePaths: readonly string[];
    noMutationNudges?: number;
    scriptHelperMode?: boolean;
    scriptHelperWritten?: boolean;
  },
): string {
  const mutationTools = [...DIRECT_FILE_WORK_MUTATION_TOOL_NAMES].filter((name) =>
    knownToolNames.has(name),
  );
  const menu =
    mutationTools.length > 0
      ? mutationTools.map((name) => `\`${name}\``).join(', ')
      : '`write_file`';
  const target = context.targetPath
    ? ` The required output file is \`${context.targetPath}\`.`
    : '';
  const readPathText =
    context.readFilePaths.length > 0
      ? ` You already read ${context.readFilePaths.map((path) => `\`${path}\``).join(', ')}.`
      : '';
  const noMutationNudges =
    'noMutationNudges' in context && typeof context.noMutationNudges === 'number'
      ? context.noMutationNudges
      : 0;
  if (context.scriptHelperMode) {
    const next = context.scriptHelperWritten
      ? `START with \`run_nodejs_script\` for exactly \`${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}\`.`
      : `START with \`write_file\` for exactly \`${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}\` containing the complete Node ESM helper.`;
    return `[system] Your derived-data turn ended without completing the required helper step.${target}${readPathText} Your next response must ${next} Do not call a read/check tool, hand-serialize the final data file, or reply in prose first.`;
  }
  const canWriteFile = knownToolNames.has('write_file');
  const canRunScript = knownToolNames.has('run_nodejs_script');
  const writeInstruction =
    canWriteFile && noMutationNudges > 0
      ? 'Your next response must START with `write_file` for the output file.'
      : canRunScript && noMutationNudges <= 1
        ? 'Your next response must START with `run_nodejs_script` that writes the output file, or `write_file` with the complete output contents.'
        : `Your next response must START with one mutation tool call (${menu}) for the output file.`;
  const doNotRead =
    context.readOnlyCalls > 0 ? ' Do not call another read/check tool before writing.' : '';
  return `[system] Your file-work turn ended after diagnostic reads/prose but no output file was written.${target}${readPathText}${doNotRead} ${writeInstruction} Do not describe the result until after that tool succeeds.`;
}

function buildDirectFileWorkScriptHelperPromptSuffix(targetPath: string): string {
  return `\n\n[Local-model data-transform mode: this output is a derived data file, so do not serialize the whole JSON/CSV by hand through \`write_file\`. First call \`write_file\` for exactly \`${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}\` with a short Node helper script. Because this helper is an \`.mjs\` file, write plain JavaScript with ESM \`import\` declarations — never \`require(...)\`, TypeScript annotations, or backslash-escaped JavaScript delimiters. The helper itself must use fs.readFileSync/fs.writeFileSync to inspect the named input files on disk and write the final deliverable to \`${targetPath}\`; create the output's parent directory recursively before writing it, and do not catch or suppress transform/write errors. Every parser loop must consume input on each iteration: if you use global \`RegExp.exec\`, its pattern must not match an empty string (or you must advance \`lastIndex\` after an empty match). After the helper file is written, call \`run_nodejs_script\` for exactly \`${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}\`. Do not call another read/check tool before writing the helper.]`;
}

function buildDirectFileWorkRunScriptNudge(targetPath: string | null): string {
  const target = targetPath ? ` The helper must write \`${targetPath}\`.` : '';
  return `[system] The helper script was written. Now run it: your next response must START with \`run_nodejs_script\` for \`${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}\`.${target} Do not call read/check tools or describe the result before running the script.`;
}

function buildDirectFileWorkScriptFailureNudge(
  targetPath: string | null,
  failureOutput: string,
): string {
  const target = targetPath ? ` The required output is still \`${targetPath}\`.` : '';
  const compactFailure = failureOutput.replace(/\s+$/g, '').slice(0, 1_500);
  const nonTerminationCorrective =
    /\b(?:timed out|exceeded\b[^\n]*\btimeout|was killed|SIGKILL|heap out of memory|allocation failed|exit -1)\b/i.test(
      compactFailure,
    )
      ? ' This was a timeout or forced termination consistent with runaway work: replace or bound the loop that failed to terminate instead of re-emitting the same source. Every loop must make observable progress. In particular, a global RegExp.exec loop must reject zero-length matches or explicitly advance lastIndex when match[0] is empty.'
      : '';
  return `[system] The helper script ran and FAILED, so it did not produce a usable derived-data deliverable.${target} Fix the FIRST execution error below.${nonTerminationCorrective} Your next response must START with \`write_file\` rewriting exactly \`${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}\` as complete corrected ESM source; do not hand-write the final data file, do not read inputs in chat, and do not reply in prose. Preserve the on-disk transform approach, create the output parent directory, and let failures exit non-zero. After the corrected helper is written, run it again.

Helper execution failure:
${compactFailure}`;
}

function buildDirectFileWorkUnchangedHelperError(failureOutput: string): string {
  const compactFailure = failureOutput.replace(/\s+$/g, '').slice(0, 1_500);
  return `ERROR: This helper rewrite is byte-for-byte identical to the helper source that just failed, so it was not written and will not be run again. Change the source to fix the prior execution failure; re-emitting identical code is not progress. If the failure was a timeout, replace or bound the non-terminating loop and ensure every parser iteration consumes input. Then call \`write_file\` again with the complete changed helper.

Previous helper execution failure:
${compactFailure}`;
}

function buildDirectFileWorkRejectedWriteNudge(path: string): string {
  return `\n\n[Local-model rejected-write recovery: the previous \`write_file\` call for \`${path}\` was rejected atomically. THE FILE WAS NOT WRITTEN by that call; the rejected draft does not exist on disk. Re-emit the complete corrected file now with \`write_file\` for exactly \`${path}\`. Do not call read_file, append_to_file, replace_in_file, or replace_lines against the rejected draft; there is nothing from that call to inspect or patch.]`;
}

function appendDirectFileWorkRejectedWriteHint(output: string, path: string): string {
  if (output.includes('THE FILE WAS NOT WRITTEN')) return output;
  return `${output}\n\n[runtime] This \`write_file\` was rejected atomically: THE FILE WAS NOT WRITTEN by this call, and the rejected draft does not exist on disk. Retry \`${path}\` with one complete corrected \`write_file\` call. Do not read, append to, or patch the rejected draft.`;
}

function missingFileEditRecoveryPath(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): string | null {
  if (toolName !== 'replace_in_file' && toolName !== 'replace_lines') return null;
  if (
    !/(?:\bENOENT\b|\bfile[- ]not[- ]found\b|\bfile does not exist\b|\bno such file\b)/i.test(
      output,
    )
  ) {
    return null;
  }
  return typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
}

function buildMissingFileCreateNudge(path: string): string {
  return `\n\n[Local-model missing-file recovery: \`${path}\` does not exist, so surgical edit tools cannot succeed. Your next response must START with \`write_file\` for exactly \`${path}\` with the complete new file contents. Do not retry \`replace_in_file\` or \`replace_lines\` until the file has been created.]`;
}

function appendMissingFileCreateHint(output: string, path: string): string {
  if (output.includes('[runtime] Missing-file transition:')) return output;
  return `${output}\n\n[runtime] Missing-file transition: \`${path}\` does not exist. Create it now with one complete \`write_file\` call; another surgical edit cannot work.`;
}

function shouldUseScenarioRepairMutationOnlySurface(context: {
  noMutationNudges: number;
  readOnlyCalls: number;
  failedMutationCalls: number;
}): boolean {
  return (
    context.noMutationNudges >= 2 ||
    context.readOnlyCalls >= 2 ||
    (context.failedMutationCalls > 0 && context.readOnlyCalls > 0)
  );
}

function shouldAllowScriptedDirectFileWork(prompt: string): boolean {
  const match = SCRIPTED_DIRECT_FILE_WORK_PROMPT_RE.exec(prompt);
  if (!match) return false;
  const prefix = prompt.slice(Math.max(0, match.index - 40), match.index);
  // Suggestions keep the normal read-first/direct-write path. An actual
  // fs.readFileSync + fs.writeFileSync contract is handled separately by
  // shouldStartScriptedDataFileWork, even when phrased inside "if you write".
  return !/\b(?:if\s+you|you\s+(?:may|can|could)|optionally|if\s+(?:needed|useful)|consider|feel\s+free\s+to)\s*[,;:]?\s*$/i.test(
    prefix,
  );
}

export function shouldPreferScriptedDataFileWork(
  prompt: string,
  targetPath: string | null,
): boolean {
  if (!targetPath || !/\.(?:json|csv|tsv|ndjson)$/i.test(targetPath)) return false;
  return (
    /\b(?:csv|tsv|dataset|exports?|transform|normalize|normalise|deduplicat|parse|sort|raw\s+inputs?|raw\s+files?|etl|wrangl|clean\s+up)\b/i.test(
      prompt,
    ) || /\bfs\.readFileSync\b|\bfs\.writeFileSync\b/i.test(prompt)
  );
}

function hasNamedDataInputPath(prompt: string, targetPath: string): boolean {
  const target = normalizeWorkspacePathForCompare(targetPath).toLowerCase();
  const paths = prompt.match(/[\w./-]+\.(?:csv|tsv|json|ndjson|txt)\b/gi) ?? [];
  return paths.some((path) => normalizeWorkspacePathForCompare(path).toLowerCase() !== target);
}

/**
 * Some derived-data prompts already provide the input paths, transform rules,
 * and an explicit on-disk script contract. In that case a chat-side read is
 * unnecessary: the helper should read the inputs itself. Entering helper mode
 * immediately also prevents a local model from hand-serializing a large JSON
 * or CSV payload before it has inspected the source files.
 */
export function shouldStartScriptedDataFileWork(
  prompt: string,
  targetPath: string | null,
): boolean {
  if (!shouldPreferScriptedDataFileWork(prompt, targetPath)) return false;
  if (!targetPath || !hasNamedDataInputPath(prompt, targetPath)) return false;
  const explicitReadThen = /\bread\b[\s\S]{0,160}\bthen\b/i.test(prompt);
  return (
    (shouldAllowScriptedDirectFileWork(prompt) && !explicitReadThen) ||
    (/\bfs\.readFileSync\b/i.test(prompt) && /\bfs\.writeFileSync\b/i.test(prompt)) ||
    /\b(?:do not hand-(?:type|serialize)|compute (?:the rows|them)|derived data file)\b/i.test(
      prompt,
    )
  );
}

function directFileWorkAfterReadTools(
  tools: ChatCompletionTool[] | undefined,
  context: {
    prompt: string;
    targetPath: string | null;
    forceWriteFile?: boolean;
    preferScriptHelper?: boolean;
    scriptHelperWritten?: boolean;
  },
): ChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  const writeFile = tools.find((tool) => chatCompletionToolName(tool) === 'write_file');
  const runNode = tools.find((tool) => chatCompletionToolName(tool) === 'run_nodejs_script');
  if (context.preferScriptHelper && writeFile && runNode) {
    return context.scriptHelperWritten ? [runNode] : [writeFile];
  }
  if (writeFile) {
    if (context.forceWriteFile) return [writeFile];
    if (runNode && shouldAllowScriptedDirectFileWork(context.prompt)) {
      return [writeFile, runNode];
    }
    return [writeFile];
  }
  const mutationTools = tools.filter((tool) => {
    const name = chatCompletionToolName(tool);
    return !!name && DIRECT_FILE_WORK_MUTATION_TOOL_NAMES.has(name);
  });
  return mutationTools.length > 0 ? mutationTools : tools;
}

function compactToolForConstrainedLocalTurn(
  tool: ChatCompletionTool,
  context: {
    writeFileTargetPath?: string | null;
    fileMutationTargetPath?: string | null;
    runNodeScriptTargetPath?: string | null;
    readFileTargetPaths?: readonly string[] | null;
  } = {},
): ChatCompletionTool {
  const name = chatCompletionToolName(tool);
  if (name === 'write_file') {
    const targetPath =
      context.writeFileTargetPath?.trim() || context.fileMutationTargetPath?.trim() || null;
    return {
      type: 'function',
      function: {
        name,
        description: targetPath
          ? `Create or overwrite exactly ${targetPath}. Do not write a helper script or any other path.`
          : 'Create or overwrite one UTF-8 text file in the project workspace. Use the exact workspace-relative path and the complete file contents.',
        parameters: {
          type: 'object',
          properties: {
            path: targetPath
              ? {
                  type: 'string',
                  enum: [targetPath],
                  description: `Must be exactly ${targetPath}.`,
                }
              : { type: 'string', description: 'Workspace-relative output path.' },
            content: { type: 'string', description: 'Complete file contents.' },
          },
          required: ['path', 'content'],
        },
      },
    };
  }
  if (name === 'run_nodejs_script') {
    const targetPath = context.runNodeScriptTargetPath?.trim() || null;
    return {
      type: 'function',
      function: {
        name,
        description: targetPath
          ? `Run exactly ${targetPath}. Do not run any other script path.`
          : 'Run an existing Node.js or TypeScript script from the project workspace. The script may read and write workspace files with fs.',
        parameters: {
          type: 'object',
          properties: {
            path: targetPath
              ? {
                  type: 'string',
                  enum: [targetPath],
                  description: `Must be exactly ${targetPath}.`,
                }
              : { type: 'string', description: 'Workspace-relative script path.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Optional arguments.' },
            timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
          },
          required: ['path'],
        },
      },
    };
  }
  if (name === 'read_file') {
    const targetPaths = context.readFileTargetPaths?.filter((path) => path.trim()) ?? [];
    return {
      type: 'function',
      function: {
        name,
        description: 'Read a workspace text file.',
        parameters: {
          type: 'object',
          properties: {
            path:
              targetPaths.length > 0
                ? {
                    type: 'string',
                    enum: targetPaths,
                    description: 'Must be one of the remaining prerequisite source paths.',
                  }
                : { type: 'string', description: 'Workspace-relative path.' },
            raw: {
              type: 'boolean',
              description: 'When true, return raw contents without line gutters.',
            },
            startLine: {
              type: 'integer',
              minimum: 1,
              maximum: 10_000_000,
              description: 'Optional 1-based first line to read (inclusive).',
            },
            endLine: {
              type: 'integer',
              minimum: 1,
              maximum: 10_000_000,
              description: 'Optional 1-based last line to read (inclusive).',
            },
          },
          required: ['path'],
        },
      },
    };
  }
  if (name === 'replace_in_file') {
    const targetPath = context.fileMutationTargetPath?.trim() || null;
    return {
      type: 'function',
      function: {
        name,
        description: targetPath
          ? `Replace a literal substring in exactly ${targetPath}. Do not patch any other path.`
          : 'Replace a literal substring in an existing workspace file.',
        parameters: {
          type: 'object',
          properties: {
            path: targetPath
              ? {
                  type: 'string',
                  enum: [targetPath],
                  description: `Must be exactly ${targetPath}.`,
                }
              : { type: 'string', description: 'Workspace-relative path.' },
            find: { type: 'string', description: 'Exact text to replace.' },
            replace: { type: 'string', description: 'Replacement text.' },
            occurrence: {
              oneOf: [{ type: 'number' }, { type: 'string' }],
              description: 'Optional occurrence selector, e.g. 1 or all.',
            },
          },
          required: ['path', 'find', 'replace'],
        },
      },
    };
  }
  if (name === 'replace_lines') {
    const targetPath = context.fileMutationTargetPath?.trim() || null;
    return {
      type: 'function',
      function: {
        name,
        description: targetPath
          ? `Replace an inclusive line range in exactly ${targetPath}. Do not patch any other path.`
          : 'Replace an inclusive line range in an existing workspace file.',
        parameters: {
          type: 'object',
          properties: {
            path: targetPath
              ? {
                  type: 'string',
                  enum: [targetPath],
                  description: `Must be exactly ${targetPath}.`,
                }
              : { type: 'string', description: 'Workspace-relative path.' },
            startLine: { type: 'number', description: 'First 1-based line to replace.' },
            endLine: { type: 'number', description: 'Last 1-based line to replace.' },
            content: { type: 'string', description: 'Replacement text for the range.' },
          },
          required: ['path', 'startLine', 'endLine', 'content'],
        },
      },
    };
  }
  if (name === 'append_to_file') {
    const targetPath = context.fileMutationTargetPath?.trim() || null;
    return {
      type: 'function',
      function: {
        name,
        description: targetPath
          ? `Append text to exactly ${targetPath}. Do not append to any other path.`
          : 'Append text to the end of an existing workspace file.',
        parameters: {
          type: 'object',
          properties: {
            path: targetPath
              ? {
                  type: 'string',
                  enum: [targetPath],
                  description: `Must be exactly ${targetPath}.`,
                }
              : { type: 'string', description: 'Workspace-relative path.' },
            content: { type: 'string', description: 'Text to append.' },
            create: { type: 'boolean', description: 'Create the file if missing.' },
          },
          required: ['path', 'content'],
        },
      },
    };
  }
  return tool;
}

function compactToolsForConstrainedLocalTurn(
  tools: ChatCompletionTool[] | undefined,
  context: {
    writeFileTargetPath?: string | null;
    fileMutationTargetPath?: string | null;
    runNodeScriptTargetPath?: string | null;
    readFileTargetPaths?: readonly string[] | null;
  } = {},
): ChatCompletionTool[] | undefined {
  return tools?.map((tool) => compactToolForConstrainedLocalTurn(tool, context));
}

function normalizeWorkspacePathForCompare(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^workspace\//i, '')
    .replace(/^\.\/+/, '');
}

function directFileWorkMutationSatisfiesTarget(
  toolName: string,
  args: Record<string, unknown>,
  targetPath: string | null,
): boolean {
  if (toolName === 'run_nodejs_script') return true;
  if (!targetPath) return true;
  if (typeof args.path !== 'string') return false;
  const writtenPath = normalizeWorkspacePathForCompare(args.path);
  const target = normalizeWorkspacePathForCompare(targetPath);
  return writtenPath === target;
}

function fileMutationWrongTargetError(
  toolName: string,
  args: Record<string, unknown>,
  targetPath: string,
): string | null {
  const action =
    toolName === 'write_file' ? 'write' : toolName === 'append_to_file' ? 'append to' : 'patch';
  if (typeof args.path !== 'string') {
    return `ERROR: This constrained repair turn must ${action} exactly \`${targetPath}\`, but the ${toolName} call did not include a string path. Retry ${toolName} with path exactly \`${targetPath}\`.`;
  }
  const writtenPath = normalizeWorkspacePathForCompare(args.path);
  const target = normalizeWorkspacePathForCompare(targetPath);
  if (writtenPath === target) return null;
  const pathInstruction =
    target === normalizeWorkspacePathForCompare(DIRECT_FILE_WORK_SCRIPT_HELPER_PATH)
      ? 'Do not write the final deliverable in this call; write the helper script path exactly.'
      : 'Do not write helper scripts or intermediate files.';
  const retryDetail = toolName === 'write_file' ? ' and the complete file contents' : '';
  return `ERROR: This constrained repair turn must ${action} exactly \`${targetPath}\`, but you called ${toolName} for \`${args.path}\`. ${pathInstruction} Retry ${toolName} with path exactly \`${targetPath}\`${retryDetail}.`;
}

export function runNodeScriptWrongTargetError(
  args: Record<string, unknown>,
  targetPath: string,
): string | null {
  if (typeof args.path !== 'string') {
    return `ERROR: This constrained script-run turn must run exactly \`${targetPath}\`, but the tool call did not include a string path. Retry with path exactly \`${targetPath}\`.`;
  }
  if (
    normalizeWorkspacePathForCompare(args.path) === normalizeWorkspacePathForCompare(targetPath)
  ) {
    return null;
  }
  return `ERROR: This constrained script-run turn must run exactly \`${targetPath}\`, but you called run_nodejs_script for \`${args.path}\`. Retry with path exactly \`${targetPath}\`; do not run a different or nonexistent helper.`;
}

function mutationToolOutputSucceeded(output: string): boolean {
  return !output.startsWith('ERROR:') && !output.startsWith('✗ ');
}

function mutationOnlyScenarioRepairTools(
  tools: ChatCompletionTool[] | undefined,
): ChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  const mutationTools = tools.filter((tool) => {
    const name = chatCompletionToolName(tool);
    return !!name && SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES.has(name);
  });
  return mutationTools.length > 0 ? mutationTools : tools;
}

function sourceFileScenarioRepairTools(
  tools: ChatCompletionTool[] | undefined,
): ChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  const sourceRepairTools = tools.filter((tool) => {
    const name = chatCompletionToolName(tool);
    return !!name && SCENARIO_SOURCE_REPAIR_TOOL_NAMES.has(name);
  });
  const canPatch = sourceRepairTools.some((tool) => {
    const name = chatCompletionToolName(tool);
    return name === 'replace_lines' || name === 'replace_in_file';
  });
  return canPatch ? sourceRepairTools : tools;
}

function patchOnlyExistingSourceEditTools(
  tools: ChatCompletionTool[] | undefined,
): ChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  const replaceInFile = tools.find((tool) => chatCompletionToolName(tool) === 'replace_in_file');
  const replaceLines = tools.find((tool) => chatCompletionToolName(tool) === 'replace_lines');
  const preferredPatchTools = [replaceInFile, replaceLines].filter(
    (tool): tool is ChatCompletionTool => !!tool,
  );
  if (preferredPatchTools.length > 0) return preferredPatchTools;
  const patchTools = tools.filter((tool) => {
    const name = chatCompletionToolName(tool);
    return !!name && EXISTING_SOURCE_EDIT_PATCH_TOOL_NAMES.has(name);
  });
  return patchTools.length > 0 ? patchTools : tools;
}

function appendScenarioRepairFailedMutationHint(
  output: string,
  toolName: string,
  args: Record<string, unknown>,
  failureCount: number,
  context: { sourceFileRepair?: boolean } = {},
): string {
  const path = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '';
  const pathText = path ? ` for \`${path}\`` : '';
  if (context.sourceFileRepair) {
    if (failureCount >= 2) {
      return `${output}\n\n[runtime] This is the second repair edit that did not change the workspace. Stop guessing surgical matches. Your next mutation tool call must be \`write_file\`${pathText} with the complete corrected source file. Do not read or try another patch before writing.`;
    }
    const nextMove = `If you already read the relevant file, copy the exact current snippet or line numbers and use \`replace_in_file\` or \`replace_lines\`${pathText} instead of guessing another \`${toolName}\` patch.`;
    return `${output}\n\n[runtime] This repair edit did not change the workspace. ${nextMove} Do not rewrite the whole source file. Only call \`${toolName}\` again if you copy the \`find\` text exactly from a fresh read.`;
  }
  const nextMove =
    failureCount >= 2
      ? `Your next mutation tool call should be \`write_file\`${pathText} with the complete corrected source file, not another guessed \`${toolName}\` patch.`
      : `If you already read the relevant file, use \`write_file\`${pathText} with the complete corrected source file instead of guessing another \`${toolName}\` snippet.`;
  return `${output}\n\n[runtime] This repair edit did not change the workspace. ${nextMove} If you have not read the exact current file yet, read it once, then write the full corrected file. Only call \`${toolName}\` again if you copy the \`find\` text exactly from a fresh read.`;
}

function isDirectCreateSourceWritePrompt(prompt: string): boolean {
  if (!/\bwrite_file\b/i.test(prompt)) return false;
  if (!/`?[\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md)`?/i.test(prompt)) {
    return false;
  }
  if (
    /\b(?:modify|repair|fix|debug|patch|refactor|continue evolving|existing codebase)\b/i.test(
      prompt,
    )
  ) {
    return false;
  }
  if (/\bpreserve\b/i.test(prompt) && !/\bfirst (?:version|pass)\b/i.test(prompt)) return false;
  return (
    /\b(?:build|create|make|implement|scaffold|write|produce)\b/i.test(prompt) &&
    /\b(?:first version|first pass|initial version|new|from scratch|at\s+`?[\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md)`?)/i.test(
      prompt,
    )
  );
}

function setChatTemplateKwarg(body: Record<string, unknown>, key: string, value: unknown): void {
  const existing = body.chat_template_kwargs;
  if (existing && typeof existing === 'object' && existing !== null) {
    (existing as Record<string, unknown>)[key] = value;
    return;
  }
  body.chat_template_kwargs = { [key]: value };
}

type DisableThinkingRequestShape = 'chat-template' | 'deepseek';

/**
 * Chat-template variables that name a model's reasoning DEPTH rather than an
 * on/off switch. `applyTuning` has already written the manifest's declared
 * `reasoning.templateKwargs` onto the body by the time the constrained-turn
 * paths run, so we downgrade whichever dial this model actually reads instead
 * of keeping a per-model branch here.
 *
 * Load-bearing for templates that have no `enable_thinking` at all: Muse
 * Glimmer reads only `reasoning_strength`, so the disable below is a silent
 * no-op there and the model keeps reasoning at its manifest default until the
 * immediate-write guard kills the turn. Measured 2026-08-10 on the tictactoe
 * eval — 1027 reasoning chars against the 1024 limit, two aborted turns and a
 * poisoned-session recovery on a run that otherwise passed.
 */
const REASONING_DEPTH_TEMPLATE_KWARGS = new Set(['reasoning_effort', 'reasoning_strength']);

function disableThinkingForConstrainedTurn(
  body: Record<string, unknown>,
  shape: DisableThinkingRequestShape,
  model: string | undefined,
): void {
  setChatTemplateKwarg(body, 'enable_thinking', false);
  const declared = body.chat_template_kwargs;
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    for (const key of Object.keys(declared as Record<string, unknown>)) {
      if (REASONING_DEPTH_TEMPLATE_KWARGS.has(key)) {
        setChatTemplateKwarg(body, key, 'low');
      }
    }
  }
  // llama.cpp's bundled GPT-OSS template ignores enable_thinking and defaults
  // reasoning_effort to "medium". Set the template's actual control for terse,
  // tool-constrained turns so the model can reach the required call promptly.
  // Kept explicit because that manifest predates `reasoning.templateKwargs`
  // and so declares no dial for the loop above to find.
  if (isGptOss20bModel(model)) {
    setChatTemplateKwarg(body, 'reasoning_effort', 'low');
  }
  if (shape === 'deepseek') {
    body.think = false;
    body.thinking = { type: 'disabled' };
  }
}

function immediateFileWritePathFromPrompt(prompt: string): string {
  const explicit = /write_file\s*\(\s*\{\s*path\s*:\s*["']([^"']+)["']/i.exec(prompt)?.[1];
  if (explicit) return explicit;
  const workspacePath = /workspace\/([A-Za-z0-9._/-]+index\.html)\b/i.exec(prompt)?.[1];
  if (workspacePath) return workspacePath.replace(/^workspace\//i, '');
  if (/\bindex\.html\b/i.test(prompt)) return 'index.html';
  return 'index.html';
}

function salvageImmediateFileWriteArgs(
  rawContent: string,
  prompt: string,
): { path: string; content: string } | null {
  const loose = tryRepairMalformedWriteToolArguments(
    'write_file',
    rawContent,
    new Set(['write_file']),
  );
  if (loose) return loose;

  const cleaned = cutAtFirstToolLeak(looseUnescapeToolArgumentText(rawContent));
  const htmlStart = firstExistingIndex(cleaned, ['<!doctype html', '<!DOCTYPE html', '<html']);
  if (htmlStart < 0) return null;
  let content = cleaned.slice(htmlStart).trim();
  const htmlEnd = content.toLowerCase().lastIndexOf('</html>');
  if (htmlEnd >= 0) content = content.slice(0, htmlEnd + '</html>'.length).trim();
  if (!looksLikeLooseSingleFileHtml(content)) return null;
  return { path: immediateFileWritePathFromPrompt(prompt), content };
}

export function hasInProgressFileRewritePayload(content: string): boolean {
  const fences = content.match(/```/g)?.length ?? 0;
  if (fences % 2 === 1) return true;
  const lower = content.toLowerCase();
  const lastToolCallOpen = lower.lastIndexOf('<tool_call>');
  if (lastToolCallOpen >= 0 && !lower.includes('</tool_call>', lastToolCallOpen)) return true;
  const lastFunctionOpen = lower.lastIndexOf('<function=');
  if (lastFunctionOpen >= 0 && !lower.includes('</function>', lastFunctionOpen)) return true;
  return false;
}

export function scenarioRepairTextAbortThreshold(
  content: string,
  fullFileRewriteExpected: boolean,
): number {
  return fullFileRewriteExpected || hasInProgressFileRewritePayload(content)
    ? SCENARIO_FILE_REPAIR_PAYLOAD_TEXT_ABORT_CHARS
    : SCENARIO_FILE_REPAIR_TEXT_ABORT_CHARS;
}

export function hasSalvageableImmediateFileWriteContent(
  rawContent: string,
  prompt: string,
): boolean {
  const salvaged = salvageImmediateFileWriteArgs(rawContent, prompt);
  if (!salvaged) return false;
  return (
    /<\/html>\s*$/i.test(salvaged.content) ||
    rawContent.length >= IMMEDIATE_FILE_WRITE_TEXT_ABORT_CHARS
  );
}

export function hasSalvageableImmediateStructuredWriteArgs(rawArguments: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    // A closing </html> can arrive before the JSON string/record closes.
    // Aborting at that point turns a healthy structured call into a lossy
    // best-effort repair and can feed an invalid partial to source guards.
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const args = parsed as Record<string, unknown>;
  if (typeof args.path !== 'string' || typeof args.content !== 'string') return false;
  return /<\/html>\s*$/i.test(args.content) && looksLikeLooseSingleFileHtml(args.content);
}

function immediateFileWriteClosing(paths: string[]): string {
  const unique = [...new Set(paths.filter((path) => path.trim().length > 0))];
  if (unique.length === 0) return 'I wrote the requested file to the workspace.';
  if (unique.length === 1) return `I wrote \`${unique[0]}\` to the workspace.`;
  return `I wrote ${unique.map((path) => `\`${path}\``).join(', ')} to the workspace.`;
}

export function isRecoverableImmediateFileWriteError(output: string): boolean {
  return (
    output.startsWith('ERROR:') &&
    /Invalid first draft\s+\S+\s+was saved anyway so you can continue with/i.test(output)
  );
}

export interface StructuredToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const WRITE_TRANSCRIPT_COMPACT_TOOL_NAMES = new Set(['write_file', 'append_to_file']);
const WRITE_TRANSCRIPT_COMPACT_MIN_CHARS = 2_000;

export function compactSuccessfulWriteToolCallForTranscript(
  call: StructuredToolCall,
  args: Record<string, unknown>,
  output: string,
): boolean {
  if (output.startsWith('ERROR:')) return false;
  if (!WRITE_TRANSCRIPT_COMPACT_TOOL_NAMES.has(call.function.name)) return false;
  const fieldName =
    typeof args.content === 'string' ? 'content' : typeof args.text === 'string' ? 'text' : null;
  if (!fieldName) return false;
  const content = args[fieldName];
  if (typeof content !== 'string' || content.length < WRITE_TRANSCRIPT_COMPACT_MIN_CHARS) {
    return false;
  }
  const path = typeof args.path === 'string' && args.path.trim() ? args.path : '(unknown path)';
  call.function.arguments = JSON.stringify({
    ...args,
    [fieldName]: `[omitted from future model transcript after successful ${call.function.name}; ${content.length} chars were written to ${path}. Use read_file to inspect current contents.]`,
  });
  return true;
}

function engineRequestAbortError(label: string): Error {
  const err = new Error(`[llama-cpp] engine request ${label} cancelled while waiting for a slot`);
  err.name = 'AbortError';
  return err;
}

export class LlamaCppProvider implements LLMProvider {
  readonly name = 'llama-cpp' as const;
  readonly queue: ProviderQueue;
  readonly supportsExternalTools = true;
  readonly supportsPriorMessages = true;
  private readonly supervisor?: NativeEngineSupervisor;
  /** Explicit base URL when no supervisor is managing the process. */
  private readonly externalBaseUrl?: string;
  private readonly defaultModel: string;
  /**
   * Catalog model id for the on-disk weights llama-server is serving —
   * `qwen3.5-9b-llama-cpp`, `gemma4-e4b-llama-cpp`, etc. Distinct from
   * `defaultModel`, which holds the placeholder string llama-server
   * accepts in the `model` request field (the engine ignores it when
   * only one model is loaded). Surfaced via {@link getEffectiveModelId}
   * so the chat manager can resolve a tier for sessions that don't
   * have an explicit model selection (`record.model` undefined AND
   * `config.defaultModel.llama-cpp` undefined). Without this, those
   * sessions classify as `tier:tiny` because the tier resolver has
   * nothing to parse — and the debug bundle can't print the model
   * name either, so an engineer reading it sees `tier: tiny` against
   * a 9B Qwen and is left guessing what model is actually loaded.
   *
   * Empty when the provider was constructed in external-baseUrl mode
   * (we don't know what the user's llama-server is serving) or before
   * the catalog has resolved a default model. Mirrors the same field
   * on `MlxProvider`.
   */
  private readonly catalogModelId?: string;
  /**
   * Catalog manager — when set, `listModels()` enumerates every model
   * the user has installed (so `/v1/models` + Settings pickers see the
   * full set the engine pool can serve), not just the resident one.
   * Optional because external-baseUrl mode has no local catalog.
   * Mirrors the same field on `MlxProvider`.
   */
  private readonly modelManager?: import('./models.js').LlamaCppModelManager;
  /** Owner key of our `'llm'` evictor registration; see constructor opts. */
  private evictorOwnerId?: string;
  /**
   * Set once {@link shutdown} runs. A disposed provider must never
   * lazily respawn its llama-server: the engine pool evicts replicas
   * by calling `shutdown()`, and any session still holding the old
   * instance would otherwise resurrect the process via
   * `ensureRunning()` — a zombie engine outside the pool's capacity
   * accounting.
   */
  private disposed = false;
  private readonly numCtx: number;
  private readonly plannedReservation?: number;
  /**
   * When true, append `stream_options:{include_usage:true}` to chat requests so
   * the engine emits a final usage chunk. Off for llama-server (it surfaces its
   * own custom timings/usage the session already parses); ds4-server emits
   * usage ONLY when asked, so {@link buildDs4Provider} opts in — without this,
   * ds4 turns record zero tokens and tok/s telemetry is null.
   */
  private readonly includeUsageInStream: boolean;
  /**
   * When true, assistant turns committed to the session transcript carry
   * their verbatim SSE `reasoning_content` so later requests replay it.
   * Off for llama-server (its templates drop reasoning on re-render, and
   * echoing it back would *change* the rendered prompt on templates that
   * honor the field). On for ds4-server, whose DeepSeek-V4 render replays
   * `<think>{reasoning_content}</think>` for every assistant turn in tool
   * context and keeps exact per-call DSML by tool-call id: with the
   * reasoning echoed, the re-rendered history is byte-identical to what
   * was generated, the engine's live-KV prefix match survives each tool
   * iteration, and a continuation prefills only the new tool results.
   * Without it, every iteration logs `live kv cache miss … reason=
   * token-mismatch`, falls back to the system-prefix disk snapshot, and
   * re-prefills the whole conversation tail (minutes per turn at DS4's
   * SSD-streamed prefill speeds).
   */
  private readonly replayReasoningContent: boolean;
  /**
   * Whether this engine was launched with `--mmproj`, i.e. whether the server
   * can actually decode an image. Gates the typed-content message shape:
   * sending image parts to a text-only server just inflates the prompt with
   * base64 the model can't interpret.
   *
   * Sourced from the installed model's projector path plus the user's
   * per-model opt-in, resolved in `buildLlamaCppProvider`.
   */
  private readonly visionEnabled: boolean;
  private readonly disableThinkingRequestShape: DisableThinkingRequestShape;
  /** Engine batch width; see the `batchMaxConcurrency` constructor opt. */
  private readonly batchMaxConcurrency: number;
  /**
   * Number of real llama-server request slots (`--parallel`). The provider
   * queue can intentionally be wider than this by one reserved background
   * lane so an in-turn one-shot can dispatch without deadlocking behind the
   * foreground turn that awaits it. This gate is the separate physical
   * boundary: cache slot save/restore plus the streamed engine request must
   * never exceed the slots the native server actually owns.
   */
  private readonly engineRequestWidth: number;
  private engineRequestsActive = 0;
  private readonly engineRequestWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];
  /**
   * Mid-stream silence cap (ms). After this many ms with no SSE chunk,
   * the in-flight `/v1/chat/completions` request is aborted with an
   * idle-stall error so the runtime publishes `done`, the engine pill
   * clears, and the user can retry. Without this cap a hung llama-cpp
   * turn (model stalled, llama-server thread wedged, GPU eviction mid-
   * generation) would hold the runtime's `await sendAndWait` forever.
   * Mirrors Ollama's same-named knob (default 5 min); see Ollama's
   * `streamingIdleMs` for the design notes.
   */
  private readonly streamingIdleMs: number;
  /**
   * Pre-first-byte cap (ms). Covers cold model load, prompt prefill,
   * and the first-token wait. Separate from `streamingIdleMs` so a
   * legitimately slow first-chunk on a 30B-class model doesn't trip
   * the streaming-idle watchdog set for active-generation silence.
   */
  private readonly preFirstByteIdleMs: number;
  /**
   * Tight post-reasoning silent-stall cap (ms). Armed when the engine
   * signals it finished thinking; fires if no SSE delta arrives within
   * the window AND a `/slots` liveness probe shows the KV cache is not
   * growing. Default 30s; overridable for tests. See the watchdog in
   * `sendAndWaitInner`.
   */
  private readonly postReasoningWatchdogMs: number;
  /**
   * Constrained mutation turns should produce a tool signal quickly after
   * the model has already inspected inputs. DS4 can otherwise burn the full
   * turn in hidden/tool thinking with no SSE signal; this timer converts that
   * into the existing no-mutation corrective retry.
   */
  private readonly constrainedToolNoSignalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logFile?: LlamaCppLogFile;
  /**
   * Cross-engine GPU coordinator. When set (and we're running a
   * supervised local llama-server, not an external base URL),
   * `resolveBaseUrl` acquires the `'llm'` slot before each request,
   * which evicts the image engine in `swap` mode. The provider also
   * registers its supervisor's `stop()` as the `'llm'` evictor so
   * image-gen requests can swap us out symmetrically.
   */
  private readonly arbiter?: GpuArbiter;
  /**
   * Sessions currently inside `sendAndWaitInner` — used to fan-out
   * supervisor-side phase events (model load progress parsed from
   * llama-server stdout) to every caller waiting on the same engine
   * startup. Sessions add themselves on turn entry and remove in the
   * finally block. Empty when the engine is idle.
   */
  private readonly activeSessions = new Set<LlamaCppSession>();
  /**
   * Last phase observed from the stdout classifier, kept so newly-
   * starting sessions can pick up the current state instead of waiting
   * for the next log line. Cleared on `ready`.
   */
  private lastStartupPhase: EnginePhaseEvent | null = null;
  /**
   * Running total of bytes allocated across every `load_tensors:` /
   * `llama_kv_cache_init:` line the stdout classifier has seen since
   * the current engine start. Reset on `ready` so a later restart's
   * allocation doesn't double-count. Published once per engine start
   * as an `engine_stats` event fanning out to active sessions.
   */
  private accumulatedRamBytes = 0;
  /**
   * Most recent ram total published — used so new sessions joining
   * mid-lifecycle get the figure replayed (same pattern as
   * `lastStartupPhase`).
   */
  private lastEngineStats: { ramAllocBytes: number } | null = null;
  /**
   * Stdout line → phase classifier used by {@link onStdoutLine}.
   * Defaults to the llama-server classifier; engine wrappers that
   * reuse this turn loop against a different binary (ds4-server via
   * {@link Ds4Provider}) inject their own so phase events reflect
   * that engine's actual log wording instead of silently matching
   * nothing.
   */
  private readonly classifyLine: (line: string) => StartupPhase | null;

  constructor(opts: {
    /**
     * Supervisor that owns the llama-server child. When set, each
     * turn calls `supervisor.ensureRunning()` to get the live base
     * URL and `markUsed()` after. Mutually exclusive with
     * `baseUrl`.
     */
    supervisor?: NativeEngineSupervisor;
    /**
     * Fixed base URL of an already-running llama-server. Used in
     * dev iteration and LAN-shared setups. Mutually exclusive with
     * `supervisor`.
     */
    baseUrl?: string;
    defaultModel?: string;
    /** See {@link LlamaCppProvider.catalogModelId} for the contract. */
    catalogModelId?: string;
    /** See {@link LlamaCppProvider.modelManager} for the contract. */
    modelManager?: import('./models.js').LlamaCppModelManager;
    /**
     * Context window (tokens) llama-server was booted with. The
     * supervisor-owned launch path is responsible for matching this
     * to the `--ctx-size` it passed; the external-baseUrl path
     * trusts the caller. Surfaced on every session so ChatManager
     * can pressure-check. Default 16384 when omitted.
     */
    numCtx?: number;
    /**
     * Broker-ledger reservation for this replica: resident weights plus
     * the KV the engine will allocate at the granted window and cache
     * mode, computed by the launch admission pass. The pool builder
     * prefers this over the catalog/weights-multiplier fallback so
     * co-residency admission can see KV (M1).
     */
    plannedReservationBytes?: number;
    /** See {@link LlamaCppProvider.includeUsageInStream}. Default false. */
    includeUsageInStream?: boolean;
    /** See {@link LlamaCppProvider.replayReasoningContent}. Default false. */
    replayReasoningContent?: boolean;
    /** See {@link LlamaCppProvider.visionEnabled}. Default false. */
    visionEnabled?: boolean;
    /**
     * Request fields used when constrained local turns need thinking disabled.
     * llama-server honors chat_template_kwargs.enable_thinking; ds4-server
     * needs DeepSeek-compatible top-level thinking fields.
     */
    disableThinkingRequestShape?: DisableThinkingRequestShape;
    concurrency?: number;
    /**
     * Keep the queue's normal spare background lane. Defaults to true because
     * llama-server can accept a queued second request while a foreground turn
     * releases/reacquires its slot between tool iterations. Specialized
     * single-tenant wrappers such as ds4 disable this so expensive SSD-streamed
     * inference is strictly serial and cannot double its I/O pressure.
     */
    reserveBackgroundSlot?: boolean;
    /**
     * Engine batch width. When set > 1 (the manager passes the llama-server
     * `--parallel` slot count once `batchedInference` is enabled and
     * `--cont-batching` is on), the queue switches to the adaptive
     * interactive policy: concurrent interactive turns may co-occupy all
     * slots, with one reserved so a live turn never waits behind a
     * background cohort. Default 1 — today's behavior (interactive
     * single-file, background fills spare slots). See {@link LLMProvider.batch}.
     */
    batchMaxConcurrency?: number;
    affinity?: boolean;
    /**
     * Override the default mid-stream silence cap (ms). Set lower for
     * tests; raise via `config.llamaCppStreamingIdleSec` for users with
     * legitimately slow models that need more headroom mid-generation.
     */
    streamingIdleMs?: number;
    /** Override the default pre-first-byte cap (ms). */
    preFirstByteIdleMs?: number;
    /** Override the default post-reasoning silent-stall cap (ms). Set lower for tests. */
    postReasoningWatchdogMs?: number;
    /** Override the constrained mutation no-tool-signal cap (ms). Set lower for tests. */
    constrainedToolNoSignalMs?: number;
    fetchImpl?: typeof fetch;
    /**
     * Rolling log-file sink capturing raw llama-server stdout/stderr.
     * Surfaced via {@link getLogFile} so the Settings → On-device log
     * viewer can tail it. Only set on the supervised path.
     */
    logFile?: LlamaCppLogFile;
    /**
     * Cross-engine GPU coordinator. Optional: cloud-LLM installs and
     * tests don't need it. When supplied alongside a supervisor, the
     * provider registers its `stop()` so image generation can evict
     * llama-server in `swap` mode, and acquires the `'llm'` slot
     * before each request so a still-running image engine gets
     * evicted first.
     */
    arbiter?: GpuArbiter;
    /**
     * Owner key for the arbiter's `'llm'`-slot evictor registration.
     * The engine pool passes the engine key (`llama-cpp/<model>#<n>`)
     * so concurrently-resident replicas don't clobber each other's
     * registration; singleton boots omit it and use the arbiter's
     * `'default'` owner. Unregistered automatically in
     * {@link shutdown}.
     */
    evictorOwnerId?: string;
    /**
     * Directory passed to llama-server's `--slot-save-path`. Non-null
     * only on the supervised path (we know what we passed); the cache
     * adapter reads it via {@link getSlotSavePath} to wire its disk-
     * persistence flow.
     */
    slotSavePath?: string;
    /** See {@link LlamaCppProvider.classifyLine}. Default: `classifyStartupLine`. */
    classifyLine?: (line: string) => StartupPhase | null;
  }) {
    if (!opts.supervisor && !opts.baseUrl) {
      throw new Error('[llama-cpp] need either a supervisor or baseUrl');
    }
    if (opts.supervisor && opts.baseUrl) {
      throw new Error('[llama-cpp] supervisor and baseUrl are mutually exclusive');
    }
    if (opts.supervisor) this.supervisor = opts.supervisor;
    if (opts.baseUrl) this.externalBaseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Only register an evictor when we own the lifecycle. External-baseUrl
    // mode targets a llama-server the user runs themselves; we don't get
    // to stop their process.
    if (opts.arbiter && opts.supervisor) {
      this.arbiter = opts.arbiter;
      if (opts.evictorOwnerId) this.evictorOwnerId = opts.evictorOwnerId;
      this.arbiter.registerEvictor(
        'llm',
        () => opts.supervisor!.stop(),
        opts.evictorOwnerId ?? 'default',
      );
    }
    // llama-server ignores the `model` field when only one model is
    // loaded; use a short placeholder that still shows up sensibly in
    // usage logs. Real per-install default comes from config.
    this.defaultModel = opts.defaultModel ?? 'llama-cpp';
    if (opts.catalogModelId) this.catalogModelId = opts.catalogModelId;
    if (opts.modelManager) this.modelManager = opts.modelManager;
    this.numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
    this.plannedReservation = opts.plannedReservationBytes;
    this.includeUsageInStream = opts.includeUsageInStream ?? false;
    this.replayReasoningContent = opts.replayReasoningContent ?? false;
    this.visionEnabled = opts.visionEnabled ?? false;
    this.disableThinkingRequestShape = opts.disableThinkingRequestShape ?? 'chat-template';
    this.classifyLine = opts.classifyLine ?? classifyStartupLine;
    // 5-minute defaults match Ollama. Generous enough to cover a 30B
    // model's cold load + prefill on a single-GPU consumer box, tight
    // enough that a wedged stream doesn't strand the runtime and the
    // user retries within a coffee break. The `GEZEL_LLAMA_CPP_STREAMING_IDLE_MS`
    // env var lets the eval harness (which has its own retry-loop watchdog
    // that fires at ~3 min of sniff-plateau) tighten this without changing
    // the production default — wild-caught squisq-review:
    // qwen3.6 stream went silent mid-generation, harness retry-loop killed
    // the trial 2m 45s later, well before the 5-min provider watchdog had
    // a chance to abort and salvage the buffered content.
    const envIdleMs = parseEnvMs(process.env.GEZEL_LLAMA_CPP_STREAMING_IDLE_MS);
    this.streamingIdleMs = opts.streamingIdleMs ?? envIdleMs ?? 300_000;
    // Pre-first-byte budget covers KV-cold prefill + engine warm-up.
    // Hardware tiering empirically calibrated against the qwen3.5-9b
    // matrix runs:
    //   - default 600s — adequate for x64 + non-Apple ARM and for warm
    //     Apple Silicon with the prompt cache hit.
    //   - 1500s on darwin-arm64 with ≤16 GB unified memory — cold-prefill
    //     of a 9B Q4 model with a ~16K-token system prompt on M2 Air
    //     blew through 600s AND 900s on every fresh gezel session in
    // the matrix. Same machine, same Q4 9B, cold KV,
    //     16K prefill → measured ~12-15 min. 1500s gives a 5-min
    //     headroom over the observed cliff without masking genuine
    //     hangs (the streaming-idle watchdog still catches mid-turn
    //     stalls at 300s).
    // `GEZEL_LLAMA_CPP_PRE_FIRST_BYTE_IDLE_MS` overrides both for ops
    // who need to tune further (e.g. 30B-class models on weaker hosts).
    const envPreFirstByteMs = parseEnvMs(process.env.GEZEL_LLAMA_CPP_PRE_FIRST_BYTE_IDLE_MS);
    const lowRamAppleSilicon =
      process.platform === 'darwin' &&
      process.arch === 'arm64' &&
      os.totalmem() <= 17 * 1024 * 1024 * 1024;
    const platformDefaultPreFirstByteMs = lowRamAppleSilicon ? 1_500_000 : 600_000;
    this.preFirstByteIdleMs =
      opts.preFirstByteIdleMs ?? envPreFirstByteMs ?? platformDefaultPreFirstByteMs;
    this.postReasoningWatchdogMs = opts.postReasoningWatchdogMs ?? 30_000;
    const envConstrainedNoSignalMs = parseEnvMs(
      process.env.GEZEL_LLAMA_CPP_CONSTRAINED_TOOL_NO_SIGNAL_MS,
    );
    this.constrainedToolNoSignalMs =
      opts.constrainedToolNoSignalMs ??
      envConstrainedNoSignalMs ??
      constrainedToolNoSignalMsForModel(opts.catalogModelId ?? opts.defaultModel);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.logFile) this.logFile = opts.logFile;
    if (opts.slotSavePath) this.slotSavePath = opts.slotSavePath;
    const slots = opts.concurrency ?? 2;
    this.launchedSlots = slots;
    this.engineRequestWidth = slots;
    const batchMax = Math.max(1, opts.batchMaxConcurrency ?? 1);
    this.batchMaxConcurrency = batchMax;
    const batching = batchMax > 1;
    // Interactive lane capped at 1 (serial) or the batch width; foreground chat
    // behaves like the old serial queue while background chores fill spare
    // slots. Reserve at least ONE slot above the interactive cap for the
    // background lane so a mid-turn one-shot pinned to this provider (compaction
    // / memory extraction / summarization) can't deadlock behind a full
    // interactive lane. The default (slots=2, interactive=1) already had a spare
    // slot; the guard matters when the memory ceiling clamps a big model to a
    // single slot (`providerConcurrency['llama-cpp']=1` or a tight-RAM auto-size)
    // — without it, a lone slot + a synchronous mid-turn compaction wedges the
    // turn, the same failure the MLX single-slot path hit. See the matching note
    // in the MLX provider.
    const interactiveConcurrency = batching ? Math.min(slots, batchMax) : 1;
    const queueConcurrency =
      opts.reserveBackgroundSlot === false ? slots : Math.max(slots, interactiveConcurrency + 1);
    this.queue = new ProviderQueue({
      // llama-server is launched with `--parallel ${slots}` (see
      // `buildLlamaCppProvider` in chat/manager.ts) so the engine has matching
      // KV slots. The queue may have one extra logical background lane, while
      // `acquireExclusiveEngineRequest` caps actual cache+generation work at
      // `slots`. A background chore the foreground awaits can therefore enter
      // this queue and claim the physical slot between tool-loop round-trips,
      // without two sessions ever pinning the same native slot concurrently.
      concurrency: queueConcurrency,
      interactiveConcurrency,
      backgroundConcurrency: Math.max(1, queueConcurrency - interactiveConcurrency),
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
      // A single local GPU: hold ambient housekeeping (nudges,
      // extraction, icon/about) while the user is actively engaged, so
      // a multi-minute chore turn never lands right before their next
      // move. Applies to ds4 too — its provider wraps this class.
      ambientQuietMs: defaultAmbientQuietMs(),
    });
  }

  /**
   * Batch capability — llama-server serves `--parallel N` concurrent KV
   * slots, so when batched inference is enabled `maxConcurrency` is that
   * slot count; otherwise 1 (we don't opt into co-batching). See
   * {@link LLMProvider.batch}.
   */
  get batch(): BatchCapability {
    return { maxConcurrency: this.batchMaxConcurrency };
  }

  /**
   * Cache adapter (Phase 1+) — set by ChatManager after construction
   * and read by sessions on every send to derive `cache_prompt` +
   * `id_slot` extras. Null when no controller is wired (cloud-only
   * install, tests).
   */
  private cacheAdapter: import('./cache-adapter.js').LlamaCppCacheAdapter | null = null;
  private slotSavePath?: string;
  private readonly launchedSlots: number;

  setCacheAdapter(adapter: import('./cache-adapter.js').LlamaCppCacheAdapter): void {
    this.cacheAdapter = adapter;
  }

  getCacheAdapter(): import('./cache-adapter.js').LlamaCppCacheAdapter | null {
    return this.cacheAdapter;
  }

  /**
   * Directory passed to llama-server's `--slot-save-path` on launch.
   * The cache adapter reads this to wire slot save/restore I/O.
   * Undefined on external-baseUrl mode (we don't control the launch).
   */
  getSlotSavePath(): string | undefined {
    return this.slotSavePath;
  }

  /**
   * The `--parallel` slot count this provider was constructed for — the
   * ENGINE's slot space, which is what the cache adapter must size its
   * slot model to. Deliberately NOT `queue.concurrency`: the queue
   * reserves a background lane ABOVE the engine slots
   * (`max(slots, interactive+1)`), so on a single-slot launch the queue
   * reads 2 — and an adapter sized off it binds sessions to slot ids the
   * server doesn't have. Wild-caught 2026-08-03: the adapter "bound"
   * slot 1 on a `--parallel 1` server; every save/restore against it
   * would 400 silently, and the debug probe's slot narration was fiction.
   */
  getLaunchedSlots(): number {
    return this.launchedSlots;
  }

  /**
   * Claim one physical llama-server request slot.
   *
   * This is deliberately narrower than {@link queue}: a logical turn holds its
   * ProviderQueue lease across the whole tool loop, while this lease covers one
   * cache-prepare + `/v1/chat/completions` round-trip. On a one-slot launch that
   * lets a synchronous background one-shot run between foreground iterations,
   * but prevents the wild-caught failure where a recovery nudge saved/restored
   * slot 0 while another session was still generating on slot 0, leaving the
   * native prompt processor stuck forever.
   */
  async acquireExclusiveEngineRequest(label: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw engineRequestAbortError(label);

    const waitStartedAt = Date.now();
    if (this.engineRequestsActive < this.engineRequestWidth) {
      this.engineRequestsActive++;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: (typeof this.engineRequestWaiters)[number] = {
          resolve,
          reject,
          ...(signal ? { signal } : {}),
        };
        if (signal) {
          waiter.onAbort = () => {
            const idx = this.engineRequestWaiters.indexOf(waiter);
            if (idx === -1) return;
            this.engineRequestWaiters.splice(idx, 1);
            signal.removeEventListener('abort', waiter.onAbort!);
            reject(engineRequestAbortError(label));
          };
          signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        this.engineRequestWaiters.push(waiter);
      });
    }

    const waitedMs = Date.now() - waitStartedAt;
    if (waitedMs > 1_000) {
      log.debug(`[llama-cpp] engine request ${label} waited ${waitedMs}ms for a physical slot`);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.engineRequestWaiters.shift();
      if (next) {
        if (next.signal && next.onAbort) {
          next.signal.removeEventListener('abort', next.onAbort);
        }
        // Hand the physical slot straight to the next waiter. The active count
        // stays unchanged across the handoff, so it can never exceed width.
        next.resolve();
      } else {
        this.engineRequestsActive--;
      }
    };
  }

  /**
   * Current base URL (when supervised) or the externally-configured
   * one. `undefined` when the supervised engine hasn't started yet —
   * the cache adapter treats that as "engine not ready, return empty
   * usage."
   */
  currentBaseUrl(): string | null {
    if (this.externalBaseUrl) return this.externalBaseUrl;
    return this.supervisor?.currentBaseUrl() ?? null;
  }

  /** True only while this native engine is serving or queuing a physical request. */
  isEngineBusy(): boolean {
    return this.engineRequestsActive > 0 || this.engineRequestWaiters.length > 0;
  }

  engineLifecycleSnapshot(): NativeEngineLifecycleSnapshot | undefined {
    return this.supervisor?.lifecycleSnapshot();
  }

  async initialize(): Promise<void> {
    // No client object to construct. The supervisor starts the child
    // lazily on the first `sendAndWait` — keeping initialize() a
    // no-op avoids spinning up the engine just because someone asked
    // the provider to exist.
  }

  async shutdown(): Promise<void> {
    // Poison FIRST so a turn racing the shutdown can't lazily respawn
    // llama-server after the stop below (see `disposed` field doc).
    this.disposed = true;
    // Only pool replicas (explicit ownerId) unregister: a singleton's
    // 'default' registration may have been replaced by a successor
    // instance, and unregistering here would drop the successor's.
    if (this.arbiter && this.supervisor && this.evictorOwnerId) {
      this.arbiter.unregisterEvictor('llm', this.evictorOwnerId);
    }
    // Flush slot caches BEFORE stopping the supervisor — once
    // llama-server exits the slot save endpoint is gone. flushAll is
    // best-effort; failures during shutdown shouldn't block the stop.
    if (this.cacheAdapter) {
      try {
        await this.cacheAdapter.flushAll();
      } catch {
        // Best-effort persistence — failure here just means the next
        // boot pays the prefill cost on resume, same as before.
      }
    }
    await this.supervisor?.stop();
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    if (this.disposed) {
      throw new Error('[llama-cpp] provider disposed (engine was evicted) — re-resolve it');
    }
    const bridges = await McpBridgePool.fromSessionOpts(opts, '[llama-cpp]');
    return new LlamaCppSession({
      resolveBaseUrl: () => this.resolveBaseUrl(),
      acquireGpuLease: () => this.acquireGpuLease(),
      markUsed: () => this.supervisor?.markUsed(),
      ...(this.supervisor
        ? {
            waitForNativeEngineExit: async (sinceMs: number) =>
              await this.supervisor?.waitForUnexpectedExitSince?.(sinceMs),
          }
        : {}),
      fetchImpl: this.fetchImpl,
      model: opts.model ?? this.defaultModel,
      numCtx: this.numCtx,
      includeUsageInStream: this.includeUsageInStream,
      replayReasoningContent: this.replayReasoningContent,
      visionEnabled: this.visionEnabled,
      disableThinkingRequestShape: this.disableThinkingRequestShape,
      systemMessage: opts.systemMessage,
      ...(opts.systemPromptLayers ? { systemPromptLayers: opts.systemPromptLayers } : {}),
      ...(opts.volatileContext ? { volatileContext: opts.volatileContext } : {}),
      // Pass widened priorMessages through — the session translates
      // tool-role entries into ChatMessage tool_calls / role:'tool'
      // entries at construction time.
      priorMessages: opts.priorMessages ?? [],
      bridges,
      queue: this.queue,
      provider: this,
      streamingIdleMs: this.streamingIdleMs,
      preFirstByteIdleMs: this.preFirstByteIdleMs,
      postReasoningWatchdogMs: this.postReasoningWatchdogMs,
      constrainedToolNoSignalMs: this.constrainedToolNoSignalMs,
      ...(opts.externalTools && opts.externalTools.length > 0
        ? { externalTools: opts.externalTools }
        : {}),
      ...(opts.requestCompaction ? { requestCompaction: opts.requestCompaction } : {}),
      ...(opts.forceDirectFileWork ? { forceDirectFileWork: true } : {}),
      ...(opts.directFileWorkTargetPath
        ? { directFileWorkTargetPath: opts.directFileWorkTargetPath }
        : {}),
      ...(opts.profile ? { profile: opts.profile } : {}),
      ...(opts.activeCraftbookStep ? { activeCraftbookStep: opts.activeCraftbookStep } : {}),
      ...(opts.tuning ? { tuning: opts.tuning } : {}),
      ...(opts.terminalToolPolicy ? { terminalToolPolicy: opts.terminalToolPolicy } : {}),
    });
  }

  getContextWindow(): number {
    return this.numCtx;
  }

  /**
   * Live engine launch provenance (granted context, slots, KV dtype) from
   * the supervisor — undefined in external base-URL mode or when no child
   * process is up. See `LLMProvider.engineLaunchSnapshot`.
   */
  engineLaunchSnapshot(): EngineLaunchSnapshot | undefined {
    return this.supervisor?.launchSnapshot();
  }

  /**
   * Weights + KV at the granted window/cache mode, from the launch
   * admission pass. See `LLMProvider.plannedReservationBytes`.
   */
  plannedReservationBytes(): number | undefined {
    return this.plannedReservation;
  }

  /**
   * Classifier hook the supervisor wires into its `onRawLine`. Runs
   * on every stdout/stderr line from llama-server; when the line
   * maps to a known startup phase, fans the descriptor out to every
   * currently-waiting session so the UI surfaces "loading model 42%"
   * instead of a silent spinner.
   *
   * Public so `buildLlamaCppProvider` can register it on the
   * supervisor it constructs; not something external callers should
   * invoke directly.
   */
  onStdoutLine(line: string): void {
    // Reasoning-budget transitions are out-of-band engine signals,
    // not startup-phase events. When the engine reports the natural
    // end of its reasoning budget, fan the signal to every active
    // session so each can arm its post-reasoning silent-stall
    // watchdog. Slot-id attribution isn't available on these lines
    // (they're emitted before the next `slot ...` line carrying the
    // id), so we fan out; sessions that ARE streaming content will
    // cancel their watchdog on the next `delta.content` and the
    // fan-out is harmless for them.
    //
    // Match the exact upstream wording — line shape has been stable
    // across recent llama.cpp versions, and a loose regex risks
    // false-positives on test logs or future format changes.
    if (line.includes('reasoning-budget: deactivated (natural end)')) {
      for (const s of this.activeSessions) {
        try {
          s.notifyReasoningEnded();
        } catch (err) {
          log.warn(
            `[llama-cpp] notifyReasoningEnded threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const phase = this.classifyLine(line);
    if (!phase) return;

    // Accumulate memory footprint from every buffer-allocation line
    // the classifier identifies. Runs BEFORE the dedupe check below
    // so two tensor-load lines with identical "size =" text still
    // both count (different buffers usually have distinct sizes, but
    // an edge case shouldn't silently discard memory).
    if (phase.bufferBytes !== undefined && phase.bufferBytes > 0) {
      this.accumulatedRamBytes += phase.bufferBytes;
    }

    // On `ready` — engine has finished loading. Publish the total
    // RAM figure to every active session, remember it for late
    // joiners, and reset the counter for the next engine lifecycle
    // (idle-stop + restart = fresh allocation).
    if (phase.phase === 'ready' && this.accumulatedRamBytes > 0) {
      const stats = { ramAllocBytes: this.accumulatedRamBytes };
      this.lastEngineStats = stats;
      for (const s of this.activeSessions) s.publishEngineStats(stats);
      this.accumulatedRamBytes = 0;
    }

    // Dedupe against the last seen phase so a burst of `load_tensors:`
    // lines doesn't flood the event bus. Same phase + same detail =
    // don't republish.
    if (
      this.lastStartupPhase &&
      this.lastStartupPhase.phase === phase.phase &&
      this.lastStartupPhase.detail === phase.detail
    ) {
      return;
    }
    const phaseEvent: EnginePhaseEvent = {
      provider: 'llama-cpp',
      phase: phase.phase,
      ...(phase.detail ? { detail: phase.detail } : {}),
      ...(typeof phase.progress === 'number' ? { progress: phase.progress } : {}),
    };
    this.lastStartupPhase = phase.phase === 'ready' ? null : phaseEvent;
    for (const s of this.activeSessions) s.publishEnginePhase(phaseEvent);
  }

  /**
   * Surface the rolling log-file handle so the service's HTTP layer
   * can tail it for the Settings → On-device log viewer. Returns
   * undefined when no supervised process is running (external
   * baseUrl mode — there's no stdout for us to capture).
   */
  getLogFile(): LlamaCppLogFile | undefined {
    return this.logFile;
  }

  /** Internal — called by LlamaCppSession to register itself for startup fan-out. */
  _registerActiveSession(session: LlamaCppSession): void {
    this.activeSessions.add(session);
    // If we already have a startup phase in-flight (another session
    // triggered the engine boot), replay it to the new session so it
    // isn't stuck on a bare spinner until the next log line.
    if (this.lastStartupPhase) session.publishEnginePhase(this.lastStartupPhase);
    // Same replay for engine stats — a session opened after the
    // engine is warm still deserves to know the RAM footprint for
    // its UI dropdown, without waiting for a restart.
    if (this.lastEngineStats) session.publishEngineStats(this.lastEngineStats);
  }

  _deregisterActiveSession(session: LlamaCppSession): void {
    this.activeSessions.delete(session);
  }

  async listModels(): Promise<ModelInfo[]> {
    // Enumerate every installed model so pickers and `/v1/models`
    // advertise the full set the engine pool can actually serve —
    // not just the one currently resident. Mirrors MlxProvider.
    if (this.modelManager) {
      try {
        const installed = await this.modelManager.listInstalled();
        if (installed.length > 0) {
          return installed.map((m) => {
            const sizeGb = m.approxSizeBytes / (1024 * 1024 * 1024);
            const sizeLabel = sizeGb >= 0.1 ? ` · ${sizeGb.toFixed(1)} GB` : '';
            const ctxLabel = m.contextWindow ? ` · ${Math.round(m.contextWindow / 1024)}k ctx` : '';
            return {
              id: m.id,
              name: `${m.name}${sizeLabel}${ctxLabel}`,
              supportsTools: true,
              ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            };
          });
        }
      } catch {
        // Fall through to the default-only entry — enumeration is a
        // UI/discovery nicety, not load-bearing for chat.
      }
    }
    // No manager wired (external-baseUrl mode) or nothing installed:
    // a single entry describing the running config.
    return [
      {
        id: this.defaultModel,
        name: this.defaultModel,
        supportsTools: true,
      },
    ];
  }

  getEffectiveModelId(): string | undefined {
    return this.catalogModelId;
  }

  private async resolveBaseUrl(): Promise<string> {
    if (this.externalBaseUrl) return this.externalBaseUrl;
    if (this.disposed) {
      throw new Error('[llama-cpp] provider disposed (engine was evicted) — re-resolve it');
    }
    if (!this.supervisor) throw new Error('[llama-cpp] no base URL resolver configured');
    // Acquire the GPU slot BEFORE asking the supervisor to start. In
    // `swap` policy this evicts a running image engine so its VRAM is
    // released by the time llama-server tries to load weights. In
    // `coexist` policy the call returns immediately. The arbiter is
    // only set on the supervised path (see constructor).
    if (this.arbiter) await this.arbiter.acquire('llm');
    const ensureStartedAt = Date.now();
    let launch: NativeEngineLaunch;
    try {
      launch = await this.supervisor.ensureRunning();
    } catch (err) {
      const nativeExit = this.supervisor.lastExitSnapshot?.();
      if (nativeExit && !nativeExit.expected && nativeExit.exitedAt >= ensureStartedAt) {
        throw new NativeEngineCrashedError(nativeExit, err);
      }
      throw err;
    }
    return launch.baseUrl.replace(/\/+$/, '');
  }

  private async acquireGpuLease(): Promise<(() => void) | undefined> {
    if (this.externalBaseUrl || !this.arbiter) return undefined;
    return this.arbiter.acquireLease('llm');
  }
}

/**
 * Per-turn handle the session exposes to the provider so out-of-band
 * engine signals (parsed from llama-server stdout via the supervisor's
 * `onRawLine`) can influence the in-flight turn. Today's only consumer
 * is the post-reasoning silent-stall watchdog — when the engine emits
 * `reasoning-budget: deactivated (natural end)`, the handle's
 * `onReasoningEnded()` arms a tight 30-second timer in the stream pump
 * that fires `ctrl.abort()` with `abortKind = 'post-reasoning-silent'`
 * unless a visible content chunk arrives first. Set on
 * `sendAndWaitInner` entry, cleared on exit; the session's
 * `notifyReasoningEnded` no-ops when no turn is in flight.
 */
interface ActiveTurnHandle {
  onReasoningEnded: () => void;
}

interface LlamaCppSessionDeps {
  resolveBaseUrl: () => Promise<string>;
  acquireGpuLease?: () => Promise<(() => void) | undefined>;
  markUsed: () => void;
  /** Correlate a transport teardown with a supervised child exit. */
  waitForNativeEngineExit?: (sinceMs: number) => Promise<NativeEngineExitSnapshot | undefined>;
  fetchImpl: typeof fetch;
  model: string;
  /** Append `stream_options:{include_usage:true}` to chat requests (ds4 opt-in). */
  includeUsageInStream?: boolean;
  /** Echo per-turn `reasoning_content` on committed assistant messages (ds4 opt-in). */
  replayReasoningContent?: boolean;
  /** See {@link LlamaCppProvider.visionEnabled}. */
  visionEnabled?: boolean;
  /** See {@link LlamaCppProvider.disableThinkingRequestShape}. */
  disableThinkingRequestShape: DisableThinkingRequestShape;
  /**
   * Context window (tokens) the underlying llama-server booted with.
   * Surfaced on the session as `numCtx` so {@link ChatManager.checkContextPressure}
   * can pressure-check and invoke compactInFlight, same as Ollama.
   * Required — the supervisor must know the cap to pass `--ctx-size`,
   * so we have a concrete value to report.
   */
  numCtx: number;
  systemMessage: string;
  /** Layered prefix-cache keys (flag ON only). See {@link SystemPromptLayers}. */
  systemPromptLayers?: import('../../cache/adapter.js').SystemPromptLayers;
  /** Volatile band seeded as a frozen system message after messages[0] (flag ON only). */
  volatileContext?: string;
  priorMessages: Array<
    | { role: 'user' | 'assistant'; content: string }
    | { role: 'assistant'; content: string; toolCalls: ExternalToolCall[] }
    | { role: 'tool'; content: string; toolCallId: string }
  >;
  bridges: McpBridgePool;
  /**
   * Caller-supplied external tool definitions. Advertised in the
   * `/v1/chat/completions` request body alongside any bridge tools;
   * the model's calls against these names halt the loop instead of
   * being executed through the bridge — captured via
   * {@link LLMSession.capturedToolCalls}.
   */
  externalTools?: ExternalToolSpec[];
  queue: ProviderQueue;
  /**
   * Back-reference so the session can register/deregister itself
   * with the provider's active-session set during `sendAndWaitInner`.
   * Used to fan out supervisor-side phase events (model load
   * progress) to every session currently waiting on engine startup.
   */
  provider: LlamaCppProvider;
  /**
   * Mid-tool-loop compaction hook — see {@link SessionOpts.requestCompaction}.
   * Threaded straight through from createSession opts; the session
   * calls it between tool-loop iterations when the in-memory transcript
   * crosses {@link MID_LOOP_COMPACT_RATIO} of `numCtx`.
   */
  requestCompaction?: NonNullable<SessionOpts['requestCompaction']>;
  /** Manager-owned direct file-work clamp state for this session surface. */
  forceDirectFileWork?: boolean;
  /** Expected output path paired with the manager-owned clamp state. */
  directFileWorkTargetPath?: string;
  /** Mid-stream silence cap (ms). See provider's same-named field. */
  streamingIdleMs: number;
  /** Pre-first-byte cap (ms). See provider's same-named field. */
  preFirstByteIdleMs: number;
  /** Post-reasoning silent-stall cap (ms). See provider's same-named field. */
  postReasoningWatchdogMs: number;
  /** Constrained mutation no-tool-signal cap (ms). See provider's same-named field. */
  constrainedToolNoSignalMs: number;
  /**
   * Resolved per-model behavior profile. Same role as Ollama's: gates
   * the ramble detector + pre-tool preamble fold on profile opt-in.
   */
  profile?: ResolvedModelProfile;
  /** Active craftbook step — passed to anti-spin abort messages. */
  activeCraftbookStep?: NonNullable<SessionOpts['activeCraftbookStep']>;
  /**
   * Resolved per-model tuning. Applied to the OpenAI-compatible request
   * body via `LLAMA_CPP_TUNING_MAP` at request-build time. Includes
   * DRY/XTC samplers, grammar / json_schema for structured output, and
   * `enable_thinking` via `chat_template_kwargs`.
   */
  tuning?: import('../../model-profile/index.js').ResolvedTuning;
  terminalToolPolicy?: NonNullable<SessionOpts['terminalToolPolicy']>;
}

/**
 * Trigger compaction mid-tool-loop when the in-memory transcript
 * exceeds this fraction of `numCtx`. 0.7 is tighter than the manager
 * boundary check (0.9) on purpose: a tool result we just appended
 * could double on the next iteration, so we want headroom. Tighter
 * than 0.7 starts compacting healthy turns; looser misses the cases
 * where the next tool result tips us over the slot ctx mid-args
 * serialization (the parse-error 500 failure mode).
 */
const MID_LOOP_COMPACT_RATIO = 0.7;
/**
 * Minimum prior-message count required to bother running a one-shot
 * compaction. Below this the synthesis cost (a full LLM call on the
 * same model) outweighs the freed tokens. Aligned with the manager-
 * side check (`COMPACTION_KEEP_TAIL + 2` floor in compactInFlight).
 */
const MID_LOOP_COMPACT_MIN_PRIOR = 2;

class LlamaCppSession extends StreamingSessionBase implements LLMSession {
  private readonly messages: ChatMessage[];
  private flattenToolMessagesForStrictAlternation = false;
  private compactWriteTranscript = false;
  /**
   * Collapse every `role:'system'` turn into one leading system message
   * before each request. Set proactively from the
   * `provider.merge-system-messages` behavior (Qwen 3.x family) and
   * reactively when a chat template rejects a non-leading system turn with
   * a 500 (see `tryParseSystemMessageOrderingError`). gezel's layered
   * prefix cache seeds the volatile band as a second system message after
   * messages[0]; templates that allow only one system message at the start
   * 500 on it, poisoning the session before any tool call lands.
   */
  private mergeSystemMessages = false;
  /**
   * Index of the current turn's user message in `this.messages`. Set
   * when the user message is pushed at the start of `sendAndWaitInner`;
   * used by {@link maybeCompactMidLoop} to identify the boundary
   * between "prior history that's safe to compact" and "this turn's
   * in-flight tool loop that must be preserved verbatim". Reset to 0
   * outside an active turn.
   */
  private currentTurnStartIdx = 0;
  /**
   * Per-turn guard: at most one mid-loop compaction per `sendAndWait`.
   * Prevents a runaway double-compaction loop if the synthesis itself
   * doesn't free enough tokens (the manager-side `MAX_COMPACTIONS_PER_SEND`
   * is the cross-turn equivalent). Reset on each `sendAndWait` entry.
   */
  private compactedThisTurn = false;
  /**
   * Aggregated `<think>` / `<reasoning>` text captured this turn,
   * across every iteration of the tool loop. Reset at the top of
   * each `sendAndWaitInner`. ChatManager reads it via
   * `getLastTurnReasoning()` after the turn resolves and stashes
   * the trace on the assistant message.
   */
  private lastTurnReasoning = '';
  /**
   * Active in-turn handle the provider's stdout pipeline writes to
   * when it detects engine-level reasoning-budget transitions. Set on
   * `sendAndWaitInner` entry, cleared on exit. The stream pump uses
   * the handle to install a tight post-reasoning watchdog so the
   * "model finished thinking and then went silent" failure mode is
   * caught in ~30s instead of waiting for the 5-min `streamingIdleMs`
   * to fire. Wild-caught squisq-review:
   * llama-server emitted `reasoning-budget: deactivated (natural end)`
   * at T+4:17 and then produced zero further tokens — the streaming
   * idle didn't fire until ~5 min later. With this handle the
   * sentence "the model gave up post-reasoning" becomes detectable in
   * 30s and the turn aborts with an actionable error.
   */
  private activeTurnHandle: ActiveTurnHandle | null = null;

  /**
   * Provider-side notification that the engine just emitted
   * `reasoning-budget: deactivated (natural end)`. Best-effort
   * attribution: the supervisor's stdout-parser doesn't carry slot
   * id on the reasoning lines, so we fan the signal out to every
   * active session. The post-reasoning watchdog only matters when
   * the next visible chunk DOESN'T arrive — sessions that ARE
   * legitimately streaming content will cancel the watchdog on the
   * next `delta.content` tick, so the fan-out is safe.
   */
  notifyReasoningEnded(): void {
    const handle = this.activeTurnHandle;
    if (!handle) return;
    handle.onReasoningEnded();
  }

  private readonly externalToolNames: Set<string>;
  private capturedCalls: ExternalToolCall[] = [];

  constructor(private readonly deps: LlamaCppSessionDeps) {
    super();
    this.externalToolNames = new Set((deps.externalTools ?? []).map((t) => t.name));
    this.messages = [{ role: 'system', content: deps.systemMessage }];
    // Layered prefix caching (flag ON): the volatile band is a SEPARATE
    // frozen system message right after the stable system message, so the
    // stable `[system][tools]` prefix the engine sees stays reusable
    // across sessions. The chat template renders this as a second system
    // turn after the first turn's system+tools block, before the
    // transcript — exactly where we want the per-session/per-turn context.
    if (deps.volatileContext) {
      this.messages.push({ role: 'system', content: deps.volatileContext });
    }
    // Strict-alternation templates (Mistral family) reject the
    // assistant(tool_calls) -> tool transcript with a 500. The
    // `provider.flatten-tool-transcript` marker flattens it proactively from
    // turn 1 so each gezel doesn't burn its first tool turn on the reactive
    // recovery below (`tryParseStrictAlternationTemplateError`).
    if (profileHasBehavior(deps.profile, 'provider.flatten-tool-transcript')) {
      this.flattenToolMessagesForStrictAlternation = true;
    }
    if (profileHasBehavior(deps.profile, 'provider.compact-write-transcript')) {
      this.compactWriteTranscript = true;
    }
    // Single-system-message templates (Qwen 3.x family) `raise_exception`
    // on the volatile band's second system turn. The
    // `provider.merge-system-messages` marker collapses system turns into
    // one leading message proactively from turn 1 so each gezel doesn't
    // burn its first turn on the reactive recovery below
    // (`tryParseSystemMessageOrderingError`).
    if (profileHasBehavior(deps.profile, 'provider.merge-system-messages')) {
      this.mergeSystemMessages = true;
    }
    // Translate the widened priorMessages shape into llama-cpp's
    // ChatMessage schema. role:'tool' becomes a tool message carrying
    // `tool_call_id`; role:'assistant' with toolCalls carries the
    // `tool_calls` array OpenAI-style; plain user/assistant turns pass
    // through verbatim.
    for (const m of deps.priorMessages) {
      if (m.role === 'tool') {
        this.messages.push({
          role: 'tool',
          content: m.content,
          tool_call_id: m.toolCallId,
        });
        continue;
      }
      if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length > 0) {
        this.messages.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        continue;
      }
      this.messages.push({ role: m.role, content: m.content });
    }
  }

  capturedToolCalls(): ExternalToolCall[] {
    return [...this.capturedCalls];
  }

  getLastTurnReasoning(): string | undefined {
    return this.lastTurnReasoning.length > 0 ? this.lastTurnReasoning : undefined;
  }

  /** Total context window (tokens) llama-server booted with. */
  get numCtx(): number {
    return this.deps.numCtx;
  }

  /**
   * Character-based estimate of the prompt size the next
   * `/v1/chat/completions` will see. Mirrors {@link OllamaSession.estimatePromptChars}
   * so {@link ChatManager.checkContextPressure} can reuse the same
   * 4-chars/token heuristic to decide whether to warn or compact.
   *
   * Includes the function-calling schema (`body.tools`) — llama-server
   * templates it into the wire prompt before the model sees a token,
   * so on a tool-heavy session (60+ MCP tools on a researcher gezel)
   * it can outweigh the entire chat transcript on turn 1. Without
   * this accounting the pressure check sees a near-empty window
   * and never fires.
   */
  estimatePromptChars(): number {
    let total = 0;
    for (const m of this.messages) {
      if (typeof m.content === 'string') total += m.content.length;
      if (m.tool_calls) {
        for (const tc of m.tool_calls)
          total += tc.function.arguments.length + tc.function.name.length;
      }
    }
    if (!this.deps.bridges.isEmpty()) {
      for (const t of this.deps.bridges.getOpenAITools()) {
        total += JSON.stringify(t).length;
      }
    }
    return total;
  }

  /**
   * Prefill-only request: POST the exact `[system][tools][transcript]`
   * prefix the next real turn will send, decoding a single token. The
   * engine's prompt cache (ds4's token-text disk KV, llama-server's
   * `cache_prompt` slots) ends up holding a byte-identical prefix of
   * the next real request, so that turn's prefill collapses to just
   * the new user message.
   *
   * The body is assembled through the SAME pipeline as
   * {@link sendAndWaitInner} — wire-message transforms, bridge +
   * external tools, catalog tuning — because a one-token divergence
   * anywhere in the rendered prompt voids the prefix match. The only
   * differences: no user message is appended, `max_tokens` is forced
   * to 1, and nothing is pushed to history.
   *
   * Callers (the ds4 cache adapter's `warm`) normally gate on engine-idle.
   * The provider's physical request gate remains authoritative here so a
   * warm racing a newly-started turn waits instead of touching its cache slot.
   */
  async prefillOnly(opts?: { timeoutMs?: number; sessionId?: string }): Promise<void> {
    // The signal bounds physical-slot waiting and the HTTP request. Engine
    // startup and cache restore retain their own existing backstops; the
    // physical lease still starts before cache preparation so a warm cannot
    // save/restore a slot another session is actively using.
    const requestSignal = AbortSignal.timeout(opts?.timeoutMs ?? 10 * 60_000);
    const label = `cache-warm:${(opts?.sessionId ?? 'anonymous').slice(0, 8)}`;
    const releaseEngineRequest = await this.deps.provider.acquireExclusiveEngineRequest(
      label,
      requestSignal,
    );
    try {
      const baseUrl = await this.deps.resolveBaseUrl();
      let wireMessages: ChatMessage[] = this.flattenToolMessagesForStrictAlternation
        ? flattenToolMessagesForStrictAlternation(this.messages)
        : this.messages;
      if (this.mergeSystemMessages) {
        wireMessages = mergeSystemMessagesIntoFirst(wireMessages);
      }
      const bridgeTools = this.deps.bridges.isEmpty()
        ? []
        : toChatCompletionsTools(this.deps.bridges);
      const externalAsChatCompletions: ChatCompletionTool[] = (this.deps.externalTools ?? []).map(
        (t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description ?? '',
            parameters: normalizeJsonSchemaForLlamaCpp(t.parameters),
          },
        }),
      );
      const tools = [...bridgeTools, ...externalAsChatCompletions];
      const body: Record<string, unknown> = {
        model: this.deps.model,
        messages: wireMessages,
        stream: false,
      };
      if (this.deps.tuning) applyTuning(body, this.deps.tuning, LLAMA_CPP_TUNING_MAP);
      // After tuning so a catalog `maxTokens` can't re-widen the decode.
      body.max_tokens = 1;
      if (tools.length > 0) body.tools = tools;
      if (opts?.sessionId) {
        const adapter = this.deps.provider.getCacheAdapter();
        if (adapter) {
          await adapter.prepareForSend(
            opts.sessionId,
            this.deps.systemMessage,
            this.deps.systemPromptLayers,
          );
          Object.assign(body, adapter.buildRequestExtras(opts.sessionId));
        }
      }
      const res = await this.deps.fetchImpl(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withWireMessages(body)),
        signal: requestSignal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`prefillOnly: HTTP ${res.status} ${txt.slice(0, 200)}`);
      }
      await res.text().catch(() => '');
    } finally {
      releaseEngineRequest();
    }
  }

  /**
   * Public wrapper around the protected `emitEnginePhase` so the
   * provider (via `LlamaCppProvider.onStdoutLine`) can push phase
   * events sourced from the supervisor's stdout classifier. Called
   * from outside the session; protected emit method stays reserved
   * for internal per-turn milestones.
   */
  publishEnginePhase(ev: EnginePhaseEvent): void {
    this.emitEnginePhase(ev);
  }

  /**
   * Public wrapper around `emitEngineStats` so the provider can
   * fan the one-shot post-load RAM total out to every currently-
   * registered session.
   */
  publishEngineStats(ev: { ramAllocBytes: number }): void {
    this.emitEngineStats({ provider: 'llama-cpp', ramAllocBytes: ev.ramAllocBytes });
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    // Ask-spawned sub-sessions bypass the TS-side queue to avoid the
    // ask_specialist / ask_gezel deadlock (asker holds the only slot
    // while waiting on the consultation's reply). llama-server's own
    // `--parallel` allocator still serializes against the slot pool,
    // so bypassing the FIFO is safe. See MlxSession.sendAndWait for
    // the same rationale.
    if (opts?.queue?.bypassQueue) return this.sendAndWaitInner(prompt, opts);
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  /**
   * Mid-tool-loop pressure check. Called between iterations after a
   * tool result has been pushed; if the in-memory transcript is over
   * {@link MID_LOOP_COMPACT_RATIO} of `numCtx`, asks the manager
   * (via {@link LlamaCppSessionDeps.requestCompaction}) to synthesize
   * the prior history into a single bubble and swap it in. Bounded
   * to one compaction per `sendAndWait` to avoid runaway loops.
   *
   * Best-effort: any failure is logged + swallowed and the turn
   * continues with the un-compacted transcript. The downstream
   * recovery paths (server-side `exceed_context_size_error`,
   * `Failed to parse tool call arguments` 500) catch the cases
   * where compaction didn't help OR wasn't attempted.
   *
   * Returns `true` when a synthesis was actually swapped in, `false`
   * otherwise (below threshold, no callback wired, callback returned
   * null/threw, insufficient prior, already compacted this turn).
   * The boolean lets reactive callers — see the parse-error 500
   * branch, where `force` skips the ratio gate — distinguish "we
   * shrunk the transcript, retry the request" from "no luck, fall
   * through to the warning".
   */
  private async maybeCompactMidLoop(opts?: { force?: boolean }): Promise<boolean> {
    if (this.compactedThisTurn) return false;
    if (!this.deps.requestCompaction) return false;
    const estimatedChars = this.estimatePromptChars();
    const estimatedTokens = Math.ceil(estimatedChars / 4);
    const ratio = estimatedTokens / this.deps.numCtx;
    // `force` is the reactive-recovery path: a server-side parse
    // error already proved we're over the line, so skip the ratio
    // gate. The proactive iteration-2 hook leaves `force` unset.
    if (!opts?.force && ratio < MID_LOOP_COMPACT_RATIO) return false;
    // Slice prior = conversational messages after ALL leading system bands
    // and before the current turn's user msg. Layered prefix caching seeds a
    // stable + volatile system pair; treating the volatile band as prior
    // conversation made a recalled first turn appear to have two old messages
    // and emitted a bogus compaction warning on `hello`.
    let priorStartIdx = 0;
    while (
      priorStartIdx < this.currentTurnStartIdx &&
      this.messages[priorStartIdx]?.role === 'system'
    ) {
      priorStartIdx++;
    }
    const prior: Array<{ role: string; content: string }> = [];
    for (let i = priorStartIdx; i < this.currentTurnStartIdx; i++) {
      const m = this.messages[i]!;
      if (
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.length > 0
      ) {
        prior.push({ role: m.role, content: m.content });
      }
    }
    if (prior.length < MID_LOOP_COMPACT_MIN_PRIOR) return false;
    let result: { syntheticContent: string } | null = null;
    try {
      result = await this.deps.requestCompaction({
        priorMessages: prior,
        estimatedTokens,
        numCtx: this.deps.numCtx,
      });
    } catch (err) {
      log.warn(
        `[llama-cpp] mid-loop compaction request failed (continuing un-compacted): ${err instanceof Error ? err.message : String(err)}`,
      );
      // Mark compacted so we don't retry every iteration on a broken
      // callback; the next user-message boundary check picks it up.
      this.compactedThisTurn = true;
      return false;
    }
    if (!result) {
      this.compactedThisTurn = true;
      return false;
    }
    // Replace the prior conversation with one synthesis assistant message,
    // preserving every leading system band verbatim. Splice keeps the array
    // reference stable (other parts may iterate over it; we mutate in place).
    const removed = this.currentTurnStartIdx - priorStartIdx;
    this.messages.splice(priorStartIdx, removed, {
      role: 'assistant',
      content: result.syntheticContent,
    });
    this.currentTurnStartIdx = priorStartIdx + 1;
    this.compactedThisTurn = true;
    log.info(
      `[llama-cpp] mid-loop compacted ${removed} prior message(s) → 1 synthesis (${result.syntheticContent.length} chars)${opts?.force ? ' (reactive recovery)' : ''}`,
    );
    this.emitWarning(
      'Compacted earlier conversation to free up working window for the current turn.',
    );
    return true;
  }

  /**
   * Shrink THIS turn's accumulated tool results in place.
   *
   * The blind spot `maybeCompactMidLoop` cannot cover: it folds only
   * `[1, currentTurnStartIdx)` — the prior turns — and the manager's
   * force-fit works on `record.messages`, which never contains the
   * in-flight turn. So when a long tool loop overflows the window inside
   * a single turn, both recovery layers report "nothing to remove"
   * (`removed=0 nope`) and the identical over-budget request is re-sent
   * until the turn dies. Wild-caught on 4 craftbooks in the 2026-07-24
   * matrix, each overshooting by only 111–919 tokens.
   *
   * Structure is never touched — only `content` strings of `role:'tool'`
   * messages — so assistant/tool `tool_call_id` pairing stays valid and
   * the chat template still renders. Oldest results shrink first and the
   * newest `KEEP_INTACT` stay whole: the model needs the most recent
   * observation verbatim to take its next step, while a 40-turn-old
   * directory listing is safely summarizable.
   *
   * Returns the number of chars reclaimed (0 when there was nothing to
   * shrink, which is the honest "this layer can't help" signal).
   */
  private condenseInTurnToolResults(): number {
    const KEEP_INTACT = 2;
    const MIN_SHRINKABLE = 400;
    const FLOOR_CHARS = 200;
    const targetChars = Math.floor(this.deps.numCtx * MID_LOOP_COMPACT_RATIO * 4);
    let estimated = this.estimatePromptChars();
    if (estimated <= targetChars) return 0;

    const shrinkable: number[] = [];
    for (let i = this.currentTurnStartIdx; i < this.messages.length; i++) {
      const m = this.messages[i]!;
      if (m.role !== 'tool') continue;
      if (typeof m.content !== 'string' || m.content.length < MIN_SHRINKABLE) continue;
      shrinkable.push(i);
    }
    // Newest results are load-bearing; drop them from the candidate set.
    const candidates = shrinkable.slice(0, Math.max(0, shrinkable.length - KEEP_INTACT));
    if (candidates.length === 0) return 0;

    let reclaimed = 0;
    for (const idx of candidates) {
      if (estimated <= targetChars) break;
      const m = this.messages[idx]!;
      const before = (m.content as string).length;
      // capToolOutput keeps head+tail and stamps a visible truncation
      // footer, so the model can tell "this was long" from "this was
      // empty" — the same contract the bridge applies on the way in.
      const condensed = capToolOutput(m.content as string, FLOOR_CHARS);
      if (condensed.length >= before) continue;
      m.content = condensed;
      const saved = before - condensed.length;
      reclaimed += saved;
      estimated -= saved;
    }
    if (reclaimed > 0) {
      log.info(
        `[llama-cpp] in-turn condensation reclaimed ${reclaimed} chars across ${candidates.length} tool result(s) (kept the newest ${KEEP_INTACT} intact)`,
      );
      this.emitWarning(
        'Condensed this turn’s older tool output to stay inside the context window. The most recent results are untouched.',
      );
    }
    return reclaimed;
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    const totalTimeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + totalTimeoutMs;
    const start = Date.now();

    // Images only ride along when the server has a projector loaded. Otherwise
    // the chat layer has already replaced them with a text digest, and base64
    // sent to a blind server just burns context on bytes it discards.
    const attachments = opts?.attachments ?? [];
    const continueFromToolResult = opts?.continueFromToolResult === true;
    if (continueFromToolResult) {
      if (prompt.length > 0 || attachments.length > 0) {
        throw new Error(
          '[llama.cpp] a tool-result continuation cannot include a new prompt or attachments',
        );
      }
      if (this.messages.at(-1)?.role !== 'tool') {
        throw new Error('[llama.cpp] a tool-result continuation requires a trailing tool result');
      }
    }
    const userMsg: ChatMessage = { role: 'user', content: prompt };
    if (attachments.length > 0) {
      if (this.deps.visionEnabled) userMsg.attachments = [...attachments];
      else
        log.debug(
          `[llama-cpp] dropping ${attachments.length} image attachment(s) — engine has no vision projector loaded`,
        );
    }
    // Mark where the current turn starts so mid-loop compaction can
    // tell "compact this" (everything before) from "preserve verbatim"
    // (this turn's user msg + tool loop). Index captured BEFORE the
    // push so `currentTurnStartIdx` points at the user message itself.
    this.currentTurnStartIdx = this.messages.length;
    this.compactedThisTurn = false;
    // Reset captured reasoning at the top of each turn — manager
    // reads `getLastTurnReasoning()` after this resolves.
    this.lastTurnReasoning = '';
    if (!continueFromToolResult) this.messages.push(userMsg);

    // Reset captures — each sendAndWait surfaces only its own externals.
    this.capturedCalls = [];
    const bridgeTools = this.deps.bridges.isEmpty()
      ? []
      : toChatCompletionsTools(this.deps.bridges);
    const externalAsChatCompletions: ChatCompletionTool[] = (this.deps.externalTools ?? []).map(
      (t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: normalizeJsonSchemaForLlamaCpp(t.parameters),
        },
      }),
    );
    const tools =
      bridgeTools.length + externalAsChatCompletions.length > 0
        ? [...bridgeTools, ...externalAsChatCompletions]
        : undefined;
    if (tools) {
      // Wire-cost diagnostic: schemas are templated into the prompt by
      // llama-server, so their JSON size is prompt tokens. Pairs with
      // GEZEL_PROMPT_BREAKDOWN's text-section table for full accounting.
      log.debug(
        `wire tools=${tools.length} schemaChars=${tools.reduce((n, t) => n + JSON.stringify(t).length, 0)}`,
      );
    }
    const collectKnownToolNames = (): Set<string> => {
      const known = new Set<string>();
      if (!this.deps.bridges.isEmpty()) {
        for (const t of this.deps.bridges.getOpenAITools()) known.add(t.name);
      }
      for (const name of this.externalToolNames) known.add(name);
      return known;
    };
    // Tool-name → declared input schema, for repairing salvaged calls
    // whose structural arguments the markup formats flattened into
    // strings. See tool-arg-schema-coercion.ts.
    const toolArgSchemas = new Map<string, Record<string, unknown>>();
    for (const t of tools ?? []) {
      const schema = t.function.parameters as Record<string, unknown> | undefined;
      if (t.function.name && schema) toolArgSchemas.set(t.function.name, schema);
    }
    // Surgical edit tools on the roster ⇒ deliverable is a modify of an
    // existing file; a repeated source-write failure steers toward a
    // targeted patch rather than "re-emit the whole file." Same as MLX.
    const knownToolNamesForFailures = collectKnownToolNames();
    const surgicalEditsAvailableForFailures =
      knownToolNamesForFailures.has('replace_in_file') ||
      knownToolNamesForFailures.has('insert_at_marker') ||
      knownToolNamesForFailures.has('replace_lines') ||
      knownToolNamesForFailures.has('append_to_file');
    // Delegation tools on the roster → repeated edit failures can hand the
    // file to a more capable model instead of thrashing to a plain abort.
    const delegationAvailableForFailures = [...knownToolNamesForFailures].some((n) =>
      n.startsWith('delegate_'),
    );
    // Per-tool consecutive-failure tracker. See ToolFailureTracker for
    // the threshold rationale; same logic the MLX provider uses.
    const failureTracker = new ToolFailureTracker({
      surgicalEditsAvailable: surgicalEditsAvailableForFailures,
      delegationAvailable: delegationAvailableForFailures,
    });
    // Per-turn same-(name, args) repeat tracker. Catches the
    // narrative-spinning loop. See ToolRepeatTracker docstring.
    const repeatTracker = new ToolRepeatTracker();
    const deliverableReadPaceTracker = DeliverableReadPaceTracker.fromUserText(prompt);
    // Per-turn ask_user_question dedup + post-question prose-fold
    // signal. See the matching block in MlxSession for the rationale.
    let askedQuestionThisTurn = false;
    // Per-turn project-macro guard. See MlxSession for the wild-caught
    // scenario — local cold-start models brainstorming variations of
    // start_project in one response and producing N duplicate projects.
    let startedProjectOrJobThisTurn: { tool: string; firstResult: string } | null = null;
    let fullText = '';
    let lastUsage: {
      prompt_tokens: number;
      completion_tokens: number;
      /** From llama-server's `timings.predicted_per_second` — decode rate. */
      predicted_per_second?: number;
      /** From llama-server's `timings.prompt_per_second` — prefill rate. */
      prompt_per_second?: number;
      /** From llama-server's `timings.cache_n` — prompt tokens reused. */
      cache_n?: number;
    } | null = null;
    // TTFT stopwatch — null until the first content delta arrives for
    // this whole turn (across every tool-loop iteration). Non-null on
    // subsequent iterations means we've already seen the first token
    // so the "prefill" phase doesn't re-fire on each tool loop.
    let firstTokenAt: number | null = null;
    // Register with the provider so supervisor-side phase events
    // (model load progress) fan out to this session while it's in-
    // flight. Deregister in the finally block below.
    this.deps.provider._registerActiveSession(this);

    // Auto-continuation state for truncated immediate-writes — see the
    // matching block in the MLX provider.
    let writeContinuationActive = false;
    let writeContinuations = 0;
    let scenarioRepairMutationSucceeded = false;
    let existingSourceEditMutationSucceeded = false;
    let directFileWorkMutationSucceeded = false;
    let scenarioRepairNoMutationNudges = 0;
    let scenarioRepairReadOnlyCalls = 0;
    const prerequisiteRepairReadPaths = extractPrerequisiteRepairReadPaths(prompt);
    let prerequisiteRepairNoProgressNudges = 0;
    let scenarioRepairFailedMutationCalls = 0;
    let scenarioRepairDiagnosticReadRetryPending = false;
    const scenarioRepairReadFilePaths: string[] = [];
    let existingSourceEditNoMutationNudges = 0;
    let existingSourceEditReadOnlyCalls = 0;
    let existingSourceEditFailedMutationCalls = 0;
    let existingSourceEditFailedMutationPath: string | null = null;
    const existingSourceEditReadFilePaths: string[] = [];
    let immediateFileWriteNoMutationNudges = 0;
    let directFileWorkNoMutationNudges = 0;
    let directFileWorkReadOnlyCalls = 0;
    const directFileWorkPrerequisiteReadPaths = extractDirectFileWorkPrerequisiteReadPaths(
      prompt,
      extractDirectFileWorkTargetPath(prompt) ?? this.deps.directFileWorkTargetPath ?? null,
    );
    let directFileWorkPrerequisiteNoProgressNudges = 0;
    let directFileWorkScriptHelperWritten = false;
    let directFileWorkScriptHelperFailure: string | null = null;
    let directFileWorkScriptHelperContent: string | null = null;
    let directFileWorkScriptHelperFailedContent: string | null = null;
    let directFileWorkRejectedWritePath: string | null = null;
    let missingFileCreatePath: string | null = null;
    const directFileWorkReadFilePaths: string[] = [];
    // Whether any earlier iteration of THIS turn fired an action tool —
    // drives `foldPostActionRumination` on later reply-only iterations
    // (the wrap-up wall a verbose model emits after its tool ran).
    let actionFiredEarlierThisTurn = false;
    // llama.cpp builds vary in which JSON-Schema constructs their aggregate
    // tool-grammar converter accepts. Recover in stages while MCP/Zod remains
    // the authority at execution: patterns first (only when that changes the
    // request), then a useful structural schema, finally a permissive object.
    let toolGrammarFallback: ToolGrammarFallback = 'none';
    // The GPU lease is acquired per loop iteration and normally released by
    // that iteration's `cleanupTurn`. The loop body is thousands of lines with
    // many `throw` sites (bounded-repair guardrails, deadline checks, grammar
    // fallbacks), and any one of them escaping before `cleanupTurn` is
    // installed used to leak the lease permanently: the arbiter's `activeLease`
    // stayed `'llm'`, and every later acquirer parked forever on a promise only
    // a release could resolve. That wedged the whole daemon — every session,
    // not just this one — with a healthy, idle engine, until gezeld restarted.
    // Holding the release here lets the outer `finally` guarantee it no matter
    // how the loop exits.
    let releaseActiveGpuLease: (() => void) | null = null;
    let releaseActiveEngineRequest: (() => void) | null = null;

    try {
      for (let turn = 0; turn < MAX_TOOL_LOOP_TURNS; turn++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`[llama-cpp] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
        }

        // Check every iteration, including the first. Tool schemas can fill
        // most of a local context window before a single result exists, and
        // the session's exact post-clamp roster is more accurate here than
        // the manager's earlier boundary estimate.
        await this.maybeCompactMidLoop();

        const engineRequestLabel = `${(opts?.queue?.sessionId ?? 'anonymous').slice(0, 8)}#${turn}`;
        const engineWaitRemaining = deadline - Date.now();
        if (engineWaitRemaining <= 0) {
          throw new Error(`[llama-cpp] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
        }
        const engineDeadlineSignal = AbortSignal.timeout(engineWaitRemaining);
        const engineWaitSignal = opts?.queue?.signal
          ? AbortSignal.any([opts.queue.signal, engineDeadlineSignal])
          : engineDeadlineSignal;
        let releaseEngineRequest: () => void;
        try {
          releaseEngineRequest = await this.deps.provider.acquireExclusiveEngineRequest(
            engineRequestLabel,
            engineWaitSignal,
          );
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            if (opts?.queue?.signal?.aborted) {
              throw new Error('[llama-cpp] turn cancelled by caller');
            }
            if (engineDeadlineSignal.aborted) {
              throw new Error(`[llama-cpp] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
            }
          }
          throw err;
        }
        let engineRequestReleased = false;
        const releaseEngineRequestOnce = () => {
          if (engineRequestReleased) return;
          engineRequestReleased = true;
          releaseActiveEngineRequest = null;
          releaseEngineRequest();
        };
        releaseActiveEngineRequest = releaseEngineRequestOnce;
        if (Date.now() >= deadline) {
          releaseEngineRequestOnce();
          throw new Error(`[llama-cpp] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
        }

        const releaseGpuLease = await this.deps.acquireGpuLease?.();
        let gpuLeaseReleased = false;
        const releaseGpuLeaseOnce = () => {
          if (gpuLeaseReleased) return;
          gpuLeaseReleased = true;
          releaseActiveGpuLease = null;
          releaseGpuLease?.();
        };
        releaseActiveGpuLease = releaseGpuLeaseOnce;
        let baseUrl: string;
        try {
          baseUrl = await this.deps.resolveBaseUrl();
        } catch (err) {
          releaseGpuLeaseOnce();
          releaseEngineRequestOnce();
          throw err;
        }
        let wireMessages: ChatMessage[] = this.flattenToolMessagesForStrictAlternation
          ? flattenToolMessagesForStrictAlternation(this.messages)
          : this.messages;
        if (this.mergeSystemMessages) {
          wireMessages = mergeSystemMessagesIntoFirst(wireMessages);
        }
        const body: Record<string, unknown> = {
          model: this.deps.model,
          messages: wireMessages,
          stream: true,
          // ds4-server emits per-turn usage only when asked; llama-server
          // surfaces its own custom timings the session already parses.
          ...(this.deps.includeUsageInStream ? { stream_options: { include_usage: true } } : {}),
          // Ask llama-server for its per-request `timings` block, which carries
          // `predicted_per_second` (decode rate), `prompt_per_second` (prefill
          // rate) and `cache_n` (prompt tokens served from cache). Without it
          // the stream's `usage` has token COUNTS only, so throughput was
          // reachable solely by scraping stdout — which meant the product had
          // no decode rate to show at all. Unknown request fields are ignored
          // by servers that predate the option, so this is safe to always send.
          timings_per_token: true,
        };
        // Per-model tuning. Writes temperature/top_p/top_k/min_p plus
        // DRY/XTC, grammar / json_schema, tool_choice, and
        // chat_template_kwargs.enable_thinking onto the OpenAI-compat
        // request body. Catalog tuning blocks live on each chat-model
        // identity; gezel frontmatter `tuning` overrides apply on top.
        if (this.deps.tuning) {
          applyTuning(body, this.deps.tuning, LLAMA_CPP_TUNING_MAP);
        }
        // Continuation-iteration output cap — see SendAndWaitOpts.
        // Iteration 0 keeps the catalog cap so a tool call is never cut
        // off before it starts; wrap-up iterations get the tight cap.
        if (turn > 0 && opts?.continuationMaxTokens && opts.continuationMaxTokens > 0) {
          const current =
            typeof body.max_tokens === 'number' ? body.max_tokens : Number.POSITIVE_INFINITY;
          body.max_tokens = Math.min(current, opts.continuationMaxTokens);
        }
        const immediateFileWriteTurn = isImmediateFileWriteTurn(prompt, tools);
        const immediateFileWriteTarget = immediateFileWriteTurn
          ? extractDirectFileWorkTargetPath(prompt)
          : null;
        const inferredDirectFileWorkTarget =
          extractDirectFileWorkTargetPath(prompt) ?? this.deps.directFileWorkTargetPath ?? null;
        // Derived-data repairs must keep the helper-write → execute loop
        // intact. Generic scenario/source repair mode treats the checked
        // output as an ordinary existing file and may end the turn after a
        // helper script mutation, before that helper is executed. Prefer the
        // scripted direct-file state machine whenever its tools are present.
        const scriptedDataFileWorkTurn =
          !immediateFileWriteTurn &&
          shouldPreferScriptedDataFileWork(prompt, inferredDirectFileWorkTarget) &&
          hasWriteFileTool(tools) &&
          (tools?.some((tool) => chatCompletionToolName(tool) === 'run_nodejs_script') ?? false);
        const scenarioFileRepairTurn =
          !scriptedDataFileWorkTurn && isScenarioFileRepairTurn(prompt, tools);
        const existingSourceEditTurn =
          !scriptedDataFileWorkTurn && isExistingSourceEditTurn(prompt, tools);
        // Stage-1 gate-escalation turns: marker-gated, so immediate-write
        // can't co-fire (stage-1 text carries no trigger phrase), but the
        // explicit guards document the intended precedence — every existing
        // mode wins; this mode fills the previously-inert gap.
        const gateSurgicalEditTurn =
          !immediateFileWriteTurn &&
          !scenarioFileRepairTurn &&
          !existingSourceEditTurn &&
          isGateSurgicalEditTurn(prompt, tools);
        const directFileWorkTurn =
          !immediateFileWriteTurn &&
          !scenarioFileRepairTurn &&
          !existingSourceEditTurn &&
          !gateSurgicalEditTurn &&
          (scriptedDataFileWorkTurn || this.deps.forceDirectFileWork === true
            ? hasDirectFileWorkToolSurface(tools)
            : isDirectFileWorkTurn(prompt, tools));
        const directFileWorkTarget = directFileWorkTurn
          ? this.deps.forceDirectFileWork && this.deps.directFileWorkTargetPath
            ? this.deps.directFileWorkTargetPath
            : inferredDirectFileWorkTarget
          : null;
        const directFileWorkScriptHelperMode =
          directFileWorkTurn &&
          shouldPreferScriptedDataFileWork(prompt, directFileWorkTarget) &&
          hasWriteFileTool(tools) &&
          (tools?.some((tool) => chatCompletionToolName(tool) === 'run_nodejs_script') ?? false) &&
          (directFileWorkReadOnlyCalls > 0 ||
            shouldStartScriptedDataFileWork(prompt, directFileWorkTarget));
        const sourceFileScenarioRepairTurn =
          scenarioFileRepairTurn && isSourceFileScenarioRepairPrompt(prompt);
        const crossFileCompilerRepairTurn =
          sourceFileScenarioRepairTurn &&
          /(?:cannot find name|does not exist on type|is not assignable to type)/i.test(prompt);
        const crossFileCompilerDependencyReadPending =
          crossFileCompilerRepairTurn && scenarioRepairReadOnlyCalls === 1;
        const remainingPrerequisiteReadPaths = scenarioFileRepairTurn
          ? remainingPrerequisiteRepairReadPaths(
              prerequisiteRepairReadPaths,
              scenarioRepairReadFilePaths,
            )
          : [];
        const prerequisiteRepairReadsPending = remainingPrerequisiteReadPaths.length > 0;
        const remainingDirectFileWorkPrerequisiteReadPaths =
          directFileWorkTurn && !directFileWorkScriptHelperMode
            ? remainingPrerequisiteRepairReadPaths(
                directFileWorkPrerequisiteReadPaths,
                directFileWorkReadFilePaths,
              )
            : [];
        const directFileWorkPrerequisiteReadsPending =
          remainingDirectFileWorkPrerequisiteReadPaths.length > 0;
        if (
          prerequisiteRepairReadsPending &&
          scenarioRepairReadOnlyCalls >
            prerequisiteRepairReadPaths.length + PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT
        ) {
          throw new Error(
            `[llama-cpp] prerequisite source-read repair exceeded its bounded read allowance before reading: ${remainingPrerequisiteReadPaths.join(', ')}`,
          );
        }
        if (
          directFileWorkPrerequisiteReadsPending &&
          directFileWorkReadOnlyCalls >
            directFileWorkPrerequisiteReadPaths.length + PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT
        ) {
          throw new Error(
            `[llama-cpp] direct file-work prerequisite reads exceeded their bounded allowance before reading: ${remainingDirectFileWorkPrerequisiteReadPaths.join(', ')}`,
          );
        }
        const explicitFullRewriteScenarioRepairTurn =
          scenarioFileRepairTurn &&
          !prerequisiteRepairReadsPending &&
          hasExplicitFullFileRewriteWording(prompt);
        const fullRewriteScenarioRepairTurn =
          sourceFileScenarioRepairTurn && explicitFullRewriteScenarioRepairTurn;
        const sourceRewriteFallback =
          sourceFileScenarioRepairTurn &&
          !fullRewriteScenarioRepairTurn &&
          (scenarioRepairNoMutationNudges >= 2 || scenarioRepairFailedMutationCalls >= 2);
        const existingSourceRewriteFallback =
          existingSourceEditTurn &&
          (existingSourceEditNoMutationNudges >= 2 || existingSourceEditFailedMutationCalls >= 2);
        // Pin an evidence-grounded post-read repair when sniff feedback names
        // the bounded mutation target explicitly. Other scenario repairs may
        // legitimately fix a dependency rather than the checked entry point,
        // so they retain the older pin only for whole-file rewrite fallbacks.
        const postReadMutationTarget = scenarioRepairPostReadMutationTargetPath(prompt);
        const scenarioRepairWriteTarget =
          scenarioFileRepairTurn && postReadMutationTarget
            ? postReadMutationTarget
            : scenarioFileRepairTurn &&
                (explicitFullRewriteScenarioRepairTurn || sourceRewriteFallback)
              ? (scenarioRepairTargetPath(prompt) ?? scenarioRepairReadFilePaths.at(-1) ?? null)
              : null;
        const sourceRewriteRefreshReadPending =
          sourceRewriteFallback &&
          scenarioRepairWriteTarget !== null &&
          !scenarioRepairReadFilePaths.some(
            (path) =>
              normalizeWorkspacePathForCompare(path) ===
              normalizeWorkspacePathForCompare(scenarioRepairWriteTarget),
          );
        const existingSourceEditWriteTarget = existingSourceEditTurn
          ? (extractSingleFileSourceRepairTargetPath(prompt) ??
            existingSourceEditFailedMutationPath ??
            existingSourceEditReadFilePaths.at(-1) ??
            null)
          : null;
        const useGemmaRepairToolGrammarFallback =
          isGemmaChannelProfile(this.deps.profile) &&
          (scenarioFileRepairTurn || existingSourceEditTurn || gateSurgicalEditTurn);
        // Gemma's native repair grammar is useful on the first attempt: it
        // keeps thinking available while the model inspects an unfamiliar
        // source file. Once that attempt returns without a mutation, however,
        // repeating the optional-tool shape just reproduces short reasoning-
        // only turns. Escalate the bounded retry to a required tool call while
        // preserving the already narrowed patch/rewrite surface.
        const useGemmaScenarioRepairToolGrammarFallback =
          useGemmaRepairToolGrammarFallback && scenarioRepairNoMutationNudges === 0;
        const useGemmaExistingSourceEditToolGrammarFallback =
          useGemmaRepairToolGrammarFallback && existingSourceEditNoMutationNudges === 0;
        const constrainedToolSignalMode = prerequisiteRepairReadsPending
          ? 'scenario-prerequisite-read'
          : directFileWorkPrerequisiteReadsPending
            ? 'direct-file-work'
            : immediateFileWriteTurn
              ? 'immediate-write'
              : gateSurgicalEditTurn
                ? 'gate-surgical-edit'
                : directFileWorkTurn &&
                    (directFileWorkReadOnlyCalls > 0 ||
                      directFileWorkRejectedWritePath !== null ||
                      directFileWorkScriptHelperMode)
                  ? 'direct-file-work'
                  : existingSourceEditTurn && existingSourceEditReadOnlyCalls > 0
                    ? 'existing-source-edit'
                    : scenarioFileRepairTurn &&
                        (fullRewriteScenarioRepairTurn || scenarioRepairReadOnlyCalls > 0)
                      ? 'scenario-repair'
                      : null;
        const pushImmediateFileWriteNoMutationCorrective = () => {
          immediateFileWriteNoMutationNudges += 1;
          if (immediateFileWriteNoMutationNudges > SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT) {
            throw new Error(
              `[llama-cpp] immediate file-write turn ended without a write_file call after ${SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT} corrective nudge(s). The latest request still requires writing the deliverable file.`,
            );
          }
          const nudge = buildImmediateFileWriteNoMutationNudge({
            targetPath: immediateFileWriteTarget,
            noMutationNudges: immediateFileWriteNoMutationNudges,
          });
          log.warn(
            `[llama-cpp] immediate-write no-mutation corrective ${immediateFileWriteNoMutationNudges}/${SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT}`,
          );
          this.messages.push({ role: 'user', content: nudge });
        };
        const pushDirectFileWorkNoMutationCorrective = () => {
          directFileWorkNoMutationNudges += 1;
          if (directFileWorkNoMutationNudges > SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT) {
            throw new Error(
              `[llama-cpp] direct file-work turn ended without a successful workspace mutation after ${SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT} corrective nudge(s). The latest request still requires writing the deliverable file.`,
            );
          }
          const nudge = directFileWorkScriptHelperFailure
            ? buildDirectFileWorkScriptFailureNudge(
                directFileWorkTarget,
                directFileWorkScriptHelperFailure,
              )
            : buildDirectFileWorkNoMutationNudge(collectKnownToolNames(), {
                targetPath: directFileWorkTarget,
                readOnlyCalls: directFileWorkReadOnlyCalls,
                readFilePaths: directFileWorkReadFilePaths,
                noMutationNudges: directFileWorkNoMutationNudges,
                scriptHelperMode: directFileWorkScriptHelperMode,
                scriptHelperWritten: directFileWorkScriptHelperWritten,
              });
          log.warn(
            `[llama-cpp] direct-file-work no-mutation corrective ${directFileWorkNoMutationNudges}/${SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT}`,
          );
          this.messages.push({ role: 'user', content: nudge });
        };
        let requestTools = tools;
        if (immediateFileWriteTurn) {
          if (
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model rescue:')
          ) {
            userMsg.content += IMMEDIATE_FILE_WRITE_PROMPT_SUFFIX;
          }
          if (
            typeof body.max_tokens !== 'number' ||
            body.max_tokens < IMMEDIATE_FILE_WRITE_MIN_TOKENS
          ) {
            body.max_tokens = IMMEDIATE_FILE_WRITE_MIN_TOKENS;
          }
          body.temperature = 0.2;
          body.top_p = 0.8;
          body.tool_choice = 'required';
          requestTools = writeFileOnlyTools(tools);
          disableThinkingForConstrainedTurn(
            body,
            this.deps.disableThinkingRequestShape,
            this.deps.model,
          );
          log.debug(
            `[llama-cpp] immediate-write mode: write_file-only surface, thinking disabled, max_tokens=${body.max_tokens}`,
          );
        }
        if (directFileWorkTurn) {
          if (
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model file-work mode:')
          ) {
            userMsg.content += DIRECT_FILE_WORK_PROMPT_SUFFIX;
          }
          if (
            directFileWorkPrerequisiteReadPaths.length > 0 &&
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model prerequisite-read mode:')
          ) {
            userMsg.content += DIRECT_FILE_WORK_PREREQUISITE_READ_PROMPT_SUFFIX;
          }
          if (directFileWorkReadOnlyCalls > 0 && !directFileWorkPrerequisiteReadsPending) {
            if (
              typeof userMsg.content === 'string' &&
              !userMsg.content.includes('[Local-model write-now mode:')
            ) {
              userMsg.content += DIRECT_FILE_WORK_AFTER_READ_PROMPT_SUFFIX;
            }
          }
          if (
            directFileWorkScriptHelperMode &&
            directFileWorkTarget &&
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model data-transform mode:')
          ) {
            userMsg.content += buildDirectFileWorkScriptHelperPromptSuffix(directFileWorkTarget);
          }
          if (directFileWorkPrerequisiteReadsPending) {
            requestTools = readFileOnlyTools(tools);
            log.debug(
              `[llama-cpp] direct-file-work prerequisite-read surface: read_file only; remaining=${remainingDirectFileWorkPrerequisiteReadPaths.join(',')}`,
            );
          } else if (directFileWorkReadOnlyCalls > 0 || directFileWorkScriptHelperMode) {
            requestTools = directFileWorkAfterReadTools(tools, {
              prompt,
              targetPath: directFileWorkTarget,
              forceWriteFile: directFileWorkNoMutationNudges > 0,
              preferScriptHelper: directFileWorkScriptHelperMode,
              scriptHelperWritten: directFileWorkScriptHelperWritten,
            });
            if (requestTools !== tools) {
              log.debug(
                `[llama-cpp] direct-file-work write-now tool surface: ${
                  requestTools
                    ?.map((tool) => chatCompletionToolName(tool))
                    .filter(Boolean)
                    .join(',') ?? 'none'
                }`,
              );
            }
          }
          if (directFileWorkRejectedWritePath) {
            if (
              typeof userMsg.content === 'string' &&
              !userMsg.content.includes('[Local-model rejected-write recovery:')
            ) {
              userMsg.content += buildDirectFileWorkRejectedWriteNudge(
                directFileWorkRejectedWritePath,
              );
            }
            requestTools = writeFileOnlyTools(tools);
            log.debug(
              `[llama-cpp] direct-file-work rejected-write recovery: write_file-only path=${directFileWorkRejectedWritePath}`,
            );
          }
          const currentMax =
            typeof body.max_tokens === 'number' ? body.max_tokens : Number.POSITIVE_INFINITY;
          body.max_tokens = Math.min(
            currentMax,
            directFileWorkReadOnlyCalls > 0
              ? DIRECT_FILE_WORK_AFTER_READ_MAX_TOKENS
              : DIRECT_FILE_WORK_MAX_TOKENS,
          );
          body.temperature = 0.2;
          body.top_p = 0.8;
          body.tool_choice = 'required';
          disableThinkingForConstrainedTurn(
            body,
            this.deps.disableThinkingRequestShape,
            this.deps.model,
          );
          log.debug(
            `[llama-cpp] direct-file-work mode: compact file surface, thinking disabled, max_tokens=${body.max_tokens}`,
          );
        }
        if (scenarioFileRepairTurn) {
          if (
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model repair mode:')
          ) {
            userMsg.content += SCENARIO_FILE_REPAIR_PROMPT_SUFFIX;
          }
          if (
            typeof userMsg.content === 'string' &&
            isDomNullRuntimeRepairPrompt(prompt) &&
            !userMsg.content.includes('[DOM null repair:')
          ) {
            userMsg.content += DOM_NULL_REPAIR_PROMPT_SUFFIX;
          }
          const currentMax =
            typeof body.max_tokens === 'number' ? body.max_tokens : Number.POSITIVE_INFINITY;
          body.max_tokens = Math.min(currentMax, SCENARIO_FILE_REPAIR_MAX_TOKENS);
          body.temperature = 0.2;
          body.top_p = 0.8;
          if (useGemmaScenarioRepairToolGrammarFallback) {
            delete body.tool_choice;
          } else {
            body.tool_choice = 'required';
            disableThinkingForConstrainedTurn(
              body,
              this.deps.disableThinkingRequestShape,
              this.deps.model,
            );
          }
          log.debug(
            `[llama-cpp] scenario-repair mode: direct file repair surface, ${
              useGemmaScenarioRepairToolGrammarFallback
                ? 'Gemma grammar fallback active'
                : 'thinking disabled'
            }, max_tokens=${body.max_tokens}`,
          );
          if (prerequisiteRepairReadsPending) {
            if (
              typeof userMsg.content === 'string' &&
              !userMsg.content.includes('[Local-model provenance-read mode:')
            ) {
              userMsg.content += PREREQUISITE_REPAIR_READ_PROMPT_SUFFIX;
            }
            requestTools = readFileOnlyTools(tools);
            body.tool_choice = 'required';
            disableThinkingForConstrainedTurn(
              body,
              this.deps.disableThinkingRequestShape,
              this.deps.model,
            );
            log.debug(
              `[llama-cpp] scenario-repair prerequisite-read surface: read_file remaining=${remainingPrerequisiteReadPaths.join(',')}`,
            );
          } else if (explicitFullRewriteScenarioRepairTurn) {
            if (
              typeof userMsg.content === 'string' &&
              !userMsg.content.includes(
                sourceFileScenarioRepairTurn
                  ? '[Local-model source rewrite mode:'
                  : '[Local-model full-file rewrite mode:',
              )
            ) {
              userMsg.content += sourceFileScenarioRepairTurn
                ? SCENARIO_SOURCE_FULL_REWRITE_PROMPT_SUFFIX
                : SCENARIO_FULL_REWRITE_PROMPT_SUFFIX;
            }
            requestTools = writeFileOnlyTools(tools);
            if (requestTools !== tools) {
              log.debug(
                `[llama-cpp] scenario-repair explicit source rewrite tool surface: ${
                  requestTools
                    ?.map((tool) => chatCompletionToolName(tool))
                    .filter(Boolean)
                    .join(',') ?? 'none'
                }`,
              );
            }
          } else if (sourceRewriteRefreshReadPending) {
            if (typeof userMsg.content === 'string') {
              userMsg.content = userMsg.content.replace(
                SCENARIO_SOURCE_REPAIR_PATCH_PROMPT_SUFFIX,
                '',
              );
              if (!userMsg.content.includes('[Local-model source rewrite refresh:')) {
                userMsg.content += `${SCENARIO_SOURCE_REWRITE_REFRESH_PROMPT_SUFFIX} Your entire next output must be one \`read_file({ path: ${JSON.stringify(scenarioRepairWriteTarget)}, raw: true })\` tool call.`;
              }
            }
            requestTools = readFileOnlyTools(tools);
            body.tool_choice = 'required';
            disableThinkingForConstrainedTurn(
              body,
              this.deps.disableThinkingRequestShape,
              this.deps.model,
            );
            log.debug(
              `[llama-cpp] scenario-repair source rewrite refresh-read surface: read_file target=${scenarioRepairWriteTarget}`,
            );
          } else if (sourceRewriteFallback) {
            if (typeof userMsg.content === 'string') {
              userMsg.content = userMsg.content.replace(
                SCENARIO_SOURCE_REPAIR_PATCH_PROMPT_SUFFIX,
                '',
              );
              if (!userMsg.content.includes('[Local-model source rewrite fallback:')) {
                userMsg.content += SCENARIO_SOURCE_REWRITE_FALLBACK_PROMPT_SUFFIX;
              }
            }
            requestTools = writeFileOnlyTools(tools);
            if (requestTools !== tools) {
              log.debug(
                `[llama-cpp] scenario-repair source rewrite fallback tool surface: ${
                  requestTools
                    ?.map((tool) => chatCompletionToolName(tool))
                    .filter(Boolean)
                    .join(',') ?? 'none'
                }`,
              );
            }
          } else if (sourceFileScenarioRepairTurn) {
            if (
              typeof userMsg.content === 'string' &&
              !userMsg.content.includes('[Local-model source repair mode:')
            ) {
              userMsg.content += SCENARIO_SOURCE_REPAIR_PROMPT_SUFFIX;
            }
            if (
              scenarioRepairReadOnlyCalls > 0 &&
              !scenarioRepairDiagnosticReadRetryPending &&
              !crossFileCompilerDependencyReadPending
            ) {
              if (
                typeof userMsg.content === 'string' &&
                !userMsg.content.includes('[Local-model source patch mode:')
              ) {
                userMsg.content += SCENARIO_SOURCE_REPAIR_PATCH_PROMPT_SUFFIX;
              }
              requestTools = patchOnlyExistingSourceEditTools(tools);
              if (requestTools !== tools) {
                log.debug(
                  `[llama-cpp] scenario-repair source patch-only tool surface: ${
                    requestTools
                      ?.map((tool) => chatCompletionToolName(tool))
                      .filter(Boolean)
                      .join(',') ?? 'none'
                  }`,
                );
              }
            } else {
              if (
                crossFileCompilerDependencyReadPending &&
                typeof userMsg.content === 'string' &&
                !userMsg.content.includes('[Local-model dependency refresh:')
              ) {
                userMsg.content += CROSS_FILE_COMPILER_DEPENDENCY_READ_PROMPT_SUFFIX;
              }
              requestTools = sourceFileScenarioRepairTools(tools);
              if (requestTools !== tools) {
                log.debug(
                  `[llama-cpp] scenario-repair source tool surface: ${
                    requestTools
                      ?.map((tool) => chatCompletionToolName(tool))
                      .filter(Boolean)
                      .join(',') ?? 'none'
                  }`,
                );
              }
            }
          } else if (
            shouldUseScenarioRepairMutationOnlySurface({
              noMutationNudges: scenarioRepairNoMutationNudges,
              readOnlyCalls: scenarioRepairReadOnlyCalls,
              failedMutationCalls: scenarioRepairFailedMutationCalls,
            })
          ) {
            requestTools = mutationOnlyScenarioRepairTools(tools);
            if (requestTools !== tools) {
              log.debug(
                `[llama-cpp] scenario-repair mutation-only tool surface: ${
                  requestTools
                    ?.map((tool) => chatCompletionToolName(tool))
                    .filter(Boolean)
                    .join(',') ?? 'none'
                }`,
              );
            }
          }
        }
        if (existingSourceEditTurn) {
          if (
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model edit mode:')
          ) {
            userMsg.content += EXISTING_SOURCE_EDIT_PROMPT_SUFFIX;
          }
          if (existingSourceRewriteFallback) {
            if (typeof userMsg.content === 'string') {
              userMsg.content = userMsg.content.replace(
                EXISTING_SOURCE_EDIT_PATCH_PROMPT_SUFFIX,
                '',
              );
              if (!userMsg.content.includes('[Local-model source rewrite fallback:')) {
                userMsg.content += SCENARIO_SOURCE_REWRITE_FALLBACK_PROMPT_SUFFIX;
              }
            }
            requestTools = writeFileOnlyTools(tools);
            if (requestTools !== tools) {
              log.debug(
                `[llama-cpp] existing-source-edit rewrite fallback tool surface: ${
                  requestTools
                    ?.map((tool) => chatCompletionToolName(tool))
                    .filter(Boolean)
                    .join(',') ?? 'none'
                }`,
              );
            }
          } else if (existingSourceEditReadOnlyCalls > 0) {
            if (
              typeof userMsg.content === 'string' &&
              !userMsg.content.includes('[Local-model patch mode:')
            ) {
              userMsg.content += EXISTING_SOURCE_EDIT_PATCH_PROMPT_SUFFIX;
            }
            requestTools = patchOnlyExistingSourceEditTools(tools);
            if (requestTools !== tools) {
              log.debug(
                `[llama-cpp] existing-source-edit patch-only tool surface after read: ${
                  requestTools
                    ?.map((tool) => chatCompletionToolName(tool))
                    .filter(Boolean)
                    .join(',') ?? 'none'
                }`,
              );
            }
          }
          const currentMax =
            typeof body.max_tokens === 'number' ? body.max_tokens : Number.POSITIVE_INFINITY;
          body.max_tokens = Math.min(currentMax, EXISTING_SOURCE_EDIT_MAX_TOKENS);
          body.temperature = 0.2;
          body.top_p = 0.8;
          if (useGemmaExistingSourceEditToolGrammarFallback) {
            delete body.tool_choice;
          } else {
            body.tool_choice = 'required';
            disableThinkingForConstrainedTurn(
              body,
              this.deps.disableThinkingRequestShape,
              this.deps.model,
            );
          }
          log.debug(
            `[llama-cpp] existing-source-edit mode: direct edit surface, ${
              useGemmaExistingSourceEditToolGrammarFallback
                ? 'Gemma grammar fallback active'
                : 'thinking disabled'
            }, max_tokens=${body.max_tokens}`,
          );
        }
        if (gateSurgicalEditTurn) {
          // First-move mode: no read precondition — the failing content is
          // in-context from the attempt the gate just rejected, and the
          // whitespace-flexible edit matcher tolerates sloppy `find`
          // reproduction. A missed patch falls through to the gate's
          // re-reject and the ladder's stage 2 (immediate-write rewrite) —
          // no corrective machinery of its own.
          if (
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model gate patch mode:')
          ) {
            userMsg.content += GATE_SURGICAL_EDIT_PROMPT_SUFFIX;
          }
          requestTools = patchOnlyExistingSourceEditTools(tools);
          const currentMax =
            typeof body.max_tokens === 'number' ? body.max_tokens : Number.POSITIVE_INFINITY;
          body.max_tokens = Math.min(currentMax, GATE_SURGICAL_EDIT_MAX_TOKENS);
          body.temperature = 0.2;
          body.top_p = 0.8;
          if (useGemmaRepairToolGrammarFallback) {
            delete body.tool_choice;
          } else {
            body.tool_choice = 'required';
            disableThinkingForConstrainedTurn(
              body,
              this.deps.disableThinkingRequestShape,
              this.deps.model,
            );
          }
          log.debug(
            `[llama-cpp] gate-surgical-edit mode: patch-only surface ${
              requestTools
                ?.map((tool) => chatCompletionToolName(tool))
                .filter(Boolean)
                .join(',') ?? 'none'
            }, ${
              useGemmaRepairToolGrammarFallback
                ? 'Gemma grammar fallback active'
                : 'thinking disabled'
            }, max_tokens=${body.max_tokens}`,
          );
        }
        if (missingFileCreatePath) {
          if (
            typeof userMsg.content === 'string' &&
            !userMsg.content.includes('[Local-model missing-file recovery:')
          ) {
            userMsg.content += buildMissingFileCreateNudge(missingFileCreatePath);
          }
          requestTools = writeFileOnlyTools(tools);
          body.tool_choice = 'required';
          disableThinkingForConstrainedTurn(
            body,
            this.deps.disableThinkingRequestShape,
            this.deps.model,
          );
          log.debug(
            `[llama-cpp] missing-file recovery: write_file-only path=${missingFileCreatePath}`,
          );
        }
        if (
          requestTools &&
          requestTools.length > 0 &&
          (immediateFileWriteTurn ||
            directFileWorkTurn ||
            scenarioFileRepairTurn ||
            existingSourceEditTurn ||
            gateSurgicalEditTurn)
        ) {
          const constrainedWriteFileTarget: string | null =
            missingFileCreatePath ??
            immediateFileWriteTarget ??
            directFileWorkRejectedWritePath ??
            scenarioRepairWriteTarget ??
            existingSourceEditWriteTarget ??
            (directFileWorkScriptHelperMode && !directFileWorkScriptHelperWritten
              ? DIRECT_FILE_WORK_SCRIPT_HELPER_PATH
              : directFileWorkTurn && shouldAllowScriptedDirectFileWork(prompt)
                ? null
                : directFileWorkTarget);
          const constrainedRunNodeScriptTarget =
            directFileWorkScriptHelperMode && directFileWorkScriptHelperWritten
              ? DIRECT_FILE_WORK_SCRIPT_HELPER_PATH
              : null;
          requestTools = compactToolsForConstrainedLocalTurn(requestTools, {
            writeFileTargetPath: constrainedWriteFileTarget,
            fileMutationTargetPath:
              scenarioRepairWriteTarget ?? existingSourceEditWriteTarget ?? directFileWorkTarget,
            runNodeScriptTargetPath: constrainedRunNodeScriptTarget,
            readFileTargetPaths: prerequisiteRepairReadsPending
              ? remainingPrerequisiteReadPaths
              : directFileWorkPrerequisiteReadsPending
                ? remainingDirectFileWorkPrerequisiteReadPaths
                : sourceRewriteRefreshReadPending && scenarioRepairWriteTarget
                  ? [scenarioRepairWriteTarget]
                  : null,
          });
        }
        if (requestTools && requestTools.length > 0) body.tools = requestTools;
        // Write-continuation: surface append_to_file so the model can
        // finish a truncated file by appending its tail (base surface is
        // write_file-only). Only active after an immediate-write truncation.
        if (writeContinuationActive && Array.isArray(body.tools)) {
          if (!body.tools.some((t) => chatCompletionToolName(t) === 'append_to_file')) {
            body.tools = [...body.tools, APPEND_TO_FILE_CONTINUATION_TOOL];
          }
        }
        if (toolGrammarFallback !== 'none' && Array.isArray(body.tools)) {
          body.tools = applyToolGrammarFallback(
            body.tools as ChatCompletionTool[],
            toolGrammarFallback,
          );
        }
        // llama-server accepts the string choices `auto`, `none`, and
        // `required`. Its OpenAI-compatible endpoint currently rejects the
        // named-object form, even when the constrained surface has one tool.
        // Keep `required` as a string; the compact one-tool surface already
        // determines which function can be called.
        // Cache reuse extras come from the engine's cache adapter (Phase
        // 1+). Without an adapter (no controller wired, e.g. in tests),
        // fall back to the unconditional `cache_prompt: true` we shipped
        // in Phase 0 so the no-controller path keeps benefiting from
        // llama-server's slot reuse without explicit slot pinning.
        // `prepareForSend` is async so disk-restore (Phase 1.2/1.3) can
        // run before the slot is pinned in the request body — without
        // it the slot would be empty on first restore-and-go scenarios.
        const adapter = this.deps.provider.getCacheAdapter();
        const sessionId = opts?.queue?.sessionId;
        if (adapter && sessionId) {
          await adapter.prepareForSend(
            sessionId,
            this.deps.systemMessage,
            this.deps.systemPromptLayers,
          );
          Object.assign(body, adapter.buildRequestExtras(sessionId));
        } else {
          body.cache_prompt = true;
        }

        const ctrl = new AbortController();
        // `abortKind` distinguishes the abort cause so the error
        // message can reflect what actually happened — idle vs hard
        // wallclock vs external user-cancel. Mirrors Ollama's same-
        // named field; see Ollama for the full design notes.
        //
        // `'post-reasoning-silent'` covers the case where the engine
        // emits `reasoning-budget: deactivated (natural end)` and then
        // produces zero further visible tokens. The default 5-min
        // `streamingIdleMs` watchdog catches this too, but slowly;
        // the post-reasoning detector aborts in ~30s for a faster
        // recovery loop. See the watchdog setup further below.
        let abortKind:
          | 'idle'
          | 'hard'
          | 'external'
          | 'post-reasoning-silent'
          | 'post-reasoning-runaway'
          | null = null;
        let idlePhase: 'pre-first-byte' | 'streaming' = 'pre-first-byte';
        const externalSignal = opts?.queue?.signal;
        const onExternalAbort = () => {
          abortKind = 'external';
          ctrl.abort();
        };
        if (externalSignal) {
          if (externalSignal.aborted) onExternalAbort();
          else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
        // Wallclock-based deadline poll. `setTimeout(remaining)` pauses
        // when macOS suspends the process during sleep, so a turn
        // started just before sleep effectively re-anchors its
        // timeout to wake time. setInterval also pauses, but the
        // first post-wake tick sees `Date.now() >= deadline` and
        // aborts within the poll period — drift bounded by the 2 s
        // interval, not the sleep duration.
        const hardTimer = setInterval(() => {
          if (Date.now() < deadline) return;
          abortKind = 'hard';
          ctrl.abort();
          clearInterval(hardTimer);
        }, 2_000);
        // Idle-stream watchdog. Without this, a wedged llama-server
        // (model stalled mid-generation, KV-cache eviction, GPU
        // pressure, or — the case in one captured transcript — a 500 from a
        // truncated tool-call JSON that left the runtime's
        // `await sendAndWait` pending) would keep the engine pill at
        // "Preparing" indefinitely with no `done` event. Reset on
        // every chunk via `resetIdle()` below.
        //
        // "Is the wire alive" and "which budget applies" are DIFFERENT
        // questions, and conflating them false-kills long prefills.
        // llama-server emits framing pulses before it has decoded
        // anything; those prove the server hasn't wedged (so they must
        // rearm the timer) but they do NOT mean generation started. The
        // budget therefore keys off `generationStarted` — set only when a
        // content / reasoning / tool-call delta actually arrives — so a
        // still-prefilling turn keeps the generous `preFirstByteIdleMs`
        // (600s, explicitly sized for KV-cold prefill) instead of the
        // between-tokens `streamingIdleMs`. The old code flipped to the
        // streaming budget on the first pulse of any kind, which is only
        // safe while streaming is the more generous of the two — false
        // whenever an operator or the eval harness tightens it
        // (`GEZEL_LLAMA_CPP_STREAMING_IDLE_MS=120000` in evals/src/spawn.ts).
        // Wild-caught in the 2026-07-25 craftbook matrix: 57 aborts across
        // 13 trials, every one reporting "0 chars in 120s", every one on a
        // long repair-loop prompt, and all 13 trials lost.
        // The tight streaming budget earns its keep ONLY when there is
        // buffered visible content to salvage: the idle abort commits that
        // buffer as the assistant turn (see the `turnContent.length > 0`
        // salvage branch), which is why the eval harness tightens it — to
        // fire before its own retry-loop kills the trial. A turn that has
        // streamed only PRIVATE REASONING has nothing to commit, so an
        // early abort is pure loss: it destroys a turn the model was still
        // working on. Such a turn is budgeted like prefill — "the model has
        // produced nothing usable yet" is one concept, whether it is still
        // reading the prompt or still thinking. The hard per-turn timeout
        // remains the backstop for a genuinely wedged engine.
        //
        // Measured: 3 books that failed 0/3 with 15 idle aborts under the
        // 120s streaming budget passed 3/3 with zero aborts at 300s; every
        // one of those aborts had `received 0 chars` — reasoning-only turns.
        const { streamingIdleMs, preFirstByteIdleMs } = this.deps;
        let generationStarted = false;
        let sawVisibleContent = false;
        let idleTimer = setTimeout(() => {
          abortKind = 'idle';
          ctrl.abort();
        }, preFirstByteIdleMs);
        let firstByteAt: number | null = null;
        let lastChunkAt: number | null = null;
        // Post-reasoning silent-stall watchdog. Armed by the provider's
        // stdout pipeline when llama-server emits `reasoning-budget:
        // deactivated (natural end)`. If no visible content chunk
        // arrives within 30s of arming, fires `ctrl.abort()` with a
        // distinct `abortKind` so the error message + recovery path
        // can react specifically to "model finished thinking but
        // produced no output." Cleared when a content chunk arrives
        // (sets `postReasoningArmed = false` in the chunk handler) and
        // in `cleanupTurn`. Wild-caught squisq-review.
        const POST_REASONING_WATCHDOG_MS = this.deps.postReasoningWatchdogMs;
        // Absolute ceiling on a continuous *reasoning-only* streak after
        // the model has already signalled it finished thinking. A model
        // that keeps emitting `reasoning_content` is alive (not wedged),
        // so each reasoning chunk refreshes the 30s idle budget below —
        // but a model that ruminates past this ceiling without ever
        // producing visible content or a tool call is genuinely stuck.
        // Abort then, with an accurate `post-reasoning-runaway` message,
        // instead of either false-killing a live engine at 30s or
        // waiting out the 5-min streaming-idle. Wild-caught:
        // gemma4-12b ended thinking early, streamed 994 reasoning tokens
        // on `reasoning_content` (invisible to content/tool path), and
        // the 30s watchdog killed a turn that was still generating.
        const POST_REASONING_REASONING_CAP_MS = 120_000;
        let postReasoningTimer: NodeJS.Timeout | null = null;
        // Once reasoning ends, stay armed for the rest of the turn —
        // re-armed on every chunk so "model emitted one token then
        // went silent" is caught at 30s instead of waiting for the
        // 5-min streaming-idle. Wild-caught petshop
        // validation matrix: reasoning ended, 1 chunk arrived
        // (canceled the one-shot version of this watchdog), then 5
        // min of silence. With re-arming, the watchdog fires 30s
        // after the LAST chunk instead.
        let postReasoningActive = false;
        // When the current post-reasoning window opened, or was last
        // reset by a real content / tool-call delta. The reasoning-only
        // streak is measured from here against the cap above, so a
        // healthy think→act→think pattern isn't penalised by an earlier
        // reasoning stretch.
        let postReasoningWindowStartedAt = 0;
        // Chars of private reasoning streamed AFTER the model signalled
        // it was done thinking. Surfaced in the stall diagnostics so the
        // failure reads "ruminated N chars off-channel" rather than the
        // old misleading "0 chars / context full" guess.
        let postReasoningReasoningChars = 0;
        // Last KV-cache size (tokens) the liveness probe observed for the
        // current 30s window. The engine grows its cache by one token per
        // decode step, so a rising count means it's actively generating.
        let lastDecodeProgressTokens: number | null = null;
        // KV-cache liveness probe. `peg-gemma4` (and any format that parses
        // the model's NATIVE tool-call tokens server-side) BUFFERS a tool
        // call instead of streaming its arguments — llama-server emits no
        // SSE delta of any kind until the whole call parses, so a large
        // `write_file` is indistinguishable from a wedged engine to a
        // delta-based watchdog. Wild-caught: gemma4-12b decoded
        // 999 tokens of a buffered write_file with zero deltas and the 30s
        // watchdog killed it mid-generation. Before declaring a silent
        // stall, ask the engine whether its KV cache is still growing; if
        // it is, the model is alive and mid-tool-call — re-arm instead of
        // aborting. Best-effort: a null probe (no /slots, parse failure)
        // falls through to the original abort so a real wedge never hangs.
        const probeEngineDecodeProgress = async (): Promise<number | null> => {
          try {
            const r = await this.deps.fetchImpl(`${baseUrl}/slots`, {
              headers: { Accept: 'application/json' },
            });
            if (!r.ok) return null;
            const slots: unknown = await r.json();
            if (!Array.isArray(slots)) return null;
            let maxTokens = -1;
            for (const s of slots) {
              const n = (s as { n_cache_tokens?: unknown }).n_cache_tokens;
              if (typeof n === 'number' && n > maxTokens) maxTokens = n;
            }
            return maxTokens >= 0 ? maxTokens : null;
          } catch {
            return null;
          }
        };
        const armPostReasoningWatchdog = () => {
          if (postReasoningTimer) clearTimeout(postReasoningTimer);
          if (!postReasoningActive) {
            postReasoningWindowStartedAt = Date.now();
            // Fresh post-reasoning window for this engine call — capture a
            // cache baseline so the first fire can tell "decoded during the
            // window" from "wedged." Runs once per call (refresh re-arms
            // with `postReasoningActive` already true, skipping this), so
            // it never spams /slots. If the probe fails the baseline stays
            // null and the first fire grants one extra window before any
            // abort.
            lastDecodeProgressTokens = null;
            void probeEngineDecodeProgress().then((n) => {
              if (n !== null && lastDecodeProgressTokens === null) lastDecodeProgressTokens = n;
            });
          }
          postReasoningActive = true;
          postReasoningTimer = setTimeout(() => {
            postReasoningTimer = null;
            void (async () => {
              const tokensNow = await probeEngineDecodeProgress();
              // Stale fire: while we awaited the probe, a delta re-armed a
              // fresh timer, the turn aborted, or cleanup ran. Drop it.
              if (!postReasoningActive || postReasoningTimer !== null || ctrl.signal.aborted) {
                return;
              }
              const baseline = lastDecodeProgressTokens;
              const engineStillDecoding =
                tokensNow !== null && (baseline === null || tokensNow > baseline);
              if (engineStillDecoding) {
                if (baseline !== null) {
                  log.info(
                    `[llama-cpp] post-reasoning watchdog: engine still decoding (KV cache ${baseline}→${tokensNow} tok) — buffered output, re-arming instead of aborting`,
                  );
                }
                lastDecodeProgressTokens = tokensNow;
                armPostReasoningWatchdog();
                return;
              }
              // No measurable decode progress (or probe unavailable) — the
              // engine really did go silent. Abort as before.
              postReasoningActive = false;
              log.warn(
                '[llama-cpp] post-reasoning watchdog FIRING — calling ctrl.abort() (abortKind=post-reasoning-silent)',
              );
              abortKind = 'post-reasoning-silent';
              ctrl.abort();
            })();
          }, POST_REASONING_WATCHDOG_MS);
        };
        const cancelPostReasoningWatchdog = () => {
          if (postReasoningTimer) {
            clearTimeout(postReasoningTimer);
            postReasoningTimer = null;
          }
          postReasoningActive = false;
        };
        // Re-arm rather than cancel when a *visible* chunk (content or
        // tool-call) arrives during the post-reasoning window — keeps the
        // tight 30s budget active until the next chunk or the turn ends,
        // and resets the reasoning-streak window since the model just
        // produced real output. Outside the window (e.g. before reasoning
        // ever fires), this is a no-op.
        const refreshPostReasoningWatchdog = () => {
          if (!postReasoningActive) return;
          postReasoningWindowStartedAt = Date.now();
          armPostReasoningWatchdog();
        };
        // A `reasoning_content` chunk arrived after reasoning ended. The
        // engine is alive, so refresh the 30s idle budget — but enforce
        // the absolute reasoning-streak ceiling so genuine "thinks itself
        // into silence" runaway still aborts (with a distinct abortKind).
        const refreshPostReasoningWatchdogOnReasoning = () => {
          if (!postReasoningActive) return;
          if (Date.now() - postReasoningWindowStartedAt >= POST_REASONING_REASONING_CAP_MS) {
            log.warn(
              '[llama-cpp] post-reasoning watchdog FIRING — reasoning-only streak exceeded cap (abortKind=post-reasoning-runaway)',
            );
            abortKind = 'post-reasoning-runaway';
            cancelPostReasoningWatchdog();
            ctrl.abort();
            return;
          }
          armPostReasoningWatchdog();
        };
        // Install the active-turn handle so the provider's
        // `notifyReasoningEnded()` (called from `onStdoutLine`) can
        // arm this watchdog. Cleared in `cleanupTurn` so a subsequent
        // tool-loop iteration installs its own fresh handle.
        this.activeTurnHandle = {
          onReasoningEnded: armPostReasoningWatchdog,
        };
        // Throttle supervisor.markUsed() to once per minute. Without this,
        // a long single-turn generation (10+ min of token streaming) trips
        // the supervisor's idle-stop timer mid-stream — the supervisor only
        // knows "activity" via turn-boundary markUsed() calls, so a quiet
        // request envelope with a noisy body looks idle to it. Throttling
        // avoids re-arming the timer on every chunk while still keeping
        // the supervisor's "is anything happening?" view accurate.
        // Citation: tankcombat trial — 1.7 MB streamed, 10-min
        // idle timeout killed the engine, empty assistant message persisted.
        const MARK_USED_THROTTLE_MS = 60_000;
        let lastMarkUsedAt = Date.now();
        // Stream-active heartbeat: log once every 5s while chunks are
        // flowing so external watchers (the eval harness's daemon-log
        // scanner) have a "model is still emitting tokens" signal.
        // Without this, a pure-text-generation phase (no tool calls, no
        // commits, no workspace writes) is invisible to the eval-level
        // no-progress watchdog and gets false-killed at 5 min while the
        // engine is actively producing thousands of tokens. Wild-caught
        // squisq-review-12-35-55-aaen: 3,416 chunks streamed
        // over 10 min, fingerprint stuck because tools+commits+workspace
        // all flat. Cost: ~12 log lines per minute during streaming, ~zero
        // when idle.
        const STREAM_PULSE_INTERVAL_MS = 5_000;
        let lastStreamPulseAt = Date.now();
        let chunksSincePulse = 0;
        let totalChunksThisTurn = 0;
        const resetIdle = () => {
          const now = Date.now();
          if (firstByteAt === null) firstByteAt = now;
          lastChunkAt = now;
          if (now - lastMarkUsedAt >= MARK_USED_THROTTLE_MS) {
            this.deps.markUsed();
            lastMarkUsedAt = now;
          }
          clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => {
              abortKind = 'idle';
              ctrl.abort();
            },
            // Tight budget only once there is something salvageable.
            generationStarted && sawVisibleContent ? streamingIdleMs : preFirstByteIdleMs,
          );
        };
        /**
         * Promote the turn out of prefill: the model has emitted a real
         * token (visible content, private reasoning, or a tool-call
         * fragment), so the between-tokens budget now applies. Rearms
         * immediately so the tighter budget takes effect on this chunk
         * rather than one chunk late.
         */
        const markGenerationStarted = () => {
          if (generationStarted) return;
          generationStarted = true;
          idlePhase = 'streaming';
          resetIdle();
        };
        let constrainedToolSignalTimer: NodeJS.Timeout | null = null;
        let constrainedToolSignalAborted = false;
        let constrainedToolNoSignalChunks = 0;
        let constrainedToolReasoningChars = 0;
        const constrainedToolReasoningCharLimit = constrainedToolReasoningCharLimitForModel(
          this.deps.model,
        );
        let sawStructuredToolSignal = false;
        const abortConstrainedToolNoSignal = (trigger: string) => {
          if (
            !constrainedToolSignalMode ||
            sawStructuredToolSignal ||
            constrainedToolSignalAborted ||
            ctrl.signal.aborted
          ) {
            return;
          }
          constrainedToolSignalAborted = true;
          if (constrainedToolSignalTimer) {
            clearTimeout(constrainedToolSignalTimer);
            constrainedToolSignalTimer = null;
          }
          log.warn(
            `[llama-cpp] ABORT-FIRED reason=${constrainedToolSignalMode}-no-tool-signal ` +
              `(${trigger}, noSignalChunks=${constrainedToolNoSignalChunks}, reasoningChars=${constrainedToolReasoningChars}) afterMs=${Date.now() - start}`,
          );
          ctrl.abort();
        };
        const armConstrainedToolSignalTimer = () => {
          if (
            !constrainedToolSignalMode ||
            constrainedToolSignalTimer ||
            sawStructuredToolSignal ||
            this.deps.constrainedToolNoSignalMs <= 0
          ) {
            return;
          }
          constrainedToolSignalTimer = setTimeout(() => {
            abortConstrainedToolNoSignal(`wallMs=${this.deps.constrainedToolNoSignalMs}`);
          }, this.deps.constrainedToolNoSignalMs);
        };
        const cleanupTurn = () => {
          clearInterval(hardTimer);
          clearTimeout(idleTimer);
          if (constrainedToolSignalTimer) {
            clearTimeout(constrainedToolSignalTimer);
            constrainedToolSignalTimer = null;
          }
          cancelPostReasoningWatchdog();
          releaseGpuLeaseOnce();
          releaseEngineRequestOnce();
          // Clear so a subsequent iteration installs its own handle.
          // Stdout signals after this point have no in-flight turn to
          // affect, which is the correct semantic — `notifyReasoningEnded`
          // no-ops when `activeTurnHandle` is null.
          this.activeTurnHandle = null;
          externalSignal?.removeEventListener('abort', onExternalAbort);
        };

        let res: Response;
        const requestStartedAt = Date.now();
        try {
          res = await this.deps.fetchImpl(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withWireMessages(body)),
            signal: ctrl.signal,
          });
        } catch (err) {
          cleanupTurn();
          this.deps.markUsed();
          if ((err as Error).name !== 'AbortError') {
            const nativeExit = await this.deps.waitForNativeEngineExit?.(requestStartedAt);
            if (nativeExit) throw new NativeEngineCrashedError(nativeExit, err);
          }
          if ((err as Error).name === 'AbortError') {
            if (abortKind === 'external' || externalSignal?.aborted) {
              throw new Error('[llama-cpp] turn cancelled by caller');
            }
            if (
              constrainedToolSignalAborted &&
              constrainedToolSignalMode === 'direct-file-work' &&
              directFileWorkTurn &&
              !directFileWorkMutationSucceeded &&
              !askedQuestionThisTurn
            ) {
              pushDirectFileWorkNoMutationCorrective();
              continue;
            }
            if (
              constrainedToolSignalAborted &&
              constrainedToolSignalMode === 'immediate-write' &&
              immediateFileWriteTurn &&
              !askedQuestionThisTurn
            ) {
              pushImmediateFileWriteNoMutationCorrective();
              continue;
            }
            if (abortKind === 'idle') {
              // Pre-first-byte vs streaming-idle messages mirror Ollama
              // so the user sees consistent diagnostics across local
              // engines. Bracketed in `[llama-cpp]` so log search
              // narrows fast when triaging hung turns.
              if (idlePhase === 'pre-first-byte') {
                throw new Error(
                  `[llama-cpp] no generated tokens after ${Math.round(preFirstByteIdleMs / 1000)}s; aborting (model likely still loading, or prompt prefill never finished${firstByteAt !== null ? ' — the wire was alive, but only framing pulses arrived' : ''}). Try retrying with a shorter prompt; if it persists, the engine may need a restart.`,
                );
              }
              const sinceFirstByte =
                firstByteAt !== null ? Math.round((Date.now() - firstByteAt) / 1000) : null;
              const sinceLastChunk =
                lastChunkAt !== null ? Math.round((Date.now() - lastChunkAt) / 1000) : null;
              const stats =
                sinceFirstByte !== null && sinceLastChunk !== null
                  ? `received ${fullText.length} chars in ${sinceFirstByte}s before going silent for ${sinceLastChunk}s`
                  : `received ${fullText.length} chars before stalling`;
              throw new Error(
                `[llama-cpp] no output for ${Math.round(streamingIdleMs / 1000)}s mid-stream; aborting (${stats}).`,
              );
            }
            throw new Error(`[llama-cpp] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
          }
          throw new Error(
            `[llama-cpp] /v1/chat/completions unreachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (!res.ok || !res.body) {
          cleanupTurn();
          this.deps.markUsed();
          const txt = await res.text().catch(() => '');
          const failedGrammarTools = Array.isArray(body.tools)
            ? (body.tools as ChatCompletionTool[])
            : [];
          if (failedGrammarTools.length > 0 && isLlamaCppGrammarParseError(txt)) {
            if (toolGrammarFallback === 'none') {
              if (hasJsonSchemaPatternsForLlamaCpp(failedGrammarTools)) {
                toolGrammarFallback = 'strip-patterns';
                log.warn(
                  '[llama-cpp] tool grammar rejected by server; retrying without JSON Schema pattern constraints',
                );
              } else {
                toolGrammarFallback = 'simplified';
                log.warn(
                  '[llama-cpp] tool grammar rejected by server; no pattern constraints to remove, retrying with structural tool schemas',
                );
              }
              continue;
            }
            if (toolGrammarFallback === 'strip-patterns') {
              toolGrammarFallback = 'simplified';
              log.warn(
                '[llama-cpp] pattern-free tool grammar still rejected; retrying with structural tool schemas',
              );
              continue;
            }
            if (toolGrammarFallback === 'simplified') {
              toolGrammarFallback = 'permissive';
              log.warn(
                '[llama-cpp] structural tool grammar still rejected; retrying with permissive object parameters',
              );
              continue;
            }
          }
          if (
            tryParseStrictAlternationTemplateError(txt) &&
            !this.flattenToolMessagesForStrictAlternation
          ) {
            this.flattenToolMessagesForStrictAlternation = true;
            log.warn(
              '[llama-cpp] chat template rejected tool-role transcript; retrying with flattened tool results',
            );
            continue;
          }
          // Single-system-message templates (Qwen 3.x) reject the volatile
          // band's second system turn with a `raise_exception("System
          // message must be at the beginning...")` 500. Mirror the
          // strict-alternation recovery: collapse system turns into one
          // leading message and retry within this runSend so the turn
          // never poisons the session.
          if (tryParseSystemMessageOrderingError(txt) && !this.mergeSystemMessages) {
            this.mergeSystemMessages = true;
            log.warn(
              '[llama-cpp] chat template rejected a non-leading system message; retrying with merged system message',
            );
            continue;
          }
          // Recognize the context-overflow error upstream returns as
          // `{"error":{"code":400,"type":"exceed_context_size_error",
          // "n_prompt_tokens":N,"n_ctx":M}}` and surface it as a
          // clean actionable message instead of the raw JSON. This
          // is the last-resort fallback after Layers 1 & 2 — the
          // adaptive tool cap should keep us from getting here in
          // normal tool flows, but a giant user message or
          // reasoning-heavy history can still overshoot.
          const overflow = tryParseContextOverflow(txt);
          if (overflow) {
            // Reactive recovery (option B) — mirror the toolParseFail
            // path below. When compaction is wired and hasn't fired
            // this turn, fold the prior transcript into one synthesis
            // and retry; the next iteration's request runs with a
            // shorter prompt and the model gets a fresh chance to
            // fit. Without this branch, multi-gezel scenarios where
            // the session history grows beyond numCtx (observed in
            // the petshop eval at 84k vs 65k) bubble the
            // overflow to ChatManager and the orchestration loop
            // never recovers.
            const recovered = await this.maybeCompactMidLoop({ force: true });
            if (recovered) continue;
            // Tier 2: the prior transcript had nothing foldable (a long
            // tool loop inside ONE turn is the common shape), so shrink
            // this turn's own older tool results instead. This is the
            // only layer that can see them — see condenseInTurnToolResults.
            if (this.condenseInTurnToolResults() > 0) continue;
            const err = new Error(
              `On-device model ran out of working memory: ${overflow.promptTokens.toLocaleString('en-US')} tokens needed but only ${overflow.nCtx.toLocaleString('en-US')} available. Try asking a narrower question, or ask me to search for a specific piece of info rather than fetching a whole page.`,
            );
            (err as Error & { isActionable: boolean }).isActionable = true;
            // Machine-readable marker: ChatManager's send loop catches this
            // code, force-compacts the session, and retries the turn once.
            (err as Error & { code: string }).code = 'context-overflow';
            throw err;
          }
          // Recognize llama-server's tool-call JSON parser failure.
          // When the model gets squeezed for context mid-tool-call,
          // its args get cut off mid-string ("Generate 2-3 new) and
          // llama-server's strict JSON parser throws a 500. Without
          // this branch the 500 bubbles up as a fatal session error
          // and the user loses their chat thread.
          //
          // Two-tier recovery:
          //   1. Reactive compaction (option B). If compaction hasn't
          //      already fired this turn AND the manager wired a
          //      `requestCompaction` callback, force-compact the prior
          //      history and `continue` the tool loop. The next
          //      iteration's request runs with a shorter transcript;
          //      the model has a fresh chance to emit a tool call
          //      that fits. Bounded to one compaction per turn (the
          //      `compactedThisTurn` flag inside maybeCompactMidLoop)
          //      so we can't loop forever on a synthesis that itself
          //      doesn't free enough room.
          //   2. Fall-through warning. Compaction unavailable, already
          //      used this turn, or didn't help → emit an actionable
          //      message and end the turn cleanly. The user can retry;
          //      raising `config.llamaCppNumCtx` is the durable fix.
          const toolParseFail = tryParseToolCallParseError(txt);
          if (toolParseFail) {
            const recovered = await this.maybeCompactMidLoop({ force: true });
            if (recovered) {
              // Don't push anything — the model's truncated output
              // was already discarded by llama-server. The for-loop
              // increment-and-continue retries the request with the
              // freshly compacted transcript.
              continue;
            }
            // Same second tier as the overflow branch: a mid-string
            // argument cut-off IS context pressure, and when the squeeze
            // came from this turn's own tool loop the prior-fold has
            // nothing to give.
            if (this.condenseInTurnToolResults() > 0) continue;
            this.emitWarning(
              'The on-device model started a tool call but its arguments got cut off mid-string before it could finish — usually means the prompt + history filled the context window. Try a shorter follow-up message, or raise `llamaCppNumCtx` in Settings → On-device → Advanced.',
            );
            if (fullText.length > 0) {
              this.messages.push({ role: 'assistant', content: fullText });
            }
            return fullText;
          }
          throw new Error(
            `[llama-cpp] /v1/chat/completions returned ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`,
          );
        }

        // Engine is up — the /v1/chat/completions response is open, so
        // we're past model-load and waiting for the first token. Only
        // emit `prefill` on the first tool-loop iteration; subsequent
        // iterations shouldn't downgrade "generating" back to "prefill".
        if (firstTokenAt === null) {
          this.emitEnginePhase({
            provider: 'llama-cpp',
            phase: 'prefill',
            detail: 'Thinking it through',
          });
        }

        let turnContent = '';
        // Verbatim `reasoning_content` bytes for THIS tool-loop iteration.
        // Committed onto the assistant message when the provider replays
        // reasoning (ds4) — see {@link ChatMessage.reasoning_content}.
        let turnReasoning = '';
        // Usage for THIS tool-loop iteration. `lastUsage` intentionally
        // remains turn-scoped for final telemetry, but truncation recovery
        // must compare the current request's completion count with its own
        // max_tokens rather than accidentally reusing a prior iteration.
        let iterationUsage: { prompt_tokens: number; completion_tokens: number } | null = null;
        let finishReason: string | null = null;
        const toolCallAccumulator = new ToolCallAccumulator();
        // Code-block salvage accumulator. When the ramble detector
        // aborts with NO recognizable tool-call markup but the buffered
        // prose contains a fenced code block (the "Here's the file:
        // ```html …```" pattern small models drift into instead of
        // calling write_file), each block is promoted to a synthesized
        // write call. Declared outside the try/catch so the post-exit
        // toolCalls merge can include it. Mirrors MlxSession.
        let codeBlockRepaired: Array<{
          id: string;
          type: 'function';
          function: { name: string; arguments: string };
        }> = [];
        // Wall-of-prose detector. See MlxSession for the rationale.
        // `RambleDetector` measures prose-since-last-action (re-arms
        // after every tool-call signal); the boolean version this
        // replaced disarmed permanently on first markup and missed
        // the common "wrote one tool then rambled" pattern.
        // Profile-driven: opted in via `turn.ramble-detection`. Absent
        // → detector disabled.
        const rambleConfig = profileBehaviorConfig<TurnRambleDetectionConfig>(
          this.deps.profile,
          'turn.ramble-detection',
        );
        const ramble = rambleConfig
          ? new RambleDetector({
              threshold: rambleConfig.coldThreshold,
              postActionThreshold: rambleConfig.postActionThreshold,
              enabled: true,
              // Models that leak untagged reasoning narrate their plan
              // in the open before acting; give the cold cap room to
              // reach the tool call. Prefer the profile opt-in, but also
              // honor the model-id family signal so a verbose family whose
              // profile is missing `turn.preamble-folding` (config drift)
              // still gets the leaky budget instead of the tight 6k cap.
              leakyReasoning:
                profileHasBehavior(this.deps.profile, 'turn.preamble-folding') ||
                leaksUntaggedReasoning(this.deps.model),
            })
          : // No length-cap opt-in for this model, but the repetition
            // guard is safe to run on any local model (it fires only on
            // degenerate low-novelty loops, never on legitimate prose) —
            // it is the sole protection a non-verbose model like ds4 gets
            // against a runaway repetition loop. See RambleDetector.
            new RambleDetector({ threshold: 6000, enabled: false, repetitionGuardEnabled: true });
        let rambleAborted = false;
        // Tool name for the live tool-args channel — only the first
        // fragment of a streamed tool call carries `function.name`.
        let liveToolArgsName = '';
        let immediateWriteTextAborted = false;
        let scenarioRepairTextAborted = false;
        let existingSourceEditTextAborted = false;
        let immediateWriteStructuredAborted = false;
        const streamedFileWriteDebug = (): string => {
          const rawWriteArgs = toolCallAccumulator.rawArgumentsForTool('write_file');
          const argSuffix = rawWriteArgs === null ? '' : ` argChars=${rawWriteArgs.length}`;
          return ` chars=${turnContent.length}${argSuffix}`;
        };
        try {
          for await (const event of readSseEvents(res.body, { comments: true })) {
            // Reset the idle watchdog on every chunk — including bare
            // framing pulses with no delta content. The watchdog's
            // signal is "is the wire still alive"; any chunk arriving
            // proves llama-server hasn't wedged. The first reset also
            // flips `idlePhase` from 'pre-first-byte' to 'streaming'
            // so a subsequent silence trips the (typically more
            // generous) streaming budget rather than the cold-start
            // budget.
            resetIdle();
            if (event === '[DONE]') break;
            // SSE comment keepalives (`: prefill`) — ds4-server pings one
            // every ~5s while prompt processing runs, and on a 284B SSD-
            // streamed model prefill is minutes long with no data chunks
            // at all. Treat them like bare framing pulses: the wire is
            // alive, the engine is working. Without this the chat shows
            // "silent for 38s" over a perfectly healthy prefill.
            if (isSseComment(event)) {
              this.emitWirePulse();
              continue;
            }
            const chunk = event as ChatCompletionChunk;
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            const hasContent = Boolean(delta?.content);
            const hasToolCalls = Boolean(delta?.tool_calls && delta.tool_calls.length > 0);
            const reasoningChunk = delta?.reasoning_content ?? null;
            const hasReasoning = reasoningChunk !== null && reasoningChunk.length > 0;
            // TTFT means first model activity, not merely first user-visible
            // prose. Reasoning-only and structured-tool turns can spend the
            // entire generation without a `content` delta, so measuring only
            // there made those turns look permanently stuck and produced no
            // TTFT log at all.
            if ((hasContent || hasReasoning || hasToolCalls) && firstTokenAt === null) {
              firstTokenAt = Date.now();
              const ttft = firstTokenAt - start;
              log.info(`[llama-cpp] TTFT ${ttft}ms (session model=${this.deps.model})`);
              this.emitEnginePhase({
                provider: 'llama-cpp',
                phase: 'generating',
                detail: `First token in ${(ttft / 1000).toFixed(1)}s`,
                ttftMs: ttft,
              });
            }
            // Prompt evaluation and server-side queueing can legitimately be
            // much longer than the constrained-action budget. Start that
            // budget only once the model has actually begun decoding visible
            // or private reasoning. The separate pre-first-byte watchdog
            // continues to catch a genuinely wedged prefill.
            // Any real token ends prefill and hands the turn to the
            // between-tokens idle budget (see `markGenerationStarted`).
            if (hasContent || hasReasoning || hasToolCalls) {
              markGenerationStarted();
            }
            // ONLY visible content licenses the tight budget, because
            // `turnContent` is exactly what the idle-abort salvage branch
            // commits. Streaming tool-call ARGUMENTS look like progress but
            // land in the accumulator, not `turnContent` — promoting on them
            // re-creates the same unsalvageable early kill this rule exists
            // to prevent (wild-caught: form-fill-batch stalled 5× mid
            // immediate-write args, argChars=1178, turnContent=0). Wedged
            // tool-call streams stay covered by the constrained-tool
            // no-signal watchdog and the hard per-turn timeout.
            if (hasContent && !sawVisibleContent) {
              sawVisibleContent = true;
              resetIdle();
            }
            if (!hasToolCalls && (hasContent || hasReasoning)) {
              armConstrainedToolSignalTimer();
            }
            // Private-reasoning tokens arrive on a separate SSE field
            // (`reasoning_content`) that never feeds `turnContent` or the
            // tool-call accumulator. They still prove the engine is alive
            // and making progress, so refresh the post-reasoning watchdog
            // — but through the *bounded* path so a model that ruminates
            // forever after it claimed to be done still aborts at the
            // reasoning-streak cap. Without this, a verbose family that
            // re-enters thinking post-"done" (gemma4-12b)
            // gets its still-generating turn false-killed at 30s with the
            // misleading "0 chars / context full" stall. Track the volume
            // so the diagnostics can say what actually happened.
            if (hasReasoning) {
              refreshPostReasoningWatchdogOnReasoning();
              postReasoningReasoningChars += reasoningChunk.length;
              constrainedToolReasoningChars += reasoningChunk.length;
              turnReasoning += reasoningChunk;
              // Stream the think phase live on its own channel. It never
              // joins `turnContent` (the committed reply stays clean) — the
              // UI renders it as a distinct "thinking" block that collapses
              // into the message's reasoning expander once the turn commits.
              // This is also what keeps the silence timer alive during a
              // long hidden-reasoning stretch, so it never false-trips the
              // "looks stalled" banner.
              this.emitReasoningDelta(reasoningChunk);
            }
            // Any usable delta — visible content OR a tool-call —
            // refreshes the post-reasoning silent-stall watchdog
            // (re-arms the 30s timer). Once reasoning ends, the
            // watchdog stays armed until the turn ends or 30s pass
            // with no chunk; "model emitted one token then went
            // silent" is caught at 30s instead of waiting for the
            // 5-min streaming-idle.
            if (hasContent || hasToolCalls) {
              refreshPostReasoningWatchdog();
              chunksSincePulse += 1;
              totalChunksThisTurn += 1;
              const now = Date.now();
              if (now - lastStreamPulseAt >= STREAM_PULSE_INTERVAL_MS) {
                log.info(
                  `[llama-cpp] stream-active session=${opts?.queue?.sessionId?.slice(0, 8) ?? '?'} chunks=${chunksSincePulse}/total=${totalChunksThisTurn}${immediateFileWriteTurn || scenarioFileRepairTurn || existingSourceEditTurn ? streamedFileWriteDebug() : ''}`,
                );
                lastStreamPulseAt = now;
                chunksSincePulse = 0;
              }
            }
            if (hasContent) {
              turnContent += delta!.content!;
              this.emitDelta(delta!.content!);
              if (!rambleAborted && ramble.observeContent(turnContent)) {
                rambleAborted = true;
                log.error(
                  `[llama-cpp] ABORT-FIRED reason=ramble (${ramble.firedOnRepetition ? 'repetition-loop' : ramble.inPostActionMode ? 'post-action' : 'cold'}; ${ramble.proseSinceLastAction} chars since last signal, cap ${ramble.activeThreshold}) afterMs=${Date.now() - start}`,
                );
                ctrl.abort();
              }
              if (
                immediateFileWriteTurn &&
                !sawStructuredToolSignal &&
                !rambleAborted &&
                !immediateWriteTextAborted &&
                (hasSalvageableImmediateFileWriteContent(turnContent, prompt) ||
                  turnContent.length >= IMMEDIATE_FILE_WRITE_TEXT_ABORT_CHARS)
              ) {
                immediateWriteTextAborted = true;
                rambleAborted = true;
                log.error(
                  `[llama-cpp] ABORT-FIRED reason=immediate-write-text (${turnContent.length} chars without structured write_file) afterMs=${Date.now() - start}`,
                );
                ctrl.abort();
              }
              if (
                scenarioFileRepairTurn &&
                !sawStructuredToolSignal &&
                !rambleAborted &&
                !scenarioRepairTextAborted &&
                turnContent.length >=
                  scenarioRepairTextAbortThreshold(
                    turnContent,
                    explicitFullRewriteScenarioRepairTurn || sourceRewriteFallback,
                  )
              ) {
                scenarioRepairTextAborted = true;
                rambleAborted = true;
                log.error(
                  `[llama-cpp] ABORT-FIRED reason=scenario-repair-text (${turnContent.length} chars without structured repair tool) afterMs=${Date.now() - start}`,
                );
                ctrl.abort();
              }
              if (
                existingSourceEditTurn &&
                !sawStructuredToolSignal &&
                !rambleAborted &&
                !existingSourceEditTextAborted &&
                turnContent.length >=
                  scenarioRepairTextAbortThreshold(turnContent, existingSourceRewriteFallback)
              ) {
                existingSourceEditTextAborted = true;
                rambleAborted = true;
                log.error(
                  `[llama-cpp] ABORT-FIRED reason=existing-source-edit-text (${turnContent.length} chars without structured edit tool) afterMs=${Date.now() - start}`,
                );
                ctrl.abort();
              }
            }
            if (hasToolCalls) {
              sawStructuredToolSignal = true;
              if (constrainedToolSignalTimer) {
                clearTimeout(constrainedToolSignalTimer);
                constrainedToolSignalTimer = null;
              }
              // Tool-argument streaming emits no deltas, so without this
              // pulse a multi-minute write_file is invisible to the manager
              // (and looks stalled to the UI + stall watchdogs).
              this.emitWirePulse();
              ramble.recordStructuredAction(turnContent.length);
              for (const tc of delta!.tool_calls!) {
                toolCallAccumulator.ingest(tc);
                // Live tool-args channel: stream the argument fragments so
                // the UI can show *what* the model is writing during a long
                // structured call (see onToolArgsDelta). The name only
                // rides the first fragment of each call — remember it so
                // later argument-only fragments stay attributed.
                if (tc.function?.name) liveToolArgsName = tc.function.name;
                const argChunk = tc.function?.arguments ?? '';
                if (tc.function?.name || argChunk.length > 0) {
                  this.emitToolArgsDelta(liveToolArgsName, argChunk);
                }
              }
              if (
                immediateFileWriteTurn &&
                !immediateWriteStructuredAborted &&
                hasSalvageableImmediateStructuredWriteArgs(
                  toolCallAccumulator.rawArgumentsForTool('write_file') ?? '',
                )
              ) {
                immediateWriteStructuredAborted = true;
                log.error(
                  `[llama-cpp] ABORT-FIRED reason=immediate-write-structured (${toolCallAccumulator.rawArgumentsForTool('write_file')?.length ?? 0} arg chars) afterMs=${Date.now() - start}`,
                );
                ctrl.abort();
              }
            }
            if (chunk.usage) {
              // `timings` rides alongside `usage` when `timings_per_token` is
              // set; it is the only HTTP source of decode/prefill rate.
              const t = (chunk as { timings?: Record<string, unknown> }).timings;
              const extendedUsage = chunk.usage as typeof chunk.usage & {
                prompt_tps?: number;
                generation_tps?: number;
                cached_tokens?: number;
              };
              const perSec =
                typeof t?.predicted_per_second === 'number'
                  ? t.predicted_per_second
                  : extendedUsage.generation_tps;
              const promptPerSec =
                typeof t?.prompt_per_second === 'number'
                  ? t.prompt_per_second
                  : extendedUsage.prompt_tps;
              const cacheN =
                typeof t?.cache_n === 'number' ? t.cache_n : extendedUsage.cached_tokens;
              iterationUsage = {
                prompt_tokens: chunk.usage.prompt_tokens,
                completion_tokens: chunk.usage.completion_tokens,
                ...(perSec !== undefined && perSec > 0 ? { predicted_per_second: perSec } : {}),
                ...(promptPerSec !== undefined && promptPerSec > 0
                  ? { prompt_per_second: promptPerSec }
                  : {}),
                ...(cacheN !== undefined && cacheN > 0 ? { cache_n: cacheN } : {}),
              };
              lastUsage = iterationUsage;
            }
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            // Wire pulse: a genuinely bare framing chunk — no content, no
            // reasoning, no tool args, no usage. Matches Ollama's behavior
            // so the UI shows "engine alive but silent" dots. Reasoning
            // chunks are excluded (`!hasReasoning`): they carry real
            // progress and stream live via `emitReasoningDelta` above.
            if (!hasContent && !hasReasoning && !hasToolCalls && !chunk.usage) {
              this.emitWirePulse();
              // A reasoning chunk is NOT a bare framing chunk — it is the
              // model legitimately thinking (streamed live via
              // `emitReasoningDelta` above, which resets the UI silence
              // timer), and it is already bounded by
              // CONSTRAINED_TOOL_REASONING_CHAR_LIMIT. Counting it here
              // killed every Gemma grammar-fallback repair turn ~32
              // reasoning-chunks (~130 chars) into the think phase, long
              // before the model could emit its tool call — the turn then
              // failed "no-tool-signal" 2/2 and the handoff died.
              // Wild-caught core sweep (gemma4-e4b-q4:
              // schema-migration + symptom-debug, deterministic).
              if (constrainedToolSignalMode && !sawStructuredToolSignal) {
                constrainedToolNoSignalChunks += 1;
              }
            }
            if (
              constrainedToolSignalMode &&
              !sawStructuredToolSignal &&
              !constrainedToolSignalAborted &&
              (constrainedToolNoSignalChunks >= CONSTRAINED_TOOL_NO_SIGNAL_CHUNK_LIMIT ||
                constrainedToolReasoningChars >= constrainedToolReasoningCharLimit)
            ) {
              abortConstrainedToolNoSignal(
                constrainedToolNoSignalChunks >= CONSTRAINED_TOOL_NO_SIGNAL_CHUNK_LIMIT
                  ? `noSignalChunkLimit=${CONSTRAINED_TOOL_NO_SIGNAL_CHUNK_LIMIT}`
                  : `reasoningCharLimit=${constrainedToolReasoningCharLimit}`,
              );
            }
          }
        } catch (err) {
          cleanupTurn();
          this.deps.markUsed();
          if ((err as Error).name !== 'AbortError') {
            const nativeExit = await this.deps.waitForNativeEngineExit?.(requestStartedAt);
            if (nativeExit) throw new NativeEngineCrashedError(nativeExit, err);
          }
          // Recovery path: a `ramble` abort that has salvageable
          // tool-call markup falls through to the salvage block
          // below instead of throwing. See MlxSession for the
          // rationale — keeps the model's queued tools alive so
          // the next iteration sees results. `recoveredFromIdleStall`
          // is the parallel case for mid-stream silence — when the
          // idle watchdog fires AFTER the model has streamed real
          // content, throwing would discard the buffer; instead we
          // commit what arrived as the assistant turn with a warning
          // so the next orchestration loop sees the partial output.
          // Wild-caught squisq-review: 200+ chunks of
          // qwen3.6 output streamed then went silent, the existing
          // throw path discarded all of it, the session committed
          // zero assistant messages, and the eval harness's retry-loop
          // killed the trial 2m 45s later with no usable artifact.
          let recoveredFromRamble = false;
          let recoveredFromIdleStall = false;
          if ((err as Error).name === 'AbortError') {
            if (abortKind === 'external' || externalSignal?.aborted) {
              throw new Error('[llama-cpp] turn cancelled by caller');
            }
            if (constrainedToolSignalAborted) {
              finishReason ??= `${constrainedToolSignalMode ?? 'constrained'}-no-tool-signal`;
              recoveredFromRamble = true;
            } else if (immediateWriteStructuredAborted) {
              finishReason ??= 'immediate-write-structured-recovered';
              recoveredFromRamble = true;
            } else if (rambleAborted) {
              const hasSalvageableMarkup = /<tool_call>|<function=/i.test(turnContent);
              if (hasSalvageableMarkup) {
                this.emitWarning(
                  `Stopped the planning monologue (${turnContent.length} chars without follow-through) — firing the tool calls you queued. Take a smaller next step.`,
                );
                finishReason ??= 'ramble-recovered';
                recoveredFromRamble = true;
              } else {
                // Last-ditch salvage: small models often inline code in
                // fenced blocks instead of calling the write tool.
                // Promote each block to a synthesized write call. Prefer
                // `write_file` (salvaged source belongs in the workspace,
                // not the artifacts drawer — the abort copy itself says
                // so); fall back to `write_artifact` only when the role
                // has no workspace-write surface. Both take the same
                // `{path, content}` shape. Gate on the chosen tool being
                // wired so we never fabricate a call to a missing tool.
                // Shared with MlxSession.
                const knownToolNames = collectKnownToolNames();
                const salvageToolName = knownToolNames.has('write_file')
                  ? 'write_file'
                  : knownToolNames.has('write_artifact')
                    ? 'write_artifact'
                    : null;
                if (salvageToolName) {
                  const blocks = prepareSalvagedCodeBlocks(
                    turnContent,
                    this.deps.activeCraftbookStep?.deliverableFile,
                  );
                  if (blocks.length > 0) {
                    codeBlockRepaired = blocks.map((b, i) => ({
                      id: `code-salvage-${turn}-${i}`,
                      type: 'function' as const,
                      function: {
                        name: salvageToolName,
                        arguments: JSON.stringify({ path: b.filename, content: b.content }),
                      },
                    }));
                    log.info(
                      `[llama-cpp] code-block-salvage: extracted ${blocks.length} ` +
                        `fenced block(s) from ${turnContent.length}-char ramble buffer ` +
                        `→ ${salvageToolName} (${blocks.map((b) => `${b.lang}:${b.filename}`).join(', ')})`,
                    );
                    this.emitWarning(
                      `The model wrote ${blocks.length === 1 ? 'a code block' : `${blocks.length} code blocks`} in chat instead of calling ${salvageToolName} — promoting them to actual file writes. Ask the model to use tools directly next time.`,
                    );
                    finishReason ??= 'ramble-recovered';
                    recoveredFromRamble = true;
                  }
                }
                if (
                  !recoveredFromRamble &&
                  immediateFileWriteTurn &&
                  knownToolNames.has('write_file')
                ) {
                  const salvaged = salvageImmediateFileWriteArgs(turnContent, prompt);
                  if (salvaged) {
                    codeBlockRepaired = [
                      {
                        id: `immediate-write-salvage-${turn}`,
                        type: 'function',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify(salvaged),
                        },
                      },
                    ];
                    log.info(
                      `[llama-cpp] immediate-write-salvage: promoted ${turnContent.length}-char text buffer to write_file path=${salvaged.path} bytes=${salvaged.content.length}`,
                    );
                    this.emitWarning(
                      `The model wrote the file body in chat instead of calling write_file; promoting it to a workspace file at ${salvaged.path}.`,
                    );
                    finishReason ??= 'ramble-recovered';
                    recoveredFromRamble = true;
                  }
                }
                if (
                  !recoveredFromRamble &&
                  (scenarioFileRepairTurn || existingSourceEditTurn) &&
                  !askedQuestionThisTurn
                ) {
                  const modeLabel = scenarioFileRepairTurn
                    ? 'scenario-repair'
                    : 'existing-source-edit';
                  log.warn(
                    `[llama-cpp] ${modeLabel} ramble aborted after ${turnContent.length} chars; converting to no-mutation corrective instead of poisoning the session`,
                  );
                  finishReason ??= `${modeLabel}-ramble-nudged`;
                  recoveredFromRamble = true;
                }
                if (!recoveredFromRamble) {
                  throw new Error(
                    `[llama-cpp] aborting — the gezel emitted ${turnContent.length} characters of prose this turn without calling any action tool. Stop planning. Your next message must START with a single tool call — or, if the work is genuinely finished and nothing is left to do, be ONE short sentence saying so and nothing else. If shipping source or project files and \`write_file\` is in your tool list, call it NOW with the full file contents — no preamble, no plan. If you lack workspace write access, start with a handoff tool or \`ask_user_question\` instead. Do not save source files with \`write_artifact\`; artifacts are for plans/scratch.`,
                  );
                }
              }
            } else if (
              abortKind === 'post-reasoning-silent' ||
              abortKind === 'post-reasoning-runaway'
            ) {
              // Engine emitted `reasoning-budget: deactivated (natural
              // end)` and then either produced nothing for 30s
              // (`-silent`) or ruminated on `reasoning_content` past the
              // streak cap without acting (`-runaway`). Default
              // streaming-idle (5 min) would catch the silent case too,
              // but slowly. Throw an actionable message so the manager's
              // continuation path can re-prompt with "you finished
              // thinking but produced nothing — act now or write what you
              // have." Wild-caught squisq-review;
              // `reasoning_content` accounting was added later.
              //
              // Report MEASURED numbers instead of the old "context is
              // probably full" guess — that guess sent debuggers down the
              // wrong path on the gemma4-12b case where the prompt was
              // only ~12% of the window. `fillNote` states the real
              // context fill; `reasoningNote` states how much private
              // reasoning streamed off-channel before the abort.
              const ctxTokens = this.deps.numCtx;
              const promptTokens = lastUsage?.prompt_tokens;
              const fillNote =
                promptTokens && ctxTokens
                  ? ` Prompt was ${promptTokens} tok (~${Math.round(
                      (promptTokens / ctxTokens) * 100,
                    )}% of the ${ctxTokens}-tok window), so context was ${
                      promptTokens / ctxTokens >= 0.85 ? 'indeed near full' : 'NOT near full'
                    }.`
                  : '';
              const reasoningNote =
                postReasoningReasoningChars > 0
                  ? ` After signalling it was done thinking, the engine streamed ${postReasoningReasoningChars} more chars of private reasoning — it ruminated off-channel instead of emitting content or a tool call (raise the model's thinkingBudget or simplify the step).`
                  : '';
              if (abortKind === 'post-reasoning-runaway') {
                throw new Error(
                  `[llama-cpp] post-reasoning runaway — the model signalled it finished thinking, then kept emitting private reasoning for ${
                    POST_REASONING_REASONING_CAP_MS / 1000
                  }s without producing any visible content or tool call. Aborting so the orchestrator can re-prompt.${reasoningNote}${fillNote} Received ${turnContent.length} chars of visible content.`,
                );
              }
              throw new Error(
                `[llama-cpp] post-reasoning silent stall — the model finished its thinking phase but produced no visible content or tool call within ${POST_REASONING_WATCHDOG_MS / 1000}s. Aborting this turn so the orchestrator can re-prompt.${reasoningNote}${fillNote} Received ${turnContent.length} chars of visible content before the silence.`,
              );
            } else if (abortKind === 'idle') {
              // Same idle-abort branches as the fetch-level catch
              // above. The streaming body can also throw AbortError when
              // the watchdog fires after the fetch has already returned
              // — that's the case a captured transcript hit (fetch
              // returned 200 + a stream that went silent).
              if (idlePhase === 'pre-first-byte') {
                throw new Error(
                  `[llama-cpp] no generated tokens after ${Math.round(preFirstByteIdleMs / 1000)}s; aborting (model likely still loading, or prompt prefill never finished${firstByteAt !== null ? ' — the wire was alive, but only framing pulses arrived' : ''}). Try retrying with a shorter prompt; if it persists, the engine may need a restart.`,
                );
              }
              const sinceFirstByte =
                firstByteAt !== null ? Math.round((Date.now() - firstByteAt) / 1000) : null;
              const sinceLastChunk =
                lastChunkAt !== null ? Math.round((Date.now() - lastChunkAt) / 1000) : null;
              const stats =
                sinceFirstByte !== null && sinceLastChunk !== null
                  ? `received ${turnContent.length} chars in ${sinceFirstByte}s before going silent for ${sinceLastChunk}s`
                  : `received ${turnContent.length} chars before stalling`;
              // Salvage path: if we received real content before the
              // stall, commit it as the assistant turn rather than
              // discarding the whole buffer. The orchestrator gets a
              // visible reply with a warning attached, the next turn
              // can react to it, and the user isn't staring at an
              // empty bubble after a multi-minute generation. Only
              // applies when there's actual buffered text — empty
              // turnContent (post-reasoning-silent class) still throws.
              if (turnContent.length > 0) {
                this.emitWarning(
                  `Stream went silent ${sinceLastChunk ?? '?'}s mid-generation; salvaging the ${turnContent.length} chars that arrived before the stall. Take a smaller next step.`,
                );
                finishReason ??= 'idle-stall-salvaged';
                recoveredFromIdleStall = true;
              } else {
                throw new Error(
                  `[llama-cpp] no output for ${Math.round(streamingIdleMs / 1000)}s mid-stream; aborting (${stats}).`,
                );
              }
            } else {
              throw new Error(`[llama-cpp] timed out after ${Math.round(totalTimeoutMs / 1000)}s`);
            }
          }
          if (!recoveredFromRamble && !recoveredFromIdleStall) throw err;
        } finally {
          cleanupTurn();
          this.deps.markUsed();
        }

        let toolCalls = toolCallAccumulator.finalize();
        // Merge any code-block salvage synthesized in the ramble-abort
        // path above. It only populates when no structured calls fired,
        // so this is additive; making `toolCalls` non-empty also
        // correctly short-circuits the prose-shaped salvage below.
        if (codeBlockRepaired.length > 0) {
          toolCalls = [...toolCalls, ...codeBlockRepaired];
        }
        if (toolCalls.length === 0 && shouldPromoteCompletedCodeBlock(turnContent)) {
          const knownToolNames = collectKnownToolNames();
          const salvageToolName = knownToolNames.has('write_file')
            ? 'write_file'
            : knownToolNames.has('write_artifact')
              ? 'write_artifact'
              : null;
          if (salvageToolName) {
            const blocks = prepareSalvagedCodeBlocks(
              turnContent,
              this.deps.activeCraftbookStep?.deliverableFile,
            );
            if (blocks.length > 0) {
              toolCalls = blocks.map((b, i) => ({
                id: `code-complete-salvage-${turn}-${i}`,
                type: 'function' as const,
                function: {
                  name: salvageToolName,
                  arguments: JSON.stringify({ path: b.filename, content: b.content }),
                },
              }));
              log.info(
                `[llama-cpp] code-block-salvage: promoted ${blocks.length} completed-turn fenced block(s) ` +
                  `→ ${salvageToolName} (${blocks.map((b) => `${b.lang}:${b.filename}`).join(', ')})`,
              );
              this.emitWarning(
                `The model wrote ${blocks.length === 1 ? 'a code block' : `${blocks.length} code blocks`} in chat instead of calling ${salvageToolName} — promoting them to actual file writes.`,
              );
            }
          }
        }
        let malformedStructuredCallIds = new Set<string>();
        if (toolCalls.length > 0) {
          const normalized = normalizeMalformedStructuredToolCalls(
            toolCalls,
            collectKnownToolNames(),
          );
          toolCalls = normalized.toolCalls;
          malformedStructuredCallIds = new Set(normalized.sanitizedIds);
          for (const r of normalized.repaired) {
            log.info(
              `[llama-cpp] repaired malformed structured ${r.name} args (path=${r.path}, content=${r.bytes} bytes)`,
            );
          }
          if (normalized.sanitized.length > 0) {
            log.info(
              `[llama-cpp] sanitized malformed structured tool args: ${normalized.sanitized.join(', ')}`,
            );
            if (finishReason === 'length') {
              const recovered = await this.maybeCompactMidLoop({ force: true });
              if (recovered || this.condenseInTurnToolResults() > 0) {
                // The cut-off call was never committed or executed. Retry
                // from the shorter prompt so the model can emit complete
                // arguments instead of turning `{}` into a fake validation
                // failure.
                continue;
              }
              this.emitWarning(
                'The model hit its output limit in the middle of a tool call. The incomplete call was not executed; reduce the request scope or increase the on-device context/output limits before retrying.',
              );
            }
          }
        }
        // Tracks ids of calls synthesized by the truncation salvage
        // stage — their tool results get an `append_to_file` continuation
        // hint appended via {@link appendTruncationHintToToolResult}.
        // Lives for one tool-loop iteration. Mirrors MLX's same-named
        // variable.
        const truncatedCallIds = new Set<string>();

        // Prose-shaped tool-call salvage. Small models on llama.cpp
        // sometimes treat tool-call emission as decoration — they
        // write `name(args)` in a markdown code block instead of
        // emitting a structured tool_calls event. If nothing fired
        // through the structured stream but the streamed text
        // contains a recognizable call shape, promote it. Strict
        // gating (known-tools set + JSON parse) prevents false
        // positives on legitimate prose. Shared with MLX + Ollama.
        if (toolCalls.length === 0 && turnContent.length > 0) {
          const knownToolNames = collectKnownToolNames();
          const gemmaNativeSalvaged = findGemmaNativeToolCallSpans(turnContent, knownToolNames);
          const proseSalvaged =
            gemmaNativeSalvaged.length > 0
              ? []
              : findProseToolCallSpans(turnContent, knownToolNames);
          // Anthropic-style XML tag form (`<browser_navigate url="..." />`).
          // Qwen 3.6 27B emits this when it's been told `<|tool_call|>`
          // markup is wrong — it picks the next-most-familiar tool-use
          // shape from training data. Run before the JSON envelope
          // salvage so a tag like `<list_projects />` doesn't get
          // mis-parsed by the JSON walker.
          const xmlTagSalvaged =
            gemmaNativeSalvaged.length > 0 || proseSalvaged.length > 0
              ? []
              : findXmlTagToolCallSpans(turnContent, knownToolNames);
          // Anthropic-style `<function_calls><invoke name="X">...</invoke></function_calls>`
          // markup. Wild-caught on Qwen 3.6 27B *after* the simpler
          // self-closing XML form was salvaged away — the model picks
          // its second-most-familiar shape from training (the literal
          // Claude tool-use XML). Parameters arrive as nested
          // `<parameter name="K">value</parameter>` elements.
          const claudeInvokeSalvaged =
            gemmaNativeSalvaged.length > 0 || proseSalvaged.length > 0 || xmlTagSalvaged.length > 0
              ? []
              : findClaudeInvokeToolCallSpans(turnContent, knownToolNames);
          // Hermes-2-Pro / Functionary `<function=NAME><parameter=K>V</parameter></function>`
          // markup, often wrapped in Qwen's canonical `<tool_call>` envelope
          // (since Qwen 3.6 has been trained on both corpora and at heavy
          // quant mixes them).
          const hermesSalvaged =
            gemmaNativeSalvaged.length > 0 ||
            proseSalvaged.length > 0 ||
            xmlTagSalvaged.length > 0 ||
            claudeInvokeSalvaged.length > 0
              ? []
              : findHermesFunctionToolCallSpans(turnContent, knownToolNames);
          // Shell-style `<tool_call>name key="value"` per line, no
          // closing tag, no JSON envelope. Wild-caught on Qwen 3.6
          // 27B as the next-most-familiar shape after the Anthropic
          // invoke form was closed off — apparently a degraded form
          // of Qwen's canonical `<tool_call>...JSON...</tool_call>`
          // template where the JSON wrapper got dropped.
          const shellSalvaged =
            proseSalvaged.length > 0 ||
            gemmaNativeSalvaged.length > 0 ||
            xmlTagSalvaged.length > 0 ||
            claudeInvokeSalvaged.length > 0 ||
            hermesSalvaged.length > 0
              ? []
              : findShellToolCallSpans(turnContent, knownToolNames);
          // Walk the streamed text for *every* JSON envelope (Qwen et al
          // sometimes chain several back-to-back) AND for a truncated
          // tail (model stopped mid-call when it ran out of output
          // budget). Previously we only promoted the first envelope; the
          // rest stayed as visible text and never fired.
          const envelopeSalvaged =
            proseSalvaged.length > 0 ||
            gemmaNativeSalvaged.length > 0 ||
            xmlTagSalvaged.length > 0 ||
            claudeInvokeSalvaged.length > 0 ||
            hermesSalvaged.length > 0 ||
            shellSalvaged.length > 0
              ? []
              : parseJsonEnvelopeToolCalls(turnContent, knownToolNames);
          const envelopeTruncated =
            proseSalvaged.length > 0 ||
            gemmaNativeSalvaged.length > 0 ||
            xmlTagSalvaged.length > 0 ||
            claudeInvokeSalvaged.length > 0 ||
            hermesSalvaged.length > 0 ||
            shellSalvaged.length > 0
              ? null
              : findTruncatedJsonEnvelope(turnContent);
          if (gemmaNativeSalvaged.length > 0) {
            log.info(
              `[llama-cpp] salvaged ${gemmaNativeSalvaged.length} Gemma-native tool call(s): ` +
                `${gemmaNativeSalvaged.map((c) => c.name).join(', ')}`,
            );
            toolCalls = gemmaNativeSalvaged.map((parsed, idx) => ({
              id: `gemma-native-repair-${Date.now()}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            }));
            turnContent = stripGemmaNativeToolCallsFromText(turnContent, gemmaNativeSalvaged);
          } else if (proseSalvaged.length > 0) {
            // Successful salvage — the tool fires correctly through
            // the returned `toolCalls`. No yellow toast; salvage IS
            // the success case and a warning every time trains users
            // to ignore the channel.
            log.info(
              `[llama-cpp] salvaged ${proseSalvaged.length} prose-shaped tool call(s): ` +
                `${proseSalvaged.map((c) => c.name).join(', ')}`,
            );
            toolCalls = proseSalvaged.map((parsed, idx) => ({
              id: `prose-repair-${Date.now()}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            }));
            // Strip every salvaged prose body so the persisted bubble
            // doesn't show the calls as decoration alongside the
            // actual tool widgets.
            turnContent = stripProseToolCallsFromText(turnContent, proseSalvaged);
          } else if (xmlTagSalvaged.length > 0) {
            log.info(
              `[llama-cpp] salvaged ${xmlTagSalvaged.length} XML-tag tool call(s): ` +
                `${xmlTagSalvaged.map((c) => c.name).join(', ')}`,
            );
            toolCalls = xmlTagSalvaged.map((parsed, idx) => ({
              id: `xml-tag-repair-${Date.now()}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            }));
            turnContent = stripXmlTagToolCallsFromText(turnContent, xmlTagSalvaged);
          } else if (claudeInvokeSalvaged.length > 0) {
            log.info(
              `[llama-cpp] salvaged ${claudeInvokeSalvaged.length} Claude-invoke tool call(s): ` +
                `${claudeInvokeSalvaged.map((c) => c.name).join(', ')}`,
            );
            toolCalls = claudeInvokeSalvaged.map((parsed, idx) => ({
              id: `claude-invoke-repair-${Date.now()}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            }));
            turnContent = stripClaudeInvokeToolCallsFromText(turnContent, claudeInvokeSalvaged);
          } else if (hermesSalvaged.length > 0) {
            log.info(
              `[llama-cpp] salvaged ${hermesSalvaged.length} Hermes-style tool call(s): ` +
                `${hermesSalvaged.map((c) => c.name).join(', ')}`,
            );
            toolCalls = hermesSalvaged.map((parsed, idx) => ({
              id: `hermes-repair-${Date.now()}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            }));
            turnContent = stripHermesFunctionToolCallsFromText(turnContent, hermesSalvaged);
          } else if (shellSalvaged.length > 0) {
            log.info(
              `[llama-cpp] salvaged ${shellSalvaged.length} shell-style tool call(s): ` +
                `${shellSalvaged.map((c) => c.name).join(', ')}`,
            );
            toolCalls = shellSalvaged.map((parsed, idx) => ({
              id: `shell-repair-${Date.now()}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            }));
            turnContent = stripShellToolCallsFromText(turnContent, shellSalvaged);
          } else if (envelopeSalvaged.length > 0) {
            log.info(
              `[llama-cpp] salvaged ${envelopeSalvaged.length} JSON-envelope tool call(s): ` +
                `${envelopeSalvaged.map((c) => c.name).join(', ')}`,
            );
            toolCalls = envelopeSalvaged.map((parsed, idx) => ({
              id: `json-envelope-repair-${Date.now()}-${idx}`,
              type: 'function' as const,
              function: {
                name: parsed.name,
                arguments: JSON.stringify(parsed.arguments),
              },
            }));
          }
          if (envelopeSalvaged.length > 0 || envelopeTruncated) {
            turnContent = stripJsonEnvelopesFromText(
              turnContent,
              envelopeSalvaged,
              envelopeTruncated?.matchStart,
            );
          }
          // Hide unrecognized-name JSON envelopes from the bubble too
          // — the next loop iteration (when the corrective nudge is
          // wired in) will retry; surfacing the failed first attempt
          // as raw JSON in the user's view is just noise.
          if (toolCalls.length === 0 && !envelopeTruncated) {
            const miss = findUnrecognizedToolEnvelope(turnContent, knownToolNames);
            if (miss) {
              turnContent = stripJsonEnvelopesFromText(turnContent, [
                { matchStart: miss.matchStart, matchEnd: miss.matchEnd },
              ]);
            }
          }
          // Layer 3 — truncation-with-partial-args salvage. When the
          // model started a write-shaped call but the stream cut off
          // mid-content, land the partial bytes anyway and tag the
          // synthesized call so the tool-result auto-continuation
          // hint fires. Shared with MLX + Ollama providers via
          // {@link salvageWriteShapedTruncation}. Only runs when no
          // other salvage path produced a call this iteration.
          if (toolCalls.length === 0) {
            const salvage = salvageWriteShapedTruncation(
              turnContent,
              knownToolNames,
              `truncated-salvage-llama-cpp-${Date.now()}`,
            );
            if (salvage.synthesizedCall) {
              const s = salvage.synthesizedCall;
              toolCalls = [
                {
                  id: s.id,
                  type: 'function' as const,
                  function: {
                    name: s.name,
                    arguments: JSON.stringify(s.argsObject),
                  },
                },
              ];
              truncatedCallIds.add(s.id);
              log.info(
                `[llama-cpp] salvaged truncated ${s.name} call (path=${s.argsObject.path}, partial=${s.argsObject.content.length} bytes) — continuation hint will fire on the tool result`,
              );
              turnContent = salvage.strippedContent;
            }
          }
          if (envelopeTruncated && toolCalls.length === 0) {
            log.info(
              `[llama-cpp] truncated JSON-envelope tool call: ${envelopeTruncated.wanted ?? '<unknown>'}`,
            );
            this.emitWarning(
              `The model's last tool call (\`${envelopeTruncated.wanted ?? 'unknown'}\`) was cut off mid-stream and was skipped. Try again — or raise the output token cap if this happens often.`,
            );
          } else if (toolCalls.length === 0) {
            // Prose-shaped truncation — `name(args` with no closing paren.
            const proseTruncated = findTruncatedProseToolCall(turnContent, knownToolNames);
            if (proseTruncated) {
              log.info(`[llama-cpp] truncated prose tool call: ${proseTruncated.wanted}`);
              this.emitWarning(
                `The model started calling \`${proseTruncated.wanted}\` but was cut off mid-args. It likely spent its output budget on reasoning before reaching the tool call. Try again — or raise the output token cap.`,
              );
            }
          }
        }
        // Every markup salvage format above is a flat KEY→text map, so a
        // parameter declared `object`/`array` arrives as a string. Repair
        // against the declared schema at the one point all salvage paths
        // converge. Schema-gated: a genuine string argument (a JSON
        // file's `content`) is never reinterpreted.
        {
          const coerced = coerceToolCallArgs(toolCalls, (n) => toolArgSchemas.get(n));
          for (const r of coerced.repaired) {
            log.info(`[llama-cpp] repaired flattened arg(s) on ${r.name}: ${r.paths.join(', ')}`);
          }
          toolCalls = coerced.calls as typeof toolCalls;
        }
        // Always pull `<think>…</think>` reasoning out of the visible
        // commit and stash the captured trace so the chat bubble can
        // render it behind a collapsed expander instead of dropping it.
        {
          const split = extractReasoningWithProfile(turnContent, this.deps.profile);
          turnContent = split.visible;
          if (split.reasoning) {
            this.lastTurnReasoning =
              this.lastTurnReasoning.length > 0
                ? `${this.lastTurnReasoning}\n\n${split.reasoning}`
                : split.reasoning;
          }
          // Separate-channel reasoning (SSE `reasoning_content`, ds4-style)
          // joins the same captured trace. Mutually exclusive with inline
          // `<think>` per model family, so no double-count in practice.
          if (turnReasoning.length > 0) {
            this.lastTurnReasoning =
              this.lastTurnReasoning.length > 0
                ? `${this.lastTurnReasoning}\n\n${turnReasoning}`
                : turnReasoning;
          }
        }

        // Preserve the exact visible bytes DS4 sampled before a tool call.
        // `foldPreToolPreamble` intentionally removes that narration from the
        // user-facing answer, but DS4 token-compares the next request against
        // its live KV. Replaying the folded content makes the request diverge
        // at the assistant tail even when `reasoning_content` and DSML are
        // otherwise byte-identical, forcing a disk-checkpoint refill. Keep the
        // raw content only in DS4's internal assistant tool-call transcript;
        // `fullText` below still receives the folded form.
        const replayTurnContent = turnContent;

        // Auto-fold pre-tool preamble for verbose-family models. When
        // the turn produced tool calls, the visible text the model
        // emitted (untagged) is almost always reasoning — "Let me
        // navigate to the URL", "I should use browser_navigate". The
        // user's substantive answer comes after the tool runs, in the
        // next iteration of the tool loop. Cf.
        // {@link foldPreToolPreamble} for the gating rationale.
        turnContent = foldPreToolPreamble({
          text: turnContent,
          toolCallsFired: toolCalls.length > 0,
          modelLeaksReasoning: profileHasBehavior(this.deps.profile, 'turn.preamble-folding'),
          askedQuestionThisTurn,
        });
        // Post-action continuation iterations (tool already ran, this
        // is the wrap-up) get the rumination fold: a verbose model that
        // re-runs its analysis in the visible reply keeps only a
        // conclusive final line; the wall moves to the collapsed
        // reasoning expander. See {@link foldPostActionRumination}.
        // Note this runs on the FOLDED content, after `replayTurnContent`
        // was captured — the ds4 replay transcript keeps the raw bytes.
        // …but only when this iteration's reasoning did NOT arrive on the
        // dedicated `reasoning_content` channel. A native-channel model
        // (ds4) has already handed us its reasoning separately, so its
        // visible content is the answer — folding it as "rumination" blanks
        // a real reply and makes the turn look empty, which then trips the
        // manager's tool-only continuation nudge (a spurious second cycle).
        // The rumination fold is for models that leak untagged reasoning
        // *into* the visible channel (gemma), whose `turnReasoning` is empty
        // here — see the mutually-exclusive-channel note above. This holds
        // regardless of whether the manifest mis-assigns the behavior.
        if (toolCalls.length === 0 && actionFiredEarlierThisTurn && turnReasoning.length === 0) {
          const foldedPostAction = foldPostActionRumination({
            text: turnContent,
            actionFiredEarlierThisTurn: true,
            modelLeaksReasoning: profileHasBehavior(this.deps.profile, 'turn.preamble-folding'),
          });
          if (foldedPostAction.reasoning) {
            log.info(
              `[llama-cpp] folded ${foldedPostAction.reasoning.length} chars of post-action rumination into reasoning (visible=${foldedPostAction.visible.length} chars)`,
            );
            turnContent = foldedPostAction.visible;
            this.lastTurnReasoning =
              this.lastTurnReasoning.length > 0
                ? `${this.lastTurnReasoning}\n\n${foldedPostAction.reasoning}`
                : foldedPostAction.reasoning;
          }
        }
        if (toolCalls.length > 0) actionFiredEarlierThisTurn = true;

        if (
          toolCalls.length === 0 &&
          scenarioFileRepairTurn &&
          prerequisiteRepairReadsPending &&
          !askedQuestionThisTurn
        ) {
          prerequisiteRepairNoProgressNudges += 1;
          if (prerequisiteRepairNoProgressNudges > PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT) {
            throw new Error(
              `[llama-cpp] prerequisite source-read repair ended without reading the remaining source(s) after ${PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT} corrective nudge(s): ${remainingPrerequisiteReadPaths.join(', ')}`,
            );
          }
          const nudge = buildPrerequisiteRepairReadNudge({
            remainingPaths: remainingPrerequisiteReadPaths,
            noProgressNudges: prerequisiteRepairNoProgressNudges,
          });
          log.warn(
            `[llama-cpp] scenario-repair prerequisite-read no-progress corrective ${prerequisiteRepairNoProgressNudges}/${PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT}`,
          );
          this.messages.push({ role: 'user', content: nudge });
          continue;
        }

        if (
          toolCalls.length === 0 &&
          directFileWorkTurn &&
          directFileWorkPrerequisiteReadsPending &&
          !askedQuestionThisTurn
        ) {
          directFileWorkPrerequisiteNoProgressNudges += 1;
          if (directFileWorkPrerequisiteNoProgressNudges > PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT) {
            throw new Error(
              `[llama-cpp] direct file-work turn ended without reading the remaining source(s) after ${PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT} corrective nudge(s): ${remainingDirectFileWorkPrerequisiteReadPaths.join(', ')}`,
            );
          }
          const nudge = buildDirectFileWorkPrerequisiteReadNudge({
            remainingPaths: remainingDirectFileWorkPrerequisiteReadPaths,
            noProgressNudges: directFileWorkPrerequisiteNoProgressNudges,
          });
          log.warn(
            `[llama-cpp] direct-file-work prerequisite-read no-progress corrective ${directFileWorkPrerequisiteNoProgressNudges}/${PREREQUISITE_REPAIR_NO_PROGRESS_LIMIT}`,
          );
          this.messages.push({ role: 'user', content: nudge });
          continue;
        }

        if (
          toolCalls.length === 0 &&
          (scenarioFileRepairTurn || existingSourceEditTurn) &&
          !scenarioRepairMutationSucceeded &&
          !existingSourceEditMutationSucceeded &&
          !askedQuestionThisTurn
        ) {
          const noMutationNudges = scenarioFileRepairTurn
            ? ++scenarioRepairNoMutationNudges
            : ++existingSourceEditNoMutationNudges;
          if (
            scenarioFileRepairTurn &&
            noMutationNudges === 1 &&
            scenarioRepairReadOnlyCalls > 0 &&
            !isGemmaChannelProfile(this.deps.profile)
          ) {
            scenarioRepairDiagnosticReadRetryPending = true;
          }
          if (noMutationNudges > SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT) {
            throw new Error(
              `[llama-cpp] source edit turn ended without a successful workspace mutation after ${SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT} corrective nudge(s). The latest request still requires a file patch; retry with a smaller targeted edit or rewrite the relevant source file with write_file after reading the current source.`,
            );
          }
          const readOnlyCallsForNudge = scenarioFileRepairTurn
            ? scenarioRepairReadOnlyCalls
            : existingSourceEditReadOnlyCalls;
          const readFilePathsForNudge = scenarioFileRepairTurn
            ? scenarioRepairReadFilePaths
            : existingSourceEditReadFilePaths;
          const nudge = buildScenarioRepairNoMutationNudge(collectKnownToolNames(), {
            readOnlyCalls: readOnlyCallsForNudge,
            readFilePaths: readFilePathsForNudge,
            failedMutationCalls: scenarioFileRepairTurn
              ? scenarioRepairFailedMutationCalls
              : existingSourceEditFailedMutationCalls,
            noMutationNudges,
          });
          log.warn(
            `[llama-cpp] ${scenarioFileRepairTurn ? 'scenario-repair' : 'existing-source-edit'} no-mutation corrective ${noMutationNudges}/${SCENARIO_FILE_REPAIR_NO_MUTATION_LIMIT}`,
          );
          this.messages.push({ role: 'user', content: nudge });
          continue;
        }
        if (toolCalls.length === 0 && immediateFileWriteTurn && !askedQuestionThisTurn) {
          pushImmediateFileWriteNoMutationCorrective();
          continue;
        }
        if (
          toolCalls.length === 0 &&
          directFileWorkTurn &&
          !directFileWorkMutationSucceeded &&
          !askedQuestionThisTurn
        ) {
          pushDirectFileWorkNoMutationCorrective();
          continue;
        }

        // Append to fullText AFTER every salvage path has had its turn
        // at stripping. Earlier ordering meant the un-stripped prose /
        // envelope / reasoning text still landed in the persisted
        // assistant message even though the salvage worked.
        fullText += turnContent;

        // External tool capture: when the model invoked any caller-
        // supplied external tool, halt the loop and surface ALL
        // pending calls (external + bridge) to the caller. Bridge
        // calls in the same turn go unexecuted — the caller (the
        // `/v1/chat/completions` route) takes the next turn and
        // decides how to satisfy each.
        if (
          toolCalls.length > 0 &&
          toolCalls.some((tc) => this.externalToolNames.has(tc.function.name))
        ) {
          this.capturedCalls = toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }));
          // Commit the assistant turn so a follow-up sendAndWait sees
          // a coherent transcript even though we're halting here.
          this.messages.push({
            role: 'assistant',
            content: (this.deps.replayReasoningContent ? replayTurnContent : turnContent) || null,
            tool_calls: toolCalls,
            ...(this.deps.replayReasoningContent && turnReasoning.length > 0
              ? { reasoning_content: turnReasoning }
              : {}),
          });
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            this.emitUsage(
              buildTurnUsage({
                model: this.deps.model,
                inputTokens: lastUsage.prompt_tokens,
                outputTokens: lastUsage.completion_tokens,
                ...(lastUsage.predicted_per_second !== undefined
                  ? { outputTokensPerSec: lastUsage.predicted_per_second }
                  : {}),
                ...(lastUsage.cache_n !== undefined
                  ? { cachedInputTokens: lastUsage.cache_n }
                  : {}),
                durationMs: Date.now() - start,
              }),
            );
          }
          return fullText;
        }

        if (toolCalls.length === 0) {
          // Normal turn end — commit assistant message, emit usage, return.
          this.messages.push({
            role: 'assistant',
            content: turnContent,
            ...(this.deps.replayReasoningContent && turnReasoning.length > 0
              ? { reasoning_content: turnReasoning }
              : {}),
          });
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            const durationMs = Date.now() - start;
            this.emitUsage(
              buildTurnUsage({
                model: this.deps.model,
                inputTokens: lastUsage.prompt_tokens,
                outputTokens: lastUsage.completion_tokens,
                ...(lastUsage.predicted_per_second !== undefined
                  ? { outputTokensPerSec: lastUsage.predicted_per_second }
                  : {}),
                ...(lastUsage.cache_n !== undefined
                  ? { cachedInputTokens: lastUsage.cache_n }
                  : {}),
                durationMs,
              }),
            );
            // Per-turn telemetry for the UI engine pill and fitness probe.
            // Prefer llama-server's own decode-loop timing. Re-deriving from
            // `completion_tokens / (end - first streamed token)` overstates
            // thinking models because completion_tokens includes private
            // reasoning the server may finish before it emits any SSE delta.
            // Keep the wall-clock estimate only for older servers that omit
            // the timings block.
            const generationMs =
              firstTokenAt !== null ? Math.max(1, Date.now() - firstTokenAt) : durationMs;
            const wallTokensPerSec =
              lastUsage.completion_tokens > 0 && generationMs > 0
                ? lastUsage.completion_tokens / (generationMs / 1000)
                : undefined;
            const tokensPerSec = lastUsage.predicted_per_second ?? wallTokensPerSec;
            this.emitTurnStats({
              provider: 'llama-cpp',
              promptTokens: lastUsage.prompt_tokens,
              completionTokens: lastUsage.completion_tokens,
              durationMs,
              ...(firstTokenAt !== null ? { ttftMs: Math.max(0, firstTokenAt - start) } : {}),
              ...(lastUsage.prompt_per_second !== undefined
                ? { promptTokensPerSec: lastUsage.prompt_per_second }
                : {}),
              ...(lastUsage.cache_n !== undefined ? { cachedPromptTokens: lastUsage.cache_n } : {}),
              ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
            });
          }
          // Surface a warning when the model was truncated by the
          // output length cap. Mirrors Ollama's `num_predict` warning.
          if (finishReason === 'length') {
            this.emitWarning(
              'Model output was cut off at the length limit. The last turn may be incomplete.',
            );
          }
          return fullText;
        }

        // Tool loop: commit assistant's tool_calls message, invoke each,
        // append tool-output messages, iterate.
        this.messages.push({
          role: 'assistant',
          content: (this.deps.replayReasoningContent ? replayTurnContent : turnContent) || null,
          tool_calls: toolCalls,
          ...(this.deps.replayReasoningContent && turnReasoning.length > 0
            ? { reasoning_content: turnReasoning }
            : {}),
        });
        let abortDueToFailureLoop: {
          tool: string;
          count: number;
          sourceFailureKind?: 'truncated' | 'not-persisted';
          transportFailure?: boolean;
        } | null = null;
        let terminalActionClosing: string | null = null;
        const immediateFileWritePaths: string[] = [];
        const immediatePartialWritePaths: string[] = [];
        // Set when an immediate-write / continuation write this turn was
        // EOS-flushed (truncated) — drives the bail-vs-loop decision below.
        let immediateWriteTruncated = false;
        if (scenarioRepairDiagnosticReadRetryPending && toolCalls.length > 0) {
          // The first no-mutation corrective may grant exactly one more
          // diagnostic action. Consume that grant on any structured call so
          // repeated reads cannot keep the source-repair surface widened.
          scenarioRepairDiagnosticReadRetryPending = false;
        }
        for (const call of toolCalls) {
          let args: Record<string, unknown> = {};
          try {
            args = call.function.arguments.length > 0 ? JSON.parse(call.function.arguments) : {};
          } catch {
            /* bad JSON — let the tool see empty args and decide what to do */
          }
          const constrainedFileMutationTarget: string | null =
            SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES.has(call.function.name)
              ? (missingFileCreatePath ??
                immediateFileWriteTarget ??
                directFileWorkRejectedWritePath ??
                scenarioRepairWriteTarget ??
                existingSourceEditWriteTarget ??
                (directFileWorkScriptHelperMode && !directFileWorkScriptHelperWritten
                  ? DIRECT_FILE_WORK_SCRIPT_HELPER_PATH
                  : directFileWorkTurn && shouldAllowScriptedDirectFileWork(prompt)
                    ? null
                    : directFileWorkTarget))
              : null;
          const constrainedWriteFileTarget: string | null =
            call.function.name === 'write_file' ? constrainedFileMutationTarget : null;
          const constrainedRunNodeScriptTarget: string | null =
            call.function.name === 'run_nodejs_script' &&
            directFileWorkScriptHelperMode &&
            directFileWorkScriptHelperWritten
              ? DIRECT_FILE_WORK_SCRIPT_HELPER_PATH
              : null;
          const directFileWorkScriptHelperUnchangedRewrite =
            directFileWorkScriptHelperMode &&
            call.function.name === 'write_file' &&
            directFileWorkScriptHelperFailure !== null &&
            directFileWorkScriptHelperFailedContent !== null &&
            typeof args.path === 'string' &&
            normalizeWorkspacePathForCompare(args.path) ===
              normalizeWorkspacePathForCompare(DIRECT_FILE_WORK_SCRIPT_HELPER_PATH) &&
            typeof args.content === 'string' &&
            args.content === directFileWorkScriptHelperFailedContent;
          let output: string;
          // Suppress duplicate ask_user_question per turn. See the
          // matching block in MlxSession for the rationale.
          if (call.function.name === 'ask_user_question' && askedQuestionThisTurn) {
            output =
              "You already posted a question card to the user earlier in this turn. The second `ask_user_question` call was suppressed so the user only sees one card. END YOUR TURN NOW — the user's answer to the first question will arrive as the next user message; this turn produces no further visible content.";
          } else if (malformedStructuredCallIds.has(call.id)) {
            output = `ERROR: \`${call.function.name}\` was not executed because the model emitted malformed JSON arguments. Emit one new compact call with valid JSON and every required field. Do not claim the tool succeeded.`;
          } else if (
            (call.function.name === 'start_project' || call.function.name === 'start_job') &&
            startedProjectOrJobThisTurn
          ) {
            output = `You already called \`${startedProjectOrJobThisTurn.tool}\` earlier in this turn — the kickoff is in flight. Do NOT call another project-start tool to brainstorm names or scopes; each call creates a real project, voorman, and kickoff task. END YOUR TURN NOW — tell the user one sentence about the project that's spinning up. The voorman picks the work up from here.`;
          } else if (directFileWorkScriptHelperUnchangedRewrite) {
            output = buildDirectFileWorkUnchangedHelperError(
              directFileWorkScriptHelperFailure ?? 'The previous helper execution failed.',
            );
            log.warn(
              `[llama-cpp] direct-file-work rejected byte-identical failed helper rewrite path=${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}`,
            );
          } else if (constrainedFileMutationTarget) {
            output =
              fileMutationWrongTargetError(
                call.function.name,
                args,
                constrainedFileMutationTarget,
              ) ??
              (await this.deps.bridges
                .callTool(call.function.name, args, {
                  budgetChars: computeToolBudgetChars(this.deps.numCtx, this.estimatePromptChars()),
                  numCtxTokens: this.deps.numCtx,
                })
                .catch((err) => `ERROR: ${err instanceof Error ? err.message : String(err)}`));
          } else if (constrainedRunNodeScriptTarget) {
            output =
              runNodeScriptWrongTargetError(args, constrainedRunNodeScriptTarget) ??
              (await this.deps.bridges
                .callTool(call.function.name, args, {
                  budgetChars: computeToolBudgetChars(this.deps.numCtx, this.estimatePromptChars()),
                  numCtxTokens: this.deps.numCtx,
                })
                .catch((err) => `ERROR: ${err instanceof Error ? err.message : String(err)}`));
          } else if (this.deps.bridges.hasTool(call.function.name)) {
            try {
              // Adaptive cap: compute how many chars of tool output
              // can fit in the remaining context budget. Target a
              // 75% working fraction of numCtx (leaves room for the
              // assistant's response + future turns); subtract the
              // current transcript's estimated tokens. Char→token
              // approximated at 4:1. The bridge applies a small
              // hard floor (CAP_TOOL_OUTPUT_HARD_FLOOR) so even an
              // exhausted-context budget delivers a usable sentinel
              // with a "context tight, refine" footer.
              const budgetChars = computeToolBudgetChars(
                this.deps.numCtx,
                this.estimatePromptChars(),
              );
              output = await this.deps.bridges.callTool(call.function.name, args, {
                budgetChars,
                numCtxTokens: this.deps.numCtx,
              });
            } catch (err) {
              output = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (call.function.name === 'ask_user_question' && !output.startsWith('ERROR:')) {
              askedQuestionThisTurn = true;
            }
            if (
              (call.function.name === 'start_project' || call.function.name === 'start_job') &&
              !output.startsWith('ERROR:')
            ) {
              startedProjectOrJobThisTurn = { tool: call.function.name, firstResult: output };
            }
          } else {
            output = `ERROR: tool ${call.function.name} is not available`;
          }
          const missingEditPath = missingFileEditRecoveryPath(call.function.name, args, output);
          if (missingEditPath) {
            missingFileCreatePath = missingEditPath;
            output = appendMissingFileCreateHint(output, missingEditPath);
            log.warn(
              `[llama-cpp] surgical edit targeted a missing file; forcing create path=${missingEditPath}`,
            );
          }
          const writeShapedCall =
            call.function.name === 'write_file' || call.function.name === 'append_to_file';
          const requestMaxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : null;
          // ds4-server can recover a tool envelope that was cut at the
          // generation limit and then report finish_reason=tool_calls. The
          // explicit `length` signal is therefore not sufficient: usage at
          // the request cap plus a failed write is the reliable fallback.
          const failedWriteHitOutputLimit =
            writeShapedCall &&
            output.startsWith('ERROR:') &&
            (finishReason === 'length' ||
              (requestMaxTokens !== null &&
                iterationUsage !== null &&
                iterationUsage.completion_tokens >= requestMaxTokens));
          const recoverableImmediateWriteError = isRecoverableImmediateFileWriteError(output);
          const truncatedWriteCall = truncatedCallIds.has(call.id) || failedWriteHitOutputLimit;
          if ((immediateFileWriteTurn || writeContinuationActive) && writeShapedCall) {
            const path = typeof args.path === 'string' ? args.path : '';
            if (!output.startsWith('ERROR:')) {
              immediateFileWritePaths.push(path);
            } else if (recoverableImmediateWriteError || failedWriteHitOutputLimit) {
              immediatePartialWritePaths.push(path);
            }
            // Truncated write → file still incomplete; loop a continuation.
            if (truncatedWriteCall) immediateWriteTruncated = true;
            if (recoverableImmediateWriteError) {
              log.info(
                `[llama-cpp] immediate write_file saved invalid first draft path=${path}; continuing in-turn for repair`,
              );
            }
          }
          if (
            scenarioFileRepairTurn &&
            SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES.has(call.function.name) &&
            mutationToolOutputSucceeded(output)
          ) {
            scenarioRepairMutationSucceeded = true;
          }
          if (
            existingSourceEditTurn &&
            SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES.has(call.function.name) &&
            mutationToolOutputSucceeded(output)
          ) {
            existingSourceEditMutationSucceeded = true;
          }
          if (
            directFileWorkTurn &&
            DIRECT_FILE_WORK_MUTATION_TOOL_NAMES.has(call.function.name) &&
            mutationToolOutputSucceeded(output) &&
            directFileWorkMutationSatisfiesTarget(call.function.name, args, directFileWorkTarget)
          ) {
            directFileWorkMutationSucceeded = true;
          }
          if (
            missingFileCreatePath &&
            call.function.name === 'write_file' &&
            mutationToolOutputSucceeded(output) &&
            typeof args.path === 'string' &&
            normalizeWorkspacePathForCompare(args.path) ===
              normalizeWorkspacePathForCompare(missingFileCreatePath)
          ) {
            missingFileCreatePath = null;
          }
          if (directFileWorkTurn && call.function.name === 'write_file') {
            if (directFileWorkScriptHelperUnchangedRewrite) {
              // This is a semantic no-op guard, not an atomic write
              // rejection: the previously persisted helper still exists.
              directFileWorkRejectedWritePath = null;
            } else if (
              mutationToolOutputSucceeded(output) ||
              isRecoverableImmediateFileWriteError(output)
            ) {
              directFileWorkRejectedWritePath = null;
            } else {
              const rejectedPath: string | null =
                constrainedWriteFileTarget ??
                (typeof args.path === 'string' ? args.path : directFileWorkTarget);
              if (rejectedPath) {
                directFileWorkRejectedWritePath = rejectedPath;
                output = appendDirectFileWorkRejectedWriteHint(output, rejectedPath);
                log.warn(
                  `[llama-cpp] direct-file-work write rejected atomically; forcing complete retry path=${rejectedPath}`,
                );
              }
            }
          }
          const directFileWorkScriptHelperJustWritten =
            directFileWorkScriptHelperMode &&
            call.function.name === 'write_file' &&
            mutationToolOutputSucceeded(output) &&
            typeof args.path === 'string' &&
            normalizeWorkspacePathForCompare(args.path) ===
              normalizeWorkspacePathForCompare(DIRECT_FILE_WORK_SCRIPT_HELPER_PATH);
          if (directFileWorkScriptHelperJustWritten) {
            directFileWorkScriptHelperWritten = true;
            directFileWorkScriptHelperFailure = null;
            directFileWorkScriptHelperContent =
              typeof args.content === 'string' ? args.content : null;
            directFileWorkScriptHelperFailedContent = null;
            // A persisted helper is concrete progress. Give a later runtime
            // failure its own bounded repair budget instead of inheriting an
            // earlier no-tool corrective and aborting after one retry.
            directFileWorkNoMutationNudges = 0;
            log.info(
              `[llama-cpp] direct-file-work helper script written; forcing run_nodejs_script next path=${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}`,
            );
          }
          const directFileWorkScriptHelperRunFailed =
            directFileWorkScriptHelperMode &&
            call.function.name === 'run_nodejs_script' &&
            !mutationToolOutputSucceeded(output) &&
            typeof args.path === 'string' &&
            normalizeWorkspacePathForCompare(args.path) ===
              normalizeWorkspacePathForCompare(DIRECT_FILE_WORK_SCRIPT_HELPER_PATH);
          if (directFileWorkScriptHelperRunFailed) {
            directFileWorkScriptHelperWritten = false;
            directFileWorkScriptHelperFailure = output;
            directFileWorkScriptHelperFailedContent = directFileWorkScriptHelperContent;
            directFileWorkNoMutationNudges = 0;
            log.warn(
              `[llama-cpp] direct-file-work helper execution failed; forcing helper rewrite path=${DIRECT_FILE_WORK_SCRIPT_HELPER_PATH}`,
            );
          }
          if (
            scenarioFileRepairTurn &&
            SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES.has(call.function.name) &&
            !mutationToolOutputSucceeded(output)
          ) {
            scenarioRepairFailedMutationCalls += 1;
            output = appendScenarioRepairFailedMutationHint(
              output,
              call.function.name,
              args,
              scenarioRepairFailedMutationCalls,
              { sourceFileRepair: sourceFileScenarioRepairTurn },
            );
          }
          if (
            existingSourceEditTurn &&
            SCENARIO_FILE_REPAIR_MUTATION_TOOL_NAMES.has(call.function.name) &&
            !mutationToolOutputSucceeded(output)
          ) {
            existingSourceEditFailedMutationCalls += 1;
            if (typeof args.path === 'string' && args.path.trim()) {
              existingSourceEditFailedMutationPath = args.path.trim();
            }
            output = appendScenarioRepairFailedMutationHint(
              output,
              call.function.name,
              args,
              existingSourceEditFailedMutationCalls,
              { sourceFileRepair: true },
            );
          }
          if (
            scenarioFileRepairTurn &&
            SCENARIO_FILE_REPAIR_READ_ONLY_TOOL_NAMES.has(call.function.name) &&
            !output.startsWith('ERROR:')
          ) {
            scenarioRepairReadOnlyCalls += 1;
            for (const normalizedPath of completeWorkspaceReadPaths(
              call.function.name,
              args,
              output,
            )) {
              const alreadyRead = scenarioRepairReadFilePaths.some(
                (path) =>
                  normalizeWorkspacePathForCompare(path).toLowerCase() ===
                  normalizeWorkspacePathForCompare(normalizedPath).toLowerCase(),
              );
              if (!alreadyRead) {
                scenarioRepairReadFilePaths.push(normalizedPath);
                const satisfiedPrerequisite = prerequisiteRepairReadPaths.some(
                  (path) =>
                    normalizeWorkspacePathForCompare(path).toLowerCase() ===
                    normalizeWorkspacePathForCompare(normalizedPath).toLowerCase(),
                );
                if (satisfiedPrerequisite) prerequisiteRepairNoProgressNudges = 0;
              }
            }
          }
          if (
            existingSourceEditTurn &&
            SCENARIO_FILE_REPAIR_READ_ONLY_TOOL_NAMES.has(call.function.name) &&
            !output.startsWith('ERROR:')
          ) {
            existingSourceEditReadOnlyCalls += 1;
            for (const normalizedPath of completeWorkspaceReadPaths(
              call.function.name,
              args,
              output,
            )) {
              if (!existingSourceEditReadFilePaths.includes(normalizedPath)) {
                existingSourceEditReadFilePaths.push(normalizedPath);
              }
            }
          }
          if (
            directFileWorkTurn &&
            DIRECT_FILE_WORK_READ_ONLY_TOOL_NAMES.has(call.function.name) &&
            !output.startsWith('ERROR:')
          ) {
            directFileWorkReadOnlyCalls += 1;
            for (const normalizedPath of completeWorkspaceReadPaths(
              call.function.name,
              args,
              output,
            )) {
              if (!directFileWorkReadFilePaths.includes(normalizedPath)) {
                directFileWorkReadFilePaths.push(normalizedPath);
                const satisfiedPrerequisite = directFileWorkPrerequisiteReadPaths.some(
                  (path) =>
                    normalizeWorkspacePathForCompare(path).toLowerCase() ===
                    normalizeWorkspacePathForCompare(normalizedPath).toLowerCase(),
                );
                if (satisfiedPrerequisite) directFileWorkPrerequisiteNoProgressNudges = 0;
              }
            }
          }
          // Auto-continuation hint for truncated write-shaped tool
          // calls. Mirrors MLX + Ollama via the shared helper.
          if (truncatedWriteCall) {
            const before = output.length;
            output = appendTruncationHintToToolResult(output, call.function.name, args);
            if (output.length !== before) {
              const path = typeof args.path === 'string' ? args.path : '(unknown)';
              const bytes = typeof args.content === 'string' ? args.content.length : 0;
              log.info(
                `[llama-cpp] auto-continuation hint appended to tool=${call.function.name} id=${call.id} path=${path} bytes=${bytes}`,
              );
            }
          }
          // The partial-bytes hint above deliberately skips ERROR results.
          // When the write was REJECTED because generation hit the output
          // cap (ds4 repairs the cut-off call and the validator refuses the
          // half-file), the model's instinct is a full rewrite — which hits
          // the same cap again. Steer it to targeted edits instead, unless
          // the MCP layer already saved the draft for append-based recovery.
          if (failedWriteHitOutputLimit && !recoverableImmediateWriteError) {
            const before = output.length;
            output = appendCapTruncationHintToRejectedWrite(
              output,
              call.function.name,
              args,
              requestMaxTokens,
            );
            if (output.length !== before) {
              const path = typeof args.path === 'string' ? args.path : '(unknown)';
              log.info(
                `[llama-cpp] cap-truncated rejected write — incremental-edit hint appended tool=${call.function.name} id=${call.id} path=${path} max_tokens=${requestMaxTokens ?? 'unset'}`,
              );
              this.emitWarning(
                `The model hit its output-token cap mid-write_file (${path}); the write was rejected and it was steered to incremental edits instead of a full rewrite.`,
              );
            }
          }
          const tracked = failureTracker.recordResult(call.function.name, output);
          terminalActionClosing ??= terminalToolClosingText(
            this.deps.terminalToolPolicy,
            call.function.name,
            args,
            output,
          );
          const repeated = repeatTracker.recordCall(call.function.name, args, tracked.output);
          const paced = deliverableReadPaceTracker?.recordCall(call.function.name, repeated.output);
          this.messages.push({
            role: 'tool',
            content: paced?.output ?? repeated.output,
            tool_call_id: call.id,
          });
          if (directFileWorkScriptHelperJustWritten) {
            this.messages.push({
              role: 'user',
              content: buildDirectFileWorkRunScriptNudge(directFileWorkTarget),
            });
          }
          if (directFileWorkScriptHelperRunFailed) {
            this.messages.push({
              role: 'user',
              content: buildDirectFileWorkScriptFailureNudge(directFileWorkTarget, output),
            });
          }
          if (
            this.compactWriteTranscript &&
            compactSuccessfulWriteToolCallForTranscript(
              call,
              args,
              paced?.output ?? repeated.output,
            )
          ) {
            const path = typeof args.path === 'string' ? args.path : '(unknown path)';
            const bytes =
              typeof args.content === 'string'
                ? args.content.length
                : typeof args.text === 'string'
                  ? args.text.length
                  : 0;
            log.info(
              `[llama-cpp] compacted ${call.function.name} transcript args path=${path} bytes=${bytes}`,
            );
          }
          if (tracked.shouldAbort) {
            abortDueToFailureLoop = {
              tool: call.function.name,
              count: tracked.count,
              ...(tracked.sourceFailureKind
                ? { sourceFailureKind: tracked.sourceFailureKind }
                : {}),
              ...(tracked.transportFailure ? { transportFailure: true } : {}),
            };
            break;
          }
          if (paced?.shouldAbort && deliverableReadPaceTracker) {
            throw deliverableReadPaceTracker.buildAbort('llama.cpp');
          }
          if (repeated.shouldAbort) {
            throw ToolRepeatTracker.buildAbort({
              providerLabel: 'llama.cpp',
              toolName: call.function.name,
              args,
              count: repeated.count,
              registeredTools: this.deps.bridges.isEmpty()
                ? []
                : this.deps.bridges.getOpenAITools().map((t) => t.name),
              ...(this.deps.activeCraftbookStep
                ? { activeStep: this.deps.activeCraftbookStep }
                : {}),
            });
          }
        }
        // Terminal: the model asked the user a question. The card is now in
        // front of the user, the question is registered, and its answer
        // arrives as the NEXT user message (the questions-route contract).
        // End the turn HERE rather than issue another generation request —
        // otherwise the turn hangs in-flight forever waiting on a follow-up
        // that must never come (the "6000-second stuck session" bug: an
        // autonomous check-in asked a question and then wedged, engine idle-
        // unloaded, spinner stuck). Highest-priority terminal — a turn that
        // asked a question ends regardless of any other mode. Mirrors the
        // mutation-landed early-returns below.
        if (askedQuestionThisTurn) {
          log.info(
            '[llama-cpp] ask_user_question posted; ending turn (answer arrives as the next message)',
          );
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            const durationMs = Date.now() - start;
            this.emitUsage(
              buildTurnUsage({
                model: this.deps.model,
                inputTokens: lastUsage.prompt_tokens,
                outputTokens: lastUsage.completion_tokens,
                ...(lastUsage.predicted_per_second !== undefined
                  ? { outputTokensPerSec: lastUsage.predicted_per_second }
                  : {}),
                ...(lastUsage.cache_n !== undefined
                  ? { cachedInputTokens: lastUsage.cache_n }
                  : {}),
                durationMs,
              }),
            );
          }
          return fullText;
        }
        if (terminalActionClosing && !abortDueToFailureLoop) {
          this.messages.push({ role: 'assistant', content: terminalActionClosing });
          fullText = terminalActionClosing;
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            this.emitUsage(
              buildTurnUsage({
                model: this.deps.model,
                inputTokens: lastUsage.prompt_tokens,
                outputTokens: lastUsage.completion_tokens,
                ...(lastUsage.predicted_per_second !== undefined
                  ? { outputTokensPerSec: lastUsage.predicted_per_second }
                  : {}),
                ...(lastUsage.cache_n !== undefined
                  ? { cachedInputTokens: lastUsage.cache_n }
                  : {}),
                durationMs: Date.now() - start,
              }),
            );
          }
          log.info('[llama-cpp] terminal action tool succeeded; ending turn without regeneration');
          return fullText;
        }
        if (
          (immediateFileWriteTurn || writeContinuationActive) &&
          immediatePartialWritePaths.length > 0
        ) {
          // Truncated mid-content with continuation budget left — keep the
          // turn alive (append_to_file is now surfaced) instead of bailing
          // on a partial file. The tool result already carries the
          // "append the rest" hint.
          if (immediateWriteTruncated && writeContinuations < MAX_IMMEDIATE_WRITE_CONTINUATIONS) {
            writeContinuationActive = true;
            writeContinuations++;
            log.info(
              `[llama-cpp] immediate-write truncated — auto-continuation ${writeContinuations}/${MAX_IMMEDIATE_WRITE_CONTINUATIONS} (append_to_file surfaced) paths=${immediatePartialWritePaths.join(',')}`,
            );
            continue;
          }
          if (immediateWriteTruncated) {
            throw new Error(
              `[llama-cpp] immediate file write remained truncated after ${MAX_IMMEDIATE_WRITE_CONTINUATIONS} continuation attempt(s): ${immediatePartialWritePaths.join(', ')}`,
            );
          }
          // A first-write syntax failure was persisted for recovery but did
          // not hit the output cap. Let the same hot turn see the validator
          // result and re-emit a corrected complete write_file call instead of
          // fabricating a success close and waiting for an external retry.
          // Repeated identical failures still fall through to the shared
          // failure-loop guard below rather than spinning until the global
          // tool-turn ceiling.
          if (!abortDueToFailureLoop) continue;
        }
        if (
          (immediateFileWriteTurn || writeContinuationActive) &&
          immediateFileWritePaths.length > 0
        ) {
          const closingText = immediateFileWriteClosing(immediateFileWritePaths);
          this.messages.push({ role: 'assistant', content: closingText });
          fullText = fullText ? `${fullText}\n${closingText}` : closingText;
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            const durationMs = Date.now() - start;
            this.emitUsage(
              buildTurnUsage({
                model: this.deps.model,
                inputTokens: lastUsage.prompt_tokens,
                outputTokens: lastUsage.completion_tokens,
                ...(lastUsage.predicted_per_second !== undefined
                  ? { outputTokensPerSec: lastUsage.predicted_per_second }
                  : {}),
                ...(lastUsage.cache_n !== undefined
                  ? { cachedInputTokens: lastUsage.cache_n }
                  : {}),
                durationMs,
              }),
            );
          }
          return fullText;
        }
        if (scenarioFileRepairTurn && scenarioRepairMutationSucceeded) {
          log.info(
            '[llama-cpp] scenario-repair mutation landed; ending turn so validation feedback can run',
          );
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            const durationMs = Date.now() - start;
            this.emitUsage(
              buildTurnUsage({
                model: this.deps.model,
                inputTokens: lastUsage.prompt_tokens,
                outputTokens: lastUsage.completion_tokens,
                ...(lastUsage.predicted_per_second !== undefined
                  ? { outputTokensPerSec: lastUsage.predicted_per_second }
                  : {}),
                ...(lastUsage.cache_n !== undefined
                  ? { cachedInputTokens: lastUsage.cache_n }
                  : {}),
                durationMs,
              }),
            );
          }
          return fullText;
        }
        if (existingSourceEditTurn && existingSourceEditMutationSucceeded) {
          log.info(
            '[llama-cpp] existing-source-edit mutation landed; ending turn so validation feedback can run',
          );
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            const durationMs = Date.now() - start;
            this.emitUsage(
              buildTurnUsage({
                model: this.deps.model,
                inputTokens: lastUsage.prompt_tokens,
                outputTokens: lastUsage.completion_tokens,
                ...(lastUsage.predicted_per_second !== undefined
                  ? { outputTokensPerSec: lastUsage.predicted_per_second }
                  : {}),
                ...(lastUsage.cache_n !== undefined
                  ? { cachedInputTokens: lastUsage.cache_n }
                  : {}),
                durationMs,
              }),
            );
          }
          return fullText;
        }
        if (directFileWorkTurn && directFileWorkMutationSucceeded) {
          log.info(
            '[llama-cpp] direct-file-work mutation landed; ending turn so validation feedback can run',
          );
          if (lastUsage && (lastUsage.prompt_tokens > 0 || lastUsage.completion_tokens > 0)) {
            const durationMs = Date.now() - start;
            this.emitUsage(
              buildTurnUsage({
                model: this.deps.model,
                inputTokens: lastUsage.prompt_tokens,
                outputTokens: lastUsage.completion_tokens,
                ...(lastUsage.predicted_per_second !== undefined
                  ? { outputTokensPerSec: lastUsage.predicted_per_second }
                  : {}),
                ...(lastUsage.cache_n !== undefined
                  ? { cachedInputTokens: lastUsage.cache_n }
                  : {}),
                durationMs,
              }),
            );
          }
          return fullText;
        }
        if (abortDueToFailureLoop) {
          throw ToolFailureTracker.buildAbort({
            providerLabel: 'llama.cpp',
            toolName: abortDueToFailureLoop.tool,
            count: abortDueToFailureLoop.count,
            surgicalEditsAvailable: surgicalEditsAvailableForFailures,
            delegationAvailable: delegationAvailableForFailures,
            ...(abortDueToFailureLoop.sourceFailureKind
              ? { sourceFailureKind: abortDueToFailureLoop.sourceFailureKind }
              : {}),
            ...(abortDueToFailureLoop.transportFailure ? { transportFailure: true } : {}),
          });
        }
      }

      throw new Error(
        `[llama-cpp] too many tool-call loops (>${MAX_TOOL_LOOP_TURNS}); aborting to prevent runaway`,
      );
    } finally {
      // Safety net for every escape the per-iteration `cleanupTurn` misses.
      // No-ops on the normal path — both per-request release functions are
      // idempotent and null their handles when they run.
      releaseActiveGpuLease?.();
      releaseActiveEngineRequest?.();
      this.deps.provider._deregisterActiveSession(this);
    }
  }

  providerState(): ProviderSessionState {
    // Stateless — the transcript lives in ChatSession.messages on disk.
    return {};
  }

  getRegisteredToolNames(): string[] {
    if (this.deps.bridges.isEmpty()) return [];
    return this.deps.bridges.getOpenAITools().map((t) => t.name);
  }

  setSystemMessage(text: string): void {
    // Replace the system message in-place. The constructor always
    // installs a `{role: 'system'}` entry at index 0; the manager
    // calls this right after `createSession` returns, before any
    // user/assistant messages have been appended.
    if (this.messages.length === 0 || this.messages[0]?.role !== 'system') {
      this.messages.unshift({ role: 'system', content: text });
      this.currentTurnStartIdx += 1;
    } else {
      this.messages[0] = { role: 'system', content: text };
    }
    // Keep the prefix-cache mapping in sync with the bytes actually sent.
    // `prepareForSend` keys on `deps.systemMessage` (legacy) / the layered
    // `project` band, so without this a mid-session refresh (live-tools
    // swap) would leave the cache keyed on the ORIGINAL prompt — the
    // pre-existing staleness bug. The refresh only changes the tools
    // block, which lives in the late `project` layer (not the `gezel`
    // identity prefix), so update `project` and keep `gezel`.
    this.deps.systemMessage = text;
    if (this.deps.systemPromptLayers) {
      this.deps.systemPromptLayers = {
        gezel: this.deps.systemPromptLayers.gezel,
        project: text,
      };
    }
  }

  async disconnect(): Promise<void> {
    this.clearHandlers();
    try {
      await this.deps.bridges.stop();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Accumulates tool_calls deltas across streaming chunks. OpenAI Chat
 * Completions streams tool calls incrementally: the `function.arguments`
 * field arrives in chunks keyed by `index`, with `id` + `name` only on
 * the first delta for each index. `finalize` returns the completed
 * calls in index order, ready to execute.
 *
 * Exported for targeted unit tests; not part of the public provider
 * surface.
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; arguments: string }>();

  ingest(delta: ToolCallDelta): void {
    const idx = delta.index;
    let entry = this.byIndex.get(idx);
    if (!entry) {
      entry = { id: '', name: '', arguments: '' };
      this.byIndex.set(idx, entry);
    }
    if (delta.id) entry.id = delta.id;
    if (delta.function?.name) entry.name = delta.function.name;
    if (delta.function?.arguments) entry.arguments += delta.function.arguments;
  }

  rawArgumentsForTool(name: string): string | null {
    for (const entry of this.byIndex.values()) {
      if (entry.name === name) return entry.arguments;
    }
    return null;
  }

  finalize(): StructuredToolCall[] {
    return Array.from(this.byIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({
        id: v.id,
        type: 'function' as const,
        function: { name: v.name, arguments: v.arguments },
      }));
  }
}

export function normalizeMalformedStructuredToolCalls(
  toolCalls: StructuredToolCall[],
  knownToolNames: ReadonlySet<string>,
): {
  toolCalls: StructuredToolCall[];
  repaired: Array<{ name: string; path: string; bytes: number }>;
  sanitized: string[];
  sanitizedIds: string[];
} {
  const repaired: Array<{ name: string; path: string; bytes: number }> = [];
  const sanitized: string[] = [];
  const sanitizedIds: string[] = [];
  const normalized = toolCalls.map((call): StructuredToolCall => {
    const raw = call.function.arguments;
    try {
      const parsed = raw.length > 0 ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return call;
    } catch {
      // Try the write-shaped repair below.
    }
    const repairedArgs = tryRepairMalformedWriteToolArguments(
      call.function.name,
      raw,
      knownToolNames,
    );
    if (repairedArgs) {
      repaired.push({
        name: call.function.name,
        path: repairedArgs.path,
        bytes: repairedArgs.content.length,
      });
      return {
        ...call,
        function: { ...call.function, arguments: JSON.stringify(repairedArgs) },
      };
    }
    sanitized.push(call.function.name || '<unknown>');
    sanitizedIds.push(call.id);
    return { ...call, function: { ...call.function, arguments: '{}' } };
  });
  return { toolCalls: normalized, repaired, sanitized, sanitizedIds };
}

export function tryRepairMalformedWriteToolArguments(
  toolName: string,
  rawArguments: string,
  knownToolNames: ReadonlySet<string>,
): { path: string; content: string } | null {
  if (!toolName || !knownToolNames.has(toolName)) return null;
  if (!isWriteShapedToolName(toolName)) return null;
  if (!rawArguments.trim()) return null;

  const decoded = cutAtFirstToolLeak(looseUnescapeToolArgumentText(rawArguments));
  const path = findLoosePathArg(decoded);
  const content = findLooseWriteContent(decoded);
  if (!content || content.length < 20) return null;
  const normalizedPath = normalizeLooseWritePath(path?.value, content);
  if (!normalizedPath) return null;
  return { path: normalizedPath, content };
}

function findLoosePathArg(text: string): { value: string; index: number } | null {
  const patterns = [
    /(?:^|[,{(\s])["']?path["']?\s*:\s*["']([^"'\r\n]{1,260})["']/i,
    /(?:^|[,{(\s])["']?name["']?\s*:\s*["']([^"'\r\n]{1,260})["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1] && m.index >= 0) return { value: m[1], index: m.index };
  }
  return null;
}

function findLooseWriteContent(text: string): string | null {
  const contentKey = /(?:^|[,{(\s])["']?content["']?\s*:\s*["']/i.exec(text);
  if (contentKey?.index !== undefined) {
    const start = contentKey.index + contentKey[0].length;
    return cleanLooseWriteContentTail(text.slice(start));
  }

  const path = findLoosePathArg(text);
  const beforePath = path ? text.slice(0, path.index) : text;
  const htmlStart = firstExistingIndex(beforePath, ['<!DOCTYPE', '<html', '<!doctype']);
  if (htmlStart >= 0) return cleanLooseWriteContentTail(beforePath.slice(htmlStart));

  const trimmed = beforePath.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return cleanLooseWriteContentTail(trimmed.slice(1));
  }
  return null;
}

function cleanLooseWriteContentTail(raw: string): string | null {
  let out = raw;
  const pathSuffix = /(?:^|[,\s])["']?path["']?\s*:/i.exec(out);
  if (pathSuffix?.index !== undefined && pathSuffix.index > 0) {
    out = out.slice(0, pathSuffix.index);
  }
  out = out
    .replace(/\s*["']{3}\s*[,)]?\s*;?\s*$/s, '')
    .replace(/\s*["']\s*\}\s*\)?\s*;?\s*$/s, '')
    .replace(/\s*["']\s*[,)]?\s*;?\s*$/s, '')
    .trim();
  return out.length > 0 ? out : null;
}

function normalizeLooseWritePath(value: string | undefined, content: string): string | null {
  const trimmed = value?.trim() ?? '';
  if (looksLikeLooseSingleFileHtml(content)) {
    if (isTrustworthyLooseHtmlPath(trimmed)) return trimmed;
    return 'index.html';
  }
  if (trimmed.length > 0 && !/^[,.:;'"`]+$/.test(trimmed)) return trimmed;
  return null;
}

function isTrustworthyLooseHtmlPath(path: string): boolean {
  if (path.length === 0 || /^[,.:;'"`]+$/.test(path)) return false;
  return /\.html?$/i.test(path);
}

function looksLikeLooseSingleFileHtml(content: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(content) && /<script[\s>]/i.test(content);
}

function firstExistingIndex(text: string, needles: string[]): number {
  let best = -1;
  const lower = text.toLowerCase();
  for (const needle of needles) {
    const idx = lower.indexOf(needle.toLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}

function cutAtFirstToolLeak(text: string): string {
  const markers = ['<|channel', '<channel|>', '<|tool_call', '<tool_call|>', '<|end|>'];
  const idx = firstExistingIndex(text, markers);
  return idx >= 0 ? text.slice(0, idx) : text;
}

function looseUnescapeToolArgumentText(raw: string): string {
  return raw
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

/**
 * Convert the MCP bridge's OpenAI-Responses-shape tools
 * (`{type:'function', name, description, parameters}`) into OpenAI
 * Chat-Completions shape (`{type:'function', function:{...}}`).
 * Ollama has an identical helper inline in its provider file; we
 * duplicate rather than share because the wire protocols happen to
 * overlap here and Phase 2 might diverge them (e.g. llama.cpp's
 * grammar / structured-output additions).
 */
function toChatCompletionsTools(bridges: McpBridgePool): ChatCompletionTool[] {
  return bridges.getOpenAITools().map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: normalizeJsonSchemaForLlamaCpp(t.parameters),
    },
  }));
}

/**
 * Some GGUF chat templates expose OpenAI-compatible `/v1/chat/completions`
 * but are still plain user/assistant templates internally. Mistral 7B's
 * `[INST]` template is the wild-caught case: after a tool loop it rejects
 * `assistant(tool_calls) -> tool` transcripts with "Conversation roles must
 * alternate user/assistant". Flattening preserves the tool output as a user
 * message and drops OpenAI-only fields for the retry.
 */
export function flattenToolMessagesForStrictAlternation(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolNamesById = new Map<string, string>();

  const append = (msg: ChatMessage): void => {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role && prev.role !== 'system') {
      prev.content = joinNonEmpty(prev.content, msg.content);
      return;
    }
    out.push(msg);
  };

  for (const msg of messages) {
    if (msg.role === 'tool') {
      const toolName = msg.tool_call_id ? toolNamesById.get(msg.tool_call_id) : undefined;
      append({
        role: 'user',
        content: `Tool result${toolName ? ` for ${toolName}` : ''}${msg.tool_call_id ? ` (${msg.tool_call_id})` : ''}:\n${msg.content ?? ''}`,
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        toolNamesById.set(call.id, call.function.name);
      }
      append({
        role: 'assistant',
        content: joinNonEmpty(
          msg.content,
          `I called ${msg.tool_calls
            .map((call) => `${call.function.name} (${call.id})`)
            .join(', ')}.`,
        ),
      });
      continue;
    }

    append({ ...msg, tool_calls: undefined, tool_call_id: undefined });
  }

  return out;
}

/**
 * Collapse every `role:'system'` turn into a single system message at
 * index 0, preserving the relative order of all non-system turns. For
 * chat templates that allow only one system message at the start of the
 * conversation (Qwen 3.x family). gezel's layered prefix cache seeds the
 * per-session volatile band as a SECOND system message after messages[0];
 * those templates 500 on it. Merging keeps the same instruction content
 * (joined with a blank line) in a single compliant turn.
 *
 * No-op shape when there's 0 or 1 system message (returns an equivalent
 * array). Empty/`null`-content system turns are dropped from the merge.
 */
export function mergeSystemMessagesIntoFirst(messages: readonly ChatMessage[]): ChatMessage[] {
  const systemParts: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content.length > 0) systemParts.push(m.content);
      continue;
    }
    rest.push(m);
  }
  if (systemParts.length === 0) return [...messages];
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
}

function joinNonEmpty(left: string | null, right: string | null): string {
  if (left && right) return `${left}\n\n${right}`;
  return left ?? right ?? '';
}

function shouldPromoteCompletedCodeBlock(text: string): boolean {
  if (!/```[a-zA-Z0-9_+-]*\s*\n/.test(text)) return false;
  return (
    /\b(create_file|write_file|write file|write the file|create the file|create the `?index\.html`?|update the `?index\.html`?|now that the file is written)\b/i.test(
      text,
    ) ||
    /\b(?:updated|revised|corrected|completed?)\s+(?:the\s+)?`?index\.html`?\s+file\b/i.test(
      text,
    ) ||
    /\b(updated|revised|corrected|complete|full)\s+HTML\b/i.test(text) ||
    /\bhere(?:'|’)s the (?:updated|revised|corrected|complete|full) HTML\b/i.test(text) ||
    /\bhere is the content of\s+`?(?:workspace\/)?index\.html`?/i.test(text)
  );
}

/**
 * Parse an OpenAI-compatible SSE stream into one JSON object per
 * `data:` frame. Emits the literal string `'[DONE]'` for the
 * terminator frame so the caller can break cleanly. Handles the two
 * line-ending conventions seen in the wild (\n\n and \r\n\r\n).
 *
 * Exported for targeted unit tests; not part of the public provider
 * surface.
 */
/**
 * Parse llama-server's `exceed_context_size_error` response shape and
 * extract the concrete token counts. Returns null for anything that
 * doesn't match — a generic 400 falls through to the default error
 * path. Exported for testing. Upstream body looks like:
 *
 * ```json
 * {"error":{"code":400,"message":"request (48514 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":48514,"n_ctx":16384}}
 * ```
 *
 * We prefer the structured fields; regex-matching the message text is
 * a last-resort fallback for older llama-server builds where the
 * numbers only appear in the human-readable string.
 */
/**
 * Parse llama-server's `Failed to parse tool call arguments as JSON`
 * 500 response. Fires when the model's tool-call args get cut off
 * mid-string before it can close the JSON — typically because the
 * slot's context budget filled up while the model was still
 * serializing arguments. The server discards the partial output and
 * returns a 500 with the parse-error message. Returns null for
 * anything that doesn't match — a generic 500 falls through to the
 * default error path. Exported for testing. Upstream body looks
 * like:
 *
 * ```json
 * {"error":{"code":500,"message":"Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 312: syntax error while parsing value - invalid string: missing closing quote; last read: '\"Generate 2-3 new'","type":"server_error"}}
 * ```
 *
 * The captured `partial` is the last-read fragment when the parser
 * gave up — useful for surfacing in a warning so the user can see
 * what the model was trying to write. Falls back to an empty string
 * if the message format doesn't match the regex.
 */
export function tryParseToolCallParseError(body: string): { partial: string } | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        type?: string;
        message?: string;
      };
    };
    const msg = parsed?.error?.message ?? '';
    if (!msg.includes('Failed to parse tool call arguments')) return null;
    const marker = "last read: '";
    const markerIdx = msg.indexOf(marker);
    if (markerIdx < 0) return { partial: '' };
    let partial = msg.slice(markerIdx + marker.length);
    if (partial.endsWith("'")) partial = partial.slice(0, -1);
    return { partial };
  } catch {
    return null;
  }
}

export function tryParseStrictAlternationTemplateError(body: string): boolean {
  if (body.includes('Conversation roles must alternate user/assistant')) return true;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return Boolean(
      parsed.error?.message?.includes('Conversation roles must alternate user/assistant'),
    );
  } catch {
    return false;
  }
}

/**
 * Detect the chat-template error raised by single-system-message templates
 * (Qwen 3.x family) when a `role:'system'` turn appears anywhere but the
 * start: `raise_exception("System message must be at the beginning of the
 * conversation")`. Matched on the stable, distinctive substring so it
 * survives minor template-wording differences across quantizations. The
 * caller flips {@link LlamaCppSession.mergeSystemMessages} and retries.
 */
export function tryParseSystemMessageOrderingError(body: string): boolean {
  const NEEDLE = 'System message must be at the beginning';
  if (body.includes(NEEDLE)) return true;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return Boolean(parsed.error?.message?.includes(NEEDLE));
  } catch {
    return false;
  }
}

export function tryParseContextOverflow(
  body: string,
): { promptTokens: number; nCtx: number } | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        type?: string;
        n_prompt_tokens?: number;
        n_ctx?: number;
        message?: string;
      };
    };
    if (parsed?.error?.type === 'exceed_context_size_error') {
      const promptTokens = parsed.error.n_prompt_tokens;
      const nCtx = parsed.error.n_ctx;
      if (typeof promptTokens === 'number' && typeof nCtx === 'number') {
        return { promptTokens, nCtx };
      }
      // Fall through to regex fallback on the message.
      const msg = parsed.error.message ?? '';
      const m = msg.match(/\((\d+)\s*tokens?\)[^(]*\((\d+)\s*tokens?\)/);
      if (m) {
        const p = Number.parseInt(m[1]!, 10);
        const n = Number.parseInt(m[2]!, 10);
        if (!Number.isNaN(p) && !Number.isNaN(n)) {
          return { promptTokens: p, nCtx: n };
        }
      }
    }
  } catch {
    /* not JSON — fall through */
  }
  return null;
}

interface ChatCompletionChunk {
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      // Private reasoning channel. llama-server emits this (separate
      // from `content`) when it parses the model's think channel
      // server-side — which it does by default under `--reasoning-budget`
      // (no `--reasoning-format none` is passed at launch). Verbose
      // families stream their whole chain-of-thought here; it never
      // reaches `content`, so the stream pump must watch it explicitly
      // or the post-reasoning watchdog mistakes "engine ruminating" for
      // "engine wedged." See the chunk handler in `sendAndWaitInner`.
      reasoning_content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
  };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}
