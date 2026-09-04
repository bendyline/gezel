import type {
  CraftbookStepOutputMedium,
  CraftbookToolsetNeed,
  TaskCraftbookStep,
} from '@bendyline/gezel';
import { requiredOutputMediaForGate } from '@bendyline/gezel';

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

/**
 * Resolve the step's result surface. Explicit JSON wins. Legacy/file-gated
 * steps get the same unambiguous behavior immediately, before their catalog
 * entry has been republished with `toolPolicy.outputMedium`.
 */
export function outputMediumForStep(
  step: Pick<TaskCraftbookStep, 'toolPolicy' | 'advanceWhen' | 'gate'> | undefined,
): CraftbookStepOutputMedium | null {
  if (!step) return null;
  if (step.toolPolicy?.outputMedium) return step.toolPolicy.outputMedium;
  if (step.advanceWhen?.file) return step.advanceWhen.artifact ? 'artifact' : 'workspace';
  const gate = step.gate;
  const checks = gate && 'checks' in gate && Array.isArray(gate.checks) ? gate.checks : [];
  const fileCheck = checks.find(
    (check): check is (typeof checks)[number] & { file: string; artifact?: boolean } =>
      'file' in check && typeof check.file === 'string' && check.file.length > 0,
  );
  if (fileCheck) return fileCheck.artifact ? 'artifact' : 'workspace';
  return null;
}

/** Primary plus explicitly-authorized secondary result surfaces. */
export function outputMediaForStep(
  step: Pick<TaskCraftbookStep, 'toolPolicy' | 'advanceWhen' | 'gate'> | undefined,
): ReadonlySet<CraftbookStepOutputMedium> {
  const primary = outputMediumForStep(step);
  if (!primary) return new Set();
  const gateRequiredMedia = requiredOutputMediaForGate(step?.gate);
  if (primary === 'none') {
    return gateRequiredMedia.size > 0 ? gateRequiredMedia : new Set(['none']);
  }
  return new Set([
    primary,
    ...(step?.toolPolicy?.additionalOutputMedia ?? []),
    ...gateRequiredMedia,
  ]);
}
