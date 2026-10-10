import { createHash, randomUUID } from 'node:crypto';
import { createLogger, estimateTokens } from '@bendyline/gezel';

const log = createLogger('api-observation');
export interface ApiObservationContext {
  sessionId?: string;
  gezelId?: string;
  projectId?: string;
  taskRef?: string;
  executionMode?: string;
  behaviors?: Array<{ id: string; config?: unknown }>;
  promptSections?: Array<{ name: string; tokens: number; band: string }>;
}
const hash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
export function apiToolSurface(tools: ReadonlyArray<{ name?: string }>) {
  return {
    count: tools.length,
    tokens: estimateTokens(JSON.stringify(tools)),
    names: tools.map((tool) => tool.name ?? ''),
    schemaHash: hash(tools),
  };
}

export function recordRuntimeIntervention(event: {
  sessionId: string;
  taskRef?: string;
  reason: string;
  prompt: string;
  source: 'external' | 'product-runtime';
}): void {
  if (process.env.GEZEL_EVAL_OBSERVE !== '1') return;
  const { prompt, ...details } = event;
  log.info(
    `measurement.intervention ${JSON.stringify({ ...details, status: 'prepared', promptHash: hash(prompt), promptTokens: estimateTokens(prompt) })}`,
  );
}

interface ObservedUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}
interface ObservationEvent {
  type: string;
  response?: { model?: string; usage?: ObservedUsage; incomplete_details?: { reason?: string } };
  message?: { model?: string; usage?: ObservedUsage };
  usage?: ObservedUsage;
  item?: { type: string };
  content_block?: { type: string };
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Observation only: no wire changes, prompt text, tool arguments, secrets, or SDK error bodies. */
export async function* observeApiStream<T>(
  create: () => AsyncIterable<T> | Promise<AsyncIterable<T>>,
  args: {
    provider: 'anthropic' | 'openai';
    request: Record<string, unknown>;
    round: number;
    context?: ApiObservationContext;
  },
): AsyncGenerator<T> {
  if (process.env.GEZEL_EVAL_OBSERVE !== '1') {
    yield* await create();
    return;
  }
  const requestId = randomUUID();
  const startedAt = Date.now();
  const tools = (args.request.tools ?? []) as Array<{ name?: string }>;
  log.info(
    `measurement.api ${JSON.stringify({
      phase: 'request',
      requestId,
      provider: args.provider,
      model: args.request.model,
      round: args.round,
      ...args.context,
      behaviors: args.context?.behaviors?.map((b) => ({ id: b.id, configHash: hash(b.config) })),
      inputHash: hash(args.request.input ?? args.request.messages),
      generation: {
        maxTokens: args.request.max_tokens ?? args.request.max_output_tokens ?? null,
        temperature: args.request.temperature ?? null,
        topP: args.request.top_p ?? null,
        toolChoice: args.request.tool_choice ?? null,
        parallelToolCalls: args.request.parallel_tool_calls ?? null,
      },
      systemHash: hash(args.request.instructions ?? args.request.system),
      systemTokens: estimateTokens(
        JSON.stringify(args.request.instructions ?? args.request.system) ?? '',
      ),
      tools: apiToolSurface(tools),
      reasoning: args.request.reasoning ?? args.request.thinking ?? null,
      outputConfig: args.request.output_config ?? null,
      sdkRetries: null,
    })}`,
  );
  const usage: Record<string, number | null> = {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
  let outcome = 'incomplete';
  let terminalEvent: string | null = null;
  let incompleteReason: string | null = null;
  let responseModel: string | null = null;
  let toolCalls = 0;
  let errorStatus: number | null = null;
  try {
    for await (const event of await create()) {
      const e = event as ObservationEvent;
      if (
        e.type === 'response.completed' ||
        e.type === 'response.failed' ||
        e.type === 'response.incomplete'
      ) {
        outcome = e.type.slice('response.'.length);
        terminalEvent = e.type;
        const reason = e.response?.incomplete_details?.reason;
        if (e.type === 'response.incomplete' && reason) {
          incompleteReason = [
            'max_output_tokens',
            'max_messages',
            'content_filter',
            'steered',
          ].includes(reason)
            ? reason
            : 'other';
        }
        const u = e.response?.usage;
        responseModel = typeof e.response?.model === 'string' ? e.response.model : null;
        if (u)
          Object.assign(usage, {
            inputTokens: number(u.input_tokens),
            outputTokens: number(u.output_tokens),
            cachedInputTokens: number(u.input_tokens_details?.cached_tokens),
            reasoningTokens: number(u.output_tokens_details?.reasoning_tokens),
          });
      }
      if (e.type === 'message_start') {
        responseModel = typeof e.message?.model === 'string' ? e.message.model : null;
        const u = e.message?.usage;
        if (u)
          Object.assign(usage, {
            inputTokens: number(u.input_tokens),
            outputTokens: number(u.output_tokens),
            cachedInputTokens: number(u.cache_read_input_tokens),
            cacheWriteTokens: number(u.cache_creation_input_tokens),
          });
      }
      if (e.type === 'message_delta' && e.usage) usage.outputTokens = number(e.usage.output_tokens);
      if (e.type === 'message_stop') {
        outcome = 'completed';
        terminalEvent = e.type;
      }
      if (e.type === 'error') {
        outcome = 'failed';
        terminalEvent = e.type;
      }
      if (
        (e.type === 'response.output_item.done' && e.item?.type === 'function_call') ||
        (e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
      )
        toolCalls++;
      yield event;
    }
  } catch (error) {
    outcome = 'failed';
    errorStatus = number((error as { status?: unknown })?.status);
    throw error;
  } finally {
    log.info(
      `measurement.api ${JSON.stringify({
        phase: 'result',
        requestId,
        provider: args.provider,
        model: args.request.model,
        responseModel,
        outcome,
        terminalEvent,
        incompleteReason,
        durationMs: Date.now() - startedAt,
        usage,
        toolCalls,
        errorStatus,
        sdkRetries: null,
      })}`,
    );
  }
}

/** Qualification must not acquire another provider, including background helper calls. */
export function assertQualificationProvider(provider: string): void {
  const expected = process.env.GEZEL_EVAL_API_PROVIDER;
  if (
    process.env.GEZEL_EVAL_OBSERVE !== '1' ||
    !['openai', 'anthropic'].includes(expected ?? '') ||
    provider === expected
  )
    return;
  log.info(`measurement.provenance ${JSON.stringify({ provider, expected, status: 'blocked' })}`);
  throw new Error(`Qualification blocked provider ${provider}; expected ${expected}`);
}
