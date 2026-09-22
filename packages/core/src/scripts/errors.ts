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
