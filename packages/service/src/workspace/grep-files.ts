import { spawn } from 'node:child_process';
import { type Dirent, constants as fsConstants } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { SearchFilesMatch, SearchFilesRequest, SearchFilesResponse } from '@bendyline/gezel';
import { resolveInside } from '../fs/safe-paths.js';

const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 256 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const MAX_LINE_CHARS = 500;

const DEFAULT_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.pnpm/**',
  '**/dist/**',
] as const;

export type WorkspaceGrepEngine = 'auto' | 'ripgrep' | 'javascript';

export interface WorkspaceGrepOptions extends SearchFilesRequest {
  workspaceDir: string;
  /** Test/diagnostic override. Product callers should leave this as `auto`. */
  engine?: WorkspaceGrepEngine;
  /** Internal-only escape hatch for regexes assembled from escaped identifiers. */
  trustedRegex?: boolean;
}

export class WorkspaceGrepError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 500 | 504,
    readonly code:
      | 'invalid-request'
      | 'invalid-regex'
      | 'path-not-found'
      | 'path-not-searchable'
      | 'path-safety'
      | 'rg-unavailable'
      | 'process-failed'
      | 'timeout',
  ) {
    super(message);
    this.name = 'WorkspaceGrepError';
  }
}

export interface ResolvedSearchTarget {
  workspaceDir: string;
  cwd: string;
  target: string;
  targetIsFile: boolean;
}

interface RawSearchResult {
  matches: SearchFilesMatch[];
  files: string[];
  count: number;
  truncated: boolean;
  truncationReason?: 'limit' | 'output';
}

export interface SearchPlan {
  pattern: string;
  caseInsensitive: boolean;
  literal: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
  resultMode: 'matches' | 'files' | 'count';
  cursor: number;
  limit: number;
  contextLines: number;
  timeoutMs: number;
  trustedRegex: boolean;
}

/**
 * Workspace-scoped content search shared by the MCP `grep_files` tool and
 * the service's compatibility HTTP endpoint. The process boundary is kept
 * here so every caller gets the same path containment, argv construction,
 * time/output limits, and JS fallback semantics.
 */
