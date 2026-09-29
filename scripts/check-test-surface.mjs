#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageThresholds = {
  // Direct-test-surface floors, not statement/branch coverage: they catch a
  // package drifting toward untested, not any single file. Each leaves room
  // for at least two more untested runtime files at the time it was set — a
  // floor on the current rate fails the very next file, which is noise. Lower
  // one to restore that room; never raise one to the current rate.
  core: 54.8,
  service: 71.7,
  ui: 54.7,
  app: 69.7,
  catalog: 85.1,
  knowledge: 57.9,
  mcp: 91.6,
  client: 65,
  cli: 82.6,
  sdk: 75,
  'app-sdk': 50,
  'plugin-sdk': 33.3,
  'connectors-spectral': 25,
  vscode: 57.1,
  'eval-viewer': 12.5,
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

/**
 * Whether a module carries anything to execute. A file of interfaces and type
 * aliases has no behavior a test could exercise, so counting it as untested
 * surface only lowers a package's rate whenever one lands — a types-only
 * `remote-serving.ts` took the client under its floor that way.
 */
export function hasRuntimeCode(source, fileName = 'module.ts') {
  const kind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  return file.statements.some((statement) => !isTypeOnlyStatement(statement));
}

function isTypeOnlyStatement(statement) {
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  if (ts.isExportDeclaration(statement)) return statement.isTypeOnly;
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return false; // a side-effect import runs the module
    if (clause.isTypeOnly) return true;
    const named = clause.namedBindings;
    return (
      !clause.name &&
      named !== undefined &&
      ts.isNamedImports(named) &&
      named.elements.every((element) => element.isTypeOnly)
    );
  }
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
  );
}

export async function resolveSourceImport(testFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(testFile), specifier);
  const extension = extname(base);
  const candidates = extension
    ? extension === '.js' || extension === '.jsx'
      ? [
          `${base.slice(0, -extension.length)}.ts`,
          `${base.slice(0, -extension.length)}.tsx`,
          `${base.slice(0, -extension.length)}.js`,
          `${base.slice(0, -extension.length)}.jsx`,
        ]
      : [base]
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
  const candidates = files.filter(
    (file) =>
      sourceExtensions.has(extname(file)) &&
      !testPattern.test(file) &&
      !file.endsWith('.d.ts') &&
      !file.endsWith(`${join('src', 'vite-env.d.ts')}`),
  );
  const production = [];
  const typeOnly = [];
  for (const file of candidates) {
    (hasRuntimeCode(await readFile(file, 'utf8'), file) ? production : typeOnly).push(file);
  }
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
    typeOnly: typeOnly.map((file) => relative(packageRoot, file).replaceAll('\\', '/')),
  };
}

export async function main(args = process.argv.slice(2)) {
  const results = (
    await Promise.all(
      Object.entries(packageThresholds).map(([name, threshold]) => inspectPackage(name, threshold)),
    )
  ).filter(Boolean);

  console.log(
    'Package test-surface inventory (direct imports + colocated tests; types-only modules excluded)',
  );
  console.log('package                 source  tests  covered   rate   floor');
  for (const result of results) {
    console.log(
      `${result.package.padEnd(23)} ${String(result.productionFiles).padStart(6)} ${String(result.testFiles).padStart(6)} ${String(result.directlyCoveredFiles).padStart(8)} ${`${result.percent.toFixed(1)}%`.padStart(7)} ${`${result.minimumPercent.toFixed(1)}%`.padStart(7)}`,
    );
  }

  const outputIndex = args.indexOf('--json');
  if (outputIndex >= 0) {
    const outputArg = args[outputIndex + 1];
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
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
