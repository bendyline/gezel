import { HttpStatusError } from '@bendyline/gezel/runtime';
import { type PathSafetyCode, PathSafetyError, resolveMutationPath } from './safe-paths.js';

/**
 * A change to the shared library or a project's artifacts, refused because of
 * where its path leads.
 *
 * `resolveMutationPath` refuses with a `PathSafetyError`, which the HTTP error
 * mapper does not recognise, so a library subfolder that is a symlink or
 * junction to another drive reached the person as "Something went wrong inside
 * Gezel" and was logged as an unhandled 500. The refusal is correct; it has to
 * read as one. Being an `HttpStatusError` is what lets `app.onError` answer
 * with a 4xx and this sentence on every route that reaches these stores, and
 * the MCP tools hand the body's `error` to the gezel verbatim. `code` stays the
 * `PathSafetyError` code so callers can still tell the refusals apart.
 */
export class MutationPathRefusedError extends HttpStatusError {
  readonly code: PathSafetyCode;

  constructor(message: string, code: PathSafetyCode) {
    super(message, code === 'symlink-escape' ? 403 : 400, { code });
    this.name = 'MutationPathRefusedError';
    this.code = code;
  }
}

/**
 * {@link resolveMutationPath} for a root a person owns. `place` completes a
 * sentence: "your library", "this project's artifacts".
 */
export async function resolveOwnedMutationPath(
  base: string,
  relPath: string,
  place: string,
): Promise<string> {
  try {
    return await resolveMutationPath(base, relPath);
  } catch (err) {
    if (!(err instanceof PathSafetyError)) throw err;
    // Only a link can be met by someone using the app as intended: a person
    // links a folder on another drive into their library. Traversal and root
    // refusals answer a malformed path, and keep the wording models know.
    const message =
      err.code === 'symlink-escape'
        ? `"${relPath}" goes through a shortcut to a location outside ${place}, so Gezel won't change files through it.`
        : err.message;
    throw new MutationPathRefusedError(message, err.code);
  }
}
