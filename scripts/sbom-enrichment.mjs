/**
 * The parts of the release SBOM that come from pinned bytes rather than from
 * pnpm's view of the generating host: hashes, SPDX identifiers, the
 * per-platform prebuilds a Linux runner never installs, and the binaries that
 * arrive inside a package or an installer without a package of their own.
 *
 * The v1.26270.76 SBOM carried no hash for any of its 824 components, no SPDX
 * id, none of the Windows prebuilds (keyring, resvg, ripgrep, sqlite-vec) or
 * electron-builder's elevate.exe, and no trace of the proprietary DirectML.dll
 * inside onnxruntime-node. Everything here is computed from inputs present on
 * the release's quality runner: pnpm-lock.yaml, the pinned native file
 * manifest, the runtime pins, the installed onnxruntime-node (which carries
 * every platform's binaries before packaging prunes them), and electron-builder.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { ENGINE_FOR_BINARY, NATIVE_PAYLOAD, allPlatformKeys } from './native-payload.mjs';
import { pnpmReleaseTargets } from './pnpm-runtime-inventory.mjs';
import { npmPurl } from './sbom-dependency-graph.mjs';

/**
 * SPDX identifiers that appear in, or are adjacent to, the shipped graph.
 * Deliberately a closed list: CycloneDX validates `license.id` against the
 * SPDX enumeration, so an identifier we merely guessed at would make the
 * whole document invalid. Anything outside it stays a `license.name`.
 */
const SPDX_IDS = new Set([
  '0BSD',
  'AFL-2.1',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'EUPL-1.1',
  'EUPL-1.2',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'NCSA',
  'OFL-1.1',
  'Python-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);
const SPDX_EXCEPTIONS = new Set(['LLVM-exception']);

/** Non-SPDX spellings published by packages we ship, and what they mean. */
const LICENSE_ALIASES = new Map([
  // sqlite-vec publishes this; its repository is dual MIT / Apache-2.0.
  ['MIT OR Apache', 'MIT OR Apache-2.0'],
  // IronCalc's wasm package writes the same dual license with a slash.
  ['MIT/Apache-2.0', 'MIT OR Apache-2.0'],
  ['Apache 2.0', 'Apache-2.0'],
  ['Apache License 2.0', 'Apache-2.0'],
  ['MIT License', 'MIT'],
]);

function spdxToken(token) {
  const bare = token.endsWith('+') ? token.slice(0, -1) : token;
  return SPDX_IDS.has(bare);
}

function spdxExpressionFor(value) {
  const tokens = value.replace(/[()]/g, ' ').trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length % 2 === 0) return null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (index % 2 === 1) {
      if (!['AND', 'OR', 'WITH'].includes(token)) return null;
      continue;
    }
    const operator = tokens[index - 1];
    if (operator === 'WITH' ? !SPDX_EXCEPTIONS.has(token) : !spdxToken(token)) return null;
  }
  return value;
}

/**
 * CycloneDX `licenses` for a declared licence string: `license.id` for one
 * SPDX identifier, `expression` for a valid SPDX expression, and
 * `license.name` for anything else (proprietary terms, prose, "Unknown").
 */
export function cyclonedxLicenses(declared) {
  const raw = String(declared ?? '').trim();
  if (!raw) return [{ license: { name: 'Unknown' } }];
  const value = LICENSE_ALIASES.get(raw) ?? raw;
  if (SPDX_IDS.has(value)) return [{ license: { id: value } }];
  if (/\s(?:OR|AND|WITH)\s/.test(value) && spdxExpressionFor(value)) {
    return [{ expression: value }];
  }
  return [{ license: { name: raw } }];
}

/** Re-express every component's single declared licence through `cyclonedxLicenses`. */
export function normalizeComponentLicenses(components) {
  let identified = 0;
  for (const component of components) {
    const [entry, ...rest] = component.licenses ?? [];
    if (!entry || rest.length > 0) continue;
    const declared = entry.expression ?? entry.license?.name ?? entry.license?.id;
    component.licenses = cyclonedxLicenses(declared);
    if (component.licenses[0].expression || component.licenses[0].license.id) identified += 1;
  }
  return identified;
}

