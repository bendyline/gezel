import type { ChatModelTuning } from './schemas/model-tuning.js';

/**
 * Chat settings llama-server takes from its launch flags, resolved from a
 * catalog model's tuning. The desktop turns them into `llama-server` argv; a
 * phone hands them to its native chat layer's `configure_chat`. One resolver,
 * so both hosts start the same model the same way.
 */
export interface LlamaCppChatLaunch {
  /** `--reasoning-budget`: the engine-wide cap on private reasoning tokens. */
  reasoningBudgetTokens?: number;
  /** `--chat-template`: a Jinja template replacing the GGUF's own. */
  chatTemplate?: string;
}

/**
 * The catalog's `--reasoning-budget`, or undefined to leave reasoning
 * unrestricted.
 *
 * Why a cap at all: qwen3-family models will think for ~15 K tokens and emit
 * no post-think content on hard prompts (qwen3.6 tankcombat run: 25 min of
 * empty Builder completions, `reasoning-budget: activated,
 * budget=2147483647` — Int32.MAX, the llama-server default).
 *
 * The budget is engine-wide, but the primary worker (Developer/Builder) runs
 * the `thinking-coding` profile, and that profile's budget is the
 * most-demanding active role's intent, so it also bounds the lighter planner
 * profiles. Prefer it so the coding budget is actually delivered; fall back
 * to base tuning when no coding profile sets one (eval-sweep-2026-06-23
 * finding #6: nemotron-nano base 8192 vs coding 6144 never ran at 6144).
 */
export function catalogReasoningBudget(tuning: ChatModelTuning | undefined): number | undefined {
  const budget =
    tuning?.profiles?.['thinking-coding']?.reasoning?.thinkingBudget ??
    tuning?.reasoning?.thinkingBudget;
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : undefined;
}

export function resolveLlamaCppChatLaunch(tuning: ChatModelTuning | undefined): LlamaCppChatLaunch {
  const reasoningBudgetTokens = catalogReasoningBudget(tuning);
  const chatTemplate = tuning?.engine?.llamaCpp?.chatTemplate;
  return {
    ...(reasoningBudgetTokens !== undefined ? { reasoningBudgetTokens } : {}),
    ...(chatTemplate ? { chatTemplate } : {}),
  };
}

/** The launch settings as a native chat layer's `configure_chat` JSON. */
export function llamaCppNativeChatConfig(launch: LlamaCppChatLaunch): Record<string, unknown> {
  return {
    ...(launch.reasoningBudgetTokens !== undefined
      ? { reasoning_budget: launch.reasoningBudgetTokens }
      : {}),
    ...(launch.chatTemplate ? { chat_template: launch.chatTemplate } : {}),
  };
}
