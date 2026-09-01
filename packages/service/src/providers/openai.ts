import { createLogger } from '@bendyline/gezel';
import type OpenAI from 'openai';
import { OPENAI_TUNING_MAP, applyTuning } from '../model-profile/tuning.js';
import { McpBridgePool } from './mcp-bridge-pool.js';
import { ProviderQueue, runInQueue } from './queue.js';
import { StreamingSessionBase } from './streaming-session.js';
import { TERMINAL_ACTION_SKIPPED_OUTPUT, terminalToolClosingText } from './terminal-tool-policy.js';
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

const log = createLogger('openai');

/**
 * OpenAI's /v1/models endpoint doesn't report which models support the
 * `reasoning.effort` parameter. We whitelist families that do. If OpenAI
 * adds a new reasoning family, add its prefix here.
 */
const REASONING_MODEL_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'];
const OPENAI_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];

/** Filter OpenAI's full model list down to ones useful for chat. */
const CHAT_MODEL_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'chatgpt'];

function isReasoningModel(id: string): boolean {
  return REASONING_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

function isChatModel(id: string): boolean {
  return CHAT_MODEL_PREFIXES.some((p) => id.startsWith(p));
}

/**
 * Build the `input` field for the Responses API.
 *
 * Plain text: the API accepts a string directly.
 * With images: wrap as an `input_message` whose `content` is the standard
 * content-part array — `{type: 'input_text', …}` + one
 * `{type: 'input_image', image_url: "data:<mime>;base64,<payload>"}` per
 * attachment.
 */
function buildInitialInput(prompt: string, attachments?: ImageAttachment[]): unknown {
  if (!attachments || attachments.length === 0) return prompt;
  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: prompt },
        ...attachments.map((a) => ({
          type: 'input_image',
          image_url: `data:${a.mimeType};base64,${a.base64}`,
        })),
      ],
    },
  ];
}

/**
 * OpenAI provider built on the Responses API with client-side state
 * (`previous_response_id`). Supports streaming and — via McpBridge — the
 * existing stdio MCP tools the agent would normally get through Copilot.
 *
 * External tool calling (the `/v1/chat/completions` `tools[]` field
 * from third-party apps) is supported: caller-supplied tools are
 * advertised to the Responses API alongside any bridge tools; on the
 * first model-emitted call against an external tool the session
 * halts and surfaces the captures via {@link LLMSession.capturedToolCalls}.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai' as const;
  readonly queue: ProviderQueue;
  readonly supportsExternalTools = true;
  readonly supportsPriorMessages = true;
  private openai: OpenAI | null = null;
  private readonly apiKey: string;
  private readonly organization?: string;
  private readonly defaultModel: string;

  constructor(opts: {
    apiKey: string;
    organization?: string;
    defaultModel?: string;
    concurrency?: number;
    affinity?: boolean;
  }) {
    this.apiKey = opts.apiKey;
    this.organization = opts.organization;
    this.defaultModel = opts.defaultModel ?? 'gpt-5';
    this.queue = new ProviderQueue({
      concurrency: opts.concurrency ?? 10,
      ...(opts.affinity !== undefined ? { affinity: opts.affinity } : {}),
    });
  }

  async initialize(): Promise<void> {
    if (this.openai) return;
    const mod = await import('openai');
    const OpenAICtor = mod.default ?? (mod as unknown as { OpenAI: typeof OpenAI }).OpenAI;
    const openaiOpts: Record<string, unknown> = { apiKey: this.apiKey };
    if (this.organization) openaiOpts.organization = this.organization;
    this.openai = new OpenAICtor(openaiOpts) as OpenAI;
    log.info('[openai] client initialized');
  }

  async shutdown(): Promise<void> {
    this.openai = null;
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    await this.initialize();
    if (!this.openai) throw new Error('[openai] client not initialized');

    const bridges = await McpBridgePool.fromSessionOpts(opts, '[openai]');
    return new OpenAISession({
      openai: this.openai,
      model: opts.model ?? this.defaultModel,
      reasoningEffort: opts.reasoningEffort,
      systemMessage: opts.systemMessage,
      bridges,
      previousResponseId: opts.openaiPreviousResponseId ?? null,
      queue: this.queue,
      ...(opts.tuning ? { tuning: opts.tuning } : {}),
      ...(opts.externalTools && opts.externalTools.length > 0
        ? { externalTools: opts.externalTools }
        : {}),
      ...(opts.priorMessages && opts.priorMessages.length > 0
        ? { priorMessages: opts.priorMessages }
        : {}),
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.initialize();
    if (!this.openai) throw new Error('[openai] client not initialized');
    const listing = await (
      this.openai as unknown as {
        models: { list: () => Promise<{ data: Array<{ id: string }> }> };
      }
    ).models.list();
    const models: ModelInfo[] = [];
    for (const m of listing.data) {
      if (!isChatModel(m.id)) continue;
      const reasoning = isReasoningModel(m.id);
      models.push({
        id: m.id,
        name: m.id,
        supportsReasoning: reasoning,
        reasoningEfforts: reasoning ? OPENAI_REASONING_EFFORTS : undefined,
        defaultReasoningEffort: reasoning ? 'medium' : undefined,
      });
    }
    // Sort alphabetically so the dropdown is stable run-to-run.
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }
}

/** @internal Exported alongside {@link OpenAISession} for unit tests. */
export interface OpenAISessionDeps {
  openai: OpenAI;
  model: string;
  reasoningEffort?: string;
  systemMessage: string;
  bridges: McpBridgePool;
  /** Pre-existing response id to continue a persisted session. */
  previousResponseId: string | null;
  queue: ProviderQueue;
  /**
   * Caller-supplied external tool definitions. When non-empty, these
   * are advertised to the Responses API alongside any bridge tools.
   * Calls against these names halt the session loop instead of being
   * executed through the bridge — captured via
   * {@link LLMSession.capturedToolCalls}.
   */
  externalTools?: ExternalToolSpec[];
  /**
   * Prior chat history threaded into the Responses API `input` array
   * on the first turn. Required for `/v1/chat/completions` multi-turn
   * (the route creates a fresh session per request); ignored when
   * `previousResponseId` is set (server-side state is already
   * carrying the transcript).
   *
   * Tool roles in this array (`role: 'tool'` with `toolCallId`, or
   * `role: 'assistant'` with `toolCalls`) are translated into
   * Responses API `function_call_output` and `function_call` items
   * respectively, preserving the round-trip shape OpenAI expects.
   */
  priorMessages?: Array<
    | { role: 'user' | 'assistant'; content: string }
    | { role: 'assistant'; content: string; toolCalls: ExternalToolCall[] }
    | { role: 'tool'; content: string; toolCallId: string }
  >;
  /**
   * Resolved per-model tuning. Applied to the Responses API request
   * body via `OPENAI_TUNING_MAP`. Reasoning effort from the tuning
   * block overrides `this.deps.reasoningEffort` when both are set.
   */
  tuning?: import('../model-profile/index.js').ResolvedTuning;
}