/** The licence a package manifest declares, in either of npm's two shapes. */
export function declaredManifestLicense(manifest) {
  if (typeof manifest?.license === 'string') return manifest.license;
  if (typeof manifest?.license?.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest?.licenses)) {
    const types = manifest.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((type) => typeof type === 'string' && type.length > 0);
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

const HASH_ALGORITHMS = {
  sha1: { alg: 'SHA-1', bytes: 20 },
  sha256: { alg: 'SHA-256', bytes: 32 },
  sha384: { alg: 'SHA-384', bytes: 48 },
  sha512: { alg: 'SHA-512', bytes: 64 },
};

/** CycloneDX hashes for an SRI string such as pnpm's `sha512-<base64>`. */
export function integrityHashes(integrity) {
  const hashes = [];
  for (const part of String(integrity ?? '').split(/\s+/)) {
    const match = part.match(/^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/);
    if (!match) continue;
    const { alg, bytes } = HASH_ALGORITHMS[match[1]];
    const digest = Buffer.from(match[2], 'base64');
    if (digest.length === bytes) hashes.push({ alg, content: digest.toString('hex') });
  }
  return hashes;
}

function sha256Hash(hex) {
  if (!/^[0-9a-f]{64}$/i.test(String(hex))) throw new Error(`invalid sha256 ${String(hex)}`);
  return { alg: 'SHA-256', content: hex.toLowerCase() };
}

function unquote(value) {
  const trimmed = value.trim();
  return /^'.*'$/.test(trimmed) ? trimmed.slice(1, -1).replaceAll("''", "'") : trimmed;
}

function flowList(value) {
  const match = value.trim().match(/^\[(.*)\]$/);
  if (!match) return undefined;
  return match[1]
    .split(',')
    .map((item) => unquote(item))
    .filter(Boolean);
}

/** `name@version` with any pnpm peer suffix removed. */
export function lockfileIdentity(key) {
  const base = key.replace(/\(.*$/, '');
  const at = base.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: base.slice(0, at), version: base.slice(at + 1), key: base };
}

/**
 * Read the `importers`, `packages`, and `snapshots` sections of a pnpm v9
 * lockfile. Only the fields the SBOM needs are kept; the format is regular
 * enough that this avoids adding a YAML dependency to the release scripts.
 */
export function parsePnpmLockfile(text) {
  if (!/^lockfileVersion: '9\./m.test(text)) {
    throw new Error('generate-sbom reads pnpm lockfile v9; update parsePnpmLockfile');
  }
  const sections = { importers: new Map(), packages: new Map(), snapshots: new Map() };
  const { importers, packages, snapshots } = sections;
  let section = null;
  let current = null;
  let field = null;
  let importerDependency = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) {
      section = line.replace(/:.*$/, '');
      current = null;
      continue;
    }
    if (!sections[section]) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    if (indent === 2) {
      const keyMatch = content.match(/^('(?:[^']|'')+'|[^:\s]+):(?:\s*\{\})?$/);
      field = null;
      if (!keyMatch) {
        current = null;
        continue;
      }
      const key = unquote(keyMatch[1]);
      current = { key };
      sections[section].set(key, current);
      continue;
    }
    if (!current) continue;
    if (indent === 4) {
      field = null;
      const match = content.match(/^([A-Za-z]+):\s*(.*)$/);
      if (!match) continue;
      const [, name, rest] = match;
      importerDependency = null;
      if (name === 'resolution') {
        const integrity = rest.match(/integrity:\s*([^,}\s]+)/)?.[1];
        if (integrity) current.integrity = integrity;
      } else if (name === 'os' || name === 'cpu' || name === 'libc') {
        const list = flowList(rest);
        if (list) current[name] = list;
      } else if ((name === 'dependencies' || name === 'optionalDependencies') && rest === '') {
        current[name] = {};
        field = name;
      }
      continue;
    }
    if (indent === 6 && field) {
      // Importers nest `specifier` / `version` under each dependency name;
      // packages and snapshots write the version inline.
      const match = content.match(/^('(?:[^']|'')+'|[^:\s]+):\s*(.*)$/);
      if (!match) continue;
      importerDependency = match[2] ? null : unquote(match[1]);
      if (match[2]) current[field][unquote(match[1])] = unquote(match[2]);
      continue;
    }
    if (indent === 8 && field && importerDependency && section === 'importers') {
      const version = content.match(/^version:\s*(.+)$/)?.[1];
      if (version) current[field][importerDependency] = unquote(version);
    }
  }
  // Snapshot keys carry peer suffixes; one package version can have several.
  const relations = new Map();
  for (const [key, snapshot] of snapshots) {
    const identity = lockfileIdentity(key);
    if (!identity) continue;
    const merged = relations.get(identity.key) ?? { dependencies: {}, optionalDependencies: {} };
    Object.assign(merged.dependencies, snapshot.dependencies ?? {});
    Object.assign(merged.optionalDependencies, snapshot.optionalDependencies ?? {});
    relations.set(identity.key, merged);
  }
  return { importers, packages, snapshots, relations };
}

