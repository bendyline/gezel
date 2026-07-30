import { z } from 'zod';
import type { ImageAttachment, ProviderName } from '../../providers/types.js';

/**
 * Request schema for `POST /v1/chat/completions`.
 *
 * Mirrors the public-facing subset of OpenAI's Chat Completions API.
 * Sampling fields (`temperature`, `max_tokens`, `top_p`,
 * `presence_penalty`, `frequency_penalty`) and the unsupported-in-v1
 * fields (`tool_choice`, `response_format`) are parsed here but
 * **rejected at the route layer** with a clear `400` rather than silently
 * dropped — sampling is set per-model via tuning, not per-request (yet).
 * `tools` IS honored (forwarded to the provider as external tools).
 *
 * The `model` field carries the gezel provider+model id. Two shapes:
 *   - `"<provider>:<model>"` — fully qualified, e.g. `"llama-cpp:qwen3-4b"`.
 *   - `"<model>"` — bare; the caller relied on a configured default.
 *     Resolved against the user's `config.defaultModel.<provider>` once
 *     the route picks a provider.
 *
 * The actual resolution lives in {@link resolveModelTarget}.
 */
/**
 * OpenAI multimodal content part. A message's `content` field may be
 * either a plain string (legacy) or an array of these parts (current
 * standard). For v1 we accept text and image_url; image_url accepts
 * either an `http(s)://` URL or a `data:image/...;base64,...` URI. The
 * data-URI form is the common case in practice (VS Code's
 * `LanguageModelDataPart`, browser File API, etc.); HTTP URL support
 * is deferred because it requires the daemon to fetch arbitrary URLs
 * with the user's network access — a non-trivial security gate.
 */
const ContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string().min(1),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
]);

const ContentSchema = z.union([z.string(), z.array(ContentPartSchema).min(1)]);

/**
 * One tool definition in OpenAI's `tools[]` shape. We accept the
 * standard `{type: 'function', function: {...}}` envelope; gezel
 * doesn't yet support non-function tools (retrieval / web search are
 * provider-built-in, not caller-supplied).
 */
const ToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(64),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  }),
});

const ToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().default('{}'),
  }),
});

const MessageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('system'),
    content: ContentSchema,
    name: z.string().optional(),
  }),
  // OpenAI's successor to `system` (o-series and newer SDK stacks emit
  // it). Translated identically to `system` — gezel providers have a
  // single system-message channel.
  z.object({
    role: z.literal('developer'),
    content: ContentSchema,
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal('user'),
    content: ContentSchema,
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal('assistant'),
    // Assistant messages carrying only tool_calls may have null content.
    content: ContentSchema.nullable().default(''),
    tool_calls: z.array(ToolCallSchema).optional(),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal('tool'),
    content: z.string(),
    tool_call_id: z.string().min(1),
  }),
]);

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1, 'model is required'),
  messages: z.array(MessageSchema).min(1, 'messages must contain at least one entry'),
  stream: z.boolean().optional(),
  /**
   * OpenAI's `stream_options`. `include_usage: true` opts into the
   * spec's usage-reporting shape: every chunk carries `usage: null`
   * and one extra pre-`[DONE]` chunk carries the final usage with an
   * empty `choices` array. Without it, no usage appears in the stream.
   */
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  // The modern replacement for `max_tokens` — parsed so the sampling
  // guard can name it in the 400 instead of silently stripping it.
  max_completion_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  // Parsed only so the route can return a friendly 400 naming them — the
  // `sampling_params_not_supported_v1` guard in v1-chat.ts rejects the
  // sampling fields rather than honoring them per-request (not yet wired):
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  /** Parsed so the route can reject n>1 loudly — gezel returns one choice. */
  n: z.number().int().positive().optional(),
  user: z.string().optional(),
  /**
   * Caller-supplied tool definitions. Forwarded to the provider as
   * external tools — the provider advertises them to the model but
   * does NOT execute them. On the first model tool call the session
   * halts and we return the calls in OpenAI's tool_calls shape.
   */
  tools: z.array(ToolSchema).optional(),
  /** Reserved for tool_choice steering — not honored in v1; accepted for forward-compat. */
  tool_choice: z.unknown().optional(),
  response_format: z.unknown().optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface ResolvedModelTarget {
  provider: ProviderName;
  /**
   * Provider-native model id. May be undefined when the caller passes
   * a bare provider name (e.g. `"copilot"`) and the provider's own
   * default model selection should kick in.
   */
  model: string | undefined;
  /**
   * The original user-facing string the caller supplied — used in the
   * OpenAI response envelope so the model field round-trips unchanged.
   */
  echoModel: string;
}

