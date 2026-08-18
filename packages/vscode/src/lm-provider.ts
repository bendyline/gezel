import { externalGezelModelId } from '@bendyline/gezel';
import type {
  GezelApp,
  ChatMessage as SdkChatMessage,
  ChatTool as SdkChatTool,
} from '@bendyline/gezel-app-sdk';
import * as vscode from 'vscode';
import type { Logger } from './log.js';

/**
 * VS Code Language Model Chat Provider that surfaces one model per
 * gezel in Copilot Chat's model picker.
 *
 * Architecture:
 *
 *   - We register a SINGLE provider vendor (`gezel`); each gezel
 *     surfaces as a distinct `LanguageModelChatInformation` entry
 *     (id = `gezel:<role>-<name>`, family = the gezel's underlying provider).
 *   - VS Code calls `provideLanguageModelChatResponse` when the user
 *     picks a gezel and sends a message. We forward through the SDK's
 *     `app.chat({ model: 'gezel:<role>-<name>', ... })`, which makes the daemon
 *     load the gezel's persona + provider before invoking inference.
 *   - The provider auto-refreshes its model list via
 *     `onDidChangeLanguageModelChatInformation` when the gezel roster
 *     changes (polled every 30s so newly-created gezels appear in the
 *     picker without a window reload).
 *
 * Per-gezel addressing means a user picking "Gezel: Maya" gets Maya's
 * persona, Maya's preferred underlying model, and Maya's voice — not a
 * raw model with no character. This is what makes the integration feel
 * native rather than "another OpenAI proxy."
 *
 * Tool calling: the underlying `/v1/chat/completions` does not yet
 * forward tool definitions through to the gezel — see Phase 6 deferred
 * work. Capabilities flag `toolCalling: false` until the ephemeral MCP
 * bridge lands.
 */
interface GezelEntry {
  id: string;
  /** Advertised model id from current daemons; older daemons omit it. */
  modelId?: string;
  name: string;
  description?: string;
  role?: string;
  /** Frontmatter override; only present when the gezel pinned a provider. */
  provider?: string;
  /** Frontmatter override; only present when the gezel pinned a model. */
  model?: string;
  /**
   * Server-resolved provider after install defaults kick in. Always
   * present on a current daemon; older daemons (pre-effective-resolution)
   * may omit it — fall back to `provider` then 'gezel' in that case.
   */
  effectiveProvider?: string;
  /**
   * Server-resolved model after install defaults kick in. Absent when
   * neither the gezel nor the install config pinned one (CLI providers
   * are the common case).
   */
  effectiveModel?: string;
}

interface GezelsListResponse {
  object: 'list';
  data: GezelEntry[];
}

const REFRESH_INTERVAL_MS = 30_000;

