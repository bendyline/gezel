import type { CraftbookToolsetNeed, TaskCraftbookStep } from '@bendyline/gezel';
export { outputMediumForStep, outputMediaForStep } from '@bendyline/gezel';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return craftbook-declared toolsets that the active step explicitly tells
 * the assignee not to call.
 *
 * Craftbook toolsets are installed at project scope so later production
 * phases can use them. Without a per-step guard that also exposed the whole
 * MCP server during planning/review phases, even when the procedure said
 * "Do not call DocBlocks". Besides confusing the model, one incompatible
 * schema on an unused server could make llama.cpp reject the entire turn.
 *
 * This is intentionally conservative: it only acts on toolsets declared by
 * the active craftbook and only on an explicit negative instruction in the
 * step prompt/description. Vague steps and ordinary user-installed toolsets
 * fail open and retain their existing behavior.
 */
export function toolsetIdsExplicitlyDisabledForStep(
  step: Pick<TaskCraftbookStep, 'prompt' | 'description' | 'toolPolicy'> | undefined,
  toolsets: readonly CraftbookToolsetNeed[] | undefined,
): ReadonlySet<string> {
  if (!step) return new Set();
  const disabled = new Set(step.toolPolicy?.disallowToolsets ?? []);
  if (!toolsets?.length) return disabled;
  const instructions = [step.description, step.prompt].filter(Boolean).join('\n');
  if (!instructions) return disabled;

  for (const need of toolsets) {
    const id = need.toolsetId.trim();
    if (!id) continue;
    const escaped = escapeRegExp(id);
    // Stop at sentence/line boundaries so a prohibition in one instruction
    // cannot accidentally suppress a toolset mentioned positively later.
    const explicitDenial = new RegExp(
      `(?:\\bdo\\s+not\\b|\\bdon't\\b|\\bnever\\b)[^.!?\\n]{0,160}\\b(?:call|use|invoke|run|access|load)\\s+(?:the\\s+)?${escaped}(?=$|[^A-Za-z0-9_-])`,
      'iu',
    );
    if (explicitDenial.test(instructions)) disabled.add(id);
  }
  return disabled;
}

/** Stable built-in group ids explicitly subtracted by the active JSON step. */
export function builtinToolsetIdsDisabledForStep(
  step: Pick<TaskCraftbookStep, 'toolPolicy'> | undefined,
): ReadonlySet<string> {
  return new Set(step?.toolPolicy?.disallowBuiltinToolsets ?? []);
}
