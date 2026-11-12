/**
 * Launching a task pack: a separate Node program owned by the product it
 * measures (for docbench, DocBlocks' `@bendyline/docblocks-bench`). Gezel
 * never imports it; it runs `describe` and `run` and validates every line
 * against the contract in `@bendyline/gezel/eval` (`bench-pack.ts`).
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type BenchCaseOutcome,
  BenchCaseOutcomeSchema,
  type BenchEvent,
  type BenchPackManifest,
  BenchPackManifestSchema,
  parseBenchEventLine,
} from '@bendyline/gezel/eval';

export interface PackCommand {
  /** The program and the arguments before the subcommand. */
  readonly command: string;
  readonly args: readonly string[];
  readonly root: string;
  /** Environment for every pack process, such as a swapped-in fixture set. */
  readonly env: Readonly<Record<string, string>>;
}

/** Where a sibling DocBlocks checkout keeps its pack, for a developer's machine. */
function siblingDocblocksPack(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', '..', 'docblocks', 'packages', 'bench');
}

/**
 * The pack to run: `--pack <dir>`, else GEZEL_DOCBENCH_PACK, else a sibling
 * `../docblocks/packages/bench`. A built pack (`dist/cli.js`) runs with Node;
 * an unbuilt checkout says how to build it rather than guessing at a loader.
 * `fixtures` points the pack at another fixture set laid out like its own,
 * such as a private holdout set.
 */
export function resolvePack(spec?: string, fixtures?: string): PackCommand {
  const root = resolve(
    spec?.trim() || process.env.GEZEL_DOCBENCH_PACK?.trim() || siblingDocblocksPack(),
  );
  const cli = join(root, 'dist', 'cli.js');
  if (!existsSync(cli)) {
    throw new Error(
      `No built task pack at ${cli}. Build it in DocBlocks (npm run build:core && npm run build:react && npm run build:bench), or pass --pack <path to packages/bench>.`,
    );
  }
  if (fixtures && !existsSync(fixtures)) throw new Error(`No fixture set at ${fixtures}`);
  return {
    command: process.execPath,
    args: [cli],
    root,
    env: fixtures ? { DOCBENCH_FIXTURES_DIR: resolve(fixtures) } : {},
  };
}

function collect(
  pack: PackCommand,
  subcommand: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    onLine?: (line: string) => void;
    stderrPath?: string;
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pack.command, [...pack.args, ...subcommand], {
      cwd: pack.root,
      env: { ...process.env, ...pack.env, ...options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const log = options.stderrPath ? createWriteStream(options.stderrPath, { flags: 'a' }) : null;
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      pending += text;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? '';
      for (const line of lines) options.onLine?.(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr = (stderr + text).slice(-20_000);
      log?.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (pending) options.onLine?.(pending);
      log?.end();
      resolvePromise({ code, stdout, stderr });
    });
  });
}

export async function describePack(pack: PackCommand): Promise<BenchPackManifest> {
  const result = await collect(pack, ['describe']);
  if (result.code !== 0) {
    throw new Error(`The task pack failed to describe itself: ${result.stderr.slice(-1_000)}`);
  }
  return BenchPackManifestSchema.parse(JSON.parse(result.stdout));
}

export interface PackRunOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly token?: string;
  /** PEM file of the daemon's per-launch certificate, trusted for this run only. */
  readonly caFile?: string;
  readonly trial: number;
  readonly seed: number;
  readonly now: string;
  readonly tasks: readonly string[];
  readonly cases?: readonly string[];
  readonly outDir: string;
  readonly stderrPath?: string;
  readonly onEvent?: (event: BenchEvent) => void;
}

/** Run the pack against one endpoint; resolves when it exits. */
export async function runPackTrial(pack: PackCommand, options: PackRunOptions): Promise<void> {
  const args = [
    'run',
    '--endpoint',
    options.endpoint,
    '--model',
    options.model,
    '--trial',
    String(options.trial),
    '--seed',
    String(options.seed),
    '--now',
    options.now,
    '--out-dir',
    options.outDir,
    ...(options.tasks.length > 0 ? ['--tasks', options.tasks.join(',')] : []),
    ...(options.cases && options.cases.length > 0 ? ['--cases', options.cases.join(',')] : []),
  ];
  const result = await collect(pack, args, {
    env: {
      // The token rides the environment, never argv, where any process can read it.
      ...(options.token ? { DOCBENCH_ENDPOINT_TOKEN: options.token } : {}),
      ...(options.caFile ? { NODE_EXTRA_CA_CERTS: options.caFile } : {}),
    },
    ...(options.stderrPath ? { stderrPath: options.stderrPath } : {}),
    onLine: (line) => {
      const event = parseBenchEventLine(line);
      if (event) options.onEvent?.(event);
    },
  });
  if (result.code !== 0) {
    throw new Error(`The task pack exited ${String(result.code)}: ${result.stderr.slice(-1_500)}`);
  }
}

/** Every outcome file under a model's case directory, validated. */
export async function readOutcomes(
  dir: string,
): Promise<{ file: string; outcome: BenchCaseOutcome }[]> {
  if (!existsSync(dir)) return [];
  const out: { file: string; outcome: BenchCaseOutcome }[] = [];
  for (const task of await readdir(dir, { withFileTypes: true })) {
    if (!task.isDirectory()) continue;
    for (const entry of await readdir(join(dir, task.name))) {
      if (!/-t\d+\.json$/u.test(entry)) continue;
      const file = join(dir, task.name, entry);
      const parsed = BenchCaseOutcomeSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (!parsed.success) {
        throw new Error(`${file} does not match the task-pack contract: ${parsed.error.message}`);
      }
      out.push({ file, outcome: parsed.data });
    }
  }
  return out;
}
