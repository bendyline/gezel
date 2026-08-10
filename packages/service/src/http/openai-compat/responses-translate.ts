import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExternalToolSpec } from '../../providers/types.js';
import {
  type ChatCompletionRequest,
  type TranslatedSessionInput,
  translateMessages,
} from './translate.js';

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_LOCAL_TOOL_NAME_LENGTH = 64;

const ToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    TOOL_NAME_PATTERN,
    'tool names may contain only letters, numbers, underscores, and dashes',
  );

const JsonSchemaSchema = z.record(z.string(), z.unknown());

const FunctionToolSchema = z
  .object({
    type: z.literal('function'),
    name: ToolNameSchema,
    description: z.string().optional(),
    parameters: JsonSchemaSchema.default({ type: 'object', properties: {} }),
    strict: z.boolean().optional(),
  })
  .passthrough();

const CustomToolFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }).passthrough(),
  z
    .object({
      type: z.literal('grammar'),
      syntax: z.enum(['lark', 'regex']),
      definition: z.string(),
    })
    .passthrough(),
]);

const CustomToolSchema = z
  .object({
    // `custom` is the current Responses spelling. `freeform` is kept as
    // a compatibility alias for early/custom provider implementations.
    type: z.enum(['custom', 'freeform']),
    name: ToolNameSchema,
    description: z.string().optional(),
    format: CustomToolFormatSchema.optional(),
  })
  .passthrough();

const NamespaceToolSchema = z
  .object({
    type: z.literal('namespace'),
    name: ToolNameSchema.max(64),
    // Codex composes namespace descriptions from plugin/tool guidance; its
    // built-in collaboration namespace already exceeds 1 KiB. Request-body
    // limits protect the route as a whole, so a small per-field cap only
    // rejects legitimate harness traffic.
    description: z.string().optional(),
    tools: z.array(z.union([FunctionToolSchema, CustomToolSchema])).min(1),
  })
  .passthrough();

const ResponseTextPartSchema = z.union([
  z.object({ type: z.literal('input_text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('output_text'), text: z.string() }).passthrough(),
  // A few compatible clients use Chat Completions' spelling in a
  // Responses message. It is text-equivalent, so accepting it is safe.
  z
    .object({ type: z.literal('text'), text: z.string() })
    .passthrough(),
]);

const ResponseMessageSchema = z
  .object({
    type: z.literal('message').optional(),
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string(), z.array(ResponseTextPartSchema)]),
  })
  .passthrough();

const FunctionCallSchema = z
  .object({
    type: z.literal('function_call'),
    call_id: z.string().min(1),
    name: ToolNameSchema,
    namespace: ToolNameSchema.max(64).optional(),
    arguments: z.string().default('{}'),
  })
  .passthrough();

const FunctionCallOutputSchema = z
  .object({
    type: z.literal('function_call_output'),
    call_id: z.string().min(1),
    output: z.union([z.string(), z.array(ResponseTextPartSchema)]),
  })
  .passthrough();

const CustomToolCallSchema = z
  .object({
    type: z.literal('custom_tool_call'),
    call_id: z.string().min(1),
    name: ToolNameSchema,
    namespace: ToolNameSchema.max(64).optional(),
    input: z.string(),
  })
  .passthrough();

const CustomToolCallOutputSchema = z
  .object({
    type: z.literal('custom_tool_call_output'),
    call_id: z.string().min(1),
    name: ToolNameSchema.optional(),
    output: z.union([z.string(), z.array(ResponseTextPartSchema)]),
  })
  .passthrough();

const ResponseInputItemSchema = z.union([
  ResponseMessageSchema,
  FunctionCallSchema,
  FunctionCallOutputSchema,
  CustomToolCallSchema,
  CustomToolCallOutputSchema,
]);

const ToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z
    .object({
      type: z.enum(['function', 'custom']),
      name: ToolNameSchema,
      namespace: ToolNameSchema.max(64).optional(),
    })
    .passthrough(),
]);

const ReasoningSchema = z
  .object({
    effort: z.string().min(1).nullable().optional(),
    summary: z.string().min(1).nullable().optional(),
  })
  .passthrough();

/**
 * Bounded request schema for the Responses subset consumed by Codex.
 *
 * Unknown top-level fields deliberately pass through. Codex currently sends
 * cache, include, and client-metadata hints which do not affect local
 * inference, and rejecting a request merely because a new hint appeared
 * would make the compatibility boundary unnecessarily brittle.
 */
export const ResponsesRequestSchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    instructions: z.string().nullable().optional(),
    input: z.union([z.string().min(1), z.array(ResponseInputItemSchema).min(1)]),
    tools: z
      .array(z.union([FunctionToolSchema, CustomToolSchema, NamespaceToolSchema]))
      .default([]),
    tool_choice: ToolChoiceSchema.default('auto'),
    parallel_tool_calls: z.boolean().nullable().optional(),
    max_output_tokens: z.number().int().positive().nullable().optional(),
    reasoning: ReasoningSchema.nullable().optional(),
    stream: z.boolean().nullable().optional(),
    store: z.boolean().nullable().optional(),
  })
  .passthrough();