export class GezelLanguageModelProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastSignature = '';
  /**
   * Re-entrancy guard for the connection-lost path: every chat turn
   * is wrapped in a try/catch that fires the host's `reconnect`
   * callback on detected fetch failures. Without this guard, a fast
   * burst of concurrent turns (Copilot's tool-use loops do this)
   * would queue up N reconnect attempts, each of which tears down
   * the provider that's STILL running the in-flight turns.
   */
  private reconnectInFlight = false;

  constructor(
    private readonly app: GezelApp,
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly logger: Logger,
    /**
     * Fired when the LM provider observes a connection-level fetch
     * failure (undici `TypeError: fetch failed`, ECONNREFUSED, etc.).
     * Used to recover from "daemon process restarted, cached
     * dispatcher points at a dead port" — the most common cause of
     * a second-turn failure after a tool-result round-trip. Provider
     * fires this fire-and-forget; the host rebuilds the connection
     * + re-registers a fresh provider in the background and the
     * user retries their request.
     */
    private readonly onConnectionLost?: () => void | Promise<void>,
  ) {
    this.disposables.push(this._onDidChange);
    this.startBackgroundRefresh();
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const list = await this.fetchGezels().catch((err) => {
      this.logger.warn(
        `provideLanguageModelChatInformation: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [] as GezelEntry[];
    });
    return list.map((g) => toChatInformation(g));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      await this.runChatResponse(model, messages, options, progress, token);
    } catch (err) {
      if (isLikelyConnectionError(err)) {
        // The daemon connection is gone. Most common cause: daemon
        // restarted between the first turn and the tool-result
        // continuation — undici's cached dispatcher still points at
        // the old port + cert. Fire reconnect in the background so
        // the user's NEXT request lands on a healthy connection,
        // and surface a friendly message right now.
        this.scheduleReconnect(err);
        throw new Error(
          'Gezel daemon connection lost — reconnecting in the background. ' +
            'Please retry your request in a moment. ' +
            '(Run "Gezel: Reconnect Daemon" if the issue persists.)',
        );
      }
      throw err;
    }
  }

  /**
   * Inner body of {@link provideLanguageModelChatResponse}. Extracted
   * so the wrapper can blanket-catch network failures without an
   * `if (err.name === 'TypeError') return; …` rebuild of a 60-line
   * try/catch around the streaming loop.
   */
  private async runChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const sdkMessages = vscodeMessagesToOpenAI(messages);
    if (sdkMessages.length === 0) {
      throw new Error('No translatable messages in chat request.');
    }
    const sdkTools = vscodeToolsToSdk(options.tools);
    const stream = await this.app.chat({
      model: model.id, // already `gezel:<role>-<name>`
      messages: sdkMessages,
      stream: true,
      ...(sdkTools && sdkTools.length > 0 ? { tools: sdkTools } : {}),
    });

    // Tool calls in OpenAI's streaming format arrive split across
    // chunks (delta.tool_calls[i].function.arguments accumulates piece
    // by piece). We assemble them here and emit one
    // LanguageModelToolCallPart per completed call when the stream
    // finishes.
    type Acc = { id: string; name: string; arguments: string };
    const accumulators: Record<number, Acc> = {};

    try {
      for await (const chunk of stream) {
        if (token.isCancellationRequested) return;
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          progress.report(new vscode.LanguageModelTextPart(delta.content));
        }
        if (delta.tool_calls) {
          for (const part of delta.tool_calls) {
            // Lookup-or-init the per-index accumulator. Split out of an
            // `??=` expression so the assignment-in-expression lint
            // doesn't trip — same semantics.
            let slot = accumulators[part.index];
            if (!slot) {
              slot = { id: part.id, name: part.function.name, arguments: '' };
              accumulators[part.index] = slot;
            }
            if (part.id) slot.id = part.id;
            if (part.function.name) slot.name = part.function.name;
            if (part.function.arguments) slot.arguments += part.function.arguments;
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Gezel chat failed: ${message}`);
    }

    // Emit assembled tool calls now that the stream is closed. VS Code
    // expects the `input` to be a parsed object, not a JSON string.
    for (const acc of Object.values(accumulators)) {
      let input: object = {};
      if (acc.arguments) {
        try {
          input = JSON.parse(acc.arguments);
        } catch {
          // Malformed arguments — emit the empty object so the call
          // still surfaces; the consumer will see a parse-error path.
        }
      }
      progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, input));
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    // Heuristic: characters / 4 ≈ tokens. The daemon doesn't expose a
    // public token-count endpoint (tokenizer differs per provider), so
    // we use the same rough estimate the gezel UI surfaces in its own
    // context-pressure indicators. Off-by-30% in practice; close enough
    // for VS Code's pre-send budget check.
    const raw = typeof text === 'string' ? text : extractMessageText(text);
    return Math.ceil(raw.length / 4);
  }

  /**
   * Fire the host's reconnect callback exactly once per detected
   * connection-lost event. Subsequent failures during the in-flight
   * reconnect are coalesced — they all observe the same error and
   * suggest the same retry, but only the first one tears down the
   * connection and rebuilds it. The flag is cleared inside the
   * callback's finally so a SECOND, later failure (the user retries
   * 30s later and the reconnect didn't take) can still trigger
   * another recovery attempt.
   */
  private scheduleReconnect(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this.reconnectInFlight) {
      this.logger.warn(
        `lm-provider: connection-lost detected (${message}); reconnect already in flight`,
      );
      return;
    }
    if (!this.onConnectionLost) {
      this.logger.warn(
        `lm-provider: connection-lost detected (${message}); no reconnect callback wired`,
      );
      return;
    }
    this.reconnectInFlight = true;
    this.logger.warn(`lm-provider: connection-lost detected (${message}); firing host reconnect`);
    void Promise.resolve()
      .then(() => this.onConnectionLost?.())
      .catch((reErr) => {
        const m = reErr instanceof Error ? reErr.message : String(reErr);
        this.logger.warn(`lm-provider: host reconnect rejected — ${m}`);
      })
      .finally(() => {
        this.reconnectInFlight = false;
      });
  }

  /**
   * Re-fetch the gezel roster on a slow interval. When the signature
   * (sorted "id|name|provider|model" tuples) changes, emit the
   * change event so VS Code re-queries the model list. Conservative
   * polling — gezel CRUD from the desktop app is rare, and the
   * picker doesn't need sub-second freshness.
   */
  private startBackgroundRefresh(): void {
    const tick = async (): Promise<void> => {
      const list = await this.fetchGezels().catch(() => null);
      if (!list) return;
      // Signature includes the effective fields so the picker refreshes
      // when the user switches the install default model in the desktop
      // app, not just when the gezel's own frontmatter changes.
      const sig = list
        .map(
          (g) =>
            `${g.id}|${g.name}|${g.role ?? ''}|${g.effectiveProvider ?? g.provider ?? ''}|${g.effectiveModel ?? g.model ?? ''}`,
        )
        .sort()
        .join(',');
      if (sig !== this.lastSignature) {
        this.lastSignature = sig;
        this._onDidChange.fire();
      }
    };
    // Run once now so the first emit lands without waiting an interval.
    void tick();
    this.refreshTimer = setInterval(() => void tick(), REFRESH_INTERVAL_MS);
  }

  private async fetchGezels(): Promise<GezelEntry[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/gezels`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      throw new Error(`GET /v1/gezels → HTTP ${res.status}`);
    }
    const body = (await res.json()) as GezelsListResponse;
    return body.data;
  }
}

/**
 * Translate a {@link GezelEntry} to the
 * {@link vscode.LanguageModelChatInformation} shape Copilot Chat
 * expects.
 *
 *   - `id` is what we route the eventual `chat()` call against.
 *     Format: `gezel:<role>-<name>` — the same string the public
 *     `/v1/chat/completions` route accepts.
 *   - `family` carries the gezel's effective provider (after install
 *     defaults) so VS Code's selector matching (`{family: 'copilot'}`)
 *     still works.
 *   - `detail` shows up as right-aligned secondary text in the picker
 *     list (the same slot where stock GPT/Claude entries show their
 *     speed/cost). We surface `<role> · <model>` so users can pick at
 *     a glance: "Farjana · Planner · gpt-4o-mini". When the gezel
 *     pinned its own model, the `(pinned)` tag distinguishes it from
 *     the install default.
 *   - `tooltip` adds the description on hover.
 */
function toChatInformation(g: GezelEntry): vscode.LanguageModelChatInformation {
  const effectiveProvider = g.effectiveProvider ?? g.provider ?? 'gezel';
  const effectiveModel = g.effectiveModel ?? g.model;
  const detail = buildDetail(g, effectiveModel);
  const tooltipParts: string[] = [];
  if (g.role) tooltipParts.push(g.role);
  if (g.description) tooltipParts.push(g.description);
  if (effectiveModel) {
    tooltipParts.push(
      g.model
        ? `Model: ${effectiveModel} (pinned)`
        : `Model: ${effectiveModel} (install default for ${effectiveProvider})`,
    );
  } else {
    tooltipParts.push(`Provider: ${effectiveProvider}`);
  }
  return {
    id: g.modelId ?? externalGezelModelId(g),
    name: `Gezel: ${g.name}`,
    family: effectiveProvider,
    version: '1',
    // Provider/model defaults are conservative — we don't know the
    // backend's actual limits without a per-provider probe, and the
    // daemon enforces real limits regardless of what we declare here.
    maxInputTokens: 128_000,
    maxOutputTokens: 4_096,
    ...(detail ? { detail } : {}),
    ...(tooltipParts.length > 0 ? { tooltip: tooltipParts.join(' — ') } : {}),
    capabilities: {
      // Multimodal images flow through as data: URIs — the SDK
      // translates VS Code's LanguageModelDataPart into OpenAI's
      // image_url content parts and the daemon decodes them into
      // gezel's `ImageAttachment` shape on the way to the provider.
      imageInput: true,
      // Tool calling is wired below — the daemon halts on the first
      // tool call, returns the call to VS Code via this provider, and
      // resumes when VS Code posts the tool result back. Cloud
      // providers (OpenAI / Anthropic / Copilot) flow this through
      // natively; local engines return a clear
      // `tools_not_supported_for_provider` error.
      toolCalling: true,
    },
  };
}

/**
 * Compose the right-aligned `detail` text the picker shows next to
 * the gezel's name. Format: `<role> · <model>`.
 *   - Role only, no model      → "Planner"
 *   - Model only, no role      → "gpt-4o-mini"
 *   - Both                     → "Planner · gpt-4o-mini"
 *   - Neither                  → undefined (caller omits the field)
 *
 * The model shown is the *effective* one — what the daemon would
 * actually dispatch with right now, after install-default resolution.
 * The tooltip on hover disambiguates pinned vs default; the picker
 * itself stays clean.
 */
/**
 * Recognize the shape of an undici fetch-layer failure (vs. a daemon
 * error response that came back as a structured 4xx/5xx). Drives the
 * lm-provider's reconnect-on-connection-lost path.
 *
 * Matches:
 *   - `TypeError` whose message contains "fetch failed" — undici's
 *     wrapper for almost every network-level error: connection
 *     reset, TLS handshake aborted, ECONN* during request.
 *   - Errors with a Node SystemError `code` set to one of the usual
 *     loopback failure codes (the daemon restarted, the port was
 *     reclaimed, the socket got reset mid-request).
 *   - undici hangs an underlying `cause` chain off its TypeError —
 *     walk it so a wrapped ECONNREFUSED still matches.
 *
 * Deliberately does NOT match:
 *   - HTTP 5xx error responses (daemon explicitly returned them —
 *     `GezelSdkError` carries the body, the lm-provider lets them
 *     pass through so VS Code shows the real message).
 *   - AbortError (caller cancelled — VS Code surfaces this cleanly
 *     already; a reconnect would surprise the user).
 */
export function isLikelyConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) return true;
  const code = (err as { code?: unknown }).code;
  if (
    typeof code === 'string' &&
    /^(ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(
      code,
    )
  ) {
    return true;
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return isLikelyConnectionError(cause);
  return false;
}

export function buildDetail(
  g: { role?: string },
  effectiveModel: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (g.role) parts.push(g.role);
  if (effectiveModel) parts.push(effectiveModel);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * Convert VS Code's heterogeneous request messages to the SDK
 * `ChatMessage` shape gezel's `/v1/chat/completions` consumes.
 *
 *   - LanguageModelTextPart → text content.
 *   - LanguageModelDataPart (image/* mime) → image_url part carrying
 *     a `data:<mime>;base64,<...>` URI.
 *   - LanguageModelToolCallPart (on an assistant message) → emits a
 *     `role: 'assistant'` message with `tool_calls[]`, mirroring the
 *     past model turn that requested tools.
 *   - LanguageModelToolResultPart (on a user message) → emits one
 *     `role: 'tool'` message per result, with `tool_call_id`. The
 *     accompanying user text (if any) lands as a separate `role:
 *     'user'` message.
 *
 * Empty messages are dropped silently — VS Code occasionally emits
 * filler turns the daemon shouldn't have to think about.
 */
export function vscodeMessagesToOpenAI(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): SdkChatMessage[] {
  const out: SdkChatMessage[] = [];
  for (const msg of messages) {
    const role = roleFromVsCode(msg.role);

    type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
    const contentParts: Part[] = [];
    const toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value) contentParts.push({ type: 'text', text: part.value });
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (!part.mimeType.startsWith('image/')) continue;
        const base64 = uint8ArrayToBase64(part.data);
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${part.mimeType};base64,${base64}` },
        });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        // Assistant tool-call turn — translate to OpenAI's tool_calls.
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        // User tool-result turn — translate to a separate role:'tool'
        // message. Concatenate any text in the result.content array.
        const text = (part.content as unknown[])
          .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
          .join('');
        toolResults.push({ callId: part.callId, content: text });
      }
    }

    // Tool result parts on a user message: emit a sequence of `role:
    // 'tool'` messages BEFORE any text-only user turn from the same
    // message. The remaining text-only content (if any) becomes the
    // follow-up user message.
    for (const tr of toolResults) {
      out.push({ role: 'tool', content: tr.content, tool_call_id: tr.callId });
    }

    if (toolCalls.length > 0 && role === 'assistant') {
      out.push({
        role: 'assistant',
        content: collapseTextParts(contentParts),
        tool_calls: toolCalls,
      });
      continue;
    }

    if (contentParts.length === 0) continue;
    const collapsed = collapseTextParts(contentParts);
    // Drop messages whose only content is whitespace — they would
    // confuse providers (Ollama in particular treats them as empty
    // turns) and never carry meaning.
    if (typeof collapsed === 'string' && !collapsed.trim()) continue;
    if (role === 'assistant') {
      out.push({ role, content: collapsed });
    } else if (role === 'system' || role === 'user') {
      out.push({ role, content: collapsed });
    }
  }
  return out;
}

