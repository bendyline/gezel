import { existsSync } from 'node:fs';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CommandShape, DiscoveredCommand } from '@bendyline/gezel';
import { discoverWorkspaceFiles } from './file-walk.js';
import { extractOclifShapes } from './oclif.js';

/**
 * Pure, stateless scanners that produce the workspace index. Composed
 * by `WorkspaceIndexManager` which owns the cache + sweep loop. Each
 * `discover*` function is independent: a thrown parse error in one
 * source yields zero entries for that source but doesn't block the
 * others. The token-index builder is similarly pure — same input, same
 * output, no I/O after `discoverFiles` has returned.
 */

const COMMAND_DESCRIPTION_CAP = 240;

/** Workspace-script extensions we treat as runnable without a shebang. */
const RUNNABLE_SCRIPT_EXTS = new Set(['.sh', '.bash', '.zsh', '.ts', '.mjs', '.js', '.py']);

/** Cap so a giant monorepo doesn't blow out the file index. */
const MAX_FILES = 20_000;

/** Tokens shorter than this aren't useful for filename autocomplete. */
const MIN_TOKEN_LEN = 2;

/** ── package scripts ──────────────────────────────────────────────── */

export type WorkspacePackageManager = 'npm' | 'pnpm';

/**
 * Pick the script runner that owns a workspace.
 *
 * `package.json#packageManager` is authoritative when present. Otherwise
 * inspect the nearest directory with package-manager infrastructure,
 * walking upward so a package opened directly inside a pnpm monorepo still
 * inherits the root's `pnpm-workspace.yaml` / lockfile. A directory with
 * both lockfiles is scored by its signals; pnpm's workspace marker makes it
 * predominant over a stale package-lock.
 */
