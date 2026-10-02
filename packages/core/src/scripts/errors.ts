/**
 * A script that could not be found where its scope keeps scripts.
 *
 * Carries `code: 'ENOENT'` because that is what the desktop's disk-backed
 * resolver has always thrown and what its callers test for. Recognised by
 * name across package boundaries, so a portable host can throw it too and
 * both route layers turn it into the same 404.
 */
export class ScriptNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(
    readonly scriptName: string,
    readonly scope: string,
  ) {
    super(`script "${scriptName}" not found in ${scope} scope`);
    this.name = 'ScriptNotFoundError';
  }
}

/**
 * The scope a `run_installed_script` call means when it names none. The tool
 * defaults to the project, so `storeRecords` without `scope: "standard"`
 * failed "not found in project scope" and small models retried that identical
 * call until their turn ended (iPhone and Galaxy S26, 2026-10-01). A name that
 * exists in only one place can only mean that one: project first, then the
 * user's own scripts, then the standard library. With no match the project
 * stays the answer, so the not-found error still names where it looked.
 */
export function inferScriptScope(
  name: string,
  scope: 'project' | 'user' | 'standard' | undefined,
  installed: readonly { name: string; scope: string }[],
): 'project' | 'user' | 'standard' {
  if (scope) return scope;
  for (const candidate of ['project', 'user', 'standard'] as const)
    if (installed.some((script) => script.name === name && script.scope === candidate))
      return candidate;
  return 'project';
}
