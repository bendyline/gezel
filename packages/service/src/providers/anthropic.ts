import type Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '@bendyline/gezel';
import { ANTHROPIC_TUNING_MAP, applyTuning } from '../model-profile/tuning.js';
import { McpBridgePool } from './mcp-bridge-pool.js';
import { ProviderQueue, runInQueue } from './queue.js';
import { StreamingSessionBase } from './streaming-session.js';
import type {
  ExternalToolCall,
  ExternalToolSpec,
  ImageAttachment,
  LLMProvider,
  LLMSession,
  ModelInfo,
  ProviderSessionState,
  SendAndWaitOpts,
  SessionOpts,
} from './types.js';
import { buildTurnUsage } from './usage-builder.js';

const log = createLogger('anthropic');

/**
 * Anthropic provider built on the Messages API.
 *
 * The Messages API is stateless: every turn must replay the full message
 * history. We rely on prompt caching (`cache_control: { type: 'ephemeral' }`
 * on the system prompt + the last block of the last persisted turn) to keep
 * per-turn cost on par with OpenAI's `previous_response_id` continuation.
 *
 * Reasoning is exposed via Anthropic's `thinking` config rather than
 * OpenAI's `reasoning.effort`. We map the same `low|medium|high` tags to
 * `budget_tokens` values, so a gezel pinned to `reasoningEffort: 'medium'`
 * works under either provider without re-configuration.
 */

/** Anthropic enforces a minimum of 1024 budget tokens for thinking. */
const ANTHROPIC_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
const REASONING_BUDGET_TOKENS: Record<string, number> = {
  low: 1024,
  medium: 4096,
  high: 16384,
};

const DEFAULT_MODEL = 'claude-sonnet-4-6';
/**
 * Required by the Messages API on every request. 16384 covers reasoning
 * turns that chew thousands of tokens on visible thinking before the
 * reply. Anthropic still bills only for tokens generated, so this is a
 * ceiling, not a target — the model stops cleanly at its natural
 * finish when the answer is short. Lowered from 32k after observing
 * verbose local models loop within the larger budget; 16k is roomy
 * enough for healthy turns while keeping pathological loops bounded.
 */
const DEFAULT_MAX_TOKENS = 16384;

/** Reasoning-capable model families. Anthropic doesn't return this on /v1/models, so we whitelist. */
const REASONING_MODEL_PREFIXES = ['claude-opus-4', 'claude-sonnet-4', 'claude-mythos'];