const KNOWN_PROVIDERS: readonly ProviderName[] = [
  'copilot',
  'openai',
  'anthropic',
  'anthropic-cli',
  'codex-cli',
  'ollama',
  'llama-cpp',
  'mlx',
];

/**
 * Parse the `model` field into a `(provider, model)` pair. Forward-slash
 * separators are also accepted (`"llama-cpp/qwen3-4b"`) since some
 * OpenAI client libraries normalize colons.
 *
 * Returns `null` when the prefix is unknown — callers should map this
 * to a `404 model_not_found` so the caller can react to the typo
 * without guessing.
 */
/**
 * Detect a `gezel:<id-or-name>` model reference. Returns the bare ref
 * (everything after the colon) when present, `null` otherwise. Callers
 * route via {@link loadGezelTarget} when this matches; everything else
 * falls through to {@link resolveModelTarget}.
 *
 * Why this exists: a gezel encapsulates a persona + tools + a preferred
 * underlying model. `model: 'gezel:<id>'` lets callers (most notably
 * the VS Code Language Model Chat Provider) route through the gezel
 * without needing to know which raw provider it currently uses.
 */
export function parseGezelModelRef(modelField: string): string | null {
  const trimmed = modelField.trim();
  if (!trimmed.startsWith('gezel:')) return null;
  const ref = trimmed.slice('gezel:'.length).trim();
  return ref.length > 0 ? ref : null;
}

export function resolveModelTarget(modelField: string): ResolvedModelTarget | null {
  const trimmed = modelField.trim();
  if (!trimmed) return null;

  // The provider boundary is the FIRST `:` or `/`. We can't split on
  // every colon — model ids like `llama3.1:8b` carry an internal colon
  // that must stay with the model name.
  const colon = trimmed.indexOf(':');
  const slash = trimmed.indexOf('/');
  const sepIdx = colon < 0 ? slash : slash < 0 ? colon : Math.min(colon, slash);

  if (sepIdx < 0) {
    // Bare provider — only valid if the bare string IS a known provider
    // (the caller is asking gezel to pick the provider's default model).
    if (KNOWN_PROVIDERS.includes(trimmed as ProviderName)) {
      return { provider: trimmed as ProviderName, model: undefined, echoModel: modelField };
    }
    return null;
  }
  const providerCandidate = trimmed.slice(0, sepIdx) as ProviderName;
  const model = trimmed.slice(sepIdx + 1).trim();
  if (!KNOWN_PROVIDERS.includes(providerCandidate)) return null;
  return {
    provider: providerCandidate,
    model: model || undefined,
    echoModel: modelField,
  };
}

export interface TranslatedSessionInput {
  systemMessage: string;
  prompt: string;
  priorMessages: Array<
    | { role: 'user' | 'assistant'; content: string }
    | {
        role: 'assistant';
        content: string;
        toolCalls: Array<{ id: string; name: string; arguments: string }>;
      }
    | { role: 'tool'; content: string; toolCallId: string }
  >;
  /**
   * Image attachments extracted from the LAST message's `image_url`
   * parts. Only the last message's images are surfaced because gezel's
   * `SendAndWaitOpts.attachments` applies to the in-flight prompt, not
   * to prior turns. Images on prior turns are silently dropped today;
   * surfacing them would require a session-wide attachment buffer that
   * no provider currently honors. Bare base64 (no data: prefix) — the
   * provider-side formatters reshape this for each backend.
   */
  attachments: ImageAttachment[];
}

/**
 * Variant of {@link translateMessages} that prepends an extra string
 * (the gezel's `about.md` persona) to the system message. The prefix
 * is separated by a blank line so the persona reads as a distinct
 * block above whatever the caller supplied.
 *
 * Used by the `gezel:<id>` model target so the gezel's voice is
 * honored regardless of what the OpenAI-shaped caller put in
 * `messages[0]`.
 */
