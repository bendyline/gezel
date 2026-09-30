/**
 * Hosts the desktop's llama.cpp turn loop (`LlamaCppSession`) on a phone.
 *
 * The loop is written against llama-server: it POSTs `/v1/chat/completions`,
 * reads the SSE stream, and probes `/slots`. On a phone llama.cpp's own chat
 * layer runs inside the app (`PortableInference.chat`), so this module serves
 * those two endpoints from it through an ordinary `fetch` signature. Every
 * request byte, stream event and error body the loop sees is what llama-server
 * would have sent, so the loop needs no phone branch.
 */

import type {
  LocalEngineHost,
  LocalToolDefinition,
  LocalToolExecutor,
  LocalToolOutputBudget,
  ToolGrammarFallback,
} from '../local-loop/engine-host.js';
import { TOOL_GRAMMAR_FALLBACK_ORDER } from '../local-loop/llama-cpp-session.js';
import type { StdioMcpServerSpec } from '../local-loop/mcp-spec.js';
import type { McpToolWrapper, McpToolWrapperContext } from '../local-loop/mcp-wrapper-types.js';
import { coerceArgsToSchema } from '../local-loop/tool-arg-schema-coercion.js';
import { MAX_TOOL_OUTPUT_CHARS, capToolOutput } from '../local-loop/tool-budget.js';
import type { UnresolvedToolFailureLedger } from '../local-loop/unresolved-tool-failure-ledger.js';
import { GEZEL_TOOL_WRAPPERS, behaviorWrappersFor } from '../local-loop/wrappers/index.js';
import type { PortableInference } from '../mobile/inference.js';
import type { ResolvedModelProfile } from '../model-profile/types.js';
import type { MobileEnginePhaseEvent } from '../schemas/mobile-provider.js';
import { canonicalToolName } from '../tools/tool-names.js';
import { ProviderQueue } from './provider-queue.js';

/** Where the loop believes llama-server listens; only this module reads it. */
export const NATIVE_ENGINE_BASE_URL = 'gezel-native://llama-cpp';

/**
 * The desktop's ceiling on one local-engine turn (`OLLAMA_TURN_TIMEOUT_MS`),
 * awake time. Watchdogs inside the loop end a stalled turn long before this.
 */