function isReasoningModel(id: string): boolean {
  return REASONING_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: unknown }>;
      is_error?: boolean;
    };

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  readonly queue: ProviderQueue;
  readonly supportsExternalTools = true;
  private anthropic: Anthropic | null = null;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(opts: {
    apiKey: string;
    defaultModel?: string;
    concurrency?: number;
    affinity?: boolean;
  }) {
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL;
    this.queue = new ProviderQueue({
      concurrency: opts.concurrency ?? 10,
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
    });
  }

  async initialize(): Promise<void> {
    if (this.anthropic) return;
    const mod = await import('@anthropic-ai/sdk');
    const Ctor = mod.default ?? (mod as unknown as { Anthropic: typeof Anthropic }).Anthropic;
    this.anthropic = new Ctor({ apiKey: this.apiKey }) as Anthropic;
    log.info('[anthropic] client initialized');
  }

  async shutdown(): Promise<void> {
    this.anthropic = null;
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    await this.initialize();
    if (!this.anthropic) throw new Error('[anthropic] client not initialized');

    const bridges = await McpBridgePool.fromSessionOpts(opts, '[anthropic]');
    return new AnthropicSession({
      anthropic: this.anthropic,
      model: opts.model ?? this.defaultModel,
      reasoningEffort: opts.reasoningEffort,
      systemMessage: opts.systemMessage,
      bridges,
      // Pass the widened priorMessages through — the session
      // translates tool-role entries into Anthropic's tool_use /
      // tool_result content blocks at construction time.
      priorMessages: opts.priorMessages ?? [],
      queue: this.queue,
      ...(opts.tuning ? { tuning: opts.tuning } : {}),
      ...(opts.externalTools && opts.externalTools.length > 0
        ? { externalTools: opts.externalTools }
        : {}),
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.initialize();
    if (!this.anthropic) throw new Error('[anthropic] client not initialized');
    const listing = await (
      this.anthropic as unknown as {
        models: { list: () => Promise<{ data: Array<{ id: string; display_name?: string }> }> };
      }
    ).models.list();
    const models: ModelInfo[] = [];
    for (const m of listing.data) {
      const reasoning = isReasoningModel(m.id);
      models.push({
        id: m.id,
        name: m.display_name ?? m.id,
        supportsReasoning: reasoning,
        reasoningEfforts: reasoning ? [...ANTHROPIC_REASONING_EFFORTS] : undefined,
        defaultReasoningEffort: reasoning ? 'medium' : undefined,
      });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }
}

/** @internal Exported alongside {@link AnthropicSession} for unit tests. */
export interface AnthropicSessionDeps {
  anthropic: Anthropic;
  model: string;
  reasoningEffort?: string;
  systemMessage: string;
  bridges: McpBridgePool;
  priorMessages: Array<
    | { role: 'user' | 'assistant'; content: string }
    | { role: 'assistant'; content: string; toolCalls: ExternalToolCall[] }
    | { role: 'tool'; content: string; toolCallId: string }
  >;
  /**
   * Caller-supplied external tool definitions. Advertised to the
   * Messages API alongside any bridge tools; calls against these names
   * halt the loop instead of executing — captured via
   * {@link LLMSession.capturedToolCalls}.
   */
  externalTools?: ExternalToolSpec[];
  queue: ProviderQueue;
  /**
   * Resolved per-model tuning. Applied to the request body via
   * `ANTHROPIC_TUNING_MAP` after the legacy `reasoningEffort` → budget
   * mapping fires, so `tuning.reasoning.thinkingBudget` (and an
   * effort override on the tuning block) wins over the constructor's
   * `reasoningEffort` when both are set.
   */
  tuning?: import('../model-profile/index.js').ResolvedTuning;
}

/**
 * Exported for unit tests in `anthropic.tools.test.ts`. Production
 * code uses {@link AnthropicProvider.createSession} which builds the
 * SDK instance + queue + bridges for you.
 *
 * @internal
 */
export class AnthropicSession extends StreamingSessionBase implements LLMSession {
  /**
   * Running message array. Seeded from `priorMessages` on construction;
   * grown across multi-turn tool loops. Persistence is handled by
   * `ChatManager` via the canonical `ChatSession.messages` log — this
   * array is only an in-memory scratchpad for the API roundtrip.
   */
  private readonly messages: AnthropicMessage[] = [];
  private readonly externalToolNames: Set<string>;
  private capturedCalls: ExternalToolCall[] = [];
  /**
   * Aggregated `thinking_delta` text for the current turn, across every
   * iteration of the tool loop. Reset at the top of `sendAndWaitInner`;
   * read by ChatManager via `getLastTurnReasoning()` after the turn
   * resolves and persisted on `ChatMessage.reasoning`.
   */
  private lastTurnReasoning = '';

  constructor(private readonly deps: AnthropicSessionDeps) {
    super();
    this.externalToolNames = new Set((deps.externalTools ?? []).map((t) => t.name));
    // Translate the widened priorMessages shape into Anthropic content
    // blocks. The Messages API has no separate `tool` role — past tool
    // results live as `tool_result` content blocks on a USER message,
    // and past assistant tool calls live as `tool_use` blocks on an
    // ASSISTANT message alongside any text.
    for (const m of deps.priorMessages) {
      if (m.role === 'tool') {
        this.messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId,
              content: m.content,
            },
          ],
        });
        continue;
      }
      if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          let input: Record<string, unknown> = {};
          try {
            input = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
          } catch {
            /* leave empty */
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input,
          });
        }
        this.messages.push({ role: 'assistant', content: blocks });
        continue;
      }
      // Plain user / assistant text turn.
      this.messages.push({ role: m.role, content: m.content });
    }
  }

  capturedToolCalls(): ExternalToolCall[] {
    return [...this.capturedCalls];
  }

  getLastTurnReasoning(): string | undefined {
    return this.lastTurnReasoning.length > 0 ? this.lastTurnReasoning : undefined;
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    // Reset captures — each turn surfaces only its own externals.
    this.capturedCalls = [];
    this.lastTurnReasoning = '';

    const deadline = Date.now() + (opts?.timeoutMs ?? 120_000);
    const start = Date.now();
    const bridgeTools = this.deps.bridges.isEmpty() ? [] : this.deps.bridges.getAnthropicTools();
    const externalToolsAsAnthropic = (this.deps.externalTools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.parameters,
    }));
    const tools =
      bridgeTools.length + externalToolsAsAnthropic.length > 0
        ? [...bridgeTools, ...externalToolsAsAnthropic]
        : undefined;

    // Append the new user prompt (with any pasted images), but ONLY
    // when there's actually a prompt or attachments. A multi-turn tool
    // round-trip can land here with an empty prompt (the route posted
    // a tool result and is asking for the model's continuation) — in
    // that case the last priorMessage was the tool_result user turn,
    // which already lives in `this.messages`. Pushing an extra empty
    // user message confuses the API.
    if (prompt || (opts?.attachments && opts.attachments.length > 0)) {
      this.messages.push(buildUserMessage(prompt, opts?.attachments));
    }

    let fullText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;

    for (let turn = 0; turn < 12; turn++) {
      if (Date.now() > deadline) {
        throw new Error(
          `[anthropic] timed out after ${Math.round((opts?.timeoutMs ?? 120_000) / 1000)}s`,
        );
      }

      const request: Record<string, unknown> = {
        model: this.deps.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: buildSystem(this.deps.systemMessage),
        messages: applyCacheBreakpoints(this.messages),
        stream: true,
      };
      if (tools && tools.length > 0) request.tools = tools;
      if (this.deps.reasoningEffort && isReasoningModel(this.deps.model)) {
        const budget =
          REASONING_BUDGET_TOKENS[this.deps.reasoningEffort] ?? REASONING_BUDGET_TOKENS.medium;
        request.thinking = { type: 'enabled', budget_tokens: budget };
      }
      // Per-model tuning. Layers on top of the reasoningEffort → budget
      // mapping above: a `tuning.reasoning.thinkingBudget` direct value
      // overwrites the effort-derived value; an effort on the tuning
      // block is skipped when a budget is already set (the map's
      // `writeAnthropicEffort` checks for that). Sampling
      // (temperature/top_p/top_k/max_tokens) lands directly on `request`.
      if (this.deps.tuning) {
        applyTuning(request, this.deps.tuning, ANTHROPIC_TUNING_MAP);
      }

      const stream = (await (
        this.deps.anthropic as unknown as {
          messages: { create: (r: unknown) => Promise<AsyncIterable<AnthropicStreamEvent>> };
        }
      ).messages.create(request)) as AsyncIterable<AnthropicStreamEvent>;

      const turnTextParts: string[] = [];
      const blocks: AnthropicContentBlock[] = [];
      // Active block index → buffer for tool_use input JSON. The SDK streams
      // tool_use input as `input_json_delta` chunks of `partial_json` text;
      // we accumulate until the block stops, then `JSON.parse`.
      const toolInputBuffers = new Map<number, string>();
      let stopReason: string | null = null;

      for await (const event of stream) {
        if (event.type === 'message_start') {
          const usage = event.message?.usage;
          if (usage) {
            totalInputTokens += usage.input_tokens ?? 0;
            totalCacheReadTokens += usage.cache_read_input_tokens ?? 0;
            totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
          }
        } else if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'text') {
            blocks.push({ type: 'text', text: '' });
          } else if (block?.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: block.id ?? '',
              name: block.name ?? '',
              input: {},
            });
            toolInputBuffers.set(event.index, '');
          } else {
            // thinking / redacted_thinking / future block types: round-trip
            // them as a placeholder so the index alignment with content_block_stop
            // stays correct, but skip in fullText.
            if (block?.type === 'thinking' && this.lastTurnReasoning.length > 0) {
              // A new thinking block in a multi-round tool loop — separate
              // it from the previous round's captured trace.
              this.lastTurnReasoning += '\n\n';
            }
            blocks.push({ type: 'text', text: '' });
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (!delta) continue;
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            const idx = event.index;
            const slot = blocks[idx];
            if (slot && slot.type === 'text') {
              slot.text += delta.text;
            }
            turnTextParts.push(delta.text);
            this.emitDelta(delta.text);
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const buf = toolInputBuffers.get(event.index) ?? '';
            toolInputBuffers.set(event.index, buf + delta.partial_json);
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            // Stream the thinking inline so the user sees forward motion
            // instead of silent dots, and capture it separately for
            // `getLastTurnReasoning()`. It stays out of `turnTextParts`,
            // so the final reply (and the round-tripped transcript) never
            // contains the trace — it persists only as
            // `ChatMessage.reasoning` behind the collapsed expander.
            this.lastTurnReasoning += delta.thinking;
            this.emitDelta(delta.thinking);
          }
        } else if (event.type === 'content_block_stop') {
          const buf = toolInputBuffers.get(event.index);
          if (buf !== undefined) {
            const slot = blocks[event.index];
            if (slot && slot.type === 'tool_use') {
              try {
                slot.input = buf.length > 0 ? (JSON.parse(buf) as Record<string, unknown>) : {};
              } catch {
                slot.input = {};
              }
            }
            toolInputBuffers.delete(event.index);
          }
        } else if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          const usage = event.usage;
          if (usage) {
            totalOutputTokens += usage.output_tokens ?? 0;
          }
        }
        // message_stop: nothing to do — the iterator ends.
      }

      // Persist this assistant turn into our running message array. Even if
      // stop_reason is `end_turn`, keeping it here means a subsequent
      // `sendAndWait` call sees a coherent transcript.
      const assistantBlocks = blocks.filter(
        (b) => b.type === 'tool_use' || (b.type === 'text' && b.text.length > 0),
      );
      this.messages.push({
        role: 'assistant',
        content:
          assistantBlocks.length > 0
            ? assistantBlocks
            : [{ type: 'text', text: turnTextParts.join('') }],
      });
      fullText += turnTextParts.join('');

      const toolUses = blocks.filter(
        (b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );

      // External tool capture: as soon as the model invokes any
      // caller-supplied external tool, halt the loop and surface ALL
      // pending tool_use blocks (external + bridge) to the caller.
      // Bridge tools the model emitted in the same turn go unexecuted
      // — the caller takes responsibility for the next turn.
      const externalUses = toolUses.filter((u) => this.externalToolNames.has(u.name));
      if (externalUses.length > 0) {
        this.capturedCalls = toolUses.map((u) => ({
          id: u.id,
          name: u.name,
          arguments: JSON.stringify(u.input),
        }));
        this.emitUsage(
          buildTurnUsage({
            model: this.deps.model,
            inputTokens: totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens,
            outputTokens: totalOutputTokens,
            durationMs: Date.now() - start,
            ...(totalCacheReadTokens > 0 ? { cachedInputTokens: totalCacheReadTokens } : {}),
          }),
        );
        return fullText;
      }

      if (stopReason !== 'tool_use' || toolUses.length === 0) {
        // Done — emit the aggregated usage for the whole multi-turn exchange
        // (matches OpenAI's behavior: one usage event per `sendAndWait`).
        // `inputTokens` is the total billed input (uncached + cache-read +
        // cache-creation); `cachedInputTokens` reports the cache-read portion
        // so the UI can surface "served from cache" without double-counting.
        this.emitUsage(
          buildTurnUsage({
            model: this.deps.model,
            inputTokens: totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens,
            outputTokens: totalOutputTokens,
            durationMs: Date.now() - start,
            ...(totalCacheReadTokens > 0 ? { cachedInputTokens: totalCacheReadTokens } : {}),
          }),
        );
        return fullText;
      }

      // Invoke each tool, then feed the results back as a single user message
      // with one `tool_result` content block per call.
      const resultBlocks: AnthropicContentBlock[] = [];
      for (const call of toolUses) {
        let text: string;
        let isError = false;
        if (this.deps.bridges.hasTool(call.name)) {
          try {
            const rich = await this.deps.bridges.callToolRich(call.name, call.input);
            text = rich.text;
          } catch (err) {
            text = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
            isError = true;
          }
        } else {
          text = `ERROR: tool ${call.name} is not available`;
          isError = true;
        }
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: text,
          ...(isError ? { is_error: true } : {}),
        });
      }
      this.messages.push({ role: 'user', content: resultBlocks });
    }

    throw new Error('[anthropic] too many tool-call loops; aborting');
  }

  providerState(): ProviderSessionState {
    // Stateless API — nothing to persist. ChatManager will rehydrate from
    // `ChatSession.messages` on next session creation.
    return {};
  }

  async disconnect(): Promise<void> {
    this.clearHandlers();
    try {
      await this.deps.bridges.stop();
    } catch {
      /* ignore */
    }
    this.messages.length = 0;
  }
}