/**
 * Every registry `name@version` reachable through production edges from the
 * given workspace importers (`packages/app`, ...), following `link:` edges
 * into other importers. Used to prove what a set of shipping roots can reach
 * without asking pnpm, whose answer depends on the host.
 */
export function lockfileProductionClosure(lockfile, importerPaths) {
  const reached = new Set();
  const visitedImporters = new Set();
  const queue = importerPaths.map((path) => ({ importer: path }));
  while (queue.length > 0) {
    const next = queue.shift();
    let relations;
    if (next.importer !== undefined) {
      if (visitedImporters.has(next.importer)) continue;
      visitedImporters.add(next.importer);
      relations = lockfile.importers.get(next.importer);
      if (!relations) throw new Error(`pnpm-lock.yaml has no importer ${next.importer}`);
    } else {
      if (reached.has(next.key)) continue;
      reached.add(next.key);
      relations = lockfile.relations.get(next.key);
      if (!relations) continue;
    }
    const base = next.importer;
    for (const [name, rawVersion] of Object.entries({
      ...relations.dependencies,
      ...relations.optionalDependencies,
    })) {
      if (rawVersion.startsWith('link:')) {
        if (base === undefined) continue;
        queue.push({ importer: posix.join(base, rawVersion.slice('link:'.length)) });
        continue;
      }
      queue.push({ key: `${name}@${rawVersion.replace(/\(.*$/, '')}` });
    }
  }
  return reached;
}

export async function readPnpmLockfile(path) {
  return parsePnpmLockfile(await readFile(path, 'utf8'));
}

function allowedBy(list, value) {
  if (!list || list.length === 0) return true;
  const negated = list.filter((item) => item.startsWith('!')).map((item) => item.slice(1));
  const positive = list.filter((item) => !item.startsWith('!'));
  if (negated.includes(value)) return false;
  return positive.length === 0 || positive.includes(value);
}

/**
 * Native platform keys whose installer can carry a package with these npm
 * `os` / `cpu` / `libc` constraints. Every Linux installer is glibc.
 */
export function platformKeysForConstraints({ os, cpu, libc } = {}) {
  return allPlatformKeys().filter((key) => {
    const [platform, arch] = key.split('-');
    if (!allowedBy(os, platform) || !allowedBy(cpu, arch)) return false;
    if (platform === 'linux' && libc?.length) return allowedBy(libc, 'glibc');
    return true;
  });
}

function isPlatformConstrained(entry) {
  return Boolean(entry?.os?.length || entry?.cpu?.length || entry?.libc?.length);
}

function packageName(component) {
  return component.group ? `${component.group}/${component.name}` : component.name;
}

