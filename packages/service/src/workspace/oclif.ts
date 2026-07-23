import { existsSync } from 'node:fs';
import { readFile, readlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { CommandShape, DiscoveredCommand, FlagSpec } from '@bendyline/gezel';

/**
 * Tier 2 command-shape extraction for oclif-based CLIs.
 *
 * oclif packages ship a `oclif.manifest.json` inside their published
 * tarball that describes every command, flag, and arg with full
 * types and descriptions. Reading it is free + deterministic, so we
 * mine it on every index pass.
 *
 * Detection pipeline:
 *   1. `resolveBinPackageDir(workspaceDir, binName)` walks the symlink
 *      under `node_modules/.bin/<name>` to find the source package.
 *   2. `readOclifManifest(packageDir)` parses `oclif.manifest.json`
 *      if it exists.
 *   3. `extractOclifShapes(workspaceDir, bin)` glues both together and
 *      returns a `{ promotedRows, shapes }` tuple for the indexer to
 *      merge into its existing outputs.
 *
 * Anything that fails returns `null` quietly — a malformed manifest
 * mustn't break the indexing pass for the rest of the bins.
 */

/** Promoted-row safety cap. Heroku has 200+; we draw the line there. */
const MAX_PROMOTED_SUBCOMMANDS = 200;

/** Examples cap inside the shape; manifests sometimes ship dozens. */
const MAX_STORED_EXAMPLES = 5;

// ── raw manifest types (tolerant of oclif v1/v2/v3) ─────────────────

interface OclifRawFlag {
  name?: string;
  type?: 'boolean' | 'option' | string;
  char?: string;
  description?: string;
  summary?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  multiple?: boolean;
}

interface OclifRawArg {
  name?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
}

interface OclifRawCommand {
  id?: string;
  description?: string;
  summary?: string;
  usage?: string | string[];
  examples?: Array<string | { command?: string; description?: string }>;
  /** oclif v2/v3 keep flags as a record keyed by flag name. */
  flags?: Record<string, OclifRawFlag>;
  /** v3 args are a record; v1/v2 sometimes an array. */
  args?: Record<string, OclifRawArg> | OclifRawArg[];
}

interface OclifRawManifest {
  version?: string;
  /** oclif v3 carries `topicSeparator: ' '` for space-style CLIs like `gh pr create`. */
  topicSeparator?: string;
  commands?: Record<string, OclifRawCommand>;
}

interface PackageJson {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
}

// ── public API ──────────────────────────────────────────────────────

export interface OclifExtraction {
  /** Promoted first-level subcommand rows (kind `'bin'`). */
  promotedRows: DiscoveredCommand[];
  /** Map keyed by rendered command name (e.g. `'gh'`, `'gh pr'`). */
  shapes: Record<string, CommandShape>;
}

/**
 * Top-level entry: resolve the bin to its package, find the
 * manifest, normalize. Returns null when this isn't an oclif CLI
 * (or the manifest is unreadable).
 */
export async function extractOclifShapes(
  workspaceDir: string,
  bin: DiscoveredCommand,
): Promise<OclifExtraction | null> {
  const packageDir = await resolveBinPackageDir(workspaceDir, bin.name);
  if (!packageDir) return null;
  const manifest = await readOclifManifest(packageDir);
  if (!manifest) return null;
  const pkg = await readPackageJson(packageDir);
  return normalizeOclifManifest(bin.name, manifest, pkg);
}

// ── resolver ────────────────────────────────────────────────────────

/**
 * Resolve `node_modules/.bin/<binName>` to the directory of the
 * package that owns the bin. Three strategies, in order:
 *   1. POSIX symlink — follow the link, walk up to the nearest
 *      `package.json`.
 *   2. Windows shim — read the `.cmd` file, parse the relative path.
 *   3. Conventional fallback — `node_modules/<binName>` directly,
 *      which catches ~70% of single-bin packages.
 */
export async function resolveBinPackageDir(
  workspaceDir: string,
  binName: string,
): Promise<string | null> {
  const binPath = join(workspaceDir, 'node_modules', '.bin', binName);
  // POSIX path: symlink → bin script → package dir.
  try {
    const target = await readlink(binPath);
    const abs = isAbsolute(target) ? target : resolve(dirname(binPath), target);
    const pkgDir = await findPackageRoot(abs);
    if (pkgDir) return pkgDir;
  } catch {
    /* not a symlink — try Windows shim or fallback */
  }
  // Windows path: .cmd shim. Look for the `\node_modules\<pkg>\…` segment.
  for (const ext of ['.cmd', '.ps1', '.bat']) {
    const shim = `${binPath}${ext}`;
    if (existsSync(shim)) {
      try {
        const raw = await readFile(shim, 'utf8');
        const pkgDir = parseShimPackagePath(workspaceDir, raw);
        if (pkgDir) return pkgDir;
      } catch {
        /* fall through */
      }
    }
  }
  // Fallback: bin name === package name.
  const conventional = join(workspaceDir, 'node_modules', binName);
  try {
    const s = await stat(conventional);
    if (s.isDirectory()) return conventional;
  } catch {
    /* not present */
  }
  return null;
}

/**
 * Walk up from a file path until we find a directory containing a
 * `package.json`. Stops at three levels max to avoid scanning up to
 * the filesystem root when the bin target is something weird.
 */
async function findPackageRoot(start: string): Promise<string | null> {
  let current = dirname(start);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Parse a Windows .cmd shim and extract the relative path to the bin
 * script under `node_modules/`. Then walk up to the package root.
 *
 * Sample shim line (npm-installed):
 *   `"%~dp0\..\foo-cli\bin\run.js" %*`
 *
 * Sample shim line (pnpm-installed):
 *   `node "%~dp0\..\.pnpm\foo-cli@1.2.3\node_modules\foo-cli\bin\run.js" %*`
 */
function parseShimPackagePath(workspaceDir: string, shim: string): string | null {
  // Capture anything between `%~dp0\` and `.js"` — that's the relative path.
  const match = shim.match(/%~dp0\\([^"]+\.(?:js|mjs|cjs))/i);
  if (!match) return null;
  const rel = match[1]!.replace(/\\/g, '/');
  const binAbs = resolve(join(workspaceDir, 'node_modules', '.bin'), rel);
  // Walk up looking for the package root.
  let current = dirname(binAbs);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

// ── manifest reader ─────────────────────────────────────────────────

export async function readOclifManifest(packageDir: string): Promise<OclifRawManifest | null> {
  try {
    const raw = await readFile(join(packageDir, 'oclif.manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as OclifRawManifest;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.commands || typeof parsed.commands !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readPackageJson(packageDir: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(join(packageDir, 'package.json'), 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

// ── normalizer ──────────────────────────────────────────────────────

/**
 * Convert the raw oclif manifest into:
 *   - a flat map of `CommandShape`s keyed by rendered command name
 *   - one promoted `DiscoveredCommand` row per first-level subcommand
 *
 * Honors the manifest's `topicSeparator` so CLIs that style commands
 * as `gh pr create` (space-separated) parse the same as classic oclif
 * `pr:create` (colon-separated).
 */
export function normalizeOclifManifest(
  binName: string,
  manifest: OclifRawManifest,
  pkg: PackageJson | null,
): OclifExtraction {
  const separator = manifest.topicSeparator === ' ' ? ' ' : ':';
  const packageName = pkg?.name ?? binName;
  const packageVersion = pkg?.version;
  const shapes: Record<string, CommandShape> = {};

  // Build a parent → direct-children map (only ONE level deep) so we
  // can promote first-level subcommands and stash deeper ones on the
  // parent's shape.
  const directChildren = new Map<string, Set<string>>();
  for (const id of Object.keys(manifest.commands ?? {})) {
    const segments = id.split(separator).filter(Boolean);
    if (segments.length === 0) continue;
    // Walk every prefix to register direct-child relationships.
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join(separator);
      const child = segments.slice(0, depth + 1).join(separator);
      let set = directChildren.get(parent);
      if (!set) {
        set = new Set();
        directChildren.set(parent, set);
      }
      set.add(child);
    }
  }

  // Helper: turn an oclif command id into the rendered command name
  // the user sees (e.g. `'pr:create'` → `'gh pr create'`).
  const renderName = (id: string): string => {
    const segments = id.split(separator).filter(Boolean);
    return [binName, ...segments].join(' ');
  };

  // Shape for the parent bin itself. Use the root oclif command if
  // present (some CLIs declare an id of "" or the bin name), else
  // derive it from package.json metadata.
  const rootCmd =
    manifest.commands?.[''] ?? manifest.commands?.[binName] ?? (manifest.commands ? null : null);
  shapes[binName] = buildShape({
    fullName: binName,
    cmd: rootCmd,
    pkg: packageName,
    pkgVersion: packageVersion,
    directChildIds: directChildren.get('') ?? new Set<string>(),
    renderName,
    separator,
  });

  // Per-command shapes. Skip the root we already emitted.
  for (const [id, cmd] of Object.entries(manifest.commands ?? {})) {
    if (id === '' || id === binName) continue;
    const fullName = renderName(id);
    shapes[fullName] = buildShape({
      fullName,
      cmd,
      pkg: packageName,
      pkgVersion: packageVersion,
      directChildIds: directChildren.get(id) ?? new Set<string>(),
      renderName,
      separator,
    });
  }

  // Synthesize shapes for intermediate topics that appear as parents
  // but have no command of their own (e.g. `gh pr` when only
  // `gh pr create` / `gh pr list` are declared). The promoted row
  // needs a shape entry so the panel can resolve its summary, and
  // future UX wants the subcommand list rooted there.
  for (const [parentId, childIds] of directChildren) {
    if (parentId === '' || parentId === binName) continue;
    if (manifest.commands?.[parentId]) continue; // explicit cmd already shaped
    const fullName = renderName(parentId);
    shapes[fullName] = buildShape({
      fullName,
      cmd: null,
      pkg: packageName,
      pkgVersion: packageVersion,
      directChildIds: childIds,
      renderName,
      separator,
    });
  }

  // Promote first-level subcommands. Top-level segments are the
  // commands directly under the root.
  const topLevelSegments = new Set<string>();
  for (const id of Object.keys(manifest.commands ?? {})) {
    if (!id) continue;
    const first = id.split(separator).filter(Boolean)[0];
    if (first) topLevelSegments.add(first);
  }
  const promotedRows: DiscoveredCommand[] = [];
  if (topLevelSegments.size <= MAX_PROMOTED_SUBCOMMANDS) {
    for (const segment of [...topLevelSegments].sort()) {
      const fullName = `${binName} ${segment}`;
      const shape = shapes[fullName];
      promotedRows.push({
        name: fullName,
        kind: 'bin',
        source: `node_modules/.bin/${binName}`,
        run: fullName,
        ...(shape?.summary
          ? { description: shape.summary }
          : { description: `${packageName} subcommand` }),
      });
    }
  }
  // else: cap hit — leave promotedRows empty; shape map still complete.

  return { promotedRows, shapes };
}

// ── per-command shape builder ───────────────────────────────────────

function buildShape(args: {
  fullName: string;
  cmd: OclifRawCommand | null | undefined;
  pkg: string;
  pkgVersion?: string;
  directChildIds: Set<string>;
  renderName: (id: string) => string;
  separator: string;
}): CommandShape {
  const { cmd, pkg, pkgVersion, directChildIds, renderName, separator } = args;
  const summary =
    pickString(cmd?.summary) ?? firstLine(pickString(cmd?.description) ?? '') ?? undefined;

  const flags = normalizeFlags(cmd?.flags);
  const argsList = normalizeArgs(cmd?.args);
  const usage = pickUsage(cmd?.usage);
  const examples = normalizeExamples(cmd?.examples);

  const subcommands = [...directChildIds].sort().map((childId) => {
    const lastSeg = childId.split(separator).filter(Boolean).pop() ?? childId;
    return {
      name: lastSeg,
      fullName: renderName(childId),
      ...(args.cmd ? {} : {}),
    };
  });

  const shape: CommandShape = {
    source: 'oclif' as const,
    package: pkg,
    ...(pkgVersion ? { packageVersion: pkgVersion } : {}),
    ...(summary ? { summary } : {}),
    ...(cmd?.description && cmd.description !== summary ? { description: cmd.description } : {}),
    ...(subcommands.length > 0 ? { subcommands } : {}),
    ...(flags.length > 0 ? { flags } : {}),
    ...(argsList.length > 0 ? { args: argsList } : {}),
    ...(usage ? { usage } : {}),
    ...(examples.length > 0 ? { examples } : {}),
  };
  return shape;
}

// ── flag/arg/example normalizers ────────────────────────────────────

function normalizeFlags(flags: Record<string, OclifRawFlag> | undefined): FlagSpec[] {
  if (!flags || typeof flags !== 'object') return [];
  const out: FlagSpec[] = [];
  for (const [name, raw] of Object.entries(flags)) {
    if (!raw || typeof raw !== 'object') continue;
    const type = raw.type === 'boolean' ? 'boolean' : 'option';
    const flag: FlagSpec = {
      name: raw.name ?? name,
      type,
      ...(raw.char && raw.char.length === 1 ? { char: raw.char } : {}),
      ...(raw.description || raw.summary ? { description: raw.summary ?? raw.description } : {}),
      ...(raw.required === true ? { required: true } : {}),
      ...(raw.default !== undefined ? { default: stringifyDefault(raw.default) } : {}),
      ...(Array.isArray(raw.options) && raw.options.length > 0
        ? { options: raw.options.map(String) }
        : {}),
      ...(raw.multiple === true ? { multiple: true } : {}),
    };
    out.push(flag);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function normalizeArgs(args: Record<string, OclifRawArg> | OclifRawArg[] | undefined): Array<{
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
  options?: string[];
}> {
  if (!args) return [];
  const entries: OclifRawArg[] = Array.isArray(args)
    ? args
    : Object.entries(args).map(([key, value]) => ({ name: value?.name ?? key, ...value }));
  const out: Array<{
    name: string;
    description?: string;
    required?: boolean;
    default?: string;
    options?: string[];
  }> = [];
  for (const raw of entries) {
    if (!raw?.name) continue;
    out.push({
      name: raw.name,
      ...(raw.description ? { description: raw.description } : {}),
      ...(raw.required === true ? { required: true } : {}),
      ...(raw.default !== undefined ? { default: stringifyDefault(raw.default) } : {}),
      ...(Array.isArray(raw.options) && raw.options.length > 0
        ? { options: raw.options.map(String) }
        : {}),
    });
  }
  return out;
}

function normalizeExamples(examples: OclifRawCommand['examples'] | undefined): string[] {
  if (!Array.isArray(examples)) return [];
  const out: string[] = [];
  for (const ex of examples) {
    if (out.length >= MAX_STORED_EXAMPLES) break;
    if (typeof ex === 'string') {
      const trimmed = ex.trim();
      if (trimmed) out.push(trimmed);
    } else if (ex && typeof ex === 'object' && typeof ex.command === 'string') {
      const trimmed = ex.command.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function pickUsage(usage: string | string[] | undefined): string | undefined {
  if (!usage) return undefined;
  if (typeof usage === 'string') return usage.trim() || undefined;
  for (const line of usage) {
    if (typeof line === 'string' && line.trim()) return line.trim();
  }
  return undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function firstLine(s: string): string | undefined {
  if (!s) return undefined;
  const idx = s.indexOf('\n');
  const line = idx < 0 ? s : s.slice(0, idx);
  return line.trim() || undefined;
}

function stringifyDefault(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
