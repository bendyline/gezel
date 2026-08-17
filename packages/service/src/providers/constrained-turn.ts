/**
 * Constrained-turn detection and shaping, shared by the local engines.
 *
 * A local model that has stalled needs the turn narrowed, not more rope: a
 * single-tool surface, a forced call, a floored token budget, cool sampling,
 * and reasoning turned down. llama-cpp grew that rescue layer over many
 * incidents; MLX hand-copied one predicate early and then drifted.
 *
 * The drift was not cosmetic. MLX's private `isImmediateFileWriteTurn`
 * required `tools.length === 1` — a surface only produced by the very
 * narrowing MLX never implemented — so its immediate-write rescue could
 * essentially never fire. Measured 2026-08-16 across 30 paired trials of
 * qwen3.8-27b-q4: zero MLX turns entered the branch, while MLX ran 8.7x
 * llama-cpp's median time-to-first-artifact (645s vs 74s, p<0.001).
 *
 * Everything here is pure so both turn loops can call it without inheriting
 * each other's state tracking. llama-cpp is the reference semantics; when
 * these need to change, change them here rather than in one provider.
 */
import { downgradeReasoningDepthKwargs } from './reasoning-depth.js';

/**
 * Structural tool shape shared by the local providers.
 *
 * Deliberately not `openai`'s `ChatCompletionTool`: both engines declare their
 * own narrower interface and pass those values around, so widening here would
 * force casts at every call site. Only `function.name` is read.
 */
export interface LocalChatCompletionTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export function chatCompletionToolName(tool: LocalChatCompletionTool): string | undefined {
  return tool.function.name;
}

export function hasWriteFileTool(tools: LocalChatCompletionTool[] | undefined): boolean {
  return tools?.some((tool) => chatCompletionToolName(tool) === 'write_file') ?? false;
}

/** Narrow the surface to `write_file` alone. Empty when the tool is absent. */
export function writeFileOnlyTools(
  tools: LocalChatCompletionTool[] | undefined,
): LocalChatCompletionTool[] {
  const writeFile = tools?.find((tool) => chatCompletionToolName(tool) === 'write_file');
  return writeFile ? [writeFile] : [];
}

/** Narrow the surface to `read_file` alone. Empty when the tool is absent. */
export function readFileOnlyTools(
  tools: LocalChatCompletionTool[] | undefined,
): LocalChatCompletionTool[] {
  const readFile = tools?.find((tool) => chatCompletionToolName(tool) === 'read_file');
  return readFile ? [readFile] : [];
}

/**
 * A repair turn where the harness has already inspected the artifact. These
 * are excluded from immediate-write mode: the model needs to read the failing
 * file before rewriting it, and a write_file-only surface would strand it.
 */