function isNpmComponent(component) {
  return typeof component.purl === 'string' && component.purl.startsWith('pkg:npm/');
}

function upsertProperty(component, name, value) {
  component.properties ??= [];
  if (component.properties.some((property) => property.name === name)) return;
  component.properties.push({ name, value });
}

/**
 * Give every npm component the registry-tarball digest pnpm pinned for it and,
 * for platform-specific packages, the installer platforms that carry it.
 */
export function enrichNpmComponents(components, lockfile) {
  let hashed = 0;
  for (const component of components) {
    if (!isNpmComponent(component)) continue;
    const entry = lockfile.packages.get(`${packageName(component)}@${component.version}`);
    if (!entry) continue;
    const hashes = integrityHashes(entry.integrity);
    if (hashes.length > 0) {
      component.hashes = hashes;
      hashed += 1;
    }
    const platforms = isPlatformConstrained(entry) ? platformKeysForConstraints(entry) : [];
    if (platforms.length > 0) upsertProperty(component, 'gezel:platforms', platforms.join(','));
  }
  return hashed;
}

function addEdge(edges, from, to) {
  const targets = edges.get(from) ?? new Set();
  targets.add(to);
  edges.set(from, targets);
}

function propertyValue(component, name) {
  return component.properties?.find((property) => property.name === name)?.value;
}

/**
 * Platform prebuilds that a released installer carries but the SBOM host did
 * not install. pnpm skips a foreign `os`/`cpu`/`libc` optional dependency, so
 * a Linux runner never sees `@napi-rs/keyring-win32-x64-msvc` and friends;
 * the lockfile still pins each one's version and tarball digest.
 *
 * Their licence is the parent package's: pnpm never downloaded their
 * manifests, and every such package in the graph publishes its parent's
 * licence. The component records that inheritance rather than hiding it.
 */