/**
 * Build the system field. Always an array of TextBlockParam so we can mark
 * the last block as a cache breakpoint — caches the system prompt for the
 * 5-minute ephemeral TTL, dropping subsequent-turn input cost to 0.1× base.
 */
function buildSystem(message: string): Array<{
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}> {
  return [{ type: 'text', text: message, cache_control: { type: 'ephemeral' } }];
}

function buildUserMessage(prompt: string, attachments?: ImageAttachment[]): AnthropicMessage {
  if (!attachments || attachments.length === 0) {
    return { role: 'user', content: prompt };
  }
  const blocks: AnthropicContentBlock[] = [{ type: 'text', text: prompt }];
  for (const a of attachments) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: a.mimeType, data: a.base64 },
    });
  }
  return { role: 'user', content: blocks };
}

/**
 * Place a single `cache_control` breakpoint on the last block of the
 * last message in the array. Combined with the system-prompt breakpoint
 * (set in `buildSystem`), the entire prior conversation lands in the
 * 5-minute ephemeral cache. Total breakpoints used: 2 of 4 allowed.
 *
 * We rebuild the array (cloning the trailing message + last block) so the
 * caller's running `messages` array stays free of cache_control markers
 * across turns — otherwise old breakpoints would accumulate inside
 * tool_use loops and stale ones near the front of the conversation
 * would no longer be helpful (the cache is keyed by prefix anyway).
 */
