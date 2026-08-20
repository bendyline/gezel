#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportRoot = join(root, 'artifacts', 'coverage');
const metrics = ['statements', 'branches', 'functions', 'lines'];
const sourceInclude = 'src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}';

// These are executable V8 coverage floors, not the direct-import test-surface
// inventory. Start from measured package baselines and ratchet them upward as
// behavior is covered. Values deliberately leave a little cross-platform
// headroom for platform-specific branches in app/service code.
export const targets = [
  {
    id: 'core',
    root: 'packages/core',
    include: sourceInclude,
    thresholds: { statements: 85, branches: 73, functions: 79, lines: 87 },
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
    include: sourceInclude,
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
    thresholds: { statements: 76, branches: 67, functions: 55, lines: 77 },
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
    thresholds: { statements: 38, branches: 0, functions: 38, lines: 40 },
  },
  {
    id: 'connectors-spectral',
    root: 'packages/connectors-spectral',
    include: sourceInclude,
    thresholds: { statements: 36, branches: 29, functions: 19, lines: 39 },
  },
  {
    id: 'vscode',
    root: 'packages/vscode',
    include: sourceInclude,
    thresholds: { statements: 23, branches: 30, functions: 17, lines: 23 },
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
    thresholds: { statements: 48, branches: 47, functions: 50, lines: 49 },
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
  const options = { reportOnly: false, packageIds: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--report-only') options.reportOnly = true;
    else if (arg === '--package') {
      const packageId = args[index + 1];
      if (!packageId) throw new Error('--package requires a package id');
      options.packageIds.push(packageId);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
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
  const requested = new Set(options.packageIds);
  const selected =
    requested.size > 0 ? targets.filter((target) => requested.has(target.id)) : targets;
  const unknown = [...requested].filter((id) => !targets.some((target) => target.id === id));
  if (unknown.length > 0) throw new Error(`Unknown coverage package(s): ${unknown.join(', ')}`);

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
      `--coverage.include=${target.include}`,
      ...exclusions.map((pattern) => `--coverage.exclude=${pattern}`),
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
