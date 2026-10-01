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

export function projectNotFoundMessage(input: string, projects: readonly ProjectRef[]): string {
  const available = projects.map((p) => `"${p.id}" (${p.name})`).join(', ');
  return `project "${input}" does not exist. Available projects: ${available || '(none)'}. Project ids and exact display names are both accepted. [runtime: non-retryable] Do not retry this same project reference. Call \`list_projects\` and use an id it returns; if this is genuinely new work, launch it with \`start_project\` or the matching craftbook before messaging a gezel.`;
}
