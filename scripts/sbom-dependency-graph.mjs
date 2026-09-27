import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const RELATION_FIELDS = ['dependencies', 'optionalDependencies'];

export function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.slice(1).split('/');
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

/**
 * Convert `pnpm list --prod --json --depth=Infinity` into CycloneDX
 * components and dependency relationships. pnpm emits every selected local
 * workspace as a top-level project and nests the exact resolved registry
 * versions below it. Duplicate/deduped appearances are unioned by purl.
 */
export function buildPnpmSbomGraph({
  projects,
  components,
  entryWorkspaceNames,
  repoRoot,
  excludedPackageNames = new Set(),
}) {
  if (!Array.isArray(projects)) throw new Error('pnpm dependency projects must be an array');

  const componentByRef = new Map(components.map((component) => [component['bom-ref'], component]));
  const workspaceByPath = new Map(
    projects.filter((project) => project?.path).map((project) => [resolve(project.path), project]),
  );
  const workspaceByName = new Map(projects.map((project) => [project.name, project]));
  const manifestCache = new Map();
  const edges = new Map();
  const visitedObjects = new WeakSet();

  const manifestFor = (path) => {
    if (!path) return null;
    const packageJson = join(path, 'package.json');
    if (!existsSync(packageJson)) return null;
    if (!manifestCache.has(packageJson)) {
      manifestCache.set(packageJson, JSON.parse(readFileSync(packageJson, 'utf8')));
    }
    return manifestCache.get(packageJson);
  };

  const identityFor = (dependencyName, node) => {
    const absolutePath = node?.path ? resolve(node.path) : null;
    const workspace = absolutePath ? workspaceByPath.get(absolutePath) : null;
    const manifest = manifestFor(absolutePath);
    const relativePath = absolutePath ? relative(repoRoot, absolutePath) : null;
    const isLocalWorkspace = Boolean(
      workspace ||
        (manifest &&
          relativePath &&
          relativePath !== '..' &&
          !relativePath.startsWith(`..${sep}`) &&
          !relativePath.split(sep).includes('node_modules')),
    );
    const name = manifest?.name ?? workspace?.name ?? node?.name ?? node?.from ?? dependencyName;
    const version = manifest?.version ?? workspace?.version ?? cleanPnpmVersion(node?.version);
    if (!name || !version) {
      throw new Error(
        `pnpm dependency node lacks a resolvable identity: ${dependencyName ?? '<unknown>'}`,
      );
    }
    return {
      name,
      version,
      ref: npmPurl(name, version),
      manifest,
      workspace: isLocalWorkspace,
      path: absolutePath,
    };
  };

  const ensureWorkspaceComponent = (identity) => {
    if (!identity.workspace || componentByRef.has(identity.ref)) return;
    const slash = identity.name.startsWith('@') ? identity.name.indexOf('/') : -1;
    const isEntry = entryWorkspaceNames.includes(identity.name);
    const workspacePath = identity.path
      ? relative(repoRoot, identity.path).split(sep).join('/') || '.'
      : identity.name;
    const component = {
      type: isEntry ? 'application' : 'library',
      'bom-ref': identity.ref,
      ...(slash > 0 ? { group: identity.name.slice(0, slash) } : {}),
      name: slash > 0 ? identity.name.slice(slash + 1) : identity.name,
      version: identity.version,
      scope: 'required',
      licenses: [licenseEntry(identity.manifest?.license)],
      purl: identity.ref,
      properties: [
        { name: 'gezel:component-kind', value: 'packaged-workspace' },
        { name: 'gezel:workspace-path', value: workspacePath },
        ...(isEntry ? [{ name: 'gezel:dependency-root', value: 'true' }] : []),
      ],
    };
    components.push(component);
    componentByRef.set(identity.ref, component);
  };

  const visit = (dependencyName, node, optional = false) => {
    if (!node || typeof node !== 'object') return null;
    const identity = identityFor(dependencyName, node);
    if (excludedPackageNames.has(identity.name)) return null;

    ensureWorkspaceComponent(identity);
    if (!componentByRef.has(identity.ref)) {
      // `pnpm list` retains foreign OS/CPU optional declarations even when
      // pnpm did not install them on the generating host. `licenses list`
      // (and the packaged payload) correctly omit those components. Preserve
      // the SBOM's documented host scope by dropping only absent optional
      // branches; an absent required package is a hard inventory mismatch.
      if (optional) return null;
      throw new Error(
        `resolved pnpm dependency ${identity.name}@${identity.version} is absent from the production component inventory`,
      );
    }
    edges.get(identity.ref) ?? edges.set(identity.ref, new Set());

    if (visitedObjects.has(node)) return identity.ref;
    visitedObjects.add(node);
    const manifestOptionals = new Set(Object.keys(identity.manifest?.optionalDependencies ?? {}));
    for (const field of RELATION_FIELDS) {
      for (const [childName, child] of Object.entries(node[field] ?? {})) {
        // pnpm's JSON reporter sometimes folds a package's optional children
        // into `dependencies`; the installed package manifest retains the
        // authoritative relationship type.
        const childRef = visit(
          childName,
          child,
          optional || field === 'optionalDependencies' || manifestOptionals.has(childName),
        );
        if (childRef) edges.get(identity.ref).add(childRef);
      }
    }
    return identity.ref;
  };

  // Visit every workspace in the selected closure. A deduped nested node can
  // omit its children, while that same workspace's top-level record retains
  // them; unioning both appearances preserves the complete edge set.
  for (const project of projects) visit(project.name, project);

  const entryRefs = entryWorkspaceNames.map((name) => {
    const project = workspaceByName.get(name);
    if (!project) throw new Error(`pnpm dependency graph omitted packaged workspace root ${name}`);
    return identityFor(name, project).ref;
  });

  return {
    entryRefs: [...new Set(entryRefs)].sort((a, b) => a.localeCompare(b)),
    dependencies: dependencyEntries(edges),
  };
}