export function translateMessagesWithPrefix(
  messages: ChatCompletionRequest['messages'],
  systemPrefix: string,
): TranslatedSessionInput {
  const base = translateMessages(messages);
  if (!systemPrefix) return base;
  const sep = base.systemMessage ? '\n\n---\n\n' : '';
  return {
    ...base,
    systemMessage: `${systemPrefix}${sep}${base.systemMessage}`,
  };
}

/**
 * Split an OpenAI `messages[]` array into the three pieces gezel's
 * `LLMSession` consumes:
 *
 *   - `systemMessage` — concatenation of every system message, in
 *     order. Gezel's `SessionOpts.systemMessage` is required (string),
 *     so an empty messages-with-no-system request still works (we
 *     default to `""`).
 *   - `priorMessages` — every non-system message except the very last,
 *     mapped 1:1 to `{role, content}`. These flow through to providers
 *     that need explicit history (Ollama, llama.cpp, MLX, Anthropic CLI).
 *   - `prompt` — the content of the last message, regardless of role.
 *     OpenAI's contract is that the last message drives the new turn.
 *
 * Throws when the last message has no content — the route maps this
 * to `400 empty_prompt`.
 */
export function translateMessages(
  messages: ChatCompletionRequest['messages'],
): TranslatedSessionInput {
  const systems: string[] = [];
  type ConversationEntry =
    | { kind: 'user'; content: string; images: ImageAttachment[] }
    | {
        kind: 'assistant';
        content: string;
        toolCalls?: Array<{ id: string; name: string; arguments: string }>;
      }
    | { kind: 'tool'; content: string; toolCallId: string };
  const conversation: ConversationEntry[] = [];

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      const split = splitContent(msg.content);
      // Image parts on a system message are dropped — providers
      // don't honor images for system messages, and silently
      // including them would surprise the caller.
      if (split.text) systems.push(split.text);
      continue;
    }
    if (msg.role === 'tool') {
      conversation.push({
        kind: 'tool',
        content: msg.content,
        toolCallId: msg.tool_call_id,
      });
      continue;
    }
    if (msg.role === 'assistant') {
      const split = splitContent(msg.content ?? '');
      const toolCalls = msg.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
      conversation.push({
        kind: 'assistant',
        content: split.text,
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }
    // user
    const split = splitContent(msg.content);
    conversation.push({ kind: 'user', content: split.text, images: split.images });
  }

  if (conversation.length === 0) {
    throw new Error('messages must include at least one non-system entry');
  }

  // The "prompt" — the in-flight turn — is the last message that
  // produces a turn-driving payload. For user messages that's the
  // text + images. For tool result messages, the prompt is implicit
  // (the model is being asked to continue with the tool result in
  // hand); we leave the prompt empty so providers seed a synthetic
  // continuation. For assistant tool-call messages, the caller has
  // mis-built the request — assistant turns can't drive a new
  // response.
  const last = conversation[conversation.length - 1]!;

  let prompt = '';
  let attachments: ImageAttachment[] = [];
  let priorEntries: ConversationEntry[];
  if (last.kind === 'user') {
    prompt = last.content;
    attachments = last.images;
    if (!prompt.trim() && attachments.length === 0) {
      throw new Error('the last message has no text or images');
    }
    priorEntries = conversation.slice(0, -1);
  } else if (last.kind === 'tool') {
    // Tool result is the trigger — everything (including this tool
    // result) goes into priorMessages and the prompt is empty.
    priorEntries = conversation;
  } else {
    // Last is an assistant turn. Either the caller forgot to include
    // a follow-up user message, or they're asking us to summarize an
    // assistant turn we already returned. Refuse — it's almost
    // always a request shape mistake.
    throw new Error('the last message cannot be an assistant turn');
  }

  const priorMessages = priorEntries.map((entry) => {
    if (entry.kind === 'tool') {
      return {
        role: 'tool' as const,
        content: entry.content,
        toolCallId: entry.toolCallId,
      };
    }
    if (entry.kind === 'assistant' && entry.toolCalls) {
      return {
        role: 'assistant' as const,
        content: entry.content,
        toolCalls: entry.toolCalls,
      };
    }
    return {
      role: entry.kind as 'user' | 'assistant',
      content: entry.content,
    };
  });

  return {
    systemMessage: systems.join('\n\n'),
    prompt,
    priorMessages,
    attachments,
  };
}

