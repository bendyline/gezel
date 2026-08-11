import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CommandApprovalInputFile } from '@bendyline/gezel';

const MAX_FILES = 128;
const MAX_HASHED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PARSED_FILE_BYTES = 2 * 1024 * 1024;
const STATIC_CODE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);
const WRAPPER_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1']);

export interface FingerprintCommandInputsOptions {
  workspaceDir: string;
  body: string;
  args: readonly string[];
  /** Known entry files, such as package.json or a resolved node_modules/.bin shim. */
  entryFiles?: readonly string[];
}

/**
 * Fingerprint local files that can be identified conservatively from a
 * package command. This is intentionally not advertised as a complete
 * dependency graph: commands can discover files dynamically, use implicit
 * config conventions, resolve PATH binaries, import packages, or fetch code.
 *
 * Covered inputs include explicit entry files, literal file tokens in the
 * command/arguments, workspace-local `.bin` entries, Windows package-manager
 * wrapper targets, symlink targets, and relative static JS/TS imports.
 */
export async function fingerprintCommandInputs(
  opts: FingerprintCommandInputsOptions,
): Promise<CommandApprovalInputFile[]> {
  const workspace = resolve(opts.workspaceDir);
  const files = new Map<string, CommandApprovalInputFile>();
  const visited = new Set<string>();

  const visit = async (rawPath: string): Promise<void> => {
    if (files.size >= MAX_FILES) return;
    const absolute = resolve(rawPath);
    if (!isInside(workspace, absolute) || visited.has(absolute)) return;
    visited.add(absolute);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch {
      return;
    }
    if (!info.isFile() || info.size > MAX_HASHED_FILE_BYTES) return;

    const path = portableRelative(workspace, absolute);
    files.set(path, { path, sha256: await sha256File(absolute) });

    // POSIX node_modules/.bin entries are normally symlinks. Hashing the
    // logical path already follows the target; visiting a workspace-local
    // real path also lets us discover its relative static imports.
    const canonical = await realpath(absolute).catch(() => absolute);
    if (canonical !== absolute && isInside(workspace, canonical)) await visit(canonical);

    if (info.size > MAX_PARSED_FILE_BYTES) return;
    const extension = extname(canonical).toLowerCase();
    if (!STATIC_CODE_EXTENSIONS.has(extension) && !WRAPPER_EXTENSIONS.has(extension)) return;

    const content = await readFile(absolute, 'utf8').catch(() => '');
    if (!content) return;

    if (WRAPPER_EXTENSIONS.has(extension)) {
      const base = dirname(absolute);
      const expanded = expandWrapperDirectoryVariables(content, base);
      for (const token of extractTokens(expanded)) {
        for (const candidate of tokenFileCandidates(token, base, workspace)) await visit(candidate);
      }
      return;
    }

    // Follow only statically visible relative imports. Bare package imports
    // and dynamic expressions remain part of the documented residual risk.
    for (const specifier of relativeModuleSpecifiers(content)) {
      for (const candidate of moduleCandidates(dirname(canonical), specifier)) {
        await visit(candidate);
      }
    }
  };

  for (const entry of opts.entryFiles ?? []) await visit(entry);

  for (const token of [...extractTokens(opts.body), ...opts.args]) {
    for (const candidate of tokenFileCandidates(token, workspace, workspace))
      await visit(candidate);
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function portableRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolveStream, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolveStream);
  });
  return hash.digest('hex');
}

function extractTokens(command: string): string[] {
  const matches = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|<>()]+/g) ?? [];
  return matches.map((token) => stripQuotes(token.trim())).filter(Boolean);
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function tokenFileCandidates(token: string, base: string, workspace: string): string[] {
  let candidate = token.trim().replace(/^[,]+|[,]+$/g, '');
  const equals = candidate.indexOf('=');
  if (equals > 0) candidate = candidate.slice(equals + 1);
  candidate = stripQuotes(candidate);
  if (
    !candidate ||
    candidate === '--' ||
    candidate.startsWith('-') ||
    candidate.includes('\0') ||
    /[*?{}[\]`]/.test(candidate) ||
    /^(?:https?|data):/i.test(candidate) ||
    /(?:^|[/\\])(?:\$|%)[^/\\]*/.test(candidate)
  ) {
    return [];
  }

  const out: string[] = [];
  const looksLikePath =
    isAbsolute(candidate) ||
    candidate.startsWith('.') ||
    candidate.includes('/') ||
    candidate.includes('\\') ||
    extname(candidate).length > 0;
  if (looksLikePath) out.push(resolve(base, candidate));

  // A bare command in a package.json script commonly resolves through the
  // project's node_modules/.bin. Try platform variants without trusting PATH.
  if (/^[A-Za-z0-9_.@-]+$/.test(candidate)) {
    const bin = resolve(workspace, 'node_modules', '.bin', candidate);
    out.push(bin, `${bin}.cmd`, `${bin}.bat`, `${bin}.ps1`, `${bin}.exe`);
  }
  return out;
}

function expandWrapperDirectoryVariables(content: string, base: string): string {
  const withSeparator = base.endsWith(sep) ? base : `${base}${sep}`;
  return content
    .replace(/%~dp0/gi, withSeparator)
    .replace(/%dp0%/gi, withSeparator)
    .replace(/\$PSScriptRoot/gi, base)
    .replace(/\$\{basedir\}/g, base)
    .replace(/\$basedir/g, base);
}

function relativeModuleSpecifiers(content: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (;;) {
      const match = pattern.exec(content);
      if (match === null) break;
      const specifier = match[1];
      if (specifier?.startsWith('.')) found.add(specifier);
    }
  }
  return [...found];
}

function moduleCandidates(base: string, specifier: string): string[] {
  const exact = resolve(base, specifier);
  const out = [exact];
  const extension = extname(exact).toLowerCase();
  if (!extension) {
    for (const ext of STATIC_CODE_EXTENSIONS) {
      out.push(`${exact}${ext}`, resolve(exact, `index${ext}`));
    }
  } else if (
    extension === '.js' ||
    extension === '.jsx' ||
    extension === '.mjs' ||
    extension === '.cjs'
  ) {
    // TypeScript source commonly imports the emitted `.js` name while tsx or
    // another loader resolves the adjacent source file at execution time.
    const stem = exact.slice(0, -extension.length);
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) out.push(`${stem}${ext}`);
  }
  return out;
}