/** Merge graphs, fill leaf nodes, and require complete reachability. */
export function finalizeSbomDependencyGraph({
  rootRef,
  rootDependsOn,
  components,
  dependencyGroups,
}) {
  const edges = new Map();
  const add = (ref, dependsOn = []) => {
    if (!ref) throw new Error('SBOM dependency relationship has no ref');
    const targets = edges.get(ref) ?? new Set();
    for (const target of dependsOn) targets.add(target);
    edges.set(ref, targets);
  };

  for (const group of dependencyGroups) {
    for (const relationship of group ?? []) add(relationship.ref, relationship.dependsOn);
  }
  add(rootRef, rootDependsOn);
  for (const component of components) add(component['bom-ref']);

  const componentRefs = components.map((component) => component['bom-ref']);
  const knownRefs = new Set([rootRef, ...componentRefs]);
  if (knownRefs.size !== componentRefs.length + 1) {
    throw new Error('SBOM component bom-refs must be unique and distinct from the metadata root');
  }
  for (const [ref, dependsOn] of edges) {
    if (!knownRefs.has(ref)) throw new Error(`SBOM dependency node has no component: ${ref}`);
    for (const target of dependsOn) {
      if (!knownRefs.has(target)) {
        throw new Error(`SBOM dependency edge ${ref} points to missing component ${target}`);
      }
    }
  }

  const reachable = new Set();
  const queue = [rootRef];
  while (queue.length > 0) {
    const ref = queue.shift();
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    queue.push(...(edges.get(ref) ?? []));
  }
  const unreachable = components
    .map((component) => component['bom-ref'])
    .filter((ref) => !reachable.has(ref));
  if (unreachable.length > 0) {
    throw new Error(
      `SBOM contains ${unreachable.length} components outside the dependency graph: ${unreachable.slice(0, 10).join(', ')}`,
    );
  }

  return dependencyEntries(edges);
}

function dependencyEntries(edges) {
  return [...edges.entries()]
    .map(([ref, dependsOn]) => ({
      ref,
      dependsOn: [...dependsOn].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

function cleanPnpmVersion(version) {
  const value = String(version ?? '').trim();
  if (!value || /^(?:link|workspace|file):/.test(value)) return null;
  return value.replace(/\(.*/, '');
}

function licenseEntry(license) {
  const value =
    typeof license === 'string'
      ? license.trim()
      : typeof license?.type === 'string'
        ? license.type.trim()
        : '';
  if (!value) return { license: { name: 'Unknown' } };
  return /\s(?:OR|AND|WITH)\s/.test(value) ? { expression: value } : { license: { name: value } };
}
