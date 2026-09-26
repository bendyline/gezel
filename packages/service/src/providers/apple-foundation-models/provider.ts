import { existsSync } from 'node:fs';
import {
  NATIVE_TOOL_LISTINGS,
  type NativeTool,
  type NativeToolListing,
  createAwakeTimeout,
  createLogger,
  decodeNativeToolArguments,
  narrowerNativeListing,
  nativeToolSpecs,
} from '@bendyline/gezel';
import { McpBridgePool } from '../mcp-bridge-pool.js';
import { computeToolBudgetChars } from '../mcp-bridge.js';
import { ProviderQueue, runInQueue } from '../queue.js';
import { StreamingSessionBase } from '../streaming-session.js';
import { terminalToolClosingText } from '../terminal-tool-policy.js';
import type {
  LLMProvider,
  LLMSession,
  ModelInfo,
  ProviderSessionState,
  SendAndWaitOpts,
  SessionOpts,
} from '../types.js';
import { buildTurnUsage } from '../usage-builder.js';
import { AppleFmError, type AppleFmHello, AppleFmHelper } from './helper.js';

const log = createLogger('apple-fm');

export const APPLE_FOUNDATION_MODEL_ID = 'apple-foundation-models';

/**
 * Passive presence for pickers: an Apple silicon Mac with the helper on disk.
 * Whether Apple Intelligence is on is only known by asking the helper, which
 * the provider does when it starts (and Settings' connection test surfaces).
 */
export function appleFoundationModelsInstalled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  const bin = env.GEZEL_APPLE_FM_BIN;
  return platform === 'darwin' && arch === 'arm64' && !!bin && existsSync(bin);
}
const TURN_BUDGET_MS = 300_000;
const MAX_TOOL_CALLS = 12;
const ACTION_LIMIT_TEXT =
  'This turn reached its action limit. Completed actions are saved; send a message to continue.';
const NO_TOOLS_NOTE =
  "\n\n## Tools available this turn\nNone: the tool list does not fit in this model's context. Answer in normal text.";

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

function actionable(message: string): Error {
  const error = new Error(message) as Error & { isActionable?: boolean };
  error.isActionable = true;
  return error;
}

function isContextRefusal(error: unknown): boolean {
  return error instanceof AppleFmError && error.code === 'CONTEXT_LIMIT';
}

/** Key order is not stable across a native decoder's repeated calls. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * Apple's on-device model (Apple Intelligence) on Apple silicon Macs running
 * macOS 26+, through the `gezel-apple-fm` helper. The model is Apple's own:
 * no download, no weights on disk, a small context window (4096 tokens before
 * OS 27). It calls tools through Apple's native tool-calling API; each call
 * comes back here and runs through the session's MCP bridge like any other
 * provider's.
 */
export class AppleFoundationModelsProvider implements LLMProvider {
  readonly name = 'apple-foundation-models' as const;
  readonly supportsPriorMessages = true;
  readonly queue = new ProviderQueue({ concurrency: 1 });
  private readonly helper: AppleFmHelper | null;
  private readonly platformSupported: boolean;
  private hello: AppleFmHello | null = null;

  constructor(
    opts: {
      binaryPath?: string;
      helper?: AppleFmHelper;
      platform?: NodeJS.Platform;
      arch?: string;
    } = {},
  ) {
    const platform = opts.platform ?? process.platform;
    const arch = opts.arch ?? process.arch;
    const binaryPath = opts.binaryPath ?? process.env.GEZEL_APPLE_FM_BIN;
    this.helper =
      opts.helper ??
      (platform === 'darwin' && arch === 'arm64' && binaryPath
        ? new AppleFmHelper({ binaryPath })
        : null);
    this.platformSupported = platform === 'darwin' && arch === 'arm64';
  }

  async initialize(): Promise<void> {
    if (this.hello?.available) return;
    if (!this.platformSupported)
      throw actionable('Apple on-device AI is only available on Apple silicon Macs.');
    if (!this.helper)
      throw actionable(
        'Apple on-device AI is not installed with this build of Gezel (the gezel-apple-fm helper is missing).',
      );
    const hello = await this.helper.ready();
    this.hello = hello;
    if (!hello.available)
      throw actionable(hello.reason ?? 'Apple on-device AI is unavailable on this Mac.');
    log.info(
      `[apple-fm] ready: helper ${hello.version}, ${hello.os}, context ${hello.contextTokens} tokens`,
    );
  }

