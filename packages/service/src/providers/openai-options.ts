import { createLogger } from '@bendyline/gezel';

const log = createLogger('openai');

/**
 * Per-model `reasoning.effort` contract for the Responses API. /v1/models
 * reports none of this, so it comes from each model's page under
 * https://developers.openai.com/api/docs/models — add a row when OpenAI ships
 * a model whose range differs. First match wins.
 */
interface OpenAIReasoningContract {
  efforts: readonly string[];
  defaultEffort: string;
}

const LOW_TO_MAX = ['low', 'medium', 'high', 'xhigh', 'max'];

const REASONING_CONTRACTS: ReadonlyArray<readonly [RegExp, OpenAIReasoningContract]> = [
  [/^gpt-6\.1-sol(?:-|$)/, { efforts: LOW_TO_MAX, defaultEffort: 'medium' }],
  [/^gpt-6-astra(?:-|$)/, { efforts: LOW_TO_MAX, defaultEffort: 'medium' }],
  [/^gpt-6-(?:sol|luna)(?:-|$)/, { efforts: ['none', ...LOW_TO_MAX], defaultEffort: 'medium' }],
  // A GPT-6 revision without its own row gets the range every one so far accepts.
  [/^gpt-6/, { efforts: LOW_TO_MAX, defaultEffort: 'medium' }],
  [/^gpt-5\.6-/, { efforts: ['none', ...LOW_TO_MAX], defaultEffort: 'medium' }],
  [
    /^gpt-5\.5(?:-|$)/,
    { efforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  ],
  [
    /^gpt-5\.[24](?:-|$)/,
    { efforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'none' },
  ],
  [
    /^gpt-5\.3-codex(?:-|$)/,
    { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
  ],
  [/^gpt-5\.1(?:-|$)/, { efforts: ['none', 'low', 'medium', 'high'], defaultEffort: 'none' }],
  [/^gpt-5/, { efforts: ['minimal', 'low', 'medium', 'high'], defaultEffort: 'medium' }],
  [/^o[134](?:-|$)/, { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }],
];

/** Every effort label any OpenAI surface uses, lowest first. `ultra` is Codex-only. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Families whose ids start with a chat prefix but cannot hold a text conversation. */
const NON_CHAT_MODEL = /-(?:image|realtime|audio|tts|transcribe|live|search|whisper)(?:-|$)/;
const CHAT_MODEL_PREFIXES = ['gpt-', 'o1', 'o3', 'o4', 'chatgpt'];

function reasoningContract(model: string): OpenAIReasoningContract | undefined {
  return REASONING_CONTRACTS.find(([pattern]) => pattern.test(model))?.[1];
}

export function isOpenAIChatModel(id: string): boolean {
  return CHAT_MODEL_PREFIXES.some((p) => id.startsWith(p)) && !NON_CHAT_MODEL.test(id);
}

export function isOpenAIReasoningModel(model: string): boolean {
  return reasoningContract(model) !== undefined;
}

export function openAIReasoningEfforts(model: string): string[] | undefined {
  const contract = reasoningContract(model);
  return contract ? [...contract.efforts] : undefined;
}

export function openAIDefaultReasoningEffort(model: string): string | undefined {
  return reasoningContract(model)?.defaultEffort;
}

/**
 * The closest effort the model accepts, ties going to the higher level: a
 * saved `minimal` runs as `low` on GPT-6 (OpenAI's own migration advice),
 * and `max` runs as `xhigh` on GPT-5.5. Undefined for an unknown label.
 */
export function supportedOpenAIEffort(model: string, effort: string): string | undefined {
  const contract = reasoningContract(model);
  const rank = EFFORT_ORDER.indexOf(effort);
  if (!contract || rank < 0) return undefined;
  if (contract.efforts.includes(effort)) return effort;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of contract.efforts) {
    const distance = Math.abs(EFFORT_ORDER.indexOf(candidate) - rank);
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Fit a Responses request to its model after tuning has been applied: clamp
 * the effort into the model's range, and drop sampling, which reasoning
 * models reject whenever they reason.
 */
export function applyOpenAIModelContract(request: Record<string, unknown>, model: string): void {
  const contract = reasoningContract(model);
  if (!contract) return;
  const reasoning = request.reasoning as { effort?: unknown } | undefined;
  if (typeof reasoning?.effort === 'string') {
    const effort = supportedOpenAIEffort(model, reasoning.effort);
    if (!effort) {
      log.warn(
        `${model} does not support reasoning effort "${reasoning.effort}"; using its default`,
      );
      delete request.reasoning;
    } else if (effort !== reasoning.effort) {
      log.info(
        `${model} does not support reasoning effort "${reasoning.effort}"; using "${effort}"`,
      );
      request.reasoning = { ...reasoning, effort };
    }
  }
  const effective = (request.reasoning as { effort?: string } | undefined)?.effort;
  if ((effective ?? contract.defaultEffort) !== 'none') {
    delete request.temperature;
    delete request.top_p;
  }
}