export function isScenarioFileRepairPrompt(prompt: string): boolean {
  return (
    /\[runtime check(?:\s+[^\]]+)?\]\s+I\s+(?:opened|re-opened)\s+`[^`]+`\s+(?:in\s+a\s+headless\s+browser|after\s+your\s+latest\s+edit)\./i.test(
      prompt,
    ) ||
    /\[runtime check(?:\s+[^\]]+)?\]\s+You've now rewritten\s+`[^`]+`\s+\d+\s+time\(s\)/i.test(
      prompt,
    ) ||
    /\[scenario check\]\s+I looked at\s+`[^`]+`\s+and\s+the\s+success\s+criteria\s+aren't\s+met\s+yet\./i.test(
      prompt,
    )
  );
}

/**
 * "Create this file from scratch" prompts, as distinct from repair/modify
 * work. Kept verbatim from the llama-cpp reference so both engines agree on
 * what counts as a first-write turn.
 */
export function isDirectCreateSourceWritePrompt(prompt: string): boolean {
  if (!/\bwrite_file\b/i.test(prompt)) return false;
  if (!/`?[\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md)`?/i.test(prompt)) {
    return false;
  }
  if (
    /\b(?:modify|repair|fix|debug|patch|refactor|continue evolving|existing codebase)\b/i.test(
      prompt,
    )
  ) {
    return false;
  }
  if (/\bpreserve\b/i.test(prompt) && !/\bfirst (?:version|pass)\b/i.test(prompt)) return false;
  return (
    /\b(?:build|create|make|implement|scaffold|write|produce)\b/i.test(prompt) &&
    /\b(?:first version|first pass|initial version|new|from scratch|at\s+`?[\w./-]+\.(?:html?|css|mjs|cjs|json|jsx|js|tsx|ts|md)`?)/i.test(
      prompt,
    )
  );
}

/**
 * Does this prompt demand a file write right now?
 *
 * The final clause is why `toolSurfaceIsWriteFileOnly` is a parameter rather
 * than something derived here: a bare "deliverable expected as a FILE" line
 * only means "write it now" once the surface has already been narrowed.
 */
export function isImmediateFileWritePrompt(
  prompt: string,
  context: { toolSurfaceIsWriteFileOnly: boolean },
): boolean {
  const urgentWriteNow =
    prompt.includes('There is still **no `index.html`** in the workspace') ||
    prompt.includes('Stop reading/planning and write the file now:') ||
    prompt.includes('Do not end your turn until `write_file`') ||
    prompt.includes('First move: create the workspace deliverable') ||
    isDirectCreateSourceWritePrompt(prompt) ||
    prompt.includes('workspace/index.html');
  const explicitDeliverableRecovery =
    /\bnext\s+tool\s+call\s+should\s+(?:write|repair|write\s+or\s+repair)\b[\s\S]{0,180}\bworkspace\s+deliverable\b/i.test(
      prompt,
    ) ||
    (/\bprevious\s+turn\s+aborted\b/i.test(prompt) &&
      /\bworkspace\s+deliverable\b/i.test(prompt) &&
      /\bwrite_file\b/.test(prompt));
  if (urgentWriteNow) return true;
  if (explicitDeliverableRecovery) return true;
  return (
    context.toolSurfaceIsWriteFileOnly &&
    /\[Deliverable expected as a FILE at `[^`]+`/i.test(prompt)
  );
}

/**
 * Should this turn run in immediate-write mode?
 *
 * Gated on `write_file` being PRESENT rather than on the surface already being
 * a single tool — requiring the latter is what made MLX's copy unreachable.
 */
export function isImmediateFileWriteTurn(
  prompt: string,
  tools: LocalChatCompletionTool[] | undefined,
): boolean {
  if (!hasWriteFileTool(tools)) return false;
  if (isScenarioFileRepairPrompt(prompt)) return false;
  return isImmediateFileWritePrompt(prompt, { toolSurfaceIsWriteFileOnly: tools?.length === 1 });
}

/** Floor for a constrained write turn — enough room for a real file body. */
export const CONSTRAINED_WRITE_MIN_TOKENS = 4_096;

export interface ConstrainedTurnShape {
  /** Depth dials that were downgraded, for logging what actually moved. */
  reasoningDepthDowngraded: string[];
}

/**
 * Apply the sampling/budget/reasoning shape every constrained turn wants.
 *
 * Deliberately does NOT touch the tool surface or `tool_choice`: those differ
 * per engine (llama-cpp forces via `tool_choice: 'required'`, MLX constrains
 * via its llguidance grammar), so each provider keeps that part.
 */
export function applyConstrainedTurnShape(body: Record<string, unknown>): ConstrainedTurnShape {
  const currentMax = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
  body.max_tokens = Math.max(currentMax, CONSTRAINED_WRITE_MIN_TOKENS);
  body.temperature = 0.2;
  body.top_p = 0.8;
  const existing = body.chat_template_kwargs;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    (existing as Record<string, unknown>).enable_thinking = false;
  } else {
    body.chat_template_kwargs = { enable_thinking: false };
  }
  return { reasoningDepthDowngraded: downgradeReasoningDepthKwargs(body) };
}
