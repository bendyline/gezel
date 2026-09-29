import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evalNodeRuntime,
  harnessBaseEnv,
  resolveCompiledHarness,
  resolveEvalHarness,
  resolveSourceHarness,
  spawnHarness,
} from './harness.js';

function touch(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** A directory that looks like a gezel checkout root to the walk. */
function plantCheckout(root: string): void {
  touch(join(root, 'pnpm-workspace.yaml'));
  touch(join(root, 'scripts', 'run-with-dependency-lease.mjs'));
  touch(join(root, 'evals', 'src', 'bin', 'all.ts'));
  touch(join(root, 'evals', 'package.json'), '{"name":"evals"}');
  touch(join(root, 'evals', 'node_modules', 'tsx', 'package.json'), '{"name":"tsx","main":"i.js"}');
  touch(join(root, 'evals', 'node_modules', 'tsx', 'i.js'));
}

function plantCompiled(serviceRoot: string): void {
  touch(join(serviceRoot, 'dist', 'evals', 'all.js'));
  touch(join(serviceRoot, 'dist', 'evals', 'catalog.js'));
}

describe('eval harness resolution', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gezel-eval-harness-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the live source harness from a gezel checkout', () => {
    plantCheckout(root);
    const module = join(root, 'packages', 'service', 'dist', 'index.js');
    touch(module);
    expect(resolveSourceHarness(module)?.repoRoot).toBe(root);
  });

  it('ignores a workspace root above an installed package', () => {
    // An npm install inside some other pnpm workspace, or a planted
    // pnpm-workspace.yaml in a shared parent, must never have its scripts run
    // with the daemon's environment.
    plantCheckout(root);
    const module = join(
      root,
      'app',
      'node_modules',
      '@bendyline',
      'gezel-service',
      'dist',
      'index.js',
    );
    touch(module);
    expect(resolveSourceHarness(module)).toBeNull();
  });

  it('runs the compiled harness beside the daemon when there is no checkout', () => {
    const serviceRoot = join(root, 'service');
    plantCompiled(serviceRoot);
    for (const entry of ['dist/index.js', 'dist/bin/gezeld.js']) {
      const moduleUrl = pathToFileURL(join(serviceRoot, entry)).href;
      touch(join(serviceRoot, entry));
      expect(resolveCompiledHarness(moduleUrl)?.all).toBe(
        join(serviceRoot, 'dist', 'evals', 'all.js'),
      );
      const harness = resolveEvalHarness({ moduleUrl, env: {} });
      expect(harness?.mode).toBe('compiled');
      const launch = harness?.launch('catalog', ['--out', '/tmp/x.json']);
      expect(launch?.args).toEqual([
        join(serviceRoot, 'dist', 'evals', 'catalog.js'),
        '--out',
        '/tmp/x.json',
      ]);
    }
  });

  it('prefers a checkout, runs through the dependency lease, and honours a forced mode', () => {
    plantCheckout(root);
    plantCompiled(join(root, 'packages', 'service'));
    const moduleUrl = pathToFileURL(join(root, 'packages', 'service', 'dist', 'index.js')).href;
    touch(join(root, 'packages', 'service', 'dist', 'index.js'));

    const source = resolveEvalHarness({ moduleUrl, env: {} });
    expect(source?.mode).toBe('source');
    const launch = source?.launch('all', ['--count', '1']);
    expect(launch?.cwd).toBe(root);
    expect(launch?.args).toEqual([
      join(root, 'scripts', 'run-with-dependency-lease.mjs'),
      '--direct-node',
      'evals/src/bin/all.ts',
      '--count',
      '1',
    ]);

    expect(resolveEvalHarness({ moduleUrl, env: { GEZEL_EVAL_HARNESS: 'compiled' } })?.mode).toBe(
      'compiled',
    );
  });

  it('reports no harness rather than guessing when neither shape exists', () => {
    const moduleUrl = pathToFileURL(join(root, 'lonely', 'dist', 'index.js')).href;
    expect(resolveEvalHarness({ moduleUrl, env: {} })).toBeNull();
  });

  it('runs the compiled harness under the bundled Node when the supervisor names one', () => {
    const node = join(root, 'bin', 'node');
    touch(node);
    expect(evalNodeRuntime({ GEZEL_NODE_PATH: node })).toEqual({ command: node, env: {} });
    expect(evalNodeRuntime({ GEZEL_NODE_PATH: join(root, 'missing') }).command).toBe(
      process.execPath,
    );
  });
});

describe('spawnHarness', () => {
  it('delivers complete lines from both streams, including an unterminated last line', async () => {
    const lines: string[] = [];
    const proc = spawnHarness(
      {
        command: process.execPath,
        args: [
          '-e',
          "process.stdout.write('a\\nb'); process.stderr.write('e\\n'); process.exit(4)",
        ],
        cwd: process.cwd(),
        env: {},
      },
      { env: process.env, onLine: (line, stream) => lines.push(`${stream}:${line}`) },
    );
    const exit = await proc.exited;
    expect(exit.code).toBe(4);
    expect(lines.sort()).toEqual(['stderr:e', 'stdout:a', 'stdout:b']);
  });
});

describe('harnessBaseEnv', () => {
  it('drops this daemon’s identity and keeps machine configuration', () => {
    const env = harnessBaseEnv({
      GEZEL_HOME: '/home/u/.gezel',
      GEZEL_PORT: '6228',
      GEZEL_SERVICE_ROLE: 'user',
      GEZEL_SYSTEM_SCOPE: '1',
      GEZEL_WEB: '1',
      GEZEL_SHUTDOWN_ON_STDIN_EOF: '1',
      GEZEL_NODE_PATH: '/home/u/.gezel/bin/node',
      GEZEL_LLAMA_SERVER_BIN: '/app/llama-server',
      PATH: '/usr/bin',
    });
    expect(env).toEqual({
      GEZEL_NODE_PATH: '/home/u/.gezel/bin/node',
      GEZEL_LLAMA_SERVER_BIN: '/app/llama-server',
      PATH: '/usr/bin',
    });
  });
});