export async function detectWorkspacePackageManager(
  workspaceDir: string,
  rootDeclared?: unknown,
): Promise<WorkspacePackageManager> {
  const rootManager = declaredPackageManager(rootDeclared);
  if (rootManager) return rootManager;

  let dir = workspaceDir;
  for (;;) {
    if (dir !== workspaceDir) {
      const declared = await readDeclaredPackageManager(dir);
      if (declared) return declared;
    }

    const pnpmScore =
      (existsSync(join(dir, 'pnpm-workspace.yaml')) ? 2 : 0) +
      (existsSync(join(dir, 'pnpm-lock.yaml')) ? 1 : 0);
    const npmScore =
      (existsSync(join(dir, 'package-lock.json')) ? 1 : 0) +
      (existsSync(join(dir, 'npm-shrinkwrap.json')) ? 1 : 0);
    if (pnpmScore > 0 || npmScore > 0) {
      return pnpmScore > npmScore ? 'pnpm' : 'npm';
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'npm';
}

export async function discoverNpmScripts(workspaceDir: string): Promise<DiscoveredCommand[]> {
  try {
    const raw = await readFile(join(workspaceDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      packageManager?: unknown;
    };
    if (!parsed.scripts || typeof parsed.scripts !== 'object') return [];
    const packageManager = await detectWorkspacePackageManager(workspaceDir, parsed.packageManager);
    return Object.entries(parsed.scripts).map(([name, cmd]) => ({
      name,
      kind: 'npm-script' as const,
      source: 'package.json',
      run: `${packageManager} run ${name}`,
      ...(typeof cmd === 'string' ? { description: truncate(cmd, COMMAND_DESCRIPTION_CAP) } : {}),
    }));
  } catch {
    return [];
  }
}

function declaredPackageManager(value: unknown): WorkspacePackageManager | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().split('@', 1)[0]?.toLowerCase();
  return name === 'npm' || name === 'pnpm' ? name : null;
}

async function readDeclaredPackageManager(dir: string): Promise<WorkspacePackageManager | null> {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { packageManager?: unknown };
    return declaredPackageManager(parsed.packageManager);
  } catch {
    return null;
  }
}

/** ── workspace scripts/ folder ─────────────────────────────────────── */

export async function discoverWorkspaceScripts(workspaceDir: string): Promise<DiscoveredCommand[]> {
  const scriptsDir = join(workspaceDir, 'scripts');
  let entries: string[];
  try {
    entries = await readdir(scriptsDir);
  } catch {
    return [];
  }
  const out: DiscoveredCommand[] = [];
  for (const name of entries) {
    const abs = join(scriptsDir, name);
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const ext = extOf(name);
    const isExtRunnable = RUNNABLE_SCRIPT_EXTS.has(ext);
    const hasShebang = isExtRunnable ? false : await detectShebang(abs);
    if (!isExtRunnable && !hasShebang) continue;
    out.push({
      name,
      kind: 'workspace-script',
      source: `scripts/${name}`,
      run: `./scripts/${name}`,
      description: hasShebang ? 'Executable script (#!)' : `${ext.slice(1)} script`,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** ── .vscode/launch.json ──────────────────────────────────────────── */

export async function discoverVscodeLaunchConfigs(
  workspaceDir: string,
): Promise<DiscoveredCommand[]> {
  const path = join(workspaceDir, '.vscode', 'launch.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch {
    return [];
  }
  const root = parsed as {
    configurations?: Array<{ name?: string; type?: string; program?: string; url?: string }>;
  };
  const configs = Array.isArray(root?.configurations) ? root.configurations : [];
  const out: DiscoveredCommand[] = [];
  for (const c of configs) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string') continue;
    const detail = [c.type, c.program ?? c.url].filter(Boolean).join(' · ');
    out.push({
      name: c.name,
      kind: 'vscode-launch',
      source: '.vscode/launch.json',
      // VSCode launch configs aren't shell-runnable — the closest
      // "paste" form is the config name itself. We surface that so
      // copy-to-clipboard gives the user something pickable in the
      // VSCode Run dropdown.
      run: c.name,
      ...(detail ? { description: detail } : {}),
    });
  }
  return out;
}

/** ── node_modules/.bin/ ───────────────────────────────────────────── */

export interface BinCommandsResult {
  commands: DiscoveredCommand[];
  /** Map keyed by rendered command name. Empty when no installed bin
   *  ships an oclif manifest (the common case). */
  shapes: Record<string, CommandShape>;
}

export async function discoverBinCommands(workspaceDir: string): Promise<BinCommandsResult> {
  const binDir = join(workspaceDir, 'node_modules', '.bin');
  let entries: string[];
  try {
    entries = await readdir(binDir);
  } catch {
    return { commands: [], shapes: {} };
  }
  const seen = new Set<string>();
  const parents: DiscoveredCommand[] = [];
  const allRows: DiscoveredCommand[] = [];
  const shapes: Record<string, CommandShape> = {};
  for (const entry of entries) {
    // Windows: strip .cmd/.ps1/.bat so the user-visible name matches POSIX.
    const base = entry.replace(/\.(cmd|ps1|bat|exe)$/i, '');
    if (!base || seen.has(base)) continue;
    seen.add(base);
    const parent: DiscoveredCommand = {
      name: base,
      kind: 'bin',
      source: `node_modules/.bin/${base}`,
      run: `npx ${base}`,
      description: 'Installed CLI',
    };
    parents.push(parent);

    // Try Tier 2 oclif extraction. Failure is silent — the parent row
    // is still emitted; only the enrichment is missed.
    const extraction = await extractOclifShapes(workspaceDir, parent).catch(() => null);
    if (extraction) {
      // Replace the stock description with the manifest summary when
      // we have one — improves the panel even for the parent row.
      const rootShape = extraction.shapes[base];
      if (rootShape?.summary) parent.description = rootShape.summary;
      for (const [name, shape] of Object.entries(extraction.shapes)) {
        shapes[name] = shape;
      }
      allRows.push(...extraction.promotedRows);
    }
  }
  // Sort all bin rows (parents + promoted subcommands) together so the
  // panel renders them alphabetically inside the "Installed CLIs" group.
  allRows.push(...parents);
  allRows.sort((a, b) => a.name.localeCompare(b.name));
  return { commands: allRows, shapes };
}

/** ── file walk ────────────────────────────────────────────────────── */

export interface WorkspaceFile {
  /** Forward-slashed relative path from the workspace root. */
  path: string;
  size: number;
  mtimeMs: number;
}

export async function discoverFiles(workspaceDir: string): Promise<WorkspaceFile[]> {
  const { files } = await discoverWorkspaceFiles(workspaceDir, { maxFiles: MAX_FILES });
  return files.map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs }));
}

/** ── token index ──────────────────────────────────────────────────── */

export interface TokenIndex {
  /** Token → list of file-indexes (positions in `files`). */
  tokens: Record<string, number[]>;
}

export function buildTokenIndex(files: WorkspaceFile[]): TokenIndex {
  const map = new Map<string, Set<number>>();
  for (let i = 0; i < files.length; i++) {
    for (const tok of tokenize(files[i]!.path)) {
      let set = map.get(tok);
      if (!set) {
        set = new Set<number>();
        map.set(tok, set);
      }
      set.add(i);
    }
  }
  const tokens: Record<string, number[]> = {};
  for (const [tok, set] of map) tokens[tok] = [...set].sort((a, b) => a - b);
  return { tokens };
}

function tokenize(path: string): string[] {
  const out: string[] = [];
  // Split on any run of non-alphanumerics. Lowercase. Drop short tokens.
  for (const raw of path.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TOKEN_LEN) out.push(raw);
  }
  return out;
}

/** ── helpers ──────────────────────────────────────────────────────── */

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap - 1)}…`;
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

async function detectShebang(absPath: string): Promise<boolean> {
  let fh: import('node:fs/promises').FileHandle | null = null;
  try {
    fh = await open(absPath, 'r');
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    if (bytesRead < 2) return false;
    return buf[0] === 0x23 && buf[1] === 0x21; // "#!"
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Strip JSONC `//` line comments and `/* *\/` block comments. Tolerant
 * enough for `.vscode/launch.json` files that ship with VSCode's
 * default comments. Doesn't try to be a full parser — strings with
 * `//` in them would currently get mangled, but launch.json values
 * are short paths/IDs and don't realistically contain `//`.
 */
function stripJsonc(input: string): string {
  // Block comments first (greedy across lines).
  let out = input.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments. The leading `[^:\\n]` guards against stripping URLs
  // like `"http://…"` — we require something before `//` that isn't a
  // colon and isn't a newline.
  out = out.replace(/(^|[^:\n])\/\/[^\n]*/g, '$1');
  return out;
}

/** Best-effort "does this look like a real workspace" check. */
export async function workspaceLooksReal(workspaceDir: string): Promise<boolean> {
  if (!existsSync(workspaceDir)) return false;
  try {
    const st = await stat(workspaceDir);
    return st.isDirectory();
  } catch {
    return false;
  }
}
