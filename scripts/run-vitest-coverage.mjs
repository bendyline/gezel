#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnPnpm } from './pnpm-cli.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportRoot = join(root, 'artifacts', 'coverage');
const metrics = ['statements', 'branches', 'functions', 'lines'];
const sourceInclude = 'src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';

// These are executable V8 coverage floors, not the direct-import test-surface
// inventory. A floor catches a collapse (a suite that stopped running, a
// source tree that lost its tests), not ordinary drift: set it about a third
// below the measured value, and never ratchet it up to a new measurement. A
// floor within a point or two of the measurement fails CI on routine work.
export const targets = [
  {
    id: 'core',
    root: 'packages/core',
    include: sourceInclude,
    // Measured 86.3 / 76.8 / 86.3 / 88.9 on 2026-11-23.
    thresholds: { statements: 57, branches: 51, functions: 57, lines: 59 },
  },
  {
    id: 'client',
    root: 'packages/client',
    include: sourceInclude,
    thresholds: { statements: 30, branches: 33, functions: 15, lines: 31 },
  },
  {
    id: 'catalog',
    root: 'packages/catalog',
    include: sourceInclude,
    thresholds: { statements: 73, branches: 66, functions: 72, lines: 76 },
  },
  {
    id: 'knowledge',
    root: 'packages/knowledge',
    include: sourceInclude,
    thresholds: { statements: 70, branches: 55, functions: 75, lines: 72 },
  },
  {
    id: 'mcp',
    root: 'packages/mcp',
    include: sourceInclude,
    thresholds: { statements: 35, branches: 22, functions: 32, lines: 35 },
  },
  {
    id: 'service',
    root: 'packages/service',
    // The extraction changes ownership, not the measured runtime or its floors.
    include: [sourceInclude, `../inference/${sourceInclude}`],
    config: 'packages/service/vitest.coverage.config.ts',
    allowExternal: true,
    thresholds: { statements: 56, branches: 47, functions: 53, lines: 59 },
  },
  {
    id: 'ui',
    root: 'packages/ui',
    include: sourceInclude,
    thresholds: { statements: 54, branches: 49, functions: 50, lines: 57 },
  },
  {
    id: 'app',
    root: 'packages/app',
    include: sourceInclude,
    thresholds: { statements: 45, branches: 40, functions: 39, lines: 47 },
  },
  {
    id: 'cli',
    root: 'packages/cli',
    include: sourceInclude,
    thresholds: { statements: 55, branches: 50, functions: 65, lines: 56 },
  },
  {
    id: 'sdk',
    root: 'packages/sdk',
    include: sourceInclude,
    // Measured 78.2 / 70.0 / 62.6 / 79.6 on 2026-11-23.
    thresholds: { statements: 52, branches: 46, functions: 41, lines: 53 },
  },
  {
    id: 'script-runtime',
    root: 'packages/script-runtime',
    include: sourceInclude,
    // Measured 93.5 / 88.2 / 98.2 / 95.3 on 2026-11-23.
    thresholds: { statements: 62, branches: 58, functions: 65, lines: 63 },
  },
  {
    id: 'app-sdk',
    root: 'packages/app-sdk',
    include: sourceInclude,
    thresholds: { statements: 62, branches: 59, functions: 62, lines: 65 },
  },
  {
    id: 'plugin-sdk',
    root: 'packages/plugin-sdk',
    include: sourceInclude,
    // Measured 40.0 / 0.0 / 40.0 / 42.9 on 2026-11-23.
    thresholds: { statements: 26, branches: 0, functions: 26, lines: 28 },
  },
  {
    id: 'connectors-spectral',
    root: 'packages/connectors-spectral',
    include: sourceInclude,
    thresholds: { statements: 85, branches: 80, functions: 75, lines: 85 },
  },
  {
    id: 'vscode',
    root: 'packages/vscode',
    include: sourceInclude,
    // Measured 24.4 / 31.3 / 17.6 / 23.9 on 2026-11-23.
    thresholds: { statements: 16, branches: 20, functions: 11, lines: 15 },
  },
  {
    id: 'script-stdlib',
    root: 'packages/script-stdlib',
    include: 'scripts/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}',
    thresholds: { statements: 32, branches: 29, functions: 44, lines: 33 },
  },
  {
    id: 'evals',
    root: 'evals',
    include: sourceInclude,
    // Measured 50.2 / 46.8 / 52.9 / 51.0 on 2026-11-23.
    thresholds: { statements: 33, branches: 31, functions: 35, lines: 34 },
  },
];

