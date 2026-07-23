/**
 * `@bendyline/gezel-sdk/checks` — the shared deliverable-check predicates,
 * re-exported for use INSIDE sandboxed scripts.
 *
 * Source of truth is `@bendyline/gezel/checks` (packages/core/src/checks).
 * This entry is built with `noExternal` so the bundle is self-contained:
 * the script runner vendors the SDK dist into each sandbox scratch dir,
 * and sandboxed scripts can only import from this package. The stdlib
 * gate scripts import their checks from here — a lint test enforces it —
 * which is what keeps gate verdicts identical to the gate engine's
 * declarative checks and the eval harness's sniffs.
 */
export * from '@bendyline/gezel/checks';

import type { GateScriptResult } from './types.js';
export type { GateScriptResult };

/**
 * Convenience for gate scripts: stamp a GateResult-shaped output from a
 * pass/fail + the failure lines the checks produced.
 *
 *   const r = await fileMinBytes(ws, input.file, input.minBytes);
 *   gezel.output(gateResult(r.ok, r.detail));
 */
export function gateResult(ok: boolean, detail: string): GateScriptResult {
  return ok ? { decision: 'approve', message: detail } : { decision: 'reject', message: detail };
}

import type { WorkspaceLike } from '@bendyline/gezel/checks';

/**
 * Adapt the `gezel` object to the `WorkspaceLike` interface every file
 * check takes. Structural parameter (not an import of the gezel
 * singleton) — this entry is bundled standalone, and importing the main
 * entry's module state from here would duplicate the stdin init.
 *
 *   const ws = workspaceFromGezel(gezel);
 *   const r = await fileMinBytes(ws, input.file, input.minBytes);
 */
export function workspaceFromGezel(g: {
  fs: { read(path: string): Promise<string>; listAll(): Promise<string[]> };
}): WorkspaceLike {
  return {
    read: async (file) => {
      try {
        return await g.fs.read(file);
      } catch {
        return null;
      }
    },
    list: () => g.fs.listAll(),
  };
}