function applyCacheBreakpoints(messages: AnthropicMessage[]): AnthropicMessage[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const out = messages.slice(0, -1);
  if (typeof last.content === 'string') {
    out.push({
      role: last.role,
      content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }],
    });
    return out;
  }
  const blocks = last.content.slice();
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock) {
    blocks[blocks.length - 1] = withCacheControl(lastBlock);
  }
  out.push({ role: last.role, content: blocks });
  return out;
}

function withCacheControl(block: AnthropicContentBlock): AnthropicContentBlock {
  // Only `text` and `tool_result` blocks accept cache_control today.
  // Image / tool_use blocks fall through unchanged — the next-most-recent
  // text block will still be cached on the following turn.
  if (block.type === 'text') {
    return { ...block, cache_control: { type: 'ephemeral' } };
  }
  if (block.type === 'tool_result') {
    return { ...block, cache_control: { type: 'ephemeral' } } as AnthropicContentBlock;
  }
  return block;
}

interface AnthropicStreamEvent {
  type: string;
  index: number;
  message?: { usage?: AnthropicUsage };
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: AnthropicUsage;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

// Test exports — kept here rather than in a separate barrel so the public
// surface (the provider class + nothing else) stays small in production.
export const __testing = {
  applyCacheBreakpoints,
  buildSystem,
  buildUserMessage,
  isReasoningModel,
};
