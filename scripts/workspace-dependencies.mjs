import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const WORKSPACE_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Return the package manifests covered by pnpm-workspace.yaml.
 *
 * Gezel's workspace layout is intentionally shallow: packages/* plus evals.
 * Keeping discovery here dependency-free lets the release prepare hook run
 * without importing pnpm internals or a YAML parser.
 */
export function workspaceManifestPaths(repoRoot) {
  const paths = [];
  const packagesDir = join(repoRoot, 'packages');

  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(packagesDir, entry.name, 'package.json');
      if (existsSync(manifestPath)) paths.push(manifestPath);
    }
  }

  const evalsManifest = join(repoRoot, 'evals', 'package.json');
  if (existsSync(evalsManifest)) paths.push(evalsManifest);

  return paths.sort();
}

export function readWorkspaceManifests(repoRoot) {
  const records = workspaceManifestPaths(repoRoot).map((path) => {
    const source = readFileSync(path, 'utf8');
    const manifest = JSON.parse(source);
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`${relative(repoRoot, path)} has no package name`);
    }
    return { path, source, manifest };
  });

  const names = new Set();
  for (const { path, manifest } of records) {
    if (names.has(manifest.name)) {
      throw new Error(
        `duplicate workspace package name ${manifest.name} at ${relative(repoRoot, path)}`,
      );
    }
    names.add(manifest.name);
  }

  return { records, names };
}

export function findWorkspaceDependencyViolations(manifest, workspaceNames) {
  const violations = [];
  for (const field of WORKSPACE_DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== 'object') continue;

    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!workspaceNames.has(name) || specifier === 'workspace:*') continue;
      violations.push({ field, name, specifier });
    }
  }
  return violations;
}

export function normalizeWorkspaceDependencies(manifest, workspaceNames) {
  const changes = findWorkspaceDependencyViolations(manifest, workspaceNames);
  for (const { field, name } of changes) manifest[field][name] = 'workspace:*';
  return changes;
}

export function serializePackageManifest(manifest, previousSource = '') {
  const newline = previousSource.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = previousSource.match(/\r?\n([\t ]+)"/);
  const indent = indentMatch?.[1] ?? '  ';
  return `${JSON.stringify(manifest, null, indent).replaceAll('\n', newline)}${newline}`;
}

export function normalizeWorkspaceManifest(record, workspaceNames, { write = true } = {}) {
  const changes = normalizeWorkspaceDependencies(record.manifest, workspaceNames);
  if (write && changes.length > 0) {
    writeFileSync(record.path, serializePackageManifest(record.manifest, record.source));
  }
  return changes;
}