export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;
export type ResponsesToolKind = 'function' | 'custom';
export type ResponsesCustomToolFormat = z.infer<typeof CustomToolFormatSchema>;

/** The JSON property used to carry a free-form custom-tool input locally. */
export const CUSTOM_TOOL_INPUT_KEY = 'input' as const;

/**
 * Describes how a flat, local function name maps back onto the Responses
 * wire. Namespaced and custom tools need this sidecar when serializing the
 * model's captured call.
 */
export interface ResponsesToolBinding {
  kind: ResponsesToolKind;
  name: string;
  namespace?: string;
  customFormat?: ResponsesCustomToolFormat;
}

export type TranslatedResponsesToolChoice =
  | { mode: 'auto' | 'none' | 'required' }
  | { mode: 'required'; name: string; kind: ResponsesToolKind };

export interface TranslatedResponsesRequest {
  model: string;
  /** Existing provider/session input shape, including the complete replayed transcript. */
  sessionInput: TranslatedSessionInput;
  /** Flat function-tool surface understood by Gezel's providers. */
  externalTools: ExternalToolSpec[];
  /** Local function name to exact Responses wire identity. */
  toolBindings: Record<string, ResponsesToolBinding>;
  /** Convenience projection for serializers which only distinguish function/custom calls. */
  toolKinds: Record<string, ResponsesToolKind>;
  toolChoice: TranslatedResponsesToolChoice;
  parallelToolCalls?: boolean;
  maxOutputTokens?: number;
  reasoning?: { effort?: string | null; summary?: string | null };
  stream?: boolean;
  store?: boolean;
}

/**
 * Convert one namespaced Responses tool identity into a legal, bounded local
 * function name. Short names remain readable; long names receive a stable
 * hash suffix so truncation cannot silently alias them.
 */
export function flattenResponsesNamespaceToolName(namespace: string, name: string): string {
  const joined = `${namespace}__${name}`;
  if (joined.length <= MAX_LOCAL_TOOL_NAME_LENGTH) return joined;

  const digest = createHash('sha256')
    .update(namespace)
    .update('\0')
    .update(name)
    .digest('hex')
    .slice(0, 12);
  const prefixLength = MAX_LOCAL_TOOL_NAME_LENGTH - digest.length - 2;
  return `${joined.slice(0, prefixLength)}__${digest}`;
}

/** Encode free-form custom input for Gezel's JSON-function tool channel. */
export function wrapCustomToolInput(input: string): string {
  return JSON.stringify({ [CUSTOM_TOOL_INPUT_KEY]: input });
}

/** Decode a captured local JSON-function call back to Responses free-form input. */
export function unwrapCustomToolInput(argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    throw new Error('custom tool arguments must be valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)[CUSTOM_TOOL_INPUT_KEY] !== 'string'
  ) {
    throw new Error(
      `custom tool arguments must contain a string ${CUSTOM_TOOL_INPUT_KEY} property`,
    );
  }
  return (parsed as Record<typeof CUSTOM_TOOL_INPUT_KEY, string>)[CUSTOM_TOOL_INPUT_KEY];
}

/**
 * Translate a parsed Responses request into Gezel's existing stateless
 * session shape. The caller should parse with {@link ResponsesRequestSchema}
 * first; keeping validation separate mirrors the Chat Completions adapter.
 */
export function translateResponsesRequest(req: ResponsesRequest): TranslatedResponsesRequest {
  const registrations = registerTools(req.tools);
  const messages = responsesInputToChatMessages(req.instructions, req.input);
  const sessionInput = translateMessages(messages);
  const toolChoice = translateToolChoice(req.tool_choice, registrations.bindings);

  return {
    model: req.model,
    sessionInput,
    externalTools: registrations.externalTools,
    toolBindings: registrations.bindings,
    toolKinds: Object.fromEntries(
      Object.entries(registrations.bindings).map(([localName, binding]) => [
        localName,
        binding.kind,
      ]),
    ),
    toolChoice,
    ...(req.parallel_tool_calls != null ? { parallelToolCalls: req.parallel_tool_calls } : {}),
    ...(req.max_output_tokens != null ? { maxOutputTokens: req.max_output_tokens } : {}),
    ...(req.reasoning
      ? {
          reasoning: {
            ...(req.reasoning.effort !== undefined ? { effort: req.reasoning.effort } : {}),
            ...(req.reasoning.summary !== undefined ? { summary: req.reasoning.summary } : {}),
          },
        }
      : {}),
    ...(req.stream != null ? { stream: req.stream } : {}),
    ...(req.store != null ? { store: req.store } : {}),
  };
}

interface RegisteredTools {
  externalTools: ExternalToolSpec[];
  bindings: Record<string, ResponsesToolBinding>;
}

