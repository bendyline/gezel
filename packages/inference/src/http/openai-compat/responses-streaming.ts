import { randomUUID } from 'node:crypto';
import type {
  ExternalToolCall,
  ImageAttachment,
  LLMSession,
  SendAndWaitOpts,
  TurnUsage,
} from '../../providers/types.js';
import { unwrapCustomToolInput } from './responses-translate.js';

export type ResponsesToolKind = 'function' | 'custom';

/**
 * Maps a provider-safe local tool name back to the identity advertised on
 * the Responses wire. Namespaces are flattened before local inference, so
 * the serializer needs this sidecar to restore them on output.
 */
export interface ResponsesToolBinding {
  kind: ResponsesToolKind;
  name: string;
  namespace?: string;
}

export interface ResponsesOutputText {
  type: 'output_text';
  text: string;
  annotations: [];
}

export interface ResponsesOutputMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  status: 'in_progress' | 'completed' | 'incomplete';
  content: ResponsesOutputText[];
}

export interface ResponsesFunctionCall {
  id: string;
  type: 'function_call';
  call_id: string;
  name: string;
  namespace?: string;
  arguments: string;
  status: 'in_progress' | 'completed' | 'incomplete';
}

export interface ResponsesCustomToolCall {
  id: string;
  type: 'custom_tool_call';
  call_id: string;
  name: string;
  namespace?: string;
  input: string;
  status: 'in_progress' | 'completed' | 'incomplete';
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesFunctionCall
  | ResponsesCustomToolCall;

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: {
    cached_tokens: number;
    cache_write_tokens: number;
  };
  output_tokens: number;
  output_tokens_details: {
    reasoning_tokens: number;
  };
  total_tokens: number;
}

export type ResponsesStatus = 'in_progress' | 'completed' | 'incomplete' | 'failed' | 'cancelled';

/**
 * Stable subset of the OpenAI Response resource consumed by Codex. Fields
 * that Gezel cannot truthfully populate are represented by their normal
 * null/default values instead of being invented from provider internals.
 */
export interface ResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  completed_at: number | null;
  status: ResponsesStatus;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: 'max_output_tokens' | 'content_filter' } | null;
  instructions: string | null;
  metadata: Record<string, string> | null;
  model: string;
  output: ResponsesOutputItem[];
  output_text: string;
  parallel_tool_calls: boolean;
  previous_response_id: string | null;
  reasoning: { effort?: string | null; summary?: string | null } | null;
  store: boolean;
  temperature: number | null;
  text: { format: { type: 'text' } };
  tool_choice: unknown;
  tools: unknown[];
  top_logprobs: number;
  top_p: number | null;
  truncation: 'auto' | 'disabled';
  max_output_tokens: number | null;
  usage: ResponsesUsage | null;
}

type WithSequence<T> = T & { sequence_number: number };

export type ResponsesStreamEvent =
  | WithSequence<{ type: 'response.created'; response: ResponsesResponse }>
  | WithSequence<{ type: 'response.in_progress'; response: ResponsesResponse }>
  | WithSequence<{
      type: 'response.output_item.added';
      output_index: number;
      item: ResponsesOutputItem;
    }>
  | WithSequence<{
      type: 'response.content_part.added';
      item_id: string;
      output_index: number;
      content_index: 0;
      part: ResponsesOutputText;
    }>
  | WithSequence<{
      type: 'response.output_text.delta';
      item_id: string;
      output_index: number;
      content_index: 0;
      delta: string;
      logprobs: [];
    }>
  | WithSequence<{
      type: 'response.output_text.done';
      item_id: string;
      output_index: number;
      content_index: 0;
      text: string;
      logprobs: [];
    }>
  | WithSequence<{
      type: 'response.content_part.done';
      item_id: string;
      output_index: number;
      content_index: 0;
      part: ResponsesOutputText;
    }>
  | WithSequence<{
      type: 'response.function_call_arguments.delta';
      item_id: string;
      output_index: number;
      delta: string;
    }>
  | WithSequence<{
      type: 'response.function_call_arguments.done';
      item_id: string;
      output_index: number;
      name: string;
      arguments: string;
    }>
  | WithSequence<{
      type: 'response.custom_tool_call_input.delta';
      item_id: string;
      output_index: number;
      delta: string;
    }>
  | WithSequence<{
      type: 'response.custom_tool_call_input.done';
      item_id: string;
      output_index: number;
      input: string;
    }>
  | WithSequence<{
      type: 'response.output_item.done';
      output_index: number;
      item: ResponsesOutputItem;
    }>
  | WithSequence<{ type: 'response.completed'; response: ResponsesResponse }>
  | WithSequence<{ type: 'response.incomplete'; response: ResponsesResponse }>
  | WithSequence<{ type: 'response.failed'; response: ResponsesResponse }>
  | WithSequence<{
      type: 'error';
      code: string | null;
      message: string;
      param: string | null;
    }>;

