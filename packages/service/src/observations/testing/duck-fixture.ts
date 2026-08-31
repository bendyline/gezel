/**
 * Test helpers for the DuckDB layer.
 *
 * Two tiers, because the two questions are different. A **fake CLI** — a shell
 * script that echoes canned JSON — answers "does the runner assemble the
 * script, parse the output, honour its budget, and scrub its env?", and runs
 * on every machine with no binary present. A **real binary**, when one is on
 * disk, answers "does the sandbox actually hold?", which no fake can tell you.
 *
 * The fake follows the `makeFakeCodex` pattern already used for the CLI
 * providers. Windows needs two things beyond it, and both are properties of
 * the fake rather than of the engine. A batch file is the only stand-in cmd
 * can execute, so the fake carries a `.cmd` extension — and Node has refused
 * to spawn a `.cmd` without a shell since the 2024 argument-injection fix,
 * which is why {@link fakeDuckSpawn} exists. The real engine is a genuine
 * `.exe` and needs neither.
 */

import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duckdbBinaryName, duckdbInstallDir } from '@bendyline/gezel/native';

/**
 * Locate a real duckdb binary, or null.
 *
 * Prefers whatever the supervisor or the engine resolver already stamped, then
 * the Electron build's staged bundle, then the version-keyed install both
 * installers write to under a dev or production home.
 *
 * DuckDB is not in `native/build/` or `native-bin/` any more — it is vendored
 * from the DuckDB Foundation's own signed release and ships as a bundled
 * runtime beside node and pnpm, so those trees are deliberately not probed.
 * Get one with `node packages/app/scripts/fetch-duckdb.mjs`.
 */
export function findRealDuckdb(): string | null {
  const fromEnv = process.env.GEZEL_DUCKDB_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const exe = duckdbBinaryName(process.platform);
  // packages/service/src/observations/testing → repo root
  const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
  const candidates = [
    join(repoRoot, 'packages', 'app', 'dist', 'duckdb-bundle', exe),
    join(duckdbInstallDir(join(homedir(), '.gezel-dev')), exe),
    join(duckdbInstallDir(join(homedir(), '.gezel')), exe),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** True when the real-engine suites can run here. */
export function hasRealDuckdb(): boolean {
  return findRealDuckdb() !== null;
}

export interface FakeDuckdbSpec {
  /** Written verbatim to stdout. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Sleep before producing output, to exercise the awake-time budget. */
  sleepSeconds?: number;
  /**
   * Dump the child's environment to this path, so a test can assert that no
   * `GEZEL_*` token survived `sandboxEnv`.
   */
  envDumpPath?: string;
}

/**
 * `spawnImpl` for a {@link makeFakeDuckdb} stand-in: the production path
 * unchanged everywhere but Windows, where the batch fake is reached through
 * cmd.exe. The command is quoted here because Node concatenates file and args
 * verbatim when `shell` is set.
 */
export function fakeDuckSpawn(): typeof spawn {
  if (process.platform !== 'win32') return spawn;
  // One pre-joined command line rather than a command plus an args array:
  // handing `shell: true` separate args is deprecated (DEP0190) because Node
  // concatenates them without escaping, which is exactly what is done here —
  // deliberately, over a path and flags this file wrote itself.
  return ((command: string, args: readonly string[], options: SpawnOptions) =>
    spawn([`"${command}"`, ...args].join(' '), { ...options, shell: true })) as typeof spawn;
}

/**
 * Write an executable stand-in for the duckdb CLI at `path` and return the
 * path it actually landed at — on Windows that is `path` plus `.cmd`, since
 * cmd.exe will not execute an extension-less script. It ignores its SQL
 * entirely — the point is the runner's plumbing, not the engine's semantics.
 */
export async function makeFakeDuckdb(path: string, spec: FakeDuckdbSpec = {}): Promise<string> {
  const { stdout = '[]', stderr = '', exitCode = 0, sleepSeconds = 0, envDumpPath } = spec;

  if (process.platform === 'win32') {
    const cmdPath = path.toLowerCase().endsWith('.cmd') ? path : `${path}.cmd`;
    // The payload goes to sidecar files and comes back out with `type`, not
    // through `set /p`: this fake's whole job is emitting JSON, and cmd has no
    // way to put a double quote inside the quoted `set /p "=…"` form — doubling
    // it emits two. `type` reproduces the file's bytes with nothing appended,
    // so multi-line output needs no per-line handling either.
    const outPath = `${cmdPath}.out`;
    const errPath = `${cmdPath}.err`;
    await writeFile(outPath, stdout, 'utf8');
    await writeFile(errPath, stderr, 'utf8');
    const lines = ['@echo off'];
    if (envDumpPath) lines.push(`set > "${envDumpPath}"`);
    // `timeout` refuses to run at all when stdin is a pipe ("input redirection
    // is not supported"), and the runner always pipes its SQL script in.
    if (sleepSeconds > 0) lines.push(`ping -n ${sleepSeconds + 1} 127.0.0.1 >NUL`);
    if (stdout) lines.push(`type "${outPath}"`);
    if (stderr) lines.push(`type "${errPath}" 1>&2`);
    lines.push(`exit /b ${exitCode}`);
    await writeFile(cmdPath, `${lines.join('\r\n')}\r\n`, 'utf8');
    return cmdPath;
  }

  const sh = (s: string) => s.replaceAll("'", "'\\''");
  const body = [
    '#!/bin/sh',
    // Drain stdin so the writer never sees EPIPE before the delay elapses.
    'cat >/dev/null',
    ...(envDumpPath ? [`env > '${sh(envDumpPath)}'`] : []),
    ...(sleepSeconds > 0 ? [`sleep ${sleepSeconds}`] : []),
    `printf '%s' '${sh(stdout)}'`,
    ...(stderr ? [`printf '%s' '${sh(stderr)}' 1>&2`] : []),
    `exit ${exitCode}`,
  ].join('\n');
  await writeFile(path, `${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}
