type ProjectRef = { id: string; name: string };

/**
 * The project a model's `project` argument names: its id, or its display
 * name case-insensitively. Both hosts resolve it this way, so a model that
 * passes "Ship Eval" instead of `ship-eval` reaches the same project.
 */
export function findProjectByReference<T extends ProjectRef>(
  projects: readonly T[],
  input: string,
): T | undefined {
  const exact = projects.find((p) => p.id === input);
  if (exact) return exact;
  const lc = input.trim().toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === lc);
}

export function projectNotFoundMessage(
  input: string,
  projects: readonly ProjectRef[],
  availableTools: readonly string[] = [],
): string {
  const available = projects.map((p) => `"${p.id}" (${p.name})`).join(', ');
  // Recovery must not prescribe a launcher hidden by the session's tool diet.
  // A start_work caller can safely name itself even when its legacy macro is absent.
  const newWork = availableTools.includes('start_work')
    ? ' For genuinely new work, call `start_work({ "option": "new-project" })` without a `project` argument. A new project name belongs in the optional `name` argument.'
    : '';
  return `project "${input}" does not exist. Available projects: ${available || '(none)'}. Project ids and exact display names are both accepted. [runtime: non-retryable] Do not retry this same project reference. For an existing project, use one of the ids above.${newWork}`;
}