type ResponsesStreamEventWithoutSequence = ResponsesStreamEvent extends infer Event
  ? Event extends { sequence_number: number }
    ? Omit<Event, 'sequence_number'>
    : never
  : never;

/**
 * Small source-event vocabulary shared by the serializer and route adapter.
 * It deliberately mirrors LLMSession callbacks, rather than depending on
 * the much larger UI ChatEvent union.
 */
export type ResponsesSourceEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_arguments_delta'; name: string; delta: string }
  | { type: 'usage'; usage: Pick<TurnUsage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'> }
  | { type: 'complete'; text: string; toolCalls?: ExternalToolCall[]; incomplete?: boolean }
  | { type: 'error'; message: string; code?: string }
  | { type: 'cancelled' };

export interface ResponsesRequestEcho {
  instructions?: string | null;
  metadata?: Record<string, string> | null;
  parallelToolCalls?: boolean;
  previousResponseId?: string | null;
  reasoning?: { effort?: string | null; summary?: string | null } | null;
  store?: boolean;
  temperature?: number | null;
  toolChoice?: unknown;
  tools?: unknown[];
  topP?: number | null;
  truncation?: 'auto' | 'disabled';
  maxOutputTokens?: number | null;
}

export interface ResponsesSerializerLimits {
  /** Maximum visible assistant text retained in one response. */
  maxOutputTextChars?: number;
  /** Maximum raw JSON argument text retained for one tool call. */
  maxToolArgumentChars?: number;
  /** Maximum output items retained in one response. */
  maxOutputItems?: number;
}

export type ResponsesIdKind =
  | 'response'
  | 'message'
  | 'function_call'
  | 'custom_tool_call'
  | 'call';

export interface ResponsesSerializerOptions {
  model: string;
  responseId?: string;
  createdAt?: number;
  nowSeconds?: () => number;
  idFactory?: (kind: ResponsesIdKind) => string;
  /** Preferred identity map produced by the Responses request translator. */
  toolBindings?: Record<string, ResponsesToolBinding>;
  /** Backward-compatible projections for callers without full bindings. */
  toolKinds?: Record<string, ResponsesToolKind>;
  toolNamespaces?: Record<string, string>;
  echo?: ResponsesRequestEcho;
  limits?: ResponsesSerializerLimits;
}

interface ActiveMessage {
  kind: 'message';
  item: ResponsesOutputMessage;
  outputIndex: number;
  text: string;
}

interface ActiveTool {
  kind: ResponsesToolKind;
  localName: string;
  publicName: string;
  namespace?: string;
  id: string;
  callId: string;
  outputIndex: number | null;
  rawArguments: string;
  announced: boolean;
  completed: boolean;
  item: ResponsesFunctionCall | ResponsesCustomToolCall | null;
}

type ActiveOutput = ActiveMessage | ActiveTool;

const DEFAULT_LIMITS: Required<ResponsesSerializerLimits> = {
  maxOutputTextChars: 4_000_000,
  maxToolArgumentChars: 1_000_000,
  maxOutputItems: 256,
};

class ResponsesSerializationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponsesSerializationLimitError';
  }
}

function defaultIdFactory(kind: ResponsesIdKind): string {
  const prefixes: Record<ResponsesIdKind, string> = {
    response: 'resp',
    message: 'msg',
    function_call: 'fc',
    custom_tool_call: 'ctc',
    call: 'call',
  };
  return `${prefixes[kind]}_${randomUUID()}`;
}

