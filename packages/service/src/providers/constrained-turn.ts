/** Pure task intent and tool-surface policy shared by local inference backends. */
import type { FileTurnIntent } from '@bendyline/gezel';
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

/** Paths are hints only; tool execution still enforces workspace authority. */
export function fileRepairTargetPath(prompt: string, intent?: FileTurnIntent): string | null {
  if (intent) return intent.kind === 'repair-file' ? intent.path : null;
  // Prefer an explicit repair verb, then a quoted path, then an ordinary path.
  // No particular extension, filename, harness label, or speaker is privileged.
  return (
    /\b(?:repair|fix|debug|patch|correct)\s+(?:the\s+)?(?:file\s+)?`?([\w./-]+\.[\w]+)`?/i.exec(
      prompt,
    )?.[1] ??
    /`([^`\n]+\.[\w]+)`/.exec(prompt)?.[1] ??
    /\b((?:[\w.-]+\/)*[\w-]+\.[a-z][a-z0-9]*)\b/i.exec(prompt)?.[1] ??
    null
  );
}

export function isFileRepairPrompt(prompt: string, intent?: FileTurnIntent): boolean {
  if (intent) return intent.kind === 'repair-file';
  // Gate escalations choose their own repair strategy. Their quoted failures
  // must not select the generic read-first mode, but an independent repair
  // request before the marker still takes precedence.
  const repairPrompt = prompt.split(/\bGATE_(?:TARGETED_EDIT|FULL_REWRITE):/, 1)[0]!;
  if (!fileRepairTargetPath(repairPrompt)) return false;
  // Repair means an observed failure in existing work. A request to create a
  // missing file is a different intent, even if it arrives from a validator.
  if (/\b(?:no|missing)\s+`?[^`\n]+`?\s+(?:file|in the workspace)\b/i.test(repairPrompt))
    return false;
  return (
    /\b(?:assertions?|checks?|tests?)\b[\s\S]{0,120}\b(?:failed|failing|failures?)\b|\b(?:success|acceptance) criteria (?:aren't|are not) met\b|\b(?:same|still)\b[\s\S]{0,80}\b(?:failing|fails|broken)\b/i.test(
      repairPrompt,
    ) ||
    /\b(?:repair|fix|debug|patch|correct)\b[\s\S]{0,160}\b(?:existing|broken|error|failure|bug|regression)\b/i.test(
      repairPrompt,
    ) ||
    /\b(?:existing|broken|error|failure|bug|regression)\b[\s\S]{0,160}\b(?:repair|fix|debug|patch|correct)\b/i.test(
      repairPrompt,
    )
  );
}

/** Compatibility name for callers predating the general repair contract. */
export const isScenarioFileRepairPrompt = isFileRepairPrompt;

export function isDirectCreateSourceWritePrompt(prompt: string): boolean {
  if (!/\bwrite_file\b/i.test(prompt) || !fileRepairTargetPath(prompt)) return false;
  if (
    /\b(?:modify|repair|fix|debug|patch|refactor|continue evolving|existing codebase)\b/i.test(
      prompt,
    )
  )
    return false;
  if (/\bpreserve\b/i.test(prompt) && !/\bfirst (?:version|pass)\b/i.test(prompt)) return false;
  return (
    /\b(?:build|create|make|implement|scaffold|write|produce)\b/i.test(prompt) &&
    /\b(?:first version|first pass|initial version|new|from scratch|at\s+`?[\w./-]+\.[\w]+`?)/i.test(
      prompt,
    )
  );
}

export function isImmediateFileWritePrompt(
  prompt: string,
  context: { toolSurfaceIsWriteFileOnly: boolean },
  intent?: FileTurnIntent,
): boolean {
  if (intent) return intent.kind === 'create-file';
  if (isFileRepairPrompt(prompt)) return false;
  // Stage 1 can target workspace patches, artifacts, or task notes. Never
  // turn its failure text (for example, "write the note first") into a
  // write_file-only request.
  if (prompt.includes('GATE_TARGETED_EDIT:')) return false;
  if (
    /\b(?:do not|don't)\s+write\s+until\b|\bread\b[\s\S]{0,100}\bbefore\s+(?:writing|drafting|creating|editing)\b/i.test(
      prompt,
    )
  )
    return false;
  const urgentWrite =
    /\b(?:write|create|save|produce)\b[\s\S]{0,100}\b(?:now|immediately|first)\b/i.test(prompt) ||
    /\b(?:first (?:move|step|action)|next tool call)\s*:\s*(?:write|create|save|produce)\b/i.test(
      prompt,
    ) ||
    /\b(?:do not|don't) end (?:your |the )?turn until\s+`?write_file\b/i.test(prompt);
  const recovery =
    /\bnext\s+tool\s+call\s+(?:must|should)\s+be\s+`?write_file\b/i.test(prompt) ||
    /\bnext\s+tool\s+call\s+should\s+(?:write|repair|write\s+or\s+repair)\b[\s\S]{0,180}\b(?:workspace\s+)?deliverable\b/i.test(
      prompt,
    ) ||
    (/\bprevious\s+turn\s+aborted\b/i.test(prompt) &&
      /\bdeliverable\b/i.test(prompt) &&
      /\bwrite_file\b/i.test(prompt));
  return (
    urgentWrite ||
    recovery ||
    isDirectCreateSourceWritePrompt(prompt) ||
    (context.toolSurfaceIsWriteFileOnly &&
      /\bdeliverable expected as a file at\s+`[^`]+`/i.test(prompt))
  );
}

export function isImmediateFileWriteTurn(
  prompt: string,
  tools: LocalChatCompletionTool[] | undefined,
  intent?: FileTurnIntent,
): boolean {
  return (
    hasWriteFileTool(tools) &&
    !isFileRepairPrompt(prompt, intent) &&
    isImmediateFileWritePrompt(prompt, { toolSurfaceIsWriteFileOnly: tools?.length === 1 }, intent)
  );
}

export const FILE_REPAIR_READ_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'read_files',
  'list_dir',
  'stat',
  'validate',
]);
export const FILE_REPAIR_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'replace_in_file',
  'replace_lines',
  'write_file',
  'append_to_file',
]);
export const FILE_REPAIR_TOOLS: ReadonlySet<string> = new Set([
  ...FILE_REPAIR_READ_TOOLS,
  ...FILE_REPAIR_MUTATION_TOOLS,
]);

export function isFileRepairTurn(
  prompt: string,
  tools: LocalChatCompletionTool[] | undefined,
  intent?: FileTurnIntent,
): boolean {
  return (
    isFileRepairPrompt(prompt, intent) &&
    (tools?.some((tool) => FILE_REPAIR_MUTATION_TOOLS.has(tool.function.name)) ?? false)
  );
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

export function isSourceFileRepairPrompt(prompt: string, intent?: FileTurnIntent): boolean {
  if (!isFileRepairPrompt(prompt, intent)) return false;
  const target = fileRepairTargetPath(prompt, intent);
  if (target) return /\.(?:html?|css|mjs|cjs|jsx?|tsx?)$/i.test(target);
  return /`?[\w./-]+\.(?:html?|css|mjs|cjs|jsx?|tsx?)(?=`|\b)/i.test(prompt);
}