export async function grepWorkspace(opts: WorkspaceGrepOptions): Promise<SearchFilesResponse> {
  const plan = normalizePlan(opts);
  const target = await resolveSearchTarget(opts.workspaceDir, opts.path);
  const requestedEngine = opts.engine ?? 'auto';
  const ripgrepPath =
    requestedEngine === 'javascript'
      ? null
      : await resolveExecutableOnPath('rg', target.workspaceDir, Math.min(plan.timeoutMs, 2000));
  if (requestedEngine === 'ripgrep' && !ripgrepPath) {
    throw new WorkspaceGrepError('ripgrep is not installed on this machine', 500, 'rg-unavailable');
  }

  let raw: RawSearchResult;
  let engine: 'ripgrep' | 'javascript';
  if (ripgrepPath) {
    try {
      raw = await runRipgrep(ripgrepPath, target, plan);
      engine = 'ripgrep';
    } catch (err) {
      if (
        requestedEngine === 'auto' &&
        err instanceof WorkspaceGrepError &&
        err.code === 'rg-unavailable'
      ) {
        raw = await runJavascriptSearch(target, plan);
        engine = 'javascript';
      } else {
        throw err;
      }
    }
  } else {
    raw = await runJavascriptSearch(target, plan);
    engine = 'javascript';
  }

  const capped = await capAndEnrichResult(target.workspaceDir, raw, plan);
  const returned =
    plan.resultMode === 'matches'
      ? capped.matches.length
      : plan.resultMode === 'files'
        ? capped.files.length
        : capped.count;
  const nextCursor =
    plan.resultMode !== 'count' && capped.truncated && returned > 0
      ? plan.cursor + returned
      : undefined;

  return {
    mode: plan.resultMode,
    matches: capped.matches,
    files: capped.files,
    count: capped.count,
    truncated: capped.truncated,
    ...(capped.truncationReason ? { truncationReason: capped.truncationReason } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    engine,
  };
}

function normalizePlan(opts: WorkspaceGrepOptions): SearchPlan {
  if (!opts.pattern || opts.pattern.length > 4000 || opts.pattern.includes('\0')) {
    throw new WorkspaceGrepError('pattern must contain 1-4000 characters', 400, 'invalid-request');
  }
  const resultMode = opts.resultMode ?? 'matches';
  const cursor = Math.max(0, Math.min(opts.cursor ?? 0, 10_000));
  const contextLines = Math.max(0, Math.min(opts.contextLines ?? 0, 5));
  if (resultMode === 'count' && cursor !== 0) {
    throw new WorkspaceGrepError(
      'cursor is not supported with resultMode="count"; refine the query or increase maxResults',
      400,
      'invalid-request',
    );
  }
  if (resultMode !== 'matches' && contextLines !== 0) {
    throw new WorkspaceGrepError(
      'contextLines is only supported with resultMode="matches"',
      400,
      'invalid-request',
    );
  }
  return {
    pattern: opts.pattern,
    caseInsensitive: opts.caseInsensitive === true,
    literal: opts.literal === true,
    includeGlobs: dedupe(
      [...(opts.glob ? [opts.glob] : []), ...(opts.includeGlobs ?? [])].map(validateGlob),
    ),
    excludeGlobs: dedupe(
      [...DEFAULT_EXCLUDE_GLOBS, ...(opts.excludeGlobs ?? [])].map(validateGlob),
    ),
    resultMode,
    cursor,
    // SearchFilesRequest caps this at 200. find_references reuses the engine
    // and has a historical max of 500, so retain that bounded internal range.
    limit: Math.max(1, Math.min(opts.maxResults ?? DEFAULT_MAX_RESULTS, 500)),
    contextLines,
    timeoutMs: Math.max(100, Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000)),
    trustedRegex: opts.trustedRegex === true,
  };
}

async function resolveSearchTarget(
  workspaceDir: string,
  requestedPath: string | undefined,
): Promise<ResolvedSearchTarget> {
  try {
    const lexicalTarget = await resolveInside(workspaceDir, requestedPath?.trim() || '.');
    const [realWorkspace, realTarget] = await Promise.all([
      realpath(workspaceDir),
      realpath(lexicalTarget),
    ]);
    const targetStat = await stat(realTarget);
    if (!targetStat.isDirectory() && !targetStat.isFile()) {
      throw new WorkspaceGrepError(
        `search path is neither a file nor a directory: ${requestedPath ?? '.'}`,
        400,
        'path-not-searchable',
      );
    }
    return targetStat.isDirectory()
      ? { workspaceDir: realWorkspace, cwd: realTarget, target: '.', targetIsFile: false }
      : {
          workspaceDir: realWorkspace,
          cwd: dirname(realTarget),
          target: basename(realTarget),
          targetIsFile: true,
        };
  } catch (err) {
    if (err instanceof WorkspaceGrepError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/symlink escape|escapes the base|absolute path outside|path traversal/i.test(message)) {
      throw new WorkspaceGrepError(
        `search path is outside the workspace: ${requestedPath ?? '.'}`,
        403,
        'path-safety',
      );
    }
    if (/ENOENT|no such file/i.test(message)) {
      throw new WorkspaceGrepError(
        `search path does not exist: ${requestedPath ?? '.'}`,
        404,
        'path-not-found',
      );
    }
    throw new WorkspaceGrepError(
      `could not resolve search path: ${requestedPath ?? '.'}`,
      400,
      'path-safety',
    );
  }
}

