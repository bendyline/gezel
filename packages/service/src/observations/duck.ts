/**
 * `DuckRunner` — the one place gezel talks to the bundled DuckDB CLI.
 *
 * One short-lived child per statement, SQL on **stdin** (never in `argv`, so
 * there is no quoting surface), results back as JSON on stdout. A subprocess
 * rather than an in-process addon is deliberate: a runaway query is then a
 * killable child instead of a runaway allocation inside the daemon's heap,
 * and gezel avoids carrying a native ABI across the embedded / spawned /
 * packaged supervisor matrix.
 *
 * ── The sandbox, and why the statement guard is not optional ──────────────
 *
 * Every run applies a configuration prelude and then `SET lock_configuration
 * = true`, after which the statement cannot undo it. Measured against the
 * pinned DuckDB (see docs/observation-corpora.md), that prelude blocks
 * reads outside the allowed directories, remote URLs, extension installs, and
 * `COPY` to an outside path — and refuses attempts to re-widen any of it.
 *
 * It does **not** block `ATTACH`. `ATTACH '<allowed-dir>/x.db'` followed by
 * `CREATE TABLE` writes a real file inside the allowed directory even with
 * `enable_external_access=false` and the configuration locked. That is why
 * model-supplied SQL must pass the leading-keyword allowlist in
 * `statement-guard.ts` before it reaches {@link DuckRunner.runTrusted}, and
 * why relaxing that guard on the theory that "the config lockdown already
 * prevents writes" would be wrong.
 *
 * Hence the method name. `runTrusted` takes **first-party SQL only**. The
 * compactor and the rollup materializer build their own statements and are
 * legitimate callers; anything carrying a model's or a user's text must go
 * through the guarded query service instead.
 *
 * Deadlines budget in AWAKE time (`createAwakeTimeout`), not wall clock: a
 * host suspension freezes the daemon and the child alike, so charging sleep
 * against a query produces the "timed out after 60s" reports whose logs show
 * fifteen minutes elapsed.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createAwakeTimeout, createLogger } from '@bendyline/gezel';
import { duckdbBinaryName, duckdbInstalledBinary } from '@bendyline/gezel/native';
import { sandboxEnv } from '../sandbox/runner.js';

const log = createLogger('duckdb');

/** Default per-statement budget. Rollups pass their own, much larger. */
export const DEFAULT_DUCK_TIMEOUT_MS = 60_000;

/** Cap on captured stdout. A result this size is a bug in the caller's LIMIT. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export class DuckUnavailableError extends Error {
  readonly code = 'duckdb-unavailable' as const;
  /**
   * Marks the message as one the user can act on. `ChatManager.ensureProvider`
   * rewrites unmarked failures into "check your credentials", which would
   * point at the wrong problem entirely for a missing engine binary.
   */
  readonly isActionable = true;
  constructor(message: string) {
    super(message);
    this.name = 'DuckUnavailableError';
  }
}

export class DuckQueryError extends Error {
  readonly code = 'duckdb-query-failed' as const;
  constructor(
    message: string,
    /** DuckDB's own text, forwarded verbatim so a model can repair its SQL. */
    readonly engineMessage: string,
  ) {
    super(message);
    this.name = 'DuckQueryError';
  }
}

export interface DuckRunOptions {
  /**
   * Absolute directories the statement may read and write. Everything else on
   * the filesystem is refused by the engine, not merely by convention.
   * Required and non-empty: an empty list would leave the process able to
   * read the whole disk, so it is a hard error rather than a permissive
   * default.
   */
  allowedDirectories: string[];
  /** Awake-time budget for this statement. */
  timeoutMs?: number;
  /** `SET memory_limit`. Keeps one query from evicting a resident model. */
  memoryLimit?: string;
  /** `SET threads`. Left generous for rollups, small for interactive queries. */
  threads?: number;
}

export interface DuckRunnerOptions {
  /** Overrides binary resolution. Tests point this at a fake CLI. */
  binaryPath?: string;
  /**
   * GEZEL_HOME, so the ladder can look for the pinned build under
   * `<home>/engines/duckdb/<version>/`. Omitted in tests that supply
   * `binaryPath`; omitting it just removes that rung.
   */
  home?: string;
  /** Test seam; defaults to `node:child_process.spawn`. */
  spawnImpl?: typeof spawn;
  /** Test seam for existence checks; defaults to `node:fs.existsSync`. */
  fileExists?: (p: string) => boolean;
}