function registerTools(tools: ResponsesRequest['tools']): RegisteredTools {
  const externalTools: ExternalToolSpec[] = [];
  const entries: Array<[string, ResponsesToolBinding]> = [];
  const localNames = new Set<string>();

  const register = (
    tool: z.infer<typeof FunctionToolSchema> | z.infer<typeof CustomToolSchema>,
    namespace?: { name: string; description?: string },
  ): void => {
    const localName = namespace
      ? flattenResponsesNamespaceToolName(namespace.name, tool.name)
      : tool.name;
    if (localNames.has(localName)) {
      throw new Error(`duplicate tool name after Responses translation: ${localName}`);
    }
    localNames.add(localName);

    if (tool.type === 'function') {
      externalTools.push({
        name: localName,
        ...(combineDescriptions(namespace?.description, tool.description)
          ? { description: combineDescriptions(namespace?.description, tool.description) }
          : {}),
        parameters: tool.parameters,
      });
      entries.push([
        localName,
        {
          kind: 'function',
          name: tool.name,
          ...(namespace ? { namespace: namespace.name } : {}),
        },
      ]);
      return;
    }

    externalTools.push({
      name: localName,
      ...(combineDescriptions(namespace?.description, tool.description)
        ? { description: combineDescriptions(namespace?.description, tool.description) }
        : {}),
      parameters: customToolParameters(tool.format),
    });
    entries.push([
      localName,
      {
        kind: 'custom',
        name: tool.name,
        ...(namespace ? { namespace: namespace.name } : {}),
        ...(tool.format ? { customFormat: tool.format } : {}),
      },
    ]);
  };

  for (const tool of tools) {
    if (tool.type === 'namespace') {
      for (const child of tool.tools) {
        register(child, {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        });
      }
    } else {
      register(tool);
    }
  }

  return { externalTools, bindings: Object.fromEntries(entries) };
}

function combineDescriptions(namespaceDescription?: string, toolDescription?: string): string {
  return [namespaceDescription, toolDescription]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

function customToolParameters(
  format: ResponsesCustomToolFormat | undefined,
): Record<string, unknown> {
  let description = 'The free-form input to pass to this custom tool.';
  if (format?.type === 'grammar') {
    description += ` Input must conform to this ${format.syntax} grammar:\n${format.definition}`;
  }
  return {
    type: 'object',
    properties: {
      [CUSTOM_TOOL_INPUT_KEY]: { type: 'string', description },
    },
    required: [CUSTOM_TOOL_INPUT_KEY],
    additionalProperties: false,
  };
}

function responsesInputToChatMessages(
  instructions: string | null | undefined,
  input: ResponsesRequest['input'],
): ChatCompletionRequest['messages'] {
  const messages: ChatCompletionRequest['messages'] = [];
  if (instructions) messages.push({ role: 'system', content: instructions });

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  for (const item of input) {
    if (item.type === 'message' || item.type === undefined) {
      messages.push({ role: item.role, content: responseText(item.content) });
      continue;
    }
    if (item.type === 'function_call') {
      appendToolCall(messages, {
        id: item.call_id,
        name: localCallName(item.namespace, item.name),
        arguments: item.arguments,
      });
      continue;
    }
    if (item.type === 'custom_tool_call') {
      appendToolCall(messages, {
        id: item.call_id,
        name: localCallName(item.namespace, item.name),
        arguments: wrapCustomToolInput(item.input),
      });
      continue;
    }
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: responseText(item.output),
      });
      continue;
    }
    throw new Error(`unsupported Responses input item: ${String(item.type)}`);
  }

  return messages;
}

function responseText(content: string | Array<z.infer<typeof ResponseTextPartSchema>>): string {
  if (typeof content === 'string') return content;
  return content.map((part) => part.text).join('\n');
}

function appendToolCall(
  messages: ChatCompletionRequest['messages'],
  call: { id: string; name: string; arguments: string },
): void {
  const toolCall = {
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.arguments },
  };
  const last = messages.at(-1);
  if (last?.role === 'assistant') {
    last.tool_calls = [...(last.tool_calls ?? []), toolCall];
  } else {
    messages.push({ role: 'assistant', content: '', tool_calls: [toolCall] });
  }
}

function localCallName(namespace: string | undefined, name: string): string {
  return namespace ? flattenResponsesNamespaceToolName(namespace, name) : name;
}

function translateToolChoice(
  choice: ResponsesRequest['tool_choice'],
  bindings: Record<string, ResponsesToolBinding>,
): TranslatedResponsesToolChoice {
  if (typeof choice === 'string') return { mode: choice };

  const localName = localCallName(choice.namespace, choice.name);
  const binding = bindings[localName];
  if (!binding || binding.kind !== choice.type) {
    throw new Error(
      `tool_choice references an unknown ${choice.type} tool: ${choice.namespace ? `${choice.namespace}.` : ''}${choice.name}`,
    );
  }
  return { mode: 'required', name: localName, kind: choice.type };
}
