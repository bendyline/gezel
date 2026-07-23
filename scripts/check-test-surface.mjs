#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageThresholds = {
  core: 53.3,
  service: 66.9,
  ui: 30.7,
  app: 47.6,
  catalog: 80,
  mcp: 92.9,
  client: 57.1,
  cli: 7.7,
  sdk: 100,
  'app-sdk': 33.3,
  'plugin-sdk': 100,
  'connectors-spectral': 33.3,
  vscode: 66.7,
  'eval-viewer': 6.7,
};

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx']);
const testPattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ignoredSegments = new Set(['dist', 'node_modules', 'generated', '__snapshots__']);

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredSegments.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

async function resolveSourceImport(testFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(testFile), specifier);
  const candidates = extname(base)
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.jsx$/, '.tsx'), base]
    : [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.jsx`,
        join(base, 'index.ts'),
        join(base, 'index.tsx'),
      ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next supported source extension.
    }
  }
  return null;
}

async function inspectPackage(name, minimumPercent) {
  const packageRoot = join(root, 'packages', name);
  const sourceRoot = join(packageRoot, 'src');
  try {
    if (!(await stat(sourceRoot)).isDirectory()) return null;
  } catch {
    return null;
  }

  const files = await walk(sourceRoot);
  const production = files.filter(
    (file) =>
      sourceExtensions.has(extname(file)) &&
      !testPattern.test(file) &&
      !file.endsWith('.d.ts') &&
      !file.endsWith(`${join('src', 'vite-env.d.ts')}`),
  );
  const tests = files.filter((file) => testPattern.test(file));
  const covered = new Set();

  for (const testFile of tests) {
    const testStem = testFile.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, '');
    for (const sourceFile of production) {
      if (sourceFile.replace(/\.[cm]?[jt]sx?$/, '') === testStem) covered.add(sourceFile);
    }

    const source = await readFile(testFile, 'utf8');
    const imports = source.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g);
    for (const match of imports) {
      const resolved = await resolveSourceImport(testFile, match[2]);
      if (resolved && production.includes(resolved)) covered.add(resolved);
    }

    // Subprocess tests intentionally launch the built CLI/API entry instead
    // of importing it. Attribute a literal dist/foo.js launch to src/foo.ts.
    for (const match of source.matchAll(/(?:^|[/'"])(?:\.\.\/)*dist\/([^'"`]+)\.js/g)) {
      for (const extension of ['.ts', '.tsx', '.js', '.jsx']) {
        const sourceFile = join(sourceRoot, `${match[1]}${extension}`);
        if (production.includes(sourceFile)) covered.add(sourceFile);
      }
    }
  }

  const percent = production.length === 0 ? 100 : (covered.size / production.length) * 100;
  const roundedPercent = Number(percent.toFixed(1));
  return {
    package: name,
    productionFiles: production.length,
    testFiles: tests.length,
    directlyCoveredFiles: covered.size,
    percent: roundedPercent,
    minimumPercent,
    passes: roundedPercent >= minimumPercent,
    uncovered: production
      .filter((file) => !covered.has(file))
      .map((file) => relative(packageRoot, file).replaceAll('\\', '/')),
  };
}

const results = (
  await Promise.all(
    Object.entries(packageThresholds).map(([name, threshold]) => inspectPackage(name, threshold)),
  )
).filter(Boolean);

console.log('Package test-surface inventory (direct imports + colocated tests)');
console.log('package                 source  tests  covered   rate   floor');
for (const result of results) {
  console.log(
    `${result.package.padEnd(23)} ${String(result.productionFiles).padStart(6)} ${String(result.testFiles).padStart(6)} ${String(result.directlyCoveredFiles).padStart(8)} ${`${result.percent.toFixed(1)}%`.padStart(7)} ${`${result.minimumPercent.toFixed(1)}%`.padStart(7)}`,
  );
}

const outputIndex = process.argv.indexOf('--json');
if (outputIndex >= 0) {
  const outputArg = process.argv[outputIndex + 1];
  if (!outputArg) throw new Error('--json requires an output path');
  const output = resolve(root, outputArg);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
}

const failed = results.filter((result) => !result.passes);
if (failed.length > 0) {
  for (const result of failed) {
    console.error(
      `${result.package}: ${result.percent.toFixed(1)}% direct test surface is below ${result.minimumPercent.toFixed(1)}%`,
    );
  }
  process.exitCode = 1;
}