/**
 * Build the configuration prelude. Ordering is load-bearing:
 * `lock_configuration` must come last, and `allowed_directories` must be set
 * before `enable_external_access` is withdrawn.
 */
export function buildDuckPrelude(opts: DuckRunOptions): string {
  if (opts.allowedDirectories.length === 0) {
    throw new Error('duckdb: allowedDirectories must not be empty');
  }
  const dirs = opts.allowedDirectories.map((d) => `'${sqlLiteral(d)}'`).join(', ');
  return [
    // No extension may be fetched or side-loaded. Without this a statement can
    // pull httpfs from the network and reopen the egress we just closed.
    'SET autoinstall_known_extensions=false;',
    'SET autoload_known_extensions=false;',
    // Scope the filesystem before withdrawing general access.
    `SET allowed_directories=[${dirs}];`,
    'SET enable_external_access=false;',
    `SET memory_limit='${sqlLiteral(opts.memoryLimit ?? '2GB')}';`,
    `SET threads=${Math.max(1, Math.min(opts.threads ?? 4, 64))};`,
    // Seal it. Every SET above is now immutable for this process.
    'SET lock_configuration=true;',
  ].join('\n');
}

/** Escape a value for a single-quoted SQL string literal. */
export function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

/** Which rung of {@link DuckRunner.binary}'s ladder produced the executable. */
export type DuckBinarySource = 'explicit' | 'env' | 'pinned' | 'duckdb-installer' | 'path';

export interface DuckBinaryResolution {
  path: string;
  source: DuckBinarySource;
  /** True only when the bytes were verified against the pinned digest. */
  pinned: boolean;
}

/**
 * First `name` on `PATH`. Deliberately does not consult the shell, so a
 * user's rc-file aliases cannot redirect the query engine, and deliberately
 * skips empty PATH segments — an empty entry means "current directory" on
 * some shells, which would let a stray `duckdb` in the working tree win.
 */
