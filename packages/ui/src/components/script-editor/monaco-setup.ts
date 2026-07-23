import { type SdkTypesResponse, setupLineSpan } from '@bendyline/gezel';
import { monaco } from '../monaco-base.js';

/**
 * Monaco wiring for the script editor — TypeScript language config + SDK
 * type injection + the preamble folding region. The heavy `editor.main.js`
 * import, web-worker setup, and the gezel themes live in the shared
 * `../monaco-base.js` (imported below). Like that module, this one is HEAVY
 * and must only ever be loaded via `import('./monaco-setup.js')` from a
 * mount-time effect, never the static graph, so the app bundle and jsdom
 * tests stay monaco-free.
 */

export { monaco };

let tsConfigured = false;
let sdkTypesVersion: string | null = null;

/**
 * Configure the global TypeScript defaults for script editing and inject
 * the `@bendyline/gezel-sdk` typings fetched from the daemon. Idempotent;
 * re-injects only when the served types version changes.
 *
 * With the d.ts registered at `file:///node_modules/@bendyline/gezel-sdk/`
 * and models created under `file:///gezel/...`, Node-style resolution
 * makes `import { defineScript, gezel } from '@bendyline/gezel-sdk'`
 * fully typed — including `InferredInput<typeof meta>` for per-script
 * input typing, with zero per-model setup.
 *
 * Note: monaco 0.50 bundles TS ~5.4, which predates `erasableSyntaxOnly`,
 * so enums etc. look legal in-editor; the save endpoint's runtime-compat
 * diagnostics are where those get caught.
 */
export async function ensureScriptTypescript(fetchTypes: () => Promise<SdkTypesResponse>) {
  const td = monaco.languages.typescript.typescriptDefaults;
  if (!tsConfigured) {
    tsConfigured = true;
    registerPreambleFolding();
    td.setCompilerOptions({
      // monaco's ScriptTarget enum copy stops at ES2020 — ESNext matches
      // the runtime (Node ≥22 with type stripping) closest anyway.
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      lib: ['esnext'],
      strict: true,
      noEmit: true,
      isolatedModules: true,
      allowNonTsExtensions: true,
      types: [],
    });
    td.setEagerModelSync(true);
  }
  const types = await fetchTypes();
  if (types.version === sdkTypesVersion) return;
  sdkTypesVersion = types.version;
  for (const file of types.files) {
    // New daemons send full node_modules-relative paths ("@bendyline/...");
    // older ones sent bare names rooted in the SDK package.
    const path = file.name.startsWith('@')
      ? `file:///node_modules/${file.name}`
      : `file:///node_modules/@bendyline/gezel-sdk/${file.name}`;
    td.addExtraLib(file.content, path);
  }
}

/** Model URI for a project script — anchored under file:/// so the SDK extra lib resolves. */
export function scriptModelUri(projectId: string, name: string): monaco.Uri {
  return monaco.Uri.parse(
    `file:///gezel/${encodeURIComponent(projectId)}/scripts/${encodeURIComponent(name)}.ts`,
  );
}

/**
 * Expose the script "setup" (imports + `export const meta = …`) as a single
 * collapsible folding region [1, setupLineSpan]. The Script tab collapses it by
 * default so only the body shows, while the whole file stays in the model for
 * type-checking. Registered once; scoped to script models by URI so it never
 * touches unrelated TypeScript buffers. Coexists with monaco's built-in TS
 * folding (the body's own blocks still fold normally).
 */
function registerPreambleFolding(): void {
  monaco.languages.registerFoldingRangeProvider('typescript', {
    provideFoldingRanges(model) {
      if (!model.uri.path.includes('/scripts/')) return [];
      const span = setupLineSpan(model.getValue());
      // Need at least two lines to fold (a one-line setup isn't worth a chevron).
      if (span < 2) return [];
      return [{ start: 1, end: span, kind: monaco.languages.FoldingRangeKind.Region }];
    },
  });
}