export function lockfilePlatformPrebuilds({
  components,
  lockfile,
  excludedPackageNames = new Set(),
}) {
  const byKey = new Map();
  for (const component of components) {
    if (isNpmComponent(component)) {
      byKey.set(`${packageName(component)}@${component.version}`, component);
    }
  }
  const added = new Set();
  const edges = new Map();
  const queue = [...byKey.values()];
  while (queue.length > 0) {
    const parent = queue.shift();
    const parentKey = `${packageName(parent)}@${parent.version}`;
    const relations = lockfile.relations.get(parentKey);
    if (!relations) continue;
    // An installed parent's required dependencies are installed too; only a
    // package added here can have required dependencies the host never saw.
    const foreignParent = added.has(parent);
    const candidates = {
      ...(foreignParent ? relations.dependencies : {}),
      ...relations.optionalDependencies,
    };
    for (const [name, rawVersion] of Object.entries(candidates)) {
      if (excludedPackageNames.has(name)) continue;
      const version = rawVersion.replace(/\(.*$/, '');
      const key = `${name}@${version}`;
      const existing = byKey.get(key);
      if (existing) {
        if (foreignParent || added.has(existing)) {
          addEdge(edges, parent['bom-ref'], existing['bom-ref']);
        }
        continue;
      }
      const entry = lockfile.packages.get(key);
      if (!entry || (!foreignParent && !isPlatformConstrained(entry))) continue;
      const parentPlatforms = foreignParent
        ? new Set(propertyValue(parent, 'gezel:platforms').split(','))
        : null;
      const platforms = platformKeysForConstraints(entry).filter(
        (platform) => !parentPlatforms || parentPlatforms.has(platform),
      );
      if (platforms.length === 0) continue;
      const purl = npmPurl(name, version);
      const slash = name.startsWith('@') ? name.indexOf('/') : -1;
      const prebuild = isPlatformConstrained(entry);
      const hashes = integrityHashes(entry.integrity);
      const component = {
        type: 'library',
        'bom-ref': purl,
        ...(slash > 0 ? { group: name.slice(0, slash) } : {}),
        name: slash > 0 ? name.slice(slash + 1) : name,
        version,
        scope: 'required',
        licenses:
          prebuild && parent.licenses
            ? structuredClone(parent.licenses)
            : [{ license: { name: 'Unknown' } }],
        purl,
        ...(hashes.length > 0 ? { hashes } : {}),
        properties: [
          {
            name: 'gezel:component-kind',
            value: prebuild ? 'npm-platform-prebuild' : 'npm-platform-dependency',
          },
          { name: 'gezel:platforms', value: platforms.join(',') },
          { name: 'gezel:inventory-source', value: 'pnpm-lock.yaml' },
          {
            name: 'gezel:license-source',
            value: prebuild
              ? `inherited from ${packageName(parent)}@${parent.version}`
              : 'not installed on the SBOM host',
          },
        ],
      };
      byKey.set(key, component);
      added.add(component);
      queue.push(component);
      addEdge(edges, parent['bom-ref'], purl);
    }
  }
  return {
    components: [...added],
    dependencies: [...edges].map(([ref, dependsOn]) => ({
      ref,
      dependsOn: [...dependsOn].sort((a, b) => a.localeCompare(b)),
    })),
  };
}

function fileComponent(name, hashHex, platforms, extraProperties = []) {
  return {
    type: 'file',
    name,
    hashes: [sha256Hash(hashHex)],
    properties: [{ name: 'gezel:platforms', value: platforms.join(',') }, ...extraProperties],
  };
}

/** Platform keys for an installer target such as `win32-x64`, or every key for `all`. */
export function platformKeysForTarget(target) {
  if (target === 'all') return allPlatformKeys();
  return allPlatformKeys().filter((key) => key.split('-').slice(0, 2).join('-') === target);
}

/**
 * One component per native platform archive, holding every file it installs
 * with the SHA-256 the release pins in native-file-manifest.json — the same
 * digests verify-installer-licenses checks inside each finished installer.
 * Attributing a shared library (ggml sits beside three engines) to one engine
 * would be a guess; the archive is what actually ships, and it depends on the
 * engines, helpers, and CUDA runtime it contains.
 */
export function nativePayloadComponents({
  manifest,
  engineRefs,
  helperSourceRefsForKey = () => [],
  cudaRuntimeRef,
}) {
  if (manifest?.schemaVersion !== 2 || !manifest.platforms) {
    throw new Error('native-file-manifest.json must be schemaVersion 2 with platforms');
  }
  const components = [];
  const dependencies = [];
  for (const key of Object.keys(manifest.platforms).sort()) {
    if (!NATIVE_PAYLOAD[key]) {
      throw new Error(
        `native-file-manifest.json has platform ${key}, which native-payload.mjs does not ship`,
      );
    }
    const { files = {}, symlinks = {} } = manifest.platforms[key];
    const ref = `gezel:native-payload/${key}@${manifest.release}`;
    components.push({
      type: 'application',
      'bom-ref': ref,
      name: `gezel-native-${key}`,
      version: manifest.release,
      scope: 'required',
      description: `Native payload staged under native-bin/${key} from native release ${manifest.release}; licensed per the engines, helpers, and redistributables it depends on`,
      properties: [
        { name: 'gezel:component-kind', value: 'native-payload' },
        { name: 'gezel:platforms', value: key },
        { name: 'gezel:native-release', value: manifest.release },
        ...Object.entries(symlinks)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([link, target]) => ({ name: 'gezel:symlink', value: `${link} -> ${target}` })),
      ],
      components: Object.keys(files)
        .sort()
        .map((file) =>
          fileComponent(
            file,
            files[file].sha256,
            [key],
            [{ name: 'gezel:size-bytes', value: String(files[file].sizeBytes) }],
          ),
        ),
    });
    const dependsOn = new Set(helperSourceRefsForKey(key));
    for (const binary of NATIVE_PAYLOAD[key]) {
      const engine = ENGINE_FOR_BINARY[binary];
      if (!engine) continue;
      const engineRef = engineRefs.get(engine);
      if (!engineRef) throw new Error(`no SBOM component for native engine ${engine}`);
      dependsOn.add(engineRef);
    }
    if (key.endsWith('-cuda') && cudaRuntimeRef) dependsOn.add(cudaRuntimeRef);
    dependencies.push({ ref, dependsOn: [...dependsOn].sort((a, b) => a.localeCompare(b)) });
  }
  return { components, dependencies };
}

