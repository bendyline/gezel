import { Buffer } from 'node:buffer';

/**
 * Node resolves a bare ESM import from the importing file, not from the
 * process cwd. Playwright scripts live in project artifacts while their
 * dependencies live in the managed system-toolset directory, so merely
 * launching Node with `cwd = installPath` does not make
 * `import { chromium } from 'playwright'` work.
 *
 * This synchronous loader hook first preserves Node's ordinary resolution
 * (including dependencies imported from inside Playwright itself), then
 * retries unresolved bare imports from the managed toolset root supplied to
 * the child (with cwd as a fallback). Relative/absolute/builtin imports are
 * never redirected.
 */
const MANAGED_TOOLSET_IMPORT_HOOK_SOURCE = String.raw`
import { isBuiltin, registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const managedRoot = process.env.GEZEL_MANAGED_TOOLSET_ROOT || process.cwd();
const managedParentURL = pathToFileURL(join(managedRoot, '__gezel_toolset_entry.mjs')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isBare =
      !specifier.startsWith('.') &&
      !specifier.startsWith('/') &&
      !specifier.startsWith('#') &&
      !specifier.includes(':') &&
      !isBuiltin(specifier);

    if (!isBare) return nextResolve(specifier, context);

    try {
      return nextResolve(specifier, context);
    } catch {
      // @playwright/mcp ships playwright (whose playwright/test export is
      // the implementation behind @playwright/test), but not the wrapper
      // package itself. Accept the canonical author-facing import without
      // duplicating the runtime in the managed install.
      const managedSpecifier = specifier === '@playwright/test' ? 'playwright/test' : specifier;
      return nextResolve(managedSpecifier, { ...context, parentURL: managedParentURL });
    }
  },
});
`;

/** A self-contained `node --import` target; no temporary loader file needed. */
export const MANAGED_TOOLSET_IMPORT_HOOK_URL = `data:text/javascript;base64,${Buffer.from(
  MANAGED_TOOLSET_IMPORT_HOOK_SOURCE,
).toString('base64')}`;

/**
 * Playwright Test starts worker processes of its own. A CLI `--import` only
 * reaches the parent, while NODE_OPTIONS is inherited by both the CLI and
 * every worker. Append instead of replace so daemon/operator Node flags stay
 * intact.
 */
export function nodeOptionsWithManagedToolsetImport(existing?: string): string {
  const hookOption = `--import=${MANAGED_TOOLSET_IMPORT_HOOK_URL}`;
  return existing ? `${existing} ${hookOption}` : hookOption;
}