/**
 * Fold `priorMessages` into the prompt text for providers that don't
 * honor explicit history (`LLMProvider.supportsPriorMessages` unset —
 * Copilot and the CLI providers, whose SDK/subprocess owns its own
 * transcript). Without this, a stateless OpenAI-shaped caller replaying
 * the full conversation each request would silently lose everything but
 * the last message.
 *
 * The transcript is rendered as labeled turns above the in-flight
 * prompt. Lossy by design — the provider sees the history as text, not
 * as real turns — but honest history beats silent amnesia. Attachments
 * are untouched (they already ride only on the in-flight prompt).
 */
export function flattenTranscriptIntoPrompt(input: TranslatedSessionInput): TranslatedSessionInput {
  if (input.priorMessages.length === 0) return input;

  const lines: string[] = [];
  for (const m of input.priorMessages) {
    if (m.role === 'tool') {
      lines.push(`Tool result (${m.toolCallId}): ${m.content}`);
    } else if (m.role === 'assistant' && 'toolCalls' in m && m.toolCalls.length > 0) {
      const calls = m.toolCalls.map((tc) => `${tc.name}(${tc.arguments})`).join(', ');
      lines.push(`Assistant: ${m.content}${m.content ? '\n' : ''}[called tools: ${calls}]`);
    } else {
      lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`);
    }
  }

  const transcript = [
    'Conversation so far (replayed because this backend does not accept explicit history):',
    '',
    ...lines,
    '',
  ].join('\n');

  // Tool-result-last requests arrive with an empty prompt (the tool
  // result itself is the trigger); give the model an explicit
  // continuation instruction so the flattened turn still reads as one.
  const prompt = input.prompt.trim()
    ? `${transcript}\nUser: ${input.prompt}`
    : `${transcript}\nContinue the conversation from the results above.`;

  return { ...input, prompt, priorMessages: [] };
}

/**
 * Split a content field (string OR multimodal array) into a plain text
 * representation and an attachment list. Text parts are concatenated in
 * order; image parts are decoded into the bare base64 + mimeType + a
 * synthetic filename. Unknown part types are silently dropped — the
 * Zod schema already rejects them at the request boundary, so they
 * shouldn't appear here, but this keeps the splitter total in case a
 * future schema extension adds a part type before this function is
 * taught to handle it.
 */
function splitContent(
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
      >
    | null,
): { text: string; images: ImageAttachment[] } {
  if (content === null) {
    return { text: '', images: [] };
  }
  if (typeof content === 'string') {
    return { text: content, images: [] };
  }
  const texts: string[] = [];
  const images: ImageAttachment[] = [];
  let imageIndex = 0;
  for (const part of content) {
    if (part.type === 'text') {
      texts.push(part.text);
    } else if (part.type === 'image_url') {
      const decoded = decodeImageDataUrl(part.image_url.url, imageIndex);
      if (decoded) {
        images.push(decoded);
        imageIndex += 1;
      } else {
        // Skip non-data URLs for now (HTTP fetch path is deferred);
        // log via a placeholder so the caller's debugging surfaces the
        // ignored part.
        throw new Error(
          'image_url must be a data: URI (data:image/<mime>;base64,<...>) — HTTP URLs are not supported yet',
        );
      }
    }
  }
  return { text: texts.join('\n'), images };
}

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;

function decodeImageDataUrl(url: string, index: number): ImageAttachment | null {
  const match = DATA_URL_RE.exec(url.trim());
  if (!match) return null;
  const mimeType = match[1]!;
  const base64 = match[2]!.replace(/\s+/g, '');
  if (!base64) return null;
  // Use the mime subtype to pick a friendly default extension; not all
  // mimes carry one obvious extension but for image/* this is fine.
  const ext = mimeType.split('/').pop()?.toLowerCase() ?? 'bin';
  return {
    base64,
    mimeType,
    filename: `image-${index}.${ext}`,
  };
}