/** Exported for a focused contract test: the user pattern must follow `--`. */
export function buildRipgrepArgs(target: ResolvedSearchTarget, plan: SearchPlan): string[] {
  const args = [
    '--json',
    '--no-messages',
    '--no-config',
    '--hidden',
    '--no-ignore',
    '--no-follow',
    '--with-filename',
    '--max-filesize',
    String(MAX_FILE_BYTES),
    '--sort',
    'path',
  ];
  if (plan.caseInsensitive) args.push('-i');
  if (plan.literal) args.push('-F');
  const globFlag = plan.caseInsensitive ? '--iglob' : '--glob';
  for (const glob of plan.includeGlobs) args.push(globFlag, glob);
  for (const glob of plan.excludeGlobs) args.push(globFlag, `!${glob}`);
  if (plan.resultMode === 'files') args.push('--max-count', '1');
  else args.push('--max-count', String(plan.cursor + plan.limit + 1));
  // Security boundary: without this delimiter a model-controlled pattern
  // such as `--pre=...` is parsed as a ripgrep option rather than data.
  args.push('--', plan.pattern, target.target);
  return args;
}

async function runRipgrep(
  executable: string,
  target: ResolvedSearchTarget,
  plan: SearchPlan,
): Promise<RawSearchResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const accumulator = new ResultAccumulator(plan);
    const child = spawn(executable, buildRipgrepArgs(target, plan), {
      cwd: target.cwd,
      shell: false,
      env: minimalSearchEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBytes = 0;
    let stderr = '';
    let buffer = '';
    const stdoutDecoder = new StringDecoder('utf8');
    let settled = false;
    let intentionalStop: 'limit' | 'output' | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const stop = (reason: 'limit' | 'output') => {
      if (intentionalStop || settled) return;
      intentionalStop = reason;
      child.kill();
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      forceKillTimer.unref?.();
    };

    const parseLine = (line: string) => {
      if (!line) return;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (event.type !== 'match' || !event.data) return;
        const eventPath = event.data.path?.text;
        const lineNumber = event.data.line_number;
        if (!eventPath || !lineNumber || lineNumber < 1) return;
        const path = workspaceRelativePath(target.workspaceDir, target.cwd, eventPath);
        if (!path) return;
        const text = (event.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, MAX_LINE_CHARS);
        if (accumulator.add({ path, line: lineNumber, text })) stop('limit');
      } catch {
        // A partial line remains buffered; a malformed complete event is
        // ignored because rg's JSON stream also includes non-match events.
      }
    };

    const drainBuffer = (flush = false) => {
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        parseLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      if (flush && buffer) {
        parseLine(buffer);
        buffer = '';
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      forceKillTimer.unref?.();
      rejectPromise(
        new WorkspaceGrepError(
          `grep timed out after ${plan.timeoutMs}ms; narrow path/includeGlobs or use a literal pattern`,
          504,
          'timeout',
        ),
      );
    }, plan.timeoutMs);
    timeout.unref?.();

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || intentionalStop) return;
      const remaining = MAX_PROCESS_OUTPUT_BYTES - stdoutBytes;
      if (remaining <= 0) {
        stop('output');
        return;
      }
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdoutBytes += accepted.length;
      buffer += stdoutDecoder.write(accepted);
      drainBuffer();
      if (chunk.length > remaining) stop('output');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_STDERR_CHARS) return;
      stderr += chunk.toString('utf8').slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      const unavailable = (err as NodeJS.ErrnoException).code === 'ENOENT';
      rejectPromise(
        new WorkspaceGrepError(
          `could not start ripgrep: ${err.message}`,
          500,
          unavailable ? 'rg-unavailable' : 'process-failed',
        ),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      buffer += stdoutDecoder.end();
      drainBuffer(true);
      if (intentionalStop) {
        resolvePromise(accumulator.result(intentionalStop));
        return;
      }
      // rg uses 0 for matches, 1 for no matches, and >=2 for errors.
      if (code === 0 || code === 1) {
        resolvePromise(accumulator.result());
        return;
      }
      const detail = stderr.trim() || `ripgrep exited with code ${code ?? 'unknown'}`;
      const invalidRegex = /regex parse error|error parsing regex/i.test(detail);
      rejectPromise(
        new WorkspaceGrepError(
          invalidRegex ? `invalid regex: ${detail}` : `ripgrep failed: ${detail}`,
          invalidRegex ? 400 : 500,
          invalidRegex ? 'invalid-regex' : 'process-failed',
        ),
      );
    });
  });
}

