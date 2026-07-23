/**
 * The pinned system-toolset list.
 *
 * Every entry here is auto-installed into `~/.gezel/system-toolsets/` on
 * first launch (and re-installed whenever the Gezel app ships with a
 * different version pin). This file IS the lockfile — we never install
 * a range, never resolve `latest`. Bumping a version is a PR whose diff
 * includes both the new version string and the new integrity hash.
 *
 * `integrity` is the `dist.integrity` string from the npm registry
 * packument for the pinned version (format: `sha512-<base64>`). pnpm
 * verifies it automatically when installing; we also sanity-check the
 * installed `package.json#version` against `version` below.
 *
 * Each entry is one of two kinds:
 *   - `mcp-toolset` — a stdio MCP server. The bootstrap registers it on
 *     the `Store`'s system-scope `InstalledToolset` list so `ChatManager`
 *     spawns it alongside shared + per-gezel toolsets.
 *   - `library` — a Node package that our in-process code dynamic-imports
 *     (e.g., the Copilot SDK, which owns its own subprocess and exposes a
 *     JS API). Library entries are NOT registered as toolsets; callers
 *     use `resolveSystemLibraryPath()` to locate the install root.
 */
export type SystemToolsetKind = 'mcp-toolset' | 'library';

export interface PinnedSystemToolset {
  /** Identifier stored on the `InstalledToolset` record — the npm package name. */
  toolsetId: string;
  /** Display label for UIs and error messages. */
  displayName: string;
  /** What sort of package this is. Drives bootstrap + resolution behavior. */
  kind: SystemToolsetKind;
  /** Exact npm package + version. No ranges. */
  pkg: string;
  version: string;
  /** `dist.integrity` from the npm packument. pnpm verifies on install. */
  integrity: string;
  /**
   * Entry path (relative to the installed package root).
   * For `mcp-toolset`: the stdio server JS file spawned by ChatManager.
   * For `library`: the JS file that `resolveSystemLibraryPath` appends
   *   when callers pass `{ withEntry: true }`. Optional — library
   *   callers often import the package's main via `package.json`.
   */
  entry?: string;
  /** Extra args passed to the `mcp-toolset` entry script. Ignored for libraries. */
  args?: string[];
  /**
   * If set, a service-managed post-install step runs after pnpm finishes.
   * Today only `'playwright-chromium'` is recognized — it shells out to
   * the toolset's own Playwright CLI to download the pinned browser
   * revision with progress reported on the status bus.
   */
  postInstall?: 'playwright-chromium';
}

/**
 * Playwright's Chromium revision is determined by the Playwright version
 * we pin. We record it separately so the bootstrap can tell at a glance
 * whether the on-disk browser dir matches expectations without shelling
 * out to Playwright's CLI.
 *
 * Bump when `@playwright/mcp`'s transitive Playwright dep changes. Quick
 * lookup: `cat node_modules/playwright-core/browsers.json` after install,
 * or check the Playwright release notes.
 */
// Typed as `string` rather than letting TS narrow to a literal — the
// bootstrap compares this against an on-disk tracking record, and a
// literal type would turn future bumps into "no overlap" TS errors at
// every comparison site.
export const CHROMIUM_REVISION: string = '1232';

export const SYSTEM_TOOLSETS: PinnedSystemToolset[] = [
  {
    toolsetId: '@playwright/mcp',
    displayName: 'Playwright (browser automation)',
    kind: 'mcp-toolset',
    pkg: '@playwright/mcp',
    // Pin resolved from the npm registry; matching lockfile lives in
    // `SYSTEM_LOCKFILES['@playwright/mcp']` (locks.ts). To bump: fetch
    // the new tarball, drop devDeps + scripts from package.json,
    // `pnpm install --prod --lockfile-only --ignore-scripts`, and paste
    // version + integrity here alongside the fresh lockfile.
    version: '0.0.78',
    integrity:
      'sha512-XLTUeA6mEN9sQ+hJ4dfG8EIkDbxS0K3Trc2RBkUJuf02TgE2FQRNTMtq/aJfhyRMINsRl/Ybc4sxcWLtFn4/TQ==',
    // Entry lives at the package root — `@playwright/mcp`'s published
    // package.json has `"bin": { "playwright-mcp": "cli.js" }` with no
    // `dist/` layer. A `dist/cli.js` entry would ENOENT on spawn and
    // the MCP bridge would silently fall back to "no browser tools",
    // which is how Copilot gezels ended up shelling out to bash + node
    // instead of using `browser_*` / `run_playwright_script`.
    entry: 'cli.js',
    postInstall: 'playwright-chromium',
  },
  {
    toolsetId: '@github/copilot-sdk',
    displayName: 'GitHub Copilot SDK + CLI',
    kind: 'library',
    pkg: '@github/copilot-sdk',
    version: '1.0.7',
    integrity:
      'sha512-dgCFCPfxWUkrgclQbrm7WCFzTf5RnJHsK1Lqsc3KjPBbDLPutJT0qIGg3xJ0ZELLyX0icg3TOmVczhR4HdwHxw==',
    entry: 'dist/cjs/index.js',
  },
];

/**
 * Is the pinned version/integrity a placeholder? Dev-mode: we shouldn't
 * attempt an install against placeholder values — skip gracefully with
 * a log line. Production releases fill these in via the bump script.
 *
 * Placeholder detection is deliberately narrow: we accept the literal
 * `'0.0.0'` version and an integrity that's ALL `A`-bytes (the canonical
 * base64 zero pattern), not any sha512 that happens to start with A.
 */
export function isPlaceholder(entry: PinnedSystemToolset): boolean {
  if (entry.version === '0.0.0') return true;
  if (/^sha512-A{86}={0,2}$/.test(entry.integrity)) return true;
  return false;
}
