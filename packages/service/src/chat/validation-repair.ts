const VALIDATION_REPAIR_CHECK_PREFIX_RE = /^\[(?:runtime|scenario) check\b/i;
const VALIDATION_REPAIR_REPEAT_PREFIX_RE =
  /^REPEAT(?: APPEND| COMBINED)? MISS\s+—\s+attempt\s+\d+\s+on\s+`[^`\r\n]+`:/i;
const VALIDATION_REPAIR_FULL_REWRITE_PREFIX_RE =
  /^GATE_FULL_REWRITE:\s+\d+\s+completed repairs of\s+`[^`\r\n]+`\s+have failed this scenario check\b/i;

/**
 * True for the validation-repair messages emitted by the runtime and eval
 * feedback loops. `sniff-feedback.ts` prepends exact stage markers to the
 * ordinary `[scenario check]` body after the first miss; classifying only the
 * nested check header made those repeat turns look like ordinary tool-only
 * chat and triggered an unnecessary closing-summary continuation.
 *
 * Keep this prefix-shaped rather than searching the whole prompt. Ordinary
 * user prose may discuss "repeat misses" or quote a scenario check without
 * being an active validation turn.
 */
export function isValidationRepairPrompt(prompt: string): boolean {
  const body = prompt
    .trimStart()
    .replace(/^\[Message from [^\]\r\n]+\]:\s*/i, '')
    .trimStart();
  if (VALIDATION_REPAIR_CHECK_PREFIX_RE.test(body)) return true;
  if (VALIDATION_REPAIR_FULL_REWRITE_PREFIX_RE.test(body)) return true;
  if (!VALIDATION_REPAIR_REPEAT_PREFIX_RE.test(body)) return false;

  const firstLineEnd = body.indexOf('\n');
  if (firstLineEnd < 0) return false;
  return VALIDATION_REPAIR_CHECK_PREFIX_RE.test(body.slice(firstLineEnd + 1).trimStart());
}

const VALIDATION_REPAIR_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'append_to_file',
  'replace_in_file',
  'replace_lines',
]);

export function hasSuccessfulWorkspaceMutation(
  toolCalls: ReadonlyArray<{ name: string; success: boolean }>,
): boolean {
  return toolCalls.some((tc) => tc.success && VALIDATION_REPAIR_MUTATION_TOOLS.has(tc.name));
}

export function isValidationRepairMutationTurn(
  prompt: string,
  toolCalls: ReadonlyArray<{ name: string; success: boolean }>,
): boolean {
  if (!isValidationRepairPrompt(prompt)) return false;
  return hasSuccessfulWorkspaceMutation(toolCalls);
}