async function runJavascriptSearch(
  target: ResolvedSearchTarget,
  plan: SearchPlan,
): Promise<RawSearchResult> {
  // An exact model call commonly omits `literal`; if the pattern contains
  // no regex syntax, literal and regex semantics are identical, so it is
  // safe to keep that high-frequency path working on hosts without rg.
  const plainPattern = !REGEX_META_RE.test(plan.pattern);
  if (!plan.literal && !plainPattern && !plan.trustedRegex) {
    throw new WorkspaceGrepError(
      'regex search requires ripgrep on this machine; retry with literal=true',
      400,
      'invalid-request',
    );
  }
  let regex: RegExp;
  try {
    regex = new RegExp(
      plan.literal || plainPattern ? escapeRegExp(plan.pattern) : plan.pattern,
      plan.caseInsensitive ? 'i' : '',
    );
  } catch (err) {
    throw new WorkspaceGrepError(
      `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      400,
      'invalid-regex',
    );
  }

  const deadline = Date.now() + plan.timeoutMs;
  const accumulator = new ResultAccumulator(plan);

  for await (const candidate of walkSearchCandidates(target, plan, deadline)) {
    assertBeforeDeadline(deadline, plan.timeoutMs);
    try {
      const path = workspaceRelativePath(target.workspaceDir, target.cwd, candidate.relativePath);
      if (!path) continue;
      // Re-check realpath containment at the read boundary. Directory entry
      // types are only a snapshot; a workspace process may replace a file
      // with a symlink between traversal and this read.
      const lexicalPath = await resolveInside(target.workspaceDir, path);
      const actualPath = await realpath(lexicalPath);
      const fileStat = await stat(actualPath);
      if (!fileStat.isFile() || fileStat.size > MAX_FILE_BYTES) continue;
      const bytes = await readFile(actualPath);
      if (!looksLikeText(bytes)) continue;
      const lines = bytes.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        assertBeforeDeadline(deadline, plan.timeoutMs);
        const line = lines[index] ?? '';
        if (!regex.test(line)) continue;
        if (accumulator.add({ path, line: index + 1, text: line.slice(0, MAX_LINE_CHARS) })) {
          return accumulator.result('limit');
        }
        if (plan.resultMode === 'files') break;
      }
    } catch (err) {
      if (err instanceof WorkspaceGrepError) throw err;
      // Match ripgrep's default behavior for unreadable/transient files:
      // skip the file, but never convert a search-wide timeout to success.
    }
  }
  return accumulator.result();
}

const REGEX_META_RE = /[\\^$.*+?()[\]{}|]/;

interface SearchCandidate {
  relativePath: string;
}

async function* walkSearchCandidates(
  target: ResolvedSearchTarget,
  plan: SearchPlan,
  deadline: number,
): AsyncGenerator<SearchCandidate> {
  if (target.targetIsFile) {
    const relativePath = target.target.split(sep).join('/');
    if (filePassesGlobs(relativePath, plan)) {
      yield { relativePath };
    }
    return;
  }

  yield* walkDirectory(target.cwd, '', plan, deadline);
}

async function* walkDirectory(
  absoluteDir: string,
  relativeDir: string,
  plan: SearchPlan,
  deadline: number,
): AsyncGenerator<SearchCandidate> {
  assertBeforeDeadline(deadline, plan.timeoutMs);
  let entries: Dirent[];
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    assertBeforeDeadline(deadline, plan.timeoutMs);
    if (entry.isSymbolicLink()) continue;
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (matchesAnyGlob(`${relativePath}/`, plan.excludeGlobs, plan.caseInsensitive)) continue;
      yield* walkDirectory(absolutePath, relativePath, plan, deadline);
    } else if (entry.isFile() && filePassesGlobs(relativePath, plan)) {
      yield { relativePath };
    }
  }
}

function filePassesGlobs(relativePath: string, plan: SearchPlan): boolean {
  if (matchesAnyGlob(relativePath, plan.excludeGlobs, plan.caseInsensitive)) return false;
  return (
    plan.includeGlobs.length === 0 ||
    matchesAnyGlob(relativePath, plan.includeGlobs, plan.caseInsensitive)
  );
}

function matchesAnyGlob(
  value: string,
  globs: readonly string[],
  caseInsensitive: boolean,
): boolean {
  const candidate = caseInsensitive ? value.toLocaleLowerCase('en-US') : value;
  return globs.some((glob) =>
    posix.matchesGlob(candidate, caseInsensitive ? glob.toLocaleLowerCase('en-US') : glob),
  );
}

class ResultAccumulator {
  private readonly matches: SearchFilesMatch[] = [];
  private readonly files: string[] = [];
  private readonly seenFiles = new Set<string>();
  private logicalSeen = 0;
  private hasMore = false;

  constructor(private readonly plan: SearchPlan) {}

  /** Returns true once one extra logical result proves a continuation exists. */
  add(match: SearchFilesMatch): boolean {
    if (this.plan.resultMode === 'files') {
      if (this.seenFiles.has(match.path)) return false;
      this.seenFiles.add(match.path);
    }
    this.logicalSeen += 1;
    if (this.plan.resultMode === 'count') {
      if (this.logicalSeen > this.plan.limit) {
        this.hasMore = true;
        return true;
      }
      return false;
    }
    if (this.logicalSeen <= this.plan.cursor) return false;
    const output = this.plan.resultMode === 'files' ? this.files : this.matches;
    if (output.length >= this.plan.limit) {
      this.hasMore = true;
      return true;
    }
    if (this.plan.resultMode === 'files') this.files.push(match.path);
    else this.matches.push(match);
    return false;
  }

  result(forcedTruncation?: 'limit' | 'output'): RawSearchResult {
    const truncated = this.hasMore || forcedTruncation !== undefined;
    return {
      matches: this.matches,
      files: this.files,
      count:
        this.plan.resultMode === 'count'
          ? Math.min(this.logicalSeen, this.plan.limit)
          : this.plan.resultMode === 'files'
            ? this.files.length
            : this.matches.length,
      truncated,
      ...(truncated
        ? { truncationReason: forcedTruncation === 'output' ? 'output' : 'limit' }
        : {}),
    };
  }
}

async function capAndEnrichResult(
  workspaceDir: string,
  raw: RawSearchResult,
  plan: SearchPlan,
): Promise<RawSearchResult> {
  if (plan.resultMode === 'count') return raw;
  if (plan.resultMode === 'files') {
    let chars = 0;
    const files: string[] = [];
    for (const file of raw.files) {
      if (chars + file.length + 1 > MAX_RESPONSE_CHARS) break;
      files.push(file);
      chars += file.length + 1;
    }
    const outputCapped = files.length < raw.files.length;
    return {
      ...raw,
      files,
      count: files.length,
      truncated: raw.truncated || outputCapped,
      ...(outputCapped ? { truncationReason: 'output' as const } : {}),
    };
  }

  const lineCache = new Map<string, string[]>();
  const matches: SearchFilesMatch[] = [];
  let chars = 0;
  for (const match of raw.matches) {
    let enriched = match;
    if (plan.contextLines > 0) {
      let lines = lineCache.get(match.path);
      if (!lines) {
        try {
          const lexical = await resolveInside(workspaceDir, match.path);
          const actual = await realpath(lexical);
          const fileStat = await stat(actual);
          if (fileStat.isFile() && fileStat.size <= MAX_FILE_BYTES) {
            lines = (await readFile(actual, 'utf8')).split(/\r?\n/);
            lineCache.set(match.path, lines);
          }
        } catch {
          // The file may disappear between search and context hydration.
          // The original matched line remains useful and safely bounded.
        }
      }
      if (lines) {
        const zeroBased = match.line - 1;
        const before = lines
          .slice(Math.max(0, zeroBased - plan.contextLines), zeroBased)
          .map((text, offset, slice) => ({
            line: zeroBased - slice.length + offset + 1,
            text: text.slice(0, MAX_LINE_CHARS),
          }));
        const after = lines
          .slice(zeroBased + 1, zeroBased + 1 + plan.contextLines)
          .map((text, offset) => ({
            line: zeroBased + offset + 2,
            text: text.slice(0, MAX_LINE_CHARS),
          }));
        enriched = {
          ...match,
          ...(before.length > 0 ? { before } : {}),
          ...(after.length > 0 ? { after } : {}),
        };
      }
    }
    const size = JSON.stringify(enriched).length;
    if (chars + size > MAX_RESPONSE_CHARS) break;
    matches.push(enriched);
    chars += size;
  }
  const outputCapped = matches.length < raw.matches.length;
  return {
    ...raw,
    matches,
    count: matches.length,
    truncated: raw.truncated || outputCapped,
    ...(outputCapped ? { truncationReason: 'output' as const } : {}),
  };
}

function workspaceRelativePath(workspaceDir: string, cwd: string, rgPath: string): string | null {
  const absolutePath = resolve(cwd, rgPath);
  const rel = relative(workspaceDir, absolutePath);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

function assertBeforeDeadline(deadline: number, timeoutMs: number): void {
  if (Date.now() <= deadline) return;
  throw new WorkspaceGrepError(
    `grep timed out after ${timeoutMs}ms; narrow path/includeGlobs or use a literal pattern`,
    504,
    'timeout',
  );
}

async function resolveExecutableOnPath(
  command: string,
  forbiddenRoot: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      findExecutableOnPath(command, forbiddenRoot),
      new Promise<null>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function findExecutableOnPath(
  command: string,
  forbiddenRoot: string,
): Promise<string | null> {
  const pathValue = process.env.PATH;
  if (!pathValue) return null;
  const suffixes =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(delimiter)]
      : [''];
  for (const rawEntry of pathValue.split(delimiter).slice(0, 128)) {
    const entry = rawEntry.replace(/^"|"$/g, '');
    // Relative PATH entries (especially ".") would make the executable
    // depend on the model-controlled workspace cwd. Never honor them.
    if (!entry || !isAbsolute(entry)) continue;
    for (const suffix of suffixes) {
      try {
        const executable = await realpath(join(entry, `${command}${suffix}`));
        if (pathIsInside(forbiddenRoot, executable)) continue;
        const executableStat = await stat(executable);
        if (!executableStat.isFile()) continue;
        await access(
          executable,
          process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return executable;
      } catch {
        // Try the next PATH entry/extension.
      }
    }
  }
  return null;
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function minimalSearchEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.NO_COLOR = '1';
  return env;
}

function looksLikeText(bytes: Buffer): boolean {
  const length = Math.min(bytes.length, 4096);
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0 || byte < 9 || (byte > 13 && byte < 32 && byte !== 27)) return false;
  }
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function validateGlob(value: string): string {
  const glob = value.replaceAll('\\', '/');
  const segments = glob.split('/');
  if (
    glob.startsWith('!') ||
    glob.startsWith('/') ||
    /^[a-zA-Z]:\//.test(glob) ||
    segments.includes('..')
  ) {
    throw new WorkspaceGrepError(
      `glob must stay relative to the search root and must not start with "!": ${value}`,
      400,
      'invalid-request',
    );
  }
  try {
    posix.matchesGlob('__gezel_glob_probe__', glob);
  } catch (err) {
    throw new WorkspaceGrepError(
      `invalid glob ${JSON.stringify(value)}: ${err instanceof Error ? err.message : String(err)}`,
      400,
      'invalid-request',
    );
  }
  return glob;
}