export const LOCAL_TURN_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export interface NativeChatFetchOptions {
  inference: PortableInference;
  modelId: string;
  contextSize: number;
  /** llama-server's launch settings (`configure_chat`). */
  chatConfig?: Record<string, unknown>;
  /** A fresh request id per HTTP request; the engine admits one at a time. */
  requestId(): string;
  /** Native loading and prompt-processing progress, which llama-server prints to stdout. */
  onPhase?(event: MobileEnginePhaseEvent): void;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * A `fetch` that answers the loop's llama-server requests from the in-app
 * engine. A request that fails before its first chunk answers with
 * llama-server's HTTP status and error body; one that fails mid-stream
 * delivers the error body as an SSE event, as llama-server does.
 */
export function nativeChatFetch(options: NativeChatFetchOptions): typeof fetch {
  const { inference } = options;
  if (!inference.chat) throw new Error('This engine has no structured chat');
  const chat = inference.chat.bind(inference);
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith(NATIVE_ENGINE_BASE_URL)
      ? url.slice(NATIVE_ENGINE_BASE_URL.length)
      : url;
    // No slot table: the loop's decode-progress probe treats this as "unknown"
    // and falls back to its own watchdogs.
    if (path === '/slots') return new Response('Not found', { status: 404 });
    if (path !== '/v1/chat/completions' || init?.method !== 'POST')
      return new Response('Not found', { status: 404 });
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const requestId = options.requestId();
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        void inference.cancel(requestId);
      },
    });
    // One Response per request: constructing another over the same stream
    // throws once the loop's reader has locked it (WebView does this).
    let streaming: Response | undefined;
    const streamingResponse = () => {
      streaming ??= new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
      return streaming;
    };
    let headSettled = false;
    let resolveHead!: (response: Response) => void;
    let rejectHead!: (error: unknown) => void;
    const head = new Promise<Response>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });
    const settle = (response: Response) => {
      if (headSettled) return;
      headSettled = true;
      resolveHead(response);
    };
    let closed = false;
    const close = (error?: Error) => {
      if (closed) return;
      closed = true;
      if (error) controller.error(error);
      else controller.close();
    };
    const onAbort = () => {
      void inference.cancel(requestId);
      if (!headSettled) {
        headSettled = true;
        rejectHead(abortError());
      }
      close(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const send = (chunk: Record<string, unknown>) => {
      if (closed) return;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    };
    chat(
      {
        requestId,
        providerId: 'llama-cpp',
        modelId: options.modelId,
        contextSize: options.contextSize,
        body,
        ...(options.chatConfig ? { chatConfig: options.chatConfig } : {}),
      },
      (chunk) => {
        const error = chunk.error as { code?: unknown } | undefined;
        if (error && typeof error === 'object' && !headSettled) {
          const status = typeof error.code === 'number' && error.code >= 400 ? error.code : 500;
          settle(
            new Response(JSON.stringify(chunk), {
              status,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
          close();
          return;
        }
        if (!headSettled) settle(streamingResponse());
        send(chunk);
      },
      options.onPhase ? { onPhase: options.onPhase } : undefined,
    ).then(
      ({ status }) => {
        signal?.removeEventListener('abort', onAbort);
        if (status === 'ok') {
          if (!headSettled) settle(streamingResponse());
          if (!closed) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          close();
        } else if (status === 'cancelled') {
          if (!headSettled) {
            headSettled = true;
            rejectHead(abortError());
          }
          close(abortError());
        } else {
          // `error` and `timeout` delivered their error body already (a
          // timeout, like a dropped connection, may deliver nothing).
          settle(new Response('The on-device engine stopped', { status: 500 }));
          close();
        }
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', onAbort);
        if (!headSettled) {
          headSettled = true;
          rejectHead(error);
        }
        close(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return head;
  }) as typeof fetch;
}

/**
 * The phone's engine as the loop's host sees it: one in-app llama.cpp engine
 * that the product runtime already serializes, so a request never waits here.
 */
export class PortableEngineHost implements LocalEngineHost {
  readonly name = 'llama-cpp';
  /** Never entered: phone turns pass `bypassQueue`, having already queued. */
  readonly queue = new ProviderQueue({ concurrency: 1 });
  readonly isDisposed = false;
  private forcedToolChoiceUnsupported = false;
  private toolGrammarFloor: { minToolCount: number; tier: ToolGrammarFallback } | null = null;

  get supportsForcedToolChoice(): boolean {
    return !this.forcedToolChoiceUnsupported;
  }

  async acquireExclusiveEngineRequest(): Promise<() => void> {
    return () => {};
  }

  getCacheAdapter(): null {
    return null;
  }

  /** The desktop provider's floor, kept per engine: see `LlamaCppProvider.noteToolGrammarFloor`. */
  noteToolGrammarFloor(toolCount: number, tier: ToolGrammarFallback): void {
    if (tier === 'none' || toolCount <= 0) return;
    const prev = this.toolGrammarFloor;
    const prevRank = prev ? TOOL_GRAMMAR_FALLBACK_ORDER.indexOf(prev.tier) : -1;
    this.toolGrammarFloor = {
      minToolCount: Math.min(prev?.minToolCount ?? toolCount, toolCount),
      tier: TOOL_GRAMMAR_FALLBACK_ORDER.indexOf(tier) > prevRank ? tier : (prev?.tier ?? tier),
    };
  }

  toolGrammarFloorFor(toolCount: number): ToolGrammarFallback {
    const floor = this.toolGrammarFloor;
    return floor && toolCount >= floor.minToolCount ? floor.tier : 'none';
  }

  noteForcedToolChoiceUnsupported(): void {
    this.forcedToolChoiceUnsupported = true;
  }

  _registerActiveSession(): void {}

  _deregisterActiveSession(): void {}
}

/** What one tool call on the phone produced, before the pipeline shapes it. */
export interface PortableToolOutcome {
  text: string;
  isError: boolean;
  /** The schema's findings when the arguments were rejected. */
  validationIssues?: readonly unknown[];
}

/**
 * The spec the gezel-tool wrappers match on. A phone's tools are the gezel-mcp
 * contract served in-process, so the daemon's wrappers for that server apply;
 * nothing launches this command.
 */
export const PORTABLE_GEZEL_TOOL_SPEC: StdioMcpServerSpec = {
  kind: 'stdio',
  command: 'node',
  args: ['@bendyline/gezel-mcp/dist/server.js'],
  env: {},
};

export interface PortableToolExecutorOptions {
  tools: readonly LocalToolDefinition[];
  run(name: string, args: Record<string, unknown>): Promise<PortableToolOutcome>;
  /** The model's resolved behaviors, whose MCP wrappers apply as on the desktop. */
  profile?: Pick<ResolvedModelProfile, 'behaviors'>;
  modelTier: McpToolWrapperContext['modelTier'];
  isMeester: boolean;
  /** Blocks `advance_task_step` behind a tool that keeps failing validation. */
  ledger?: UnresolvedToolFailureLedger;
}

/**
 * The phone's tools behind the loop's executor interface, run through the
 * desktop MCP bridge's per-call pipeline: legacy names resolve, flattened
 * arguments are repaired against the schema, the unresolved-failure ledger
 * and the wrappers' pre-processing run first, a schema rejection reads as the
 * MCP server's validation error and is translated the same way, and results
 * reach the model as the bridge delivers them (`ERROR: <message>` for
 * failures, successes capped to the loop's budget).
 */
export class PortableToolExecutor implements LocalToolExecutor {
  private readonly tools: LocalToolDefinition[];
  private readonly wrappers: readonly McpToolWrapper[];
  private readonly context: McpToolWrapperContext;

  constructor(private readonly options: PortableToolExecutorOptions) {
    const spec = PORTABLE_GEZEL_TOOL_SPEC;
    this.wrappers = [
      ...behaviorWrappersFor(options.profile, spec),
      ...GEZEL_TOOL_WRAPPERS.filter((wrapper) => {
        try {
          return wrapper.matches(spec);
        } catch {
          return false;
        }
      }),
    ];
    this.context = {
      spec,
      cwd: '',
      modelTier: options.modelTier,
      isMeester: options.isMeester,
      hasTool: (name) => this.hasTool(name),
      callTool: async (name, args) => {
        const outcome = await this.options.run(name, args);
        return { text: outcome.text, images: [] };
      },
    };
    let tools = [...options.tools];
    for (const wrapper of this.wrappers) {
      if (!wrapper.decorateTools) continue;
      try {
        tools = wrapper.decorateTools(tools, this.context);
      } catch {
        // A wrapper that cannot decorate leaves the prior list, as on the desktop.
      }
    }
    this.tools = tools;
  }

  isEmpty(): boolean {
    return this.tools.length === 0;
  }

  getOpenAITools(): LocalToolDefinition[] {
    return [...this.tools];
  }

  private resolve(name: string): string | undefined {
    if (this.tools.some((tool) => tool.name === name)) return name;
    const canonical = canonicalToolName(name);
    return this.tools.some((tool) => tool.name === canonical) ? canonical : undefined;
  }

  hasTool(name: string): boolean {
    return this.resolve(name) !== undefined;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: LocalToolOutputBudget,
  ): Promise<string> {
    const toolName = this.resolve(name);
    if (!toolName) throw new Error(`tool "${name}" is not available in this session`);
    const schema = this.tools.find((tool) => tool.name === toolName)?.parameters;
    let effective = args;
    try {
      effective = coerceArgsToSchema(args, schema).args;
    } catch {
      // A coercion fault must not take down a call that would have worked.
    }
    const { ledger } = this.options;
    let rejected = ledger?.blockReason(toolName) ?? null;
    const blockedByLedger = rejected !== null;
    if (rejected === null) {
      for (const wrapper of this.wrappers) {
        if (!wrapper.preProcess) continue;
        try {
          const verdict = await wrapper.preProcess(toolName, effective, this.context);
          if (verdict.kind === 'reject') {
            rejected = verdict.error;
            break;
          }
          if (verdict.args) effective = verdict.args;
        } catch {
          // A throwing wrapper allows the call, as on the desktop.
        }
      }
    }
    let text: string;
    let isError: boolean;
    try {
      if (rejected !== null) {
        text = rejected;
        isError = true;
      } else {
        const outcome = await this.options.run(toolName, effective);
        isError = outcome.isError;
        // Trimmed, as the desktop bridge joins and trims an MCP result's text.
        text = outcome.validationIssues
          ? `MCP error -32602: Input validation error: Invalid arguments for tool ${toolName}: ${JSON.stringify(outcome.validationIssues, null, 2)}`
          : outcome.text.trim();
        for (const wrapper of this.wrappers) {
          try {
            if (!isError && wrapper.postProcess)
              text = (
                await wrapper.postProcess(toolName, effective, { text, images: [] }, this.context)
              ).text;
            else if (isError && wrapper.postProcessError)
              text = await wrapper.postProcessError(
                toolName,
                effective,
                text,
                this.context,
                schema,
              );
          } catch {
            // Fall back to the text so far, as on the desktop.
          }
        }
      }
    } finally {
      for (const wrapper of this.wrappers) {
        try {
          await wrapper.onCallEnd?.(toolName, effective, this.context);
        } catch {
          // Per-call wrapper state must drain even when a wrapper throws.
        }
      }
    }
    if (!blockedByLedger) ledger?.record(toolName, text, isError);
    if (isError) return `ERROR: ${text}`;
    return capToolOutput(text || '(empty)', opts?.budgetChars ?? MAX_TOOL_OUTPUT_CHARS, {
      ...(opts?.numCtxTokens !== undefined ? { numCtxTokens: opts.numCtxTokens } : {}),
    });
  }

  async stop(): Promise<void> {}
}