/** Parse `export const NAME ... = { 'key': 'value', ... }` from a TypeScript pin file. */
export function parseStringRecord(source, name) {
  const start = source.match(new RegExp(`export const ${name}\\b[^=]*=\\s*\\{`));
  if (!start) throw new Error(`cannot find ${name}`);
  const body = source.slice(start.index + start[0].length, source.indexOf('}', start.index));
  const record = {};
  for (const match of body.matchAll(/['"]?([\w.-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
    record[match[1]] = match[2];
  }
  if (Object.keys(record).length === 0) throw new Error(`${name} is empty`);
  return record;
}

export function parseStringConstant(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]+)['"]`));
  if (!match) throw new Error(`cannot parse ${name}`);
  return match[1];
}

const NODE_ASSET_FOR_TARGET = {
  'darwin-arm64': 'macos-arm64',
  'linux-arm64': 'linux-arm64',
  'linux-x64': 'linux-x64',
  'win32-arm64': 'win-arm64',
  'win32-x64': 'win-x64',
};

/**
 * Distribution digests for the bundled runtimes, from the pins their fetch
 * scripts already verify. Node's Windows pin and DuckDB's binary pin are the
 * shipped executables themselves, so those also become file components.
 */
export async function runtimeArtifacts({ repoRoot, versions }) {
  const appRoot = join(repoRoot, 'packages', 'app');
  const targets = pnpmReleaseTargets();
  const result = {};

  const requireFromApp = createRequire(join(appRoot, 'package.json'));
  const electronRoot = dirname(requireFromApp.resolve('electron/package.json'));
  const checksums = JSON.parse(await readFile(join(electronRoot, 'checksums.json'), 'utf8'));
  result.Electron = {
    externalReferences: targets.map((target) => {
      const file = `electron-v${versions.Electron}-${target}.zip`;
      if (!checksums[file]) throw new Error(`electron checksums.json has no ${file}`);
      return {
        type: 'distribution',
        url: `https://github.com/electron/electron/releases/download/v${versions.Electron}/${file}`,
        comment: `${target} distribution electron-builder repackages`,
        hashes: [sha256Hash(checksums[file])],
      };
    }),
  };

  const nodeSource = await readFile(join(appRoot, 'src', 'node-version.ts'), 'utf8');
  const nodeVersion = parseStringConstant(nodeSource, 'NODE_VERSION');
  const nodeShas = parseStringRecord(nodeSource, 'NODE_SHA256');
  const nodeFiles = [];
  result['Node.js'] = {
    externalReferences: targets.map((target) => {
      const key = NODE_ASSET_FOR_TARGET[target];
      if (!key || !nodeShas[key]) throw new Error(`node-version.ts pins no asset for ${target}`);
      const windows = key.startsWith('win-');
      if (windows)
        nodeFiles.push(fileComponent('node.exe', nodeShas[key], platformKeysForTarget(target)));
      return {
        type: 'distribution',
        url: windows
          ? `https://nodejs.org/dist/v${nodeVersion}/${key}/node.exe`
          : `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-${key.replace('macos', 'darwin')}.tar.gz`,
        comment: windows
          ? `${target} executable, shipped as-is`
          : `${target} archive bin/node is taken from`,
        hashes: [sha256Hash(nodeShas[key])],
      };
    }),
    components: nodeFiles,
  };

  const pnpmSource = await readFile(join(appRoot, 'src', 'pnpm-version.ts'), 'utf8');
  const pnpmVersion = parseStringConstant(pnpmSource, 'PNPM_VERSION');
  const pnpmSha = parseStringConstant(pnpmSource, 'PNPM_PACKAGE_SHA256');
  result.pnpm = {
    hashes: [sha256Hash(pnpmSha)],
    externalReferences: [
      {
        type: 'distribution',
        url: `https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz`,
        comment: 'npm tarball extracted into the installer',
        hashes: [sha256Hash(pnpmSha)],
      },
    ],
  };

  const duckdbSource = await readFile(
    join(repoRoot, 'packages', 'core', 'src', 'native', 'duckdb-pin.ts'),
    'utf8',
  );
  const duckdbVersion = parseStringConstant(duckdbSource, 'DUCKDB_VERSION');
  const duckdbAssets = parseStringRecord(duckdbSource, 'DUCKDB_ASSET');
  const duckdbArchives = parseStringRecord(duckdbSource, 'DUCKDB_ARCHIVE_SHA256');
  const duckdbBinaries = parseStringRecord(duckdbSource, 'DUCKDB_BINARY_SHA256');
  result.DuckDB = {
    externalReferences: targets.map((target) => {
      if (!duckdbAssets[target] || !duckdbArchives[target]) {
        throw new Error(`duckdb-pin.ts pins no archive for ${target}`);
      }
      return {
        type: 'distribution',
        url: `https://github.com/duckdb/duckdb/releases/download/v${duckdbVersion}/${duckdbAssets[target]}`,
        comment: `${target} archive`,
        hashes: [sha256Hash(duckdbArchives[target])],
      };
    }),
    components: targets.map((target) => {
      if (!duckdbBinaries[target]) throw new Error(`duckdb-pin.ts pins no binary for ${target}`);
      return fileComponent(
        target.startsWith('win32-') ? 'duckdb.exe' : 'duckdb',
        duckdbBinaries[target],
        platformKeysForTarget(target),
      );
    }),
  };
  return result;
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Components for the native builds a package carries under terms its own
 * metadata omits — ONNX Runtime, DirectML, and the DirectX Shader Compiler
 * inside onnxruntime-node — hashed from the installed files, which are the
 * bytes packaging keeps for each target.
 */
export async function supplementalBinaryComponents({ supplemental, installedPackages }) {
  // One upstream build can ride in two packages (Transformers.js copies
  // onnxruntime-web's wasm), so components are keyed by their own identity.
  const byRef = new Map();
  const dependencies = [];
  for (const entry of supplemental.npmPackages.values()) {
    const installed = installedPackages.get(entry.name);
    if (!installed) continue;
    const packagePath = installed.get(entry.version);
    if (!packagePath) {
      throw new Error(
        `${entry.name} ships as ${[...installed.keys()].join(', ')}, but legal/licenses/manifest.json covers ${entry.version}`,
      );
    }
    const carrier = `${entry.name}@${entry.version}`;
    const refs = [];
    for (const component of entry.components) {
      const ref =
        component.purl ?? `gezel:embedded/${entry.name}/${component.id}@${component.version}`;
      refs.push(ref);
      let merged = byRef.get(ref);
      if (!merged) {
        merged = { component, carriers: [], files: [], platformKeys: new Set() };
        byRef.set(ref, merged);
      }
      merged.carriers.push(carrier);
      for (const binary of component.binaries) {
        const path = join(packagePath, ...binary.path.split('/'));
        const keys = platformKeysForTarget(binary.target);
        for (const key of keys) merged.platformKeys.add(key);
        if (!existsSync(path)) {
          // Only the target's own install script fetches an optional binary;
          // the SBOM still names the component, without a digest it cannot see.
          if (binary.optional) continue;
          throw new Error(`${carrier} has no ${binary.path}`);
        }
        merged.files.push(
          fileComponent(`node_modules/${entry.name}/${binary.path}`, await sha256File(path), keys),
        );
      }
    }
    dependencies.push({
      ref: npmPurl(entry.name, entry.version),
      dependsOn: refs.sort((a, b) => a.localeCompare(b)),
    });
  }

  const components = [...byRef].map(([ref, { component, carriers, files, platformKeys }]) => ({
    type: 'library',
    'bom-ref': ref,
    ...(component.supplier ? { supplier: { name: component.supplier } } : {}),
    name: component.name,
    version: component.version,
    scope: 'required',
    description: `${component.name} binaries carried inside ${carriers.join(', ')}`,
    licenses: cyclonedxLicenses(component.license),
    ...(component.purl ? { purl: component.purl } : {}),
    properties: [
      { name: 'gezel:component-kind', value: 'npm-embedded-binary' },
      { name: 'gezel:carried-by', value: carriers.join(',') },
      {
        name: 'gezel:platforms',
        value: allPlatformKeys()
          .filter((key) => platformKeys.has(key))
          .join(','),
      },
      ...(component.proprietary ? [{ name: 'gezel:proprietary', value: 'true' }] : []),
      ...component.texts.map((file) => ({
        name: 'gezel:license-text',
        value: `resources/licenses/standards/${file}`,
      })),
    ],
    externalReferences: [{ type: 'website', url: component.source }],
    ...(files.length > 0 ? { components: files.sort((a, b) => a.name.localeCompare(b.name)) } : {}),
  }));
  return { components, dependencies };
}

/**
 * electron-builder's `elevate.exe`, which it copies into every per-machine
 * NSIS build from its NSIS toolset. The distribution digest is the one
 * electron-builder itself verifies before extracting that toolset; the copy in
 * the installer is Authenticode-signed by our release, so its own bytes are
 * not a stable identity.
 */
export async function installerBinaryComponents({ supplemental, repoRoot }) {
  const appRequire = createRequire(join(repoRoot, 'packages', 'app', 'package.json'));
  const builderRequire = createRequire(appRequire.resolve('electron-builder/package.json'));
  const appBuilderLib = dirname(builderRequire.resolve('app-builder-lib/package.json'));
  const toolsets = await readFile(join(appBuilderLib, 'out', 'toolsets', 'windows.js'), 'utf8');
  const nsis = toolsets.match(
    /getLegacyNsisBin\(\)\s*\{[\s\S]*?getBinFromUrl\)\("(nsis-[\d.]+)",\s*"(nsis-[\d.]+\.7z)",\s*"([0-9a-f]{64})"\)/,
  );
  const components = [];
  for (const entry of supplemental.installerBinaries.values()) {
    if (entry.id !== 'elevate') throw new Error(`no SBOM mapping for installer binary ${entry.id}`);
    if (!nsis || !entry.carrier.endsWith(nsis[1])) {
      throw new Error(
        `electron-builder no longer takes elevate.exe from ${entry.carrier}; review legal/licenses/manifest.json#installerBinaries.elevate`,
      );
    }
    const [, release, archive, digest] = nsis;
    components.push({
      type: 'application',
      'bom-ref': `gezel:installer-binary/${entry.id}@${entry.version}`,
      supplier: { name: entry.supplier },
      name: entry.name,
      version: entry.version,
      scope: 'required',
      description: `${entry.path} in the Windows installer. ${entry.note}`,
      licenses: cyclonedxLicenses(entry.license),
      properties: [
        { name: 'gezel:component-kind', value: 'installer-binary' },
        {
          name: 'gezel:platforms',
          value: entry.targets.flatMap((target) => platformKeysForTarget(target)).join(','),
        },
        { name: 'gezel:installed-path', value: entry.path },
        ...entry.texts.map((file) => ({
          name: 'gezel:license-text',
          value: `resources/licenses/standards/${file}`,
        })),
      ],
      externalReferences: [
        { type: 'vcs', url: entry.source },
        {
          type: 'distribution',
          url: `https://github.com/electron-userland/electron-builder-binaries/releases/download/${release}/${archive}`,
          comment: 'electron-builder NSIS toolset the executable is copied from',
          hashes: [sha256Hash(digest)],
        },
      ],
    });
  }
  return components;
}
