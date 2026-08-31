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
 * providers, including its Windows branch: interpolating multi-line output
 * into a single `set /p` makes cmd.exe execute line two as a command.
 */

import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate a real duckdb binary, or null. Prefers whatever the supervisor or the
 * engine resolver already stamped, then the local `native/build` tree a
 * developer gets from `native/engines/duckdb/build.sh`, then the fetched
 * release payload.
 */
export function findRealDuckdb(): string | null {
  const fromEnv = process.env.GEZEL_DUCKDB_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const platformKey =
    process.platform === 'darwin' && process.arch === 'arm64'
      ? 'darwin-arm64'
      : process.platform === 'linux' && process.arch === 'x64'
        ? 'linux-x64'
        : process.platform === 'linux' && process.arch === 'arm64'
          ? 'linux-arm64'
          : process.platform === 'win32' && process.arch === 'x64'
            ? 'win32-x64'
            : null;
  if (!platformKey) return null;

  const exe = process.platform === 'win32' ? 'duckdb.exe' : 'duckdb';
  // packages/service/src/observations/testing → repo root
  const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..');
  for (const dir of [
    join(repoRoot, 'native', 'build', platformKey),
    join(repoRoot, 'packages', 'app', 'native-bin', platformKey),
  ]) {
    const candidate = join(dir, exe);
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
 * Write an executable stand-in for the duckdb CLI at `path` and return it.
 * It ignores its SQL entirely — the point is the runner's plumbing, not the
 * engine's semantics.
 */
export async function makeFakeDuckdb(path: string, spec: FakeDuckdbSpec = {}): Promise<string> {
  const { stdout = '[]', stderr = '', exitCode = 0, sleepSeconds = 0, envDumpPath } = spec;

  if (process.platform === 'win32') {
    const lines = ['@echo off'];
    if (envDumpPath) lines.push(`set > "${envDumpPath}"`);
    if (sleepSeconds > 0) lines.push(`timeout /t ${sleepSeconds} /nobreak >NUL`);
    // One `set /p` per line: cmd.exe would treat a subsequent line of an
    // interpolated multi-line value as its own command.
    for (const line of stdout.split('\n')) {
      lines.push(`<NUL set /p "=${line.replaceAll('%', '%%').replaceAll('"', '""')}"`);
    }
    for (const line of stderr.split('\n').filter(Boolean)) {
      lines.push(`echo ${line.replaceAll('%', '%%')} 1>&2`);
    }
    lines.push(`exit /b ${exitCode}`);
    await writeFile(path, `${lines.join('\r\n')}\r\n`, 'utf8');
    return path;
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
