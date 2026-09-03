/**
 * What a file is FOR, as far as the Village is concerned. The index's `kind`
 * answers "what format is this" (every JSON file is `config` there); the map
 * needs the coarser, more human question — is this code, is it data, is it
 * the machinery that configures the project, or is it styling — because each
 * gets a different kind of place on the map:
 *
 * - `code` → a building from the period vocabulary (the default)
 * - `data` → a field: JSON, YAML, CSV that hold content rather than settings
 * - `config` → a signal tower: the municipal machinery of the project
 * - `style` → a park: stylesheets are the town's gardens and ornaments
 *
 * Path-based on purpose, so the client can classify a pre-existing payload and
 * the service can weight a file before layout without a second signal.
 */
export type FileUse = 'code' | 'data' | 'config' | 'style';

const STYLE_EXT = /\.(css|scss|sass|less|styl|stylus|pcss)$/i;
const DATA_EXT = /\.(json|jsonc|json5|geojson|ndjson|ya?ml|csv|tsv|xml|toml)$/i;

/** Basenames that are configuration whatever their extension. */
const CONFIG_BASENAME = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-workspace.yml',
  'lerna.json',
  'nx.json',
  'turbo.json',
  'biome.json',
  'biome.jsonc',
  'renovate.json',
  'vercel.json',
  'netlify.toml',
  'deno.json',
  'deno.jsonc',
  'bun.lockb',
  'composer.json',
  'cargo.toml',
  'pyproject.toml',
  'setup.cfg',
  'go.mod',
  'gemfile',
  'makefile',
  'justfile',
  'dockerfile',
  'procfile',
  'lefthook.yml',
  'codecov.yml',
  'electron-builder.yml',
  'electron-builder.json',
  'app.json',
  'manifest.json',
  'firebase.json',
  'now.json',
  'wrangler.toml',
  'fly.toml',
  'mkdocs.yml',
  'docusaurus.config.js',
  'babel.config.js',
  'jest.config.js',
]);

const CONFIG_PATTERN = [
  /^tsconfig[\w.-]*\.json$/i,
  /^jsconfig[\w.-]*\.json$/i,
  /\.config\.[cm]?[jt]sx?$/i,
  /\.config\.(json|ya?ml|toml)$/i,
  /^\.[\w-]+rc(\.(json|jsonc|js|cjs|mjs|ya?ml|toml))?$/i,
  /^\.(env|npmrc|yarnrc|nvmrc|editorconfig|prettierrc|browserslistrc)/i,
  /^dockerfile(\.|$)/i,
  /^docker-compose[\w.-]*\.ya?ml$/i,
  /^vitest\.workspace\.[cm]?[jt]s$/i,
  /^(webpack|rollup|vite|tsup|esbuild|playwright|jest|karma|babel|postcss|tailwind|eslint|prettier|stylelint|commitlint|release|semantic-release)[\w.-]*\.(config|rc)?[\w.-]*\.[cm]?[jt]sx?$/i,
];

/** Folders whose files are configuration by location. */
const CONFIG_DIR =
  /(^|\/)(\.github\/workflows|\.github|\.vscode|\.idea|\.devcontainer|\.husky|\.changeset)(\/|$)/i;

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/** Classify a path (and, when known, the index language) into its map use. */
export function fileUseOf(path: string, lang?: string | null): FileUse {
  const base = basenameOf(path);
  const lower = base.toLowerCase();
  if (STYLE_EXT.test(base) || lang === 'css' || lang === 'scss' || lang === 'less') return 'style';
  if (CONFIG_BASENAME.has(lower)) return 'config';
  for (const re of CONFIG_PATTERN) if (re.test(base)) return 'config';
  if (CONFIG_DIR.test(path) && !/\.[cm]?[jt]sx?$/i.test(base)) return 'config';
  if (DATA_EXT.test(base)) return 'data';
  if (lang === 'json' || lang === 'yaml' || lang === 'yml' || lang === 'csv' || lang === 'tsv') {
    return 'data';
  }
  return 'code';
}
