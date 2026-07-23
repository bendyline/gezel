#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

const roots = ['packages/app/src', 'packages/service/src', 'packages/eval-viewer', 'scripts'];

const allowlistedFiles = new Set([
  'packages/service/src/fs/safe-paths.ts',
  'packages/service/src/fs/safe-paths.test.ts',
  'packages/service/src/folders/validation.ts',
  'scripts/check-path-safety.mjs',
]);

const ignoredDirs = new Set([
  '.git',
  'dist',
  'node_modules',
  '.turbo',
  'coverage',
  'ux-screenshots',
]);

const sourceExts = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

const checks = [
  {
    name: 'normalize(join(...)) containment pattern',
    pattern: /normalize\s*\(\s*join\s*\(/,
    detail: 'Use safeJoin/resolveInside from packages/service/src/fs/safe-paths.ts.',
  },
  {
    name: 'normalize(resolve(...)) containment pattern',
    pattern: /normalize\s*\(\s*resolve\s*\(/,
    detail: 'Use safeJoin/resolveInside from packages/service/src/fs/safe-paths.ts.',
  },
  {
    name: 'local path containment helper',
    pattern: /function\s+(?:safeJoin|resolveInside|resolveInsideOrNull|pathStartsWithDir)\b/,
    detail:
      'Keep containment helpers centralized in safe-paths.ts unless this is a dedicated validation module.',
  },
  {
    name: 'path startsWith containment check',
    pattern: /\b(?:full|file|target|candidate|joined)\.startsWith\s*\(/,
    detail: 'Use a separator-aware shared path helper instead of startsWith.',
  },
];

const findings = [];

for (const root of roots) {
  walk(join(repoRoot, root));
}

if (findings.length > 0) {
  console.error('Unsafe path-containment patterns found:\n');
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.check}`);
    console.error(`  ${finding.detail}`);
    console.error(`  ${finding.text.trim()}\n`);
  }
  process.exit(1);
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) walk(abs);
      continue;
    }
    if (!entry.isFile() || !isSourceFile(entry.name)) continue;
    scanFile(abs);
  }
}

function scanFile(abs) {
  const rel = relative(repoRoot, abs).replace(/\\/g, '/');
  if (allowlistedFiles.has(rel)) return;
  const text = readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    for (const check of checks) {
      if (!check.pattern.test(line)) continue;
      findings.push({
        file: rel,
        line: i + 1,
        check: check.name,
        detail: check.detail,
        text: line,
      });
    }
  }
}

function isSourceFile(name) {
  for (const ext of sourceExts) {
    if (name.endsWith(ext)) return true;
  }
  return false;
}
