/**
 * Model profile — typed declarations a chat-model carries about its
 * style (reasoning + tool-call format, family) and the runtime
 * behaviors that should apply when it's the active model.
 *
 * The split:
 *   - **Style** is descriptive: "this model's leaked reasoning tends
 *     to use the channel family, prefers function-call tool
 *     invocation, and is in the gemma family." Style fields tell the
 *     runtime what to expect.
 *   - **Behaviors** are prescriptive: "for this model, run the
 *     id-validator wrapper, strip channel tags, capture pre-tool
 *     prose into the reasoning expando." Behaviors tell the runtime
 *     what to do.
 *
 * Style fields are short enums; behavior IDs are strings keyed into
 * the registry that lives in `@bendyline/gezel-service` (the runtime
 * layer). Core only knows the IDs; service knows the implementations.
 *
 * Both fields land on `ChatModelIdentitySchema` (root manifest) so
 * they're stable across versions — bumping a model's version doesn't
 * change which behaviors apply, just the install payload (sha,
 * filename, etc.). Both are optional so existing manifests parse
 * unchanged; the runtime falls back to a tier-based default profile
 * for any model that doesn't declare a style or behaviors set.
 */
import { z } from 'zod';

/**
 * Vendor-shaped lineage families. Influences reasoning/tool-call
 * format defaults and signals which post-training the runtime can
 * assume. Every catalog manifest declares one explicitly — the
 * substring-from-id inference that lived in `ollama-models.ts`'s
 * `MODEL_FAMILIES_LEAKING_REASONING` list goes away in favor of this
 * field.
 */
export const ModelFamilySchema = z.enum([
  'gemma',
  'qwen',
  'gpt-oss',
  'mistral',
  'llama',
  'deepseek',
  'qwq',
  'phi',
  'nemotron',
  'granite',
  'glm',
  // Meta Superintelligence Labs' Muse line (Muse Spark, and Muse Glimmer
  // distilled from it). Deliberately NOT folded into `llama`: it is a
  // separate architecture with its own chat format (Harmony-style
  // `<|start|>role<|message|>` channels) and tool-call grammar (ATEM XML),
  // so a `llama` label here would tell the runtime to assume post-training
  // this family does not have.
  'muse',
  'other',
]);
export type ModelFamily = z.infer<typeof ModelFamilySchema>;

/**
 * How the model tends to wrap chain-of-thought reasoning when it
 * leaks into visible output. This is descriptive: it drives the
 * salvage-side extractor that pulls reasoning out of persisted
 * bubbles. Prompt guidance should stay format-neutral unless the
 * provider exposes a native private-reasoning control.
 *
 *   - `think`: `<think>...</think>` (Qwen, DeepSeek-R1, QwQ default)
 *   - `channel`: gpt-oss-style `<|channel|>analysis<|message|>...<|end|>` (Gemma 3/4, GPT-OSS)
 *   - `inline`: bare prose, captured heuristically (model emits "thought\n…", "Plan:", etc.)
 *   - `none`: model is not expected to emit chain-of-thought (frontier-style strict surface)
 */
export const ReasoningFormatSchema = z.enum(['think', 'channel', 'inline', 'none']);
export type ReasoningFormat = z.infer<typeof ReasoningFormatSchema>;

/**
 * How the model emits tool calls when it's not using the canonical
 * function-calling channel. The salvage layer uses this to pick a
 * dedicated parser for fabricated calls (e.g. Gemma's special-token
 * `call:NAME{key:<|"|>value}` shape).
 *
 *   - `function-call`: canonical OpenAI/MCP function-calling channel
 *   - `qwen-xml`: `<tool_call>...</tool_call>`
 *   - `hermes`: `<function=name><parameter=key>val</parameter></function>`
 *   - `gemma-special-token`: `call:NAME{key:<|"|>value}`
 *   - `json-envelope`: `{"tool":"...","args":{...}}`
 */
export const ToolCallFormatSchema = z.enum([
  'function-call',
  'qwen-xml',
  'hermes',
  'gemma-special-token',
  'json-envelope',
]);
export type ToolCallFormat = z.infer<typeof ToolCallFormatSchema>;

export const ModelStyleSchema = z.object({
  family: ModelFamilySchema,
  reasoningFormat: ReasoningFormatSchema,
  toolCallFormat: ToolCallFormatSchema,
});
export type ModelStyle = z.infer<typeof ModelStyleSchema>;

/**
 * Behavior ID — the string that keys into the runtime registry. Kept
 * as a bare string in the schema (not a Zod enum) so adding a new
 * behavior in the service package doesn't require a core release;
 * the runtime is the source of truth for which IDs are valid.
 *
 * IDs use a `category.kebab-name` convention so logs and manifests
 * stay readable: `reasoning.strip-channel-tags`,
 * `mcp.validate-ids-strict`, `turn.continuation-budget`, etc.
 */
export const BehaviorIdSchema = z.string().min(1);
export type BehaviorId = z.infer<typeof BehaviorIdSchema>;

/**
 * Manifest-level entry: either a bare id (the common case — most
 * behaviors are switches with no parameters) or `{ id, config }`
 * when the behavior declares a config schema. The runtime
 * normalizes both forms to `{ id, config }` at resolve time and
 * validates `config` against the behavior's Zod schema, so consumers
 * never see the raw union past resolution.
 */
export const BehaviorEntrySchema = z.union([
  BehaviorIdSchema,
  z.object({
    id: BehaviorIdSchema,
    config: z.unknown().optional(),
  }),
]);
export type BehaviorEntry = z.infer<typeof BehaviorEntrySchema>;