  async shutdown(): Promise<void> {
    await this.helper?.shutdown();
    this.hello = null;
  }

  getEffectiveModelId(): string {
    return APPLE_FOUNDATION_MODEL_ID;
  }

  getContextWindow(): number | undefined {
    return this.hello?.contextTokens;
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.initialize();
    return [
      {
        id: APPLE_FOUNDATION_MODEL_ID,
        name: 'Apple on-device model',
        contextWindow: this.hello!.contextTokens,
        supportsTools: true,
      },
    ];
  }

  async createSession(opts: SessionOpts): Promise<LLMSession> {
    await this.initialize();
    const bridges = await McpBridgePool.fromSessionOpts(opts, '[apple-fm]');
    const history: Message[] = [];
    for (const message of opts.priorMessages ?? []) {
      // Apple's transcript only takes text turns here; earlier tool traffic
      // is represented by the assistant text that followed it.
      if (message.role === 'tool' || !message.content) continue;
      history.push({ role: message.role, content: message.content });
    }
    return new AppleFoundationSession({
      helper: this.helper!,
      queue: this.queue,
      bridges,
      systemMessage: opts.systemMessage,
      history,
      contextTokens: this.hello!.contextTokens,
      maxTokens: Math.min(
        this.hello!.maxOutputTokens,
        opts.tuning?.sampling?.maxTokens ?? this.hello!.maxOutputTokens,
      ),
      ...(opts.terminalToolPolicy ? { terminalToolPolicy: opts.terminalToolPolicy } : {}),
    });
  }
}

/** @internal Exported for unit tests. */
export interface AppleFoundationSessionDeps {
  helper: AppleFmHelper;
  queue: ProviderQueue;
  bridges: McpBridgePool;
  systemMessage: string;
  history: Message[];
  contextTokens: number;
  maxTokens: number;
  terminalToolPolicy?: SessionOpts['terminalToolPolicy'];
}

/** @internal Exported for unit tests. */
export class AppleFoundationSession extends StreamingSessionBase implements LLMSession {
  readonly model = APPLE_FOUNDATION_MODEL_ID;
  readonly numCtx: number;
  private systemMessage: string;
  private readonly history: Message[];
  /** Where this conversation last fitted; later turns start there. */
  private listing: NativeToolListing = 'full';

  constructor(private readonly deps: AppleFoundationSessionDeps) {
    super();
    this.numCtx = deps.contextTokens;
    this.systemMessage = deps.systemMessage;
    this.history = [...deps.history];
  }

  setSystemMessage(message: string): void {
    this.systemMessage = message;
  }

  getRegisteredToolNames(): string[] {
    return this.deps.bridges.isEmpty()
      ? []
      : this.deps.bridges.getOpenAITools().map((tool) => tool.name);
  }