function cloneOutputItem(item: ResponsesOutputItem): ResponsesOutputItem {
  if (item.type === 'message') {
    return {
      ...item,
      content: item.content.map((part) => ({ ...part, annotations: [] })),
    };
  }
  return { ...item };
}

function usageFromTurn(
  usage: Pick<TurnUsage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>,
): ResponsesUsage {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: {
      cached_tokens: usage.cachedInputTokens ?? 0,
      cache_write_tokens: 0,
    },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function customInputFromArguments(argumentsJson: string): string {
  return unwrapCustomToolInput(argumentsJson);
}

/**
 * Stateful Responses output serializer. Every returned event is an immutable
 * snapshot: later deltas never mutate an earlier response.created payload.
 */
export class ResponsesStreamSerializer {
  private readonly model: string;
  private readonly responseId: string;
  private readonly createdAt: number;
  private readonly nowSeconds: () => number;
  private readonly idFactory: (kind: ResponsesIdKind) => string;
  private readonly toolBindings: Record<string, ResponsesToolBinding>;
  private readonly toolKinds: Record<string, ResponsesToolKind>;
  private readonly toolNamespaces: Record<string, string>;
  private readonly echo: ResponsesRequestEcho;
  private readonly limits: Required<ResponsesSerializerLimits>;

  private started = false;
  private terminal = false;
  private sequenceNumber = 0;
  private status: ResponsesStatus = 'in_progress';
  private completedAt: number | null = null;
  private responseError: { code: string; message: string } | null = null;
  private incompleteDetails: ResponsesResponse['incomplete_details'] = null;
  private usage: ResponsesUsage | null = null;
  private output: ResponsesOutputItem[] = [];
  private active: ActiveOutput | null = null;
  private toolStates: ActiveTool[] = [];
  private unnamedToolArguments = '';
  private visibleText = '';

  constructor(options: ResponsesSerializerOptions) {
    this.model = options.model;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.responseId = options.responseId ?? this.idFactory('response');
    this.createdAt = options.createdAt ?? this.nowSeconds();
    this.toolBindings = options.toolBindings ?? {};
    this.toolKinds = options.toolKinds ?? {};
    this.toolNamespaces = options.toolNamespaces ?? {};
    this.echo = options.echo ?? {};
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  get isTerminal(): boolean {
    return this.terminal;
  }

  /** Emit the canonical opening pair exactly once. */
  start(): ResponsesStreamEvent[] {
    if (this.started) return [];
    this.started = true;
    return [
      this.event({ type: 'response.created', response: this.response() }),
      this.event({ type: 'response.in_progress', response: this.response() }),
    ];
  }

  push(source: ResponsesSourceEvent): ResponsesStreamEvent[] {
    if (this.terminal) return [];
    const events = this.start();
    try {
      switch (source.type) {
        case 'text_delta':
          events.push(...this.pushTextDelta(source.delta));
          break;
        case 'tool_arguments_delta':
          events.push(...this.pushToolArgumentsDelta(source.name, source.delta));
          break;
        case 'usage':
          this.usage = usageFromTurn(source.usage);
          break;
        case 'complete':
          events.push(
            ...this.complete(source.text, source.toolCalls ?? [], {
              incomplete: source.incomplete ?? false,
              includeStart: false,
            }),
          );
          break;
        case 'error':
          events.push(...this.fail(source.message, source.code ?? 'server_error', false));
          break;
        case 'cancelled':
          events.push(...this.cancel(false));
          break;
      }
    } catch (error) {
      events.push(...this.fail(errorMessage(error), 'server_error', false));
    }
    return events;
  }

  /** Convenience method matching LLMSession.onDelta. */
  textDelta(delta: string): ResponsesStreamEvent[] {
    return this.push({ type: 'text_delta', delta });
  }

  /** Convenience method matching LLMSession.onToolArgsDelta. */
  toolArgumentsDelta(name: string, delta: string): ResponsesStreamEvent[] {
    return this.push({ type: 'tool_arguments_delta', name, delta });
  }

  /** Convenience method matching LLMSession.onUsage. */
  setUsage(usage: Pick<TurnUsage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens'>): void {
    if (!this.terminal) this.usage = usageFromTurn(usage);
  }

  /**
   * Finalize the response after sendAndWait resolves. Captured tool calls
   * supply stable final argument strings; raw argument callbacks are used
   * for live deltas when the provider exposes them.
   */
  complete(
    text: string,
    toolCalls: ExternalToolCall[] = [],
    options: { incomplete?: boolean; includeStart?: boolean } = {},
  ): ResponsesStreamEvent[] {
    if (this.terminal) return [];
    const events = options.includeStart === false ? [] : this.start();
    try {
      const calls = this.echo.parallelToolCalls === false ? toolCalls.slice(0, 1) : toolCalls;
      events.push(...this.reconcileToolCalls(calls));
      events.push(...this.reconcileFinalText(text));
      events.push(...this.finalizeActive());

      this.terminal = true;
      this.completedAt = this.nowSeconds();
      if (options.incomplete) {
        this.status = 'incomplete';
        this.incompleteDetails = { reason: 'max_output_tokens' };
        events.push(this.event({ type: 'response.incomplete', response: this.response() }));
      } else {
        this.status = 'completed';
        events.push(this.event({ type: 'response.completed', response: this.response() }));
      }
    } catch (error) {
      events.push(...this.fail(errorMessage(error), 'server_error', false));
    }
    return events;
  }

  fail(message: string, code = 'server_error', includeStart = true): ResponsesStreamEvent[] {
    if (this.terminal) return [];
    const events = includeStart ? this.start() : [];
    this.markActiveIncomplete();
    this.terminal = true;
    this.status = 'failed';
    this.completedAt = this.nowSeconds();
    this.responseError = { code, message };
    events.push(
      this.event({ type: 'error', code, message, param: null }),
      this.event({ type: 'response.failed', response: this.response() }),
    );
    return events;
  }

  cancel(includeStart = true): ResponsesStreamEvent[] {
    if (this.terminal) return [];
    const events = includeStart ? this.start() : [];
    this.markActiveIncomplete();
    this.terminal = true;
    this.status = 'cancelled';
    this.completedAt = this.nowSeconds();
    events.push(
      this.event({ type: 'error', code: 'cancelled', message: 'Response cancelled', param: null }),
      this.event({ type: 'response.failed', response: this.response() }),
    );
    return events;
  }

  /** Return an immutable non-streaming response snapshot. */
  response(): ResponsesResponse {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      completed_at: this.completedAt,
      status: this.status,
      error: this.responseError ? { ...this.responseError } : null,
      incomplete_details: this.incompleteDetails ? { ...this.incompleteDetails } : null,
      instructions: this.echo.instructions ?? null,
      metadata: this.echo.metadata ? { ...this.echo.metadata } : null,
      model: this.model,
      output: this.output.map(cloneOutputItem),
      output_text: this.output
        .filter((item): item is ResponsesOutputMessage => item.type === 'message')
        .flatMap((item) => item.content)
        .map((part) => part.text)
        .join(''),
      parallel_tool_calls: this.echo.parallelToolCalls ?? true,
      previous_response_id: this.echo.previousResponseId ?? null,
      reasoning: this.echo.reasoning ? { ...this.echo.reasoning } : null,
      store: this.echo.store ?? false,
      temperature: this.echo.temperature ?? null,
      text: { format: { type: 'text' } },
      tool_choice: this.echo.toolChoice ?? 'auto',
      tools: this.echo.tools ? [...this.echo.tools] : [],
      top_logprobs: 0,
      top_p: this.echo.topP ?? null,
      truncation: this.echo.truncation ?? 'disabled',
      max_output_tokens: this.echo.maxOutputTokens ?? null,
      usage: this.usage
        ? {
            ...this.usage,
            input_tokens_details: { ...this.usage.input_tokens_details },
            output_tokens_details: { ...this.usage.output_tokens_details },
          }
        : null,
    };
  }

  private pushTextDelta(delta: string): ResponsesStreamEvent[] {
    if (!delta) return [];
    const events: ResponsesStreamEvent[] = [];
    if (this.active?.kind !== 'message') {
      events.push(...this.finalizeActive());
      events.push(...this.openMessage());
    }
    const active = this.active;
    if (!active || active.kind !== 'message') return events;

    this.assertTextCapacity(delta.length);
    active.text += delta;
    this.visibleText += delta;
    events.push(
      this.event({
        type: 'response.output_text.delta',
        item_id: active.item.id,
        output_index: active.outputIndex,
        content_index: 0,
        delta,
        logprobs: [],
      }),
    );
    return events;
  }

  private pushToolArgumentsDelta(name: string, delta: string): ResponsesStreamEvent[] {
    if (!delta && !name) return [];
    if (!name) {
      this.assertToolCapacity(this.unnamedToolArguments.length + delta.length);
      this.unnamedToolArguments += delta;
      return [];
    }

    const events: ResponsesStreamEvent[] = [];
    if (
      this.echo.parallelToolCalls === false &&
      this.toolStates.length > 0 &&
      (!this.active || this.active.kind === 'message' || this.active.localName !== name)
    ) {
      return events;
    }
    if (this.active?.kind === 'message') events.push(...this.finalizeActive());
    if (this.active && this.active.kind !== 'message' && this.active.localName !== name) {
      events.push(...this.finalizeActive());
    }
    if (!this.active || this.active.kind === 'message') {
      const buffered = this.unnamedToolArguments;
      this.unnamedToolArguments = '';
      events.push(...this.openTool(name));
      if (buffered) events.push(...this.appendToolArguments(buffered));
    }
    events.push(...this.appendToolArguments(delta));
    return events;
  }

  private openMessage(): ResponsesStreamEvent[] {
    this.assertOutputCapacity();
    const outputIndex = this.output.length;
    const item: ResponsesOutputMessage = {
      id: this.idFactory('message'),
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    };
    this.output.push(item);
    this.active = { kind: 'message', item, outputIndex, text: '' };
    return [
      this.event({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: cloneOutputItem(item),
      }),
      this.event({
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    ];
  }

  private openTool(localName: string, callId?: string): ResponsesStreamEvent[] {
    const binding = this.bindingFor(localName);
    const state: ActiveTool = {
      kind: binding.kind,
      localName,
      publicName: binding.name,
      ...(binding.namespace ? { namespace: binding.namespace } : {}),
      id: this.idFactory(binding.kind === 'custom' ? 'custom_tool_call' : 'function_call'),
      callId: callId ?? this.idFactory('call'),
      outputIndex: null,
      rawArguments: '',
      announced: false,
      completed: false,
      item: null,
    };
    this.active = state;
    this.toolStates.push(state);
    return state.kind === 'function' ? this.announceTool(state) : [];
  }

  private announceTool(state: ActiveTool): ResponsesStreamEvent[] {
    if (state.announced) return [];
    this.assertOutputCapacity();
    const outputIndex = this.output.length;
    const common = {
      id: state.id,
      call_id: state.callId,
      name: state.publicName,
      ...(state.namespace ? { namespace: state.namespace } : {}),
      status: 'in_progress' as const,
    };
    const item: ResponsesFunctionCall | ResponsesCustomToolCall =
      state.kind === 'custom'
        ? { ...common, type: 'custom_tool_call', input: '' }
        : { ...common, type: 'function_call', arguments: '' };
    state.outputIndex = outputIndex;
    state.item = item;
    state.announced = true;
    this.output.push(item);
    return [
      this.event({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: cloneOutputItem(item),
      }),
    ];
  }

  private appendToolArguments(delta: string): ResponsesStreamEvent[] {
    const state = this.active;
    if (!state || state.kind === 'message' || !delta) return [];
    this.assertToolCapacity(state.rawArguments.length + delta.length);
    state.rawArguments += delta;
    if (state.kind === 'custom') {
      // The local provider sees custom tools as `{input: string}` function
      // schemas. Buffer their JSON until completion, then emit the unwrapped
      // free-form input expected by the Responses custom-tool protocol.
      return [];
    }
    if (!state.announced || state.outputIndex === null) return [];
    return [
      this.event({
        type: 'response.function_call_arguments.delta',
        item_id: state.id,
        output_index: state.outputIndex,
        delta,
      }),
    ];
  }

  private finalizeActive(finalArguments?: string): ResponsesStreamEvent[] {
    const active = this.active;
    if (!active) return [];
    this.active = null;
    if (active.kind === 'message') return this.finalizeMessage(active);
    return this.finalizeTool(active, finalArguments);
  }

  private finalizeMessage(active: ActiveMessage): ResponsesStreamEvent[] {
    const part: ResponsesOutputText = {
      type: 'output_text',
      text: active.text,
      annotations: [],
    };
    active.item.status = 'completed';
    active.item.content = [part];
    return [
      this.event({
        type: 'response.output_text.done',
        item_id: active.item.id,
        output_index: active.outputIndex,
        content_index: 0,
        text: active.text,
        logprobs: [],
      }),
      this.event({
        type: 'response.content_part.done',
        item_id: active.item.id,
        output_index: active.outputIndex,
        content_index: 0,
        part: { ...part, annotations: [] },
      }),
      this.event({
        type: 'response.output_item.done',
        output_index: active.outputIndex,
        item: cloneOutputItem(active.item),
      }),
    ];
  }

  private finalizeTool(state: ActiveTool, finalArguments?: string): ResponsesStreamEvent[] {
    if (state.completed) return [];
    const events: ResponsesStreamEvent[] = [];
    const finalRaw = finalArguments ?? state.rawArguments;
    this.assertToolCapacity(finalRaw.length);

    if (!state.announced) events.push(...this.announceTool(state));
    if (!state.item || state.outputIndex === null) return events;

    if (state.kind === 'custom') {
      const input = customInputFromArguments(finalRaw);
      if (input) {
        events.push(
          this.event({
            type: 'response.custom_tool_call_input.delta',
            item_id: state.id,
            output_index: state.outputIndex,
            delta: input,
          }),
        );
      }
      if (state.item.type !== 'custom_tool_call') return events;
      state.item.input = input;
      state.item.status = 'completed';
      events.push(
        this.event({
          type: 'response.custom_tool_call_input.done',
          item_id: state.id,
          output_index: state.outputIndex,
          input,
        }),
      );
    } else {
      if (finalRaw.startsWith(state.rawArguments)) {
        const suffix = finalRaw.slice(state.rawArguments.length);
        if (suffix) {
          events.push(
            this.event({
              type: 'response.function_call_arguments.delta',
              item_id: state.id,
              output_index: state.outputIndex,
              delta: suffix,
            }),
          );
        }
      } else if (!state.rawArguments && finalRaw) {
        events.push(
          this.event({
            type: 'response.function_call_arguments.delta',
            item_id: state.id,
            output_index: state.outputIndex,
            delta: finalRaw,
          }),
        );
      }
      if (state.item.type !== 'function_call') return events;
      state.item.arguments = finalRaw;
      state.item.status = 'completed';
      events.push(
        this.event({
          type: 'response.function_call_arguments.done',
          item_id: state.id,
          output_index: state.outputIndex,
          name: state.publicName,
          arguments: finalRaw,
        }),
      );
    }

    state.completed = true;
    events.push(
      this.event({
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item: cloneOutputItem(state.item),
      }),
    );
    return events;
  }

  private reconcileToolCalls(calls: ExternalToolCall[]): ResponsesStreamEvent[] {
    const events: ResponsesStreamEvent[] = [];
    const matched = new Set<ActiveTool>();
    for (const call of calls) {
      const existing = this.toolStates.find(
        (state) => !matched.has(state) && state.localName === call.name,
      );
      if (existing) {
        matched.add(existing);
        if (!existing.announced) existing.callId = call.id;
        if (!existing.completed) {
          if (this.active === existing) this.active = null;
          events.push(...this.finalizeTool(existing, call.arguments));
        }
        continue;
      }

      if (this.active) events.push(...this.finalizeActive());
      events.push(...this.openTool(call.name, call.id));
      const state = this.active;
      if (state && state.kind !== 'message') {
        this.active = null;
        events.push(...this.finalizeTool(state, call.arguments));
        matched.add(state);
      }
    }

    if (this.active && this.active.kind !== 'message') events.push(...this.finalizeActive());
    this.unnamedToolArguments = '';
    return events;
  }

  private reconcileFinalText(text: string): ResponsesStreamEvent[] {
    if (!text || text === this.visibleText) return [];
    if (text.startsWith(this.visibleText)) {
      return this.pushTextDelta(text.slice(this.visibleText.length));
    }
    // Deltas are authoritative once emitted; replacing them would make the
    // final `done` value disagree with the stream the client accumulated.
    return [];
  }

  private markActiveIncomplete(): void {
    const active = this.active;
    if (!active) return;
    if (active.kind === 'message') {
      active.item.status = 'incomplete';
      active.item.content = [{ type: 'output_text', text: active.text, annotations: [] }];
    } else if (active.item) {
      active.item.status = 'incomplete';
      if (active.item.type === 'function_call') active.item.arguments = active.rawArguments;
      if (active.item.type === 'custom_tool_call') {
        try {
          active.item.input = customInputFromArguments(active.rawArguments);
        } catch {
          active.item.input = active.rawArguments;
        }
      }
    }
    this.active = null;
  }

  private bindingFor(localName: string): ResponsesToolBinding {
    const explicit = this.toolBindings[localName];
    if (explicit) return explicit;
    return {
      kind: this.toolKinds[localName] ?? 'function',
      name: localName,
      ...(this.toolNamespaces[localName] ? { namespace: this.toolNamespaces[localName] } : {}),
    };
  }

  private assertTextCapacity(additionalChars: number): void {
    if (this.visibleText.length + additionalChars > this.limits.maxOutputTextChars) {
      throw new ResponsesSerializationLimitError(
        'Responses output text exceeded the configured limit',
      );
    }
  }

  private assertToolCapacity(totalChars: number): void {
    if (totalChars > this.limits.maxToolArgumentChars) {
      throw new ResponsesSerializationLimitError(
        'Responses tool arguments exceeded the configured limit',
      );
    }
  }

  private assertOutputCapacity(): void {
    if (this.output.length >= this.limits.maxOutputItems) {
      throw new ResponsesSerializationLimitError('Responses output item limit exceeded');
    }
  }

  private event<T extends ResponsesStreamEventWithoutSequence>(event: T): ResponsesStreamEvent {
    return {
      ...event,
      sequence_number: this.sequenceNumber++,
    } as unknown as ResponsesStreamEvent;
  }
}

export interface ResponsesSSEMessage {
  event?: string;
  data: string;
}

export interface ResponsesSSEWriter {
  writeSSE(message: ResponsesSSEMessage): Promise<void>;
}

/** Responses streams name each SSE event after its JSON `type`. */
export function serializeResponsesSseEvent(event: ResponsesStreamEvent): ResponsesSSEMessage {
  return { event: event.type, data: JSON.stringify(event) };
}

export interface RunResponsesOptions
  extends Omit<ResponsesSerializerOptions, 'model' | 'createdAt'> {
  attachments?: ImageAttachment[];
  /** Continue from a replayed external tool result without adding an empty user turn. */
  continueFromToolResult?: boolean;
  /** Abort queued or in-flight provider work when the Responses client disconnects. */
  signal?: AbortSignal;
  /** Receives the raw provider exception for server-side diagnostics only. */
  onProviderError?: (error: unknown) => void;
  /** Reaching this cap without a tool call yields response.incomplete. */
  lengthCapTokens?: number;
}

function sendAndWaitOptions(options: RunResponsesOptions): SendAndWaitOpts | undefined {
  const sendOptions: SendAndWaitOpts = {
    ...(options.attachments && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
    ...(options.continueFromToolResult !== undefined
      ? { continueFromToolResult: options.continueFromToolResult }
      : {}),
    ...(options.signal ? { queue: { lane: 'interactive' as const, signal: options.signal } } : {}),
  };
  return Object.keys(sendOptions).length > 0 ? sendOptions : undefined;
}

function serializerOptions(
  model: string,
  nowSeconds: () => number,
  options: RunResponsesOptions,
): ResponsesSerializerOptions {
  return {
    model,
    createdAt: nowSeconds(),
    nowSeconds,
    ...(options.responseId ? { responseId: options.responseId } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    ...(options.toolBindings ? { toolBindings: options.toolBindings } : {}),
    ...(options.toolKinds ? { toolKinds: options.toolKinds } : {}),
    ...(options.toolNamespaces ? { toolNamespaces: options.toolNamespaces } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    echo: {
      ...options.echo,
      ...(options.echo?.maxOutputTokens === undefined && options.lengthCapTokens !== undefined
        ? { maxOutputTokens: options.lengthCapTokens }
        : {}),
    },
  };
}

function reachedLengthCap(
  usage: Pick<TurnUsage, 'outputTokens'> | null,
  cap: number | undefined,
  hasToolCalls: boolean,
): boolean {
  return (
    !hasToolCalls && cap !== undefined && cap > 0 && usage !== null && usage.outputTokens >= cap
  );
}

/**
 * High-level streaming adapter for the existing LLMSession surface. Writes
 * every event in callback order. Responses streams terminate at the final
 * JSON event followed by EOF; unlike Chat Completions, there is no `[DONE]`
 * sentinel.
 */
export async function runResponsesStreaming(
  session: LLMSession,
  prompt: string,
  echoModel: string,
  sink: ResponsesSSEWriter,
  nowSeconds: () => number,
  options: RunResponsesOptions = {},
): Promise<ResponsesResponse> {
  const serializer = new ResponsesStreamSerializer(
    serializerOptions(echoModel, nowSeconds, options),
  );
  let writes = Promise.resolve();
  const enqueue = (events: ResponsesStreamEvent[]): void => {
    for (const event of events) {
      writes = writes.then(() => sink.writeSSE(serializeResponsesSseEvent(event)));
      // Observe each new tail immediately. A rejecting writeSSE (client gone
      // mid-stream) otherwise sits unhandled until the next enqueue or the
      // final await — and an unowned rejection is fatal daemon-wide. The
      // chain itself still rejects, so `await writes` below keeps surfacing
      // the first failure and later events keep being skipped.
      writes.catch(() => {});
    }
  };

  const usageRef: { value: TurnUsage | null } = { value: null };
  enqueue(serializer.start());
  const unsubscribeDelta = session.onDelta((delta) => enqueue(serializer.textDelta(delta)));
  const unsubscribeUsage = session.onUsage((usage) => {
    usageRef.value = usage;
    serializer.setUsage(usage);
  });
  const unsubscribeToolArguments =
    session.onToolArgsDelta?.((name, delta) =>
      enqueue(serializer.toolArgumentsDelta(name, delta)),
    ) ?? (() => {});

  try {
    const text = await session.sendAndWait(prompt, sendAndWaitOptions(options));
    const toolCalls = session.capturedToolCalls?.() ?? [];
    enqueue(
      serializer.complete(text, toolCalls, {
        incomplete: reachedLengthCap(usageRef.value, options.lengthCapTokens, toolCalls.length > 0),
      }),
    );
  } catch (error) {
    options.onProviderError?.(error);
    enqueue(
      serializer.fail(
        'The model provider failed while generating this response.',
        'provider_error',
      ),
    );
  } finally {
    unsubscribeDelta();
    unsubscribeUsage();
    unsubscribeToolArguments();
  }

  await writes;
  return serializer.response();
}

/**
 * High-level one-shot adapter. Provider failures are represented as a
 * status=failed Response so callers can use the same envelope as streaming.
 */
export async function runResponsesNonStreaming(
  session: LLMSession,
  prompt: string,
  echoModel: string,
  nowSeconds: () => number,
  options: RunResponsesOptions = {},
): Promise<ResponsesResponse> {
  const serializer = new ResponsesStreamSerializer(
    serializerOptions(echoModel, nowSeconds, options),
  );
  const usageRef: { value: TurnUsage | null } = { value: null };
  const unsubscribeUsage = session.onUsage((usage) => {
    usageRef.value = usage;
    serializer.setUsage(usage);
  });
  try {
    const text = await session.sendAndWait(prompt, sendAndWaitOptions(options));
    const toolCalls = session.capturedToolCalls?.() ?? [];
    serializer.complete(text, toolCalls, {
      incomplete: reachedLengthCap(usageRef.value, options.lengthCapTokens, toolCalls.length > 0),
    });
  } finally {
    unsubscribeUsage();
  }
  return serializer.response();
}

/** Serialize an already-materialized source-event sequence for tests/embedders. */
export function serializeNonStreamingResponse(
  sourceEvents: Iterable<ResponsesSourceEvent>,
  options: ResponsesSerializerOptions,
): ResponsesResponse {
  const serializer = new ResponsesStreamSerializer(options);
  for (const event of sourceEvents) serializer.push(event);
  if (!serializer.isTerminal) serializer.complete('');
  return serializer.response();
}