function findOnPath(name: string, fileExists: (p: string) => boolean): string | null {
  const raw = process.env.PATH;
  if (!raw) return null;
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export class DuckRunner {
  private readonly spawnImpl: typeof spawn;
  private readonly explicitBinary?: string;
  private readonly home?: string;
  private readonly fileExists: (p: string) => boolean;

  constructor(opts: DuckRunnerOptions = {}) {
    this.spawnImpl = opts.spawnImpl ?? spawn;
    if (opts.binaryPath !== undefined) this.explicitBinary = opts.binaryPath;
    if (opts.home !== undefined) this.home = opts.home;
    this.fileExists = opts.fileExists ?? existsSync;
  }

  /**
   * Resolve the CLI, in descending order of how much we can vouch for it.
   *
   * The ordering is a security decision, not a convenience one. Both the
   * configuration prelude above and `statement-guard`'s use of
   * `json_serialize_sql` are behavioural contracts measured against the
   * pinned build, so a binary we verified against {@link DUCKDB_BINARY_SHA256}
   * must win over whatever `duckdb` happens to be on `PATH` — an older or
   * differently-configured engine could change those semantics silently, and
   * a writable PATH entry would otherwise be a substitution vector for the
   * component that enforces the query sandbox.
   *
   * Rungs three and four exist so an npm / CLI install that declined the
   * download still works: `~/.duckdb/cli/latest/` is where DuckDB's own
   * installer (install.duckdb.org) puts the CLI, and it is frequently not on
   * PATH. Those rungs are unverified by construction, which is why
   * {@link resolvedBinaryProvenance} records which rung answered — a support
   * case needs to know whether the measured sandbox matrix applies.
   */
  binary(): string {
    const resolved = this.resolve();
    if (!resolved) {
      throw new DuckUnavailableError(
        'The data query engine (DuckDB) is not installed yet. Run `gezel engines install duckdb` to ' +
          'download the pinned build, install DuckDB yourself (https://install.duckdb.org, `brew install duckdb`, ' +
          'or your package manager), or set GEZEL_DUCKDB_BIN to an existing duckdb binary. ' +
          'The mirrored data is safe on disk either way.',
      );
    }
    return resolved.path;
  }

  /**
   * Which rung of the ladder answered, and whether those bytes were checked
   * against the pin. Logged once per process by {@link exec} so a bug report
   * carries the provenance without needing a repro.
   */
  resolvedBinaryProvenance(): DuckBinaryResolution | null {
    return this.resolve();
  }

  private resolve(): DuckBinaryResolution | null {
    if (this.explicitBinary) {
      return { path: this.explicitBinary, source: 'explicit', pinned: false };
    }
    const fromEnv = process.env.GEZEL_DUCKDB_BIN;
    if (fromEnv) return { path: fromEnv, source: 'env', pinned: false };

    if (this.home) {
      const pinned = duckdbInstalledBinary(this.home);
      if (this.fileExists(pinned)) {
        return { path: pinned, source: 'pinned', pinned: true };
      }
    }

    const vendorInstall = join(
      homedir(),
      '.duckdb',
      'cli',
      'latest',
      duckdbBinaryName(process.platform),
    );
    if (this.fileExists(vendorInstall)) {
      return { path: vendorInstall, source: 'duckdb-installer', pinned: false };
    }

    const onPath = findOnPath(duckdbBinaryName(process.platform), this.fileExists);
    if (onPath) return { path: onPath, source: 'path', pinned: false };

    return null;
  }

  available(): boolean {
    try {
      this.binary();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run FIRST-PARTY SQL and parse the JSON result.
   *
   * Never pass model- or user-authored SQL here directly — see the file header.
   * Callers handling untrusted text must apply the statement guard first.
   */
  async runTrusted<Row = Record<string, unknown>>(
    sql: string,
    opts: DuckRunOptions,
  ): Promise<Row[]> {
    const stdout = await this.exec(`${buildDuckPrelude(opts)}\n${sql}\n`, opts);
    const text = stdout.trim();
    if (!text) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as Row[]) : [parsed as Row];
    } catch (err) {
      throw new DuckQueryError(
        `duckdb returned output that is not JSON: ${String(err)}`,
        text.slice(0, 2000),
      );
    }
  }

  private exec(script: string, opts: DuckRunOptions): Promise<string> {
    const bin = this.binary();
    const budgetMs = opts.timeoutMs ?? DEFAULT_DUCK_TIMEOUT_MS;
    const { signal, budget, dispose } = createAwakeTimeout(budgetMs);

    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(bin, ['-json', '-batch', ':memory:'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // The child is its own process group on POSIX so a timeout kills any
          // descendants too; on Windows `detached` only spawns a console
          // window, so it stays off there.
          detached: process.platform !== 'win32',
          // Strip every GEZEL_* token and provider key. The engine has no
          // business holding credentials, and cannot leak what it never saw.
          env: sandboxEnv(process.env),
        });
      } catch (err) {
        dispose();
        reject(new DuckUnavailableError(`could not start the data query engine: ${String(err)}`));
        return;
      }

      let out = '';
      let errText = '';
      let truncated = false;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        dispose();
        fn();
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (out.length >= MAX_STDOUT_BYTES) {
          truncated = true;
          return;
        }
        out += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        // Bounded: a malformed statement can otherwise repeat its error.
        if (errText.length < 64_000) errText += chunk.toString('utf8');
      });

      signal.addEventListener(
        'abort',
        () => {
          killGroup(child);
          finish(() =>
            reject(
              new DuckQueryError(
                `the query exceeded its ${Math.round(budgetMs / 1000)}s budget${budget.describeSuspension()}`,
                errText.trim(),
              ),
            ),
          );
        },
        { once: true },
      );

      child.on('error', (err) => {
        finish(() =>
          reject(new DuckUnavailableError(`the data query engine failed to run: ${String(err)}`)),
        );
      });

      child.on('close', (code, sig) => {
        if (signal.aborted) return;
        if (truncated) {
          finish(() =>
            reject(
              new DuckQueryError(
                'the query produced more output than can be held in memory — add a LIMIT or aggregate further',
                errText.trim(),
              ),
            ),
          );
          return;
        }
        if (code === 0) {
          finish(() => resolve(out));
          return;
        }
        const detail = errText.trim() || `exit ${code ?? 'null'}${sig ? ` (${sig})` : ''}`;
        log.debug(`query failed: ${detail}`);
        finish(() => reject(new DuckQueryError(detail, detail)));
      });

      child.stdin?.on('error', () => {
        /* the close handler reports the real failure */
      });
      child.stdin?.end(script);
    });
  }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