/**
 * Exported for unit tests in `openai.tools.test.ts`. Production code
 * uses {@link OpenAIProvider.createSession} which wires the SDK
 * instance + queue + bridges for you.
 *
 * @internal
 */
export class OpenAISession extends StreamingSessionBase implements LLMSession {
  /** `previous_response_id` for server-side state across turns. */
  private previousResponseId: string | null;
  /** Names of caller-supplied external tools — used to classify each function_call. */
  private readonly externalToolNames: Set<string>;
  /** Captured external tool calls from the most recent `sendAndWait`. */
  private capturedCalls: ExternalToolCall[] = [];

  constructor(private readonly deps: OpenAISessionDeps) {
    super();
    this.previousResponseId = deps.previousResponseId ?? null;
    this.externalToolNames = new Set((deps.externalTools ?? []).map((t) => t.name));
  }

  capturedToolCalls(): ExternalToolCall[] {
    return [...this.capturedCalls];
  }

  getRegisteredToolNames(): string[] {
    const bridgeNames = this.deps.bridges.isEmpty()
      ? []
      : this.deps.bridges.getOpenAITools().map((tool) => tool.name);
    return [...new Set([...bridgeNames, ...this.externalToolNames])];
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    // Reset captures — each turn surfaces only its own externals.
    this.capturedCalls = [];

    // The outer loop continues the conversation while the model keeps
    // emitting tool calls. Timeout bounds the entire multi-turn exchange.
    // Clock starts AFTER queue acquire so a queued request doesn't
    // fail from waiting.
    const deadline = Date.now() + (opts?.timeoutMs ?? 120_000);
    const start = Date.now();

    // Tools list combines gezel's MCP bridge tools (existing) with
    // caller-supplied external tools. We tag the external tools so
    // the dispatch loop can distinguish them — same `type: 'function'`
    // shape OpenAI expects.
    const bridgeTools = this.deps.bridges.isEmpty() ? [] : this.deps.bridges.getOpenAITools();
    const externalToolsAsOpenAI = (this.deps.externalTools ?? []).map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters,
    }));
    const tools =
      bridgeTools.length + externalToolsAsOpenAI.length > 0
        ? [...bridgeTools, ...externalToolsAsOpenAI]
        : undefined;

    // First-turn input: when continuing a server-side session (we have
    // a previousResponseId), only the new prompt + attachments go in.
    // Otherwise build the full transcript from priorMessages so
    // `/v1/chat/completions` (which creates a fresh session per
    // request) preserves history.
    let input: unknown = this.previousResponseId
      ? buildInitialInput(prompt, opts?.attachments)
      : this.buildHistoricalInput(prompt, opts?.attachments);
    let fullText = '';
    let lastUsage: {
      input_tokens: number;
      output_tokens: number;
      total_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    } | null = null;

    // Hard bound on tool-call loops so a runaway model can't hang forever.
    for (let turn = 0; turn < 12; turn++) {
      if (Date.now() > deadline) {
        throw new Error(
          `[openai] timed out after ${Math.round((opts?.timeoutMs ?? 120_000) / 1000)}s`,
        );
      }

      const request: Record<string, unknown> = {
        model: this.deps.model,
        input,
        stream: true,
        store: true,
      };
      // `previous_response_id` carries conversation items server-side but
      // NOT `instructions` — the Responses API docs: instructions "will not
      // be carried over to the next response". Omitting them here means the
      // session runs without any system prompt from the second request
      // onward (and about.md edits never reach the model). Re-send every
      // request.
      request.instructions = this.deps.systemMessage;
      if (this.previousResponseId) {
        request.previous_response_id = this.previousResponseId;
      }
      if (tools && tools.length > 0) request.tools = tools;
      if (this.deps.reasoningEffort && isReasoningModel(this.deps.model)) {
        request.reasoning = { effort: this.deps.reasoningEffort };
      }
      // Per-model tuning. Sampling (temperature/top_p/max_tokens/seed/
      // freq+pres penalty), structured output (response_format /
      // json_schema), tool_choice, and a tuning-block effort override
      // land here. A `tuning.reasoning.effort` overwrites the legacy
      // `request.reasoning.effort` set above when both apply.
      if (this.deps.tuning) {
        applyTuning(request, this.deps.tuning, OPENAI_TUNING_MAP);
      }

      const stream = await (
        this.deps.openai as unknown as {
          responses: { stream: (r: unknown) => AsyncIterable<OpenAIStreamEvent> };
        }
      ).responses.stream(request);

      const turnTextParts: string[] = [];
      const pendingCalls: OpenAIToolCall[] = [];
      let responseId: string | null = null;

      for await (const event of stream) {
        const type = event.type;
        if (type === 'response.output_text.delta') {
          const delta = (event as { delta?: string }).delta ?? '';
          if (delta) {
            turnTextParts.push(delta);
            this.emitDelta(delta);
          }
        } else if (type === 'response.output_item.done') {
          const item = (event as { item?: Record<string, unknown> }).item;
          if (item && item.type === 'function_call') {
            pendingCalls.push({
              call_id: (item.call_id as string) ?? '',
              name: (item.name as string) ?? '',
              arguments: (item.arguments as string) ?? '{}',
            });
          }
        } else if (type === 'response.completed') {
          const resp = (
            event as {
              response?: {
                id?: string;
                usage?: {
                  input_tokens: number;
                  output_tokens: number;
                  total_tokens?: number;
                  input_tokens_details?: { cached_tokens?: number };
                };
              };
            }
          ).response;
          if (resp?.id) responseId = resp.id;
          if (resp?.usage) lastUsage = resp.usage;
        }
      }

      if (responseId) this.previousResponseId = responseId;
      fullText += turnTextParts.join('');

      // External tool capture: when the model called any caller-supplied
      // external tool, halt the loop and surface ALL pending calls (both
      // external and bridge) so the caller sees the full set. Any bridge
      // tools the model called alongside externals are NOT executed —
      // the caller owns the next turn and decides how to satisfy each.
      const externalCalls = pendingCalls.filter((c) => this.externalToolNames.has(c.name));
      if (externalCalls.length > 0) {
        this.capturedCalls = pendingCalls.map((c) => ({
          id: c.call_id,
          name: c.name,
          arguments: c.arguments,
        }));
        if (lastUsage) {
          this.emitUsage(
            buildTurnUsage({
              model: this.deps.model,
              inputTokens: lastUsage.input_tokens,
              outputTokens: lastUsage.output_tokens,
              durationMs: Date.now() - start,
              cachedInputTokens: lastUsage.input_tokens_details?.cached_tokens,
            }),
          );
        }
        return fullText;
      }

      if (pendingCalls.length === 0) {
        // Done — record usage and return.
        if (lastUsage) {
          this.emitUsage(
            buildTurnUsage({
              model: this.deps.model,
              inputTokens: lastUsage.input_tokens,
              outputTokens: lastUsage.output_tokens,
              durationMs: Date.now() - start,
              cachedInputTokens: lastUsage.input_tokens_details?.cached_tokens,
            }),
          );
        }
        return fullText;
      }

      // Execute tools; feed the outputs back as the next turn's input.
      const outputs: unknown[] = [];
      const toolImages: Array<{ base64: string; mimeType: string }> = [];
      let terminalActionClosing: string | null = null;
      for (const call of pendingCalls) {
        if (terminalActionClosing) {
          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: TERMINAL_ACTION_SKIPPED_OUTPUT,
          } satisfies ResponsesInputItem);
          continue;
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments);
        } catch {
          /* leave empty */
        }
        let output: string;
        let outputIsError = false;
        if (this.deps.bridges.hasTool(call.name)) {
          try {
            const rich = await this.deps.bridges.callToolRich(call.name, args);
            output = rich.text;
            outputIsError = rich.isError;
            toolImages.push(...rich.images);
          } catch (err) {
            output = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
            outputIsError = true;
          }
        } else {
          output = `ERROR: tool ${call.name} is not available`;
          outputIsError = true;
        }
        if (!outputIsError) {
          terminalActionClosing ??= terminalToolClosingText(undefined, call.name, args, output);
        }
        outputs.push({
          type: 'function_call_output',
          call_id: call.call_id,
          output,
        } satisfies ResponsesInputItem);
      }
      if (terminalActionClosing) {
        if (lastUsage) {
          this.emitUsage(
            buildTurnUsage({
              model: this.deps.model,
              inputTokens: lastUsage.input_tokens,
              outputTokens: lastUsage.output_tokens,
              durationMs: Date.now() - start,
              cachedInputTokens: lastUsage.input_tokens_details?.cached_tokens,
            }),
          );
        }
        return terminalActionClosing;
      }
      // If any tool returned an image block, surface it to the model as a
      // follow-up user-message input_image so vision-capable runs can
      // actually *see* what the tool produced. Text-only runs still get
      // the textual output via the function_call_output items above.
      if (toolImages.length > 0) {
        outputs.push({
          role: 'user',
          content: toolImages.map((img) => ({
            type: 'input_image',
            image_url: `data:${img.mimeType};base64,${img.base64}`,
          })),
        });
      }
      input = outputs;
    }

    throw new Error('[openai] too many tool-call loops; aborting');
  }

  /**
   * Build a Responses API `input` array carrying the full transcript:
   * each prior user/assistant turn, any past function_call /
   * function_call_output items from the tool-calling loop, plus the
   * current user prompt and attachments.
   *
   * Called only on the first turn of a session (when no server-side
   * `previous_response_id` exists). The route's `/v1/chat/completions`
   * flow creates a fresh session per HTTP request, so without this the
   * model would only see the new prompt — losing both the conversation
   * and any in-flight tool-calling state.
   */
  private buildHistoricalInput(prompt: string, attachments?: ImageAttachment[]): unknown {
    const items: unknown[] = [];
    for (const msg of this.deps.priorMessages ?? []) {
      if (msg.role === 'tool') {
        items.push({
          type: 'function_call_output',
          call_id: msg.toolCallId,
          output: msg.content,
        });
        continue;
      }
      if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls.length > 0) {
        // The model's past turn carried tool calls. Emit each as a
        // function_call item so the Responses API knows the conversation
        // state. Any text content is added as a separate assistant
        // message item.
        for (const tc of msg.toolCalls) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments || '{}',
          });
        }
        if (msg.content) {
          items.push({ role: 'assistant', content: msg.content });
        }
        continue;
      }
      // Plain user or assistant text turn.
      items.push({ role: msg.role, content: msg.content });
    }

    // Current prompt. When attachments are present, wrap as the
    // multi-part content shape OpenAI expects for vision.
    if (attachments && attachments.length > 0) {
      items.push({
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...attachments.map((a) => ({
            type: 'input_image',
            image_url: `data:${a.mimeType};base64,${a.base64}`,
          })),
        ],
      });
    } else if (prompt) {
      items.push({ role: 'user', content: prompt });
    } else if (items.length === 0) {
      // Pathological — no history and no prompt. Fall back to the
      // existing empty-prompt behavior so the caller sees a useful
      // error from the API rather than a silent malformed request.
      return buildInitialInput(prompt, attachments);
    }
    return items;
  }

  providerState(): ProviderSessionState {
    return {
      openaiPreviousResponseId: this.previousResponseId ?? undefined,
    };
  }

  async disconnect(): Promise<void> {
    this.clearHandlers();
    try {
      await this.deps.bridges.stop();
    } catch {
      /* ignore */
    }
    this.previousResponseId = null;
  }
}

interface OpenAIStreamEvent {
  type: string;
}

interface OpenAIToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

interface ResponsesInputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}