const exclusions = [
  '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
  '**/*.config.{js,mjs,cjs,ts,mts,cts}',
  '**/*.d.ts',
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/test-fixtures/**',
  '**/generated/**',
  '**/test-utils/**',
];

export function parseArgs(args) {
  const options = { reportOnly: false, packageIds: [], excludedPackageIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--report-only') options.reportOnly = true;
    else if (arg === '--package' || arg === '--exclude-package') {
      const packageId = args[index + 1];
      if (!packageId) throw new Error(`${arg} requires a package id`);
      (arg === '--package' ? options.packageIds : options.excludedPackageIds).push(packageId);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

// CI shards the pass by exclusion (`--package service` on one runner,
// `--exclude-package service` on the other) so a target added above lands in
// a shard without anyone editing the workflow. A misspelled id or a shard left
// with nothing to measure must fail loudly, not report an empty success.
export function selectTargets(configuredTargets, options) {
  const named = [...options.packageIds, ...options.excludedPackageIds];
  const unknown = named.filter((id) => !configuredTargets.some((target) => target.id === id));
  if (unknown.length > 0) throw new Error(`Unknown coverage package(s): ${unknown.join(', ')}`);
  const requested = new Set(options.packageIds);
  const excluded = new Set(options.excludedPackageIds);
  const selected = configuredTargets.filter(
    (target) => (requested.size === 0 || requested.has(target.id)) && !excluded.has(target.id),
  );
  if (selected.length === 0) throw new Error('No coverage packages left to measure');
  return selected;
}

// pnpm goes through spawnPnpm: a bare `spawn('pnpm')` cannot resolve
// pnpm.cmd on Windows, so `pnpm all` died at its coverage step there.
function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const options = { cwd: root, env: process.env, stdio: 'inherit' };
    const child = command === 'pnpm' ? spawnPnpm(args, options) : spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolveRun(code ?? 1);
    });
  });
}

export function normalizeSummary(target, rawSummary) {
  const total = rawSummary.total;
  if (!total) throw new Error(`${target.id}: coverage-summary.json has no total`);
  const coverage = Object.fromEntries(
    metrics.map((metric) => {
      const value = total[metric];
      if (!value || typeof value.pct !== 'number') {
        throw new Error(`${target.id}: coverage summary is missing ${metric}`);
      }
      return [metric, { total: value.total, covered: value.covered, pct: value.pct }];
    }),
  );
  return {
    package: target.id,
    packageRoot: target.root,
    coverage,
    thresholds: target.thresholds,
  };
}

export function thresholdFailures(summary) {
  return metrics.flatMap((metric) => {
    const minimum = summary.thresholds[metric];
    if (typeof minimum !== 'number' || summary.coverage[metric].pct >= minimum) return [];
    return [
      `${summary.package} ${metric}: ${summary.coverage[metric].pct.toFixed(2)}% < ${minimum.toFixed(2)}%`,
    ];
  });
}

export function validateTargets(configuredTargets) {
  return configuredTargets.flatMap((target) =>
    metrics.flatMap((metric) => {
      const value = target.thresholds[metric];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
        ? []
        : [`${target.id}: ${metric} threshold must be a number from 0 to 100`];
    }),
  );
}

export async function main() {
  const configurationFailures = validateTargets(targets);
  if (configurationFailures.length > 0) {
    throw new Error(`Invalid coverage configuration:\n${configurationFailures.join('\n')}`);
  }
  const options = parseArgs(process.argv.slice(2));
  const selected = selectTargets(targets, options);

  await rm(reportRoot, { recursive: true, force: true });
  await mkdir(reportRoot, { recursive: true });

  const summaries = [];
  for (const target of selected) {
    const reportsDirectory = join(reportRoot, target.id);
    process.stdout.write(`\n[coverage] ${target.id}\n`);
    const vitestArgs = [
      'run',
      '--root',
      target.root,
      // Instrumentation adds measurable overhead to process-heavy tests. Keep
      // behavioral timeouts inside the code under test authoritative instead
      // of failing because Vitest's default five-second wrapper was exceeded.
      '--testTimeout=60000',
      '--hookTimeout=60000',
      '--coverage.enabled=true',
      '--coverage.provider=v8',
      '--coverage.reportOnFailure=true',
      '--coverage.reporter=text-summary',
      '--coverage.reporter=json-summary',
      `--coverage.reportsDirectory=${reportsDirectory}`,
      ...[target.include].flat().map((pattern) => `--coverage.include=${pattern}`),
      ...(target.config ? ['--config', resolve(root, target.config)] : []),
      ...(target.allowExternal ? ['--coverage.allowExternal=true'] : []),
      ...exclusions.map((pattern) => `--coverage.exclude=${pattern}`),
      // The CLI integration suite runs a real daemon and many CLI children.
      // Parallel coverage workers contend with them on the CI runner, causing
      // child deadlines and daemon connection resets. Keep all tests in the
      // coverage pass, but run this package's files one at a time.
      ...(target.id === 'cli' ? ['--maxWorkers=1'] : []),
    ];
    // The override is useful while the checkout's dependency mutation lease is
    // occupied: a separately installed Vitest can measure this tree without
    // rewriting its live node_modules. Normal local and CI runs use pnpm.
    const injectedVitest = process.env.GEZEL_COVERAGE_VITEST_BIN;
    const exitCode = injectedVitest
      ? await run(injectedVitest, vitestArgs)
      : await run('pnpm', ['exec', 'vitest', ...vitestArgs]);
    if (exitCode !== 0) process.exit(exitCode);

    const rawSummary = JSON.parse(
      await readFile(join(reportsDirectory, 'coverage-summary.json'), 'utf8'),
    );
    summaries.push(normalizeSummary(target, rawSummary));
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    provider: 'v8',
    scope: 'Vitest production source files',
    packages: summaries,
  };
  await writeFile(join(reportRoot, 'summary.json'), `${JSON.stringify(artifact, null, 2)}\n`);

  process.stdout.write('\nExecutable V8 coverage by package\n');
  process.stdout.write('package                 stmts  branch   funcs   lines\n');
  for (const summary of summaries) {
    process.stdout.write(
      `${summary.package.padEnd(23)} ${metrics
        .map((metric) => `${summary.coverage[metric].pct.toFixed(1)}%`.padStart(7))
        .join(' ')}\n`,
    );
  }

  if (options.reportOnly) {
    process.stdout.write('\n[coverage] report-only mode: thresholds were not enforced.\n');
    return;
  }

  const failures = summaries.flatMap(thresholdFailures);
  if (failures.length > 0) {
    process.stderr.write(
      `\nCoverage floors failed:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
