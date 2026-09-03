/**
 * The exporter's DuckDB seam: one short-lived CLI child per script, SQL on
 * stdin (never in argv), stdout captured. The binary is caller-supplied — the
 * toolchain package never downloads engines — and its reported version is
 * checked against the one the caller expects, because Parquet bytes are only
 * reproducible against a pinned writer.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

export interface DuckdbCli {
  binaryPath: string;
  /** Refuse to run a different release (e.g. `1.5.5`); omit to accept any. */
  expectedVersion?: string;
}

export class DuckdbError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'DuckdbError';
  }
}

/** `duckdb --version` prints `v1.5.5 (Variegata) d8cdaa33fd`; the tag without its `v`. */
export async function duckdbVersion(binaryPath: string): Promise<string> {
  const { stdout } = await runDuckdbProcess(binaryPath, ['--version'], '');
  const match = /v?(\d+\.\d+\.\d+)/.exec(stdout);
  if (!match?.[1])
    throw new DuckdbError(`could not read the DuckDB version from: ${stdout.trim()}`, '');
  return match[1];
}

export async function assertDuckdbCli(cli: DuckdbCli): Promise<string> {
  await access(cli.binaryPath).catch(() => {
    throw new DuckdbError(`DuckDB CLI not found at ${cli.binaryPath}`, '');
  });
  const version = await duckdbVersion(cli.binaryPath);
  if (cli.expectedVersion && version !== cli.expectedVersion) {
    throw new DuckdbError(
      `DuckDB ${cli.expectedVersion} expected, but ${cli.binaryPath} is ${version}; Parquet output is only reproducible against the pinned release`,
      '',
    );
  }
  return version;
}

/** Run a SQL script against an in-memory database; throws with DuckDB's own text on failure. */
export async function runDuckdbScript(cli: DuckdbCli, sql: string): Promise<string> {
  const { stdout } = await runDuckdbProcess(cli.binaryPath, ['-batch', ':memory:'], sql);
  return stdout;
}

function runDuckdbProcess(
  binaryPath: string,
  args: string[],
  stdin: string,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) =>
      reject(new DuckdbError(`could not start DuckDB: ${err.message}`, stderr)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout });
      else
        reject(
          new DuckdbError(
            `DuckDB exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
            stderr,
          ),
        );
    });
    child.stdin.on('error', () => {
      /* the close handler reports the failure */
    });
    child.stdin.end(stdin);
  });
}