  estimatePromptChars(): number {
    return this.history.reduce((sum, m) => sum + m.content.length, this.systemMessage.length);
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    const started = Date.now();
    const timeout = createAwakeTimeout(opts?.timeoutMs ?? TURN_BUDGET_MS);
    const signal = opts?.queue?.signal
      ? AbortSignal.any([opts.queue.signal, timeout.signal])
      : timeout.signal;
    const inventory = this.deps.bridges.isEmpty()
      ? []
      : this.deps.bridges.getOpenAITools().map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        }));
    let history = [...this.history];
    let listing: NativeToolListing = NATIVE_TOOL_LISTINGS.includes(this.listing)
      ? this.listing
      : 'full';
    let droppedHistory = false;
    let text = '';
    let calls = 0;
    let ended: string | null = null;
    const failures = new Map<string, number>();
    // Apple's model issues calls in parallel (it wrote a file in the same
    // breath as reading its source). One at a time keeps each result in view.
    let serial: Promise<unknown> = Promise.resolve();

    const runTool = async (name: string, rawArgs: string, tools: NativeTool[]) => {
      if (ended !== null) return { output: '', endTurn: true };
      if (++calls > MAX_TOOL_CALLS) {
        ended = ACTION_LIMIT_TEXT;
        return { output: '', endTurn: true };
      }
      const spec = tools.find((tool) => tool.name === name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawArgs);
      } catch {
        parsed = {};
      }
      const decoded = spec ? decodeNativeToolArguments(spec.parameters, parsed) : parsed;
      const args =
        decoded && typeof decoded === 'object' && !Array.isArray(decoded)
          ? (decoded as Record<string, unknown>)
          : {};
      let output: string;
      let isError = false;
      if (this.deps.bridges.hasTool(name)) {
        try {
          const rich = await this.deps.bridges.callToolRich(name, args, {
            budgetChars: computeToolBudgetChars(
              this.deps.contextTokens,
              this.systemMessage.length + history.reduce((n, m) => n + m.content.length, 0),
            ),
            numCtxTokens: this.deps.contextTokens,
          });
          output = rich.text;
          isError = rich.isError;
        } catch (err) {
          output = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
      } else {
        output = `ERROR: tool ${name} is not available`;
        isError = true;
      }
      if (isError) {
        const key = `${name}\n${stableJson(args)}\n${output}`;
        const count = (failures.get(key) ?? 0) + 1;
        failures.set(key, count);
        if (count >= 3) {
          ended = `Stopped: the same ${name} call failed three times (${output.slice(0, 200)}). Add detail or rephrase, then try again.`;
          return { output, endTurn: true };
        }
      } else {
        const closing = terminalToolClosingText(this.deps.terminalToolPolicy, name, args, output);
        if (closing) {
          ended = closing;
          return { output, endTurn: true };
        }
      }
      return { output };
    };

    try {
      for (;;) {
        const tools = nativeToolSpecs(inventory, listing);
        const messages: Message[] = [
          {
            role: 'system',
            content: `${this.systemMessage}${inventory.length && listing === 'none' ? NO_TOOLS_NOTE : ''}`,
          },
          ...history,
          { role: 'user', content: prompt },
        ];
        try {
          const stopReason = await this.deps.helper.generate(
            {
              messages,
              tools,
              maxTokens: this.deps.maxTokens,
              contextSize: this.deps.contextTokens,
            },
            {
              onDelta: (chunk) => {
                text += chunk;
                this.emitDelta(chunk);
              },
              onToolCall: (call) => {
                const next = serial.then(() => runTool(call.name, call.arguments, tools));
                serial = next.catch(() => {});
                return next;
              },
            },
            signal,
          );
          if (stopReason === 'cancelled' && timeout.signal.aborted && ended === null)
            throw new Error(
              `Apple on-device AI timed out after ${Math.round((opts?.timeoutMs ?? TURN_BUDGET_MS) / 1000)}s.`,
            );
          await this.reportUsage(messages, tools, text, started);
          break;
        } catch (error) {
          // The helper refuses an oversized prompt before generating anything,
          // so these retries cannot repeat an action.
          if (!isContextRefusal(error) || calls > 0 || text) throw error;
          const narrower = narrowerNativeListing(inventory, listing);
          if (narrower && narrower !== 'none') {
            listing = narrower;
            continue;
          }
          if (history.length > 0) {
            history = history.slice(Math.min(2, history.length));
            if (!droppedHistory) {
              droppedHistory = true;
              this.emitWarning(
                "Earlier messages no longer fit Apple's on-device context; this reply sees only the most recent part of the conversation.",
              );
            }
            continue;
          }
          if (narrower) {
            listing = narrower;
            continue;
          }
          throw actionable(
            "This message is too long for Apple's on-device model. Shorten it or start a new conversation.",
          );
        }
      }
    } finally {
      timeout.dispose();
    }

    this.listing = listing;
    const reply = ended ?? text;
    this.history.splice(0, this.history.length, ...history, { role: 'user', content: prompt });
    if (reply) this.history.push({ role: 'assistant', content: reply });
    return reply;
  }

  /** Input tokens are exact where the OS can count them (macOS 26.4+). */
  private async reportUsage(
    messages: Message[],
    tools: NativeTool[],
    text: string,
    started: number,
  ): Promise<void> {
    let inputTokens = 0;
    try {
      inputTokens = await this.deps.helper.countTokens(messages, tools);
    } catch {
      inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    }
    this.emitUsage(
      buildTurnUsage({
        model: APPLE_FOUNDATION_MODEL_ID,
        inputTokens,
        outputTokens: Math.ceil(text.length / 4),
        durationMs: Date.now() - started,
        contextUtilization: { used: inputTokens, limit: this.deps.contextTokens },
      }),
    );
  }

  providerState(): ProviderSessionState {
    return {};
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
