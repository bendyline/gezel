#!/usr/bin/env node
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_DEPENDENCY_FIELDS,
  findWorkspaceDependencyViolations,
  normalizeWorkspaceManifest,
  readWorkspaceManifests,
} from './workspace-dependencies.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { records, names } = readWorkspaceManifests(repoRoot);
const fix = process.argv.slice(2).includes('--fix');
const violations = [];
let localEdges = 0;
let fixed = 0;

for (const record of records) {
  const { path, manifest } = record;
  for (const field of WORKSPACE_DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== 'object') continue;
    localEdges += Object.keys(dependencies).filter((name) => names.has(name)).length;
  }

  if (fix) fixed += normalizeWorkspaceManifest(record, names).length;

  for (const violation of findWorkspaceDependencyViolations(manifest, names)) {
    violations.push({ path, ...violation });
  }
}

if (violations.length > 0) {
  console.error('workspace dependency invariant failed:\n');
  for (const { path, field, name, specifier } of violations) {
    console.error(
      `  ${relative(repoRoot, path)} ${field}.${name} is ${JSON.stringify(specifier)}; expected "workspace:*"`,
    );
  }
  console.error(
    '\nKeep concrete sibling versions inside pnpm pack/publish output; never commit them to workspace manifests.',
  );
  process.exit(1);
}

if (fix && fixed > 0) console.log(`restored ${fixed} workspace dependency specifier(s)`);
console.log(`workspace dependency invariant OK (${localEdges} local dependency edges)`);
