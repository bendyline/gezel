import type { CheckResult } from './types.js';

/**
 * Named exports of the Node built-ins most often confused in ESM code. A
 * name's "owner" is the builtin that UNIQUELY exports it across this map;
 * importing a uniquely-owned name from a different builtin is the
 * high-confidence error {@link esmImports} flags — e.g. `import { dirname }
 * from 'node:url'` (`dirname` is a `node:path` export). Names exported by
 * more than one builtin (`parse`, `format`, `resolve`) have no unique owner
 * and are never flagged, so a legitimate `import { format } from 'node:url'`
 * passes. Intentionally scoped to the path/url pair — the documented
 * confusion and the bookstore-openapi eval failure; extend only with a
 * complete, accurate export set so a forgotten name can't false-flag.
 */
const NODE_BUILTIN_EXPORTS: Record<string, readonly string[]> = {
  'node:path': [
    'dirname',
    'basename',
    'extname',
    'join',
    'resolve',
    'normalize',
    'relative',
    'isAbsolute',
    'sep',
    'delimiter',
    'parse',
    'format',
    'toNamespacedPath',
    'matchesGlob',
    'posix',
    'win32',
  ],
  'node:url': [
    'fileURLToPath',
    'pathToFileURL',
    'URL',
    'URLSearchParams',
    'format',
    'parse',
    'resolve',
    'domainToASCII',
    'domainToUnicode',
    'urlToHttpOptions',
    'Url',
  ],
};

/** name → its single owning builtin (omitted when 0 or >1 builtins export it). */
const UNIQUE_OWNER: ReadonlyMap<string, string> = (() => {
  const seen = new Map<string, string[]>();
  for (const [mod, names] of Object.entries(NODE_BUILTIN_EXPORTS)) {
    for (const name of names) {
      const arr = seen.get(name) ?? [];
      arr.push(mod);
      seen.set(name, arr);
    }
  }
  const owner = new Map<string, string>();
  for (const [name, mods] of seen) {
    if (mods.length === 1 && mods[0]) owner.set(name, mods[0]);
  }
  return owner;
})();

// `import [defaultName,] { a, b as c } from 'node:x'` — the `[^{}'"]*`
// tolerates an optional default-import or `type` keyword before the braces.
const NAMED_IMPORT_RE = /import\s+[^{}'"]*\{([^}]*)\}\s*from\s*['"](node:[a-z/]+)['"]/g;
const REQUIRE_CALL_RE = /(?<![.\w])require\s*\(/;

/**
 * Static-scan an ESM/JS/TS file for two high-confidence import errors that
 * break the module at LOAD time (so nothing runs) yet slip past the
 * inline-`<script>` JS-parse gate — which skips `type="module"` and never
 * sees a standalone `.mjs`/`.ts`:
 *
 *  1. A named import pulled from the WRONG `node:` builtin (the canonical
 *     case: `import { dirname } from 'node:url'` — `dirname` is `node:path`).
 *     Throws `SyntaxError: … does not provide an export named …`.
 *  2. `require(...)` inside a `.mjs` file — `require` is not defined in ESM
 *     and throws at runtime. (Restricted to `.mjs`, where ESM is
 *     unambiguous; a bare `.js`/`.ts` may legitimately be CommonJS.)
 *
 * Returns the FIRST issue with a prescriptive fix (the "name one gap"
 * discipline). A file with no `node:` named imports — and no require() in a
 * `.mjs` — passes; there is nothing this check can be confident about.
 */
export function esmImports(content: string, file = ''): CheckResult {
  for (const m of content.matchAll(NAMED_IMPORT_RE)) {
    const mod = m[2] ?? '';
    for (const raw of (m[1] ?? '').split(',')) {
      // `dirname as d` → validate the imported name (before `as`).
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (!name) continue;
      const owner = UNIQUE_OWNER.get(name);
      if (owner && owner !== mod) {
        const label = file || 'this file';
        return {
          ok: false,
          detail: `${label} imports { ${name} } from '${mod}', but '${mod}' has no '${name}' export — it is a '${owner}' export. Import it from '${owner}' (e.g. \`import { ${name} } from '${owner}'\`, or \`import path from 'node:path'\` then \`path.${name}(…)\`). A wrong-source named import throws "SyntaxError: … does not provide an export named …" at load and nothing runs.`,
        };
      }
    }
  }
  if (file.endsWith('.mjs') && REQUIRE_CALL_RE.test(content)) {
    return {
      ok: false,
      detail: `${file} is an ES module (.mjs) but calls require(...) — \`require\` is not defined in ESM and throws at runtime. Use \`import\` instead (read JSON via node:fs, or import a module's exports directly).`,
    };
  }
  return { ok: true, detail: 'node: named imports resolve; no require() in ESM' };
}

/**
 * Standalone-file parse floor for `.js`/`.mjs` sources, without the
 * TypeScript compiler (usable from the sandboxed stdlib). Import/export
 * statements are textually stripped (top-level module syntax can't be
 * function-parsed), then the remainder must parse via `new Function` —
 * catching the dominant truncation / unbalanced-brace failure class the
 * way `validateScriptSyntax` does for inline HTML scripts. TypeScript
 * sources need the service-side `sourceParses` gate check instead.
 */
export function standaloneJsParses(content: string, file = ''): CheckResult {
  const stripped = content
    // import defaults/named/namespace/side-effect forms, incl. multiline named blocks
    .replace(/^[ \t]*import\b[\s\S]*?from\s*['"][^'"]*['"];?[ \t]*$/gm, '')
    .replace(/^[ \t]*import\s*['"][^'"]*['"];?[ \t]*$/gm, '')
    // export { ... } / export default expr / export const|function|class → keep the declaration
    .replace(/^[ \t]*export\s+default\s+/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*(?:from\s*['"][^'"]*['"])?;?[ \t]*$/gm, '')
    .replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)/gm, '')
    // top-level await can't be function-parsed either
    .replace(/^([ \t]*)await\b/gm, '$1void ');
  try {
    new Function(stripped);
    return { ok: true, detail: `${file || 'source'} parses` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `${file || 'source'} does not parse: ${message}. The file will not load until this is fixed — commonly a truncated file or an unbalanced brace/parenthesis.`,
    };
  }
}