/**
 * Collapse text-only multi-part content back to a plain string for
 * readability; keep the array form when images are present.
 */
function collapseTextParts(
  parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>,
):
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  const hasImage = parts.some((p) => p.type === 'image_url');
  if (hasImage) return parts;
  return parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/**
 * Translate VS Code's `LanguageModelChatTool[]` (from the chat
 * request's `tools` option) to the SDK's `ChatTool[]` shape.
 * Tools without a description get the empty string — VS Code requires
 * description but the SDK + daemon allow it to be empty.
 */
function vscodeToolsToSdk(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): SdkChatTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      ...(t.inputSchema && typeof t.inputSchema === 'object'
        ? { parameters: t.inputSchema as Record<string, unknown> }
        : {}),
    },
  }));
}

/**
 * Browser-friendly base64 encoder for `Uint8Array`. `Buffer` is the
 * Node-native path; we fall back to manual chunking for sizes too large
 * for `String.fromCharCode(...)` in one shot.
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(data).toString('base64');
  // 32k characters per chunk keeps us comfortably below the
  // `apply()` argument-list limit in older runtimes.
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < data.length; i += chunkSize) {
    const slice = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function roleFromVsCode(
  role: vscode.LanguageModelChatMessageRole,
): 'user' | 'assistant' | 'system' {
  // System messages in newer VS Code reach the provider as User role
  // with annotation; we still accept the explicit system role for back-
  // compat. Tool roles fold to user (their content carries the result
  // text we just want to feed in as context).
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  return 'user';
}

function extractMessageText(msg: vscode.LanguageModelChatRequestMessage): string {
  return msg.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
    .join('');
}
