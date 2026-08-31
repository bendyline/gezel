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
