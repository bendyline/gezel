#!/usr/bin/env node
/**
 * Stage license texts for the third-party code compiled into the service's
 * published browser bundles (`dist/ui/`, `dist/office/`).
 *
 * The desktop installer's legal bundle comes from pnpm's production graph
 * (stage-third-party-licenses.mjs). The npm tarball had no such step, and
 * minification strips nearly every license comment, so the published service
 * carried about 250 bundled packages with no license text. The source maps the
 * UI build already emits name every file each bundle compiled from. This
 * module turns them into the same content-addressed `npm/manifest.json` layout
 * the installer carries, at `dist/licenses/npm/`.
 *
 * Some dependencies publish a dist that already inlines other packages. Those
 * with a third-party notice file (squisq, which pre-bundles Mediabunny) are
 * covered by carrying that file. The rest are found through the dependency's
 * own maps and need a reviewed text in `legal/embedded-licenses/`, keyed to
 * the exact carrier version: @mermaid-js/parser inlines chevrotain (Apache-2.0)
 * and ships only mermaid's MIT license.
 *
 *   node scripts/service-bundled-licenses.mjs             verify dist/licenses/npm
 *   node scripts/service-bundled-licenses.mjs --stage     restage it
 *   node scripts/service-bundled-licenses.mjs --embedded  list pre-bundled packages
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_DIST = join(repoRoot, 'packages', 'service', 'dist');
const UI_ROOT = join(repoRoot, 'packages', 'ui');
export const EMBEDDED_LICENSES_ROOT = join(repoRoot, 'legal', 'embedded-licenses');
/**
 * The service's Vite-built surfaces and the directory each was built in. The
 * service's own tsup bundles inline no node_modules code. The tsup hook copies
 * these trees one level deeper than Vite wrote them, so their maps' relative
 * sources resolve only against the original location.
 */
const BUNDLED_SURFACES = [
  { name: 'ui', builtIn: join(UI_ROOT, 'dist') },
  { name: 'office', builtIn: join(UI_ROOT, 'dist-office') },
];
const NODE_MODULES = `${sep}node_modules${sep}`;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function serviceBundledLicenseRoot(serviceDist = SERVICE_DIST) {
  return join(serviceDist, 'licenses', 'npm');
}

/** The installed package directory a bundled file came from, or null for first-party code. */
export function packageRootOf(file) {
  const index = file.lastIndexOf(NODE_MODULES);
  if (index < 0) return null;
  const segments = file.slice(index + NODE_MODULES.length).split(sep);
  const name = segments[0]?.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
  if (!name || name.startsWith('.')) return null;
  return { name, root: file.slice(0, index + NODE_MODULES.length) + name.split('/').join(sep) };
}

/**
 * Every package a dependency's own map source names, read from the raw string.
 * Those paths describe the publisher's build machine, so they are never
 * resolved here; a pnpm store segment just before a package gives its version.
 * Nested packages each count (`css-line-break/node_modules/utrie/...`).
 */
export function embeddedPackagesOf(source) {
  const normalized = source.replaceAll('\\', '/');
  const found = [];
  for (const match of normalized.matchAll(/node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//g)) {
    const name = match[1];
    const store = normalized.slice(0, match.index).match(/\.pnpm\/([^/]+)\/$/)?.[1];
    const prefix = `${name.replace('/', '+')}@`;
    const version = store?.startsWith(prefix) ? store.slice(prefix.length).split('_')[0] : null;
    found.push({ name, version });
  }
  return found;
}

async function listMaps(root) {
  const maps = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith('.map')) maps.push(path);
    }
  }
  await walk(root);
  return maps.sort();
}

function mapSources(map) {
  if (Array.isArray(map.sections))
    return map.sections.flatMap((section) => mapSources(section.map));
  return (map.sources ?? []).map((source) => ({ source, sourceRoot: map.sourceRoot ?? '' }));
}

/** Bundler virtual modules (`\0vite/...`) and URL-scheme sources name no file. */
function namesNoFile(source) {
  return source.includes('\0') || /^[a-z][a-z0-9+.-]+:/i.test(source);
}

/**
 * What the bundles under `roots` contain. Each root is `{ dir, builtIn }`:
 * maps are read from `dir` and their sources resolved as if they still sat in
 * `builtIn`.
 *
 * Returns `packages`, every installed package a bundle compiled files from
 * (keyed by real directory), and `embedded`, per carrier directory, the
 * packages that carrier's own published maps show it inlined. A first-party
 * source with a `.map` beside it is followed, so code a workspace package
 * pre-bundled from node_modules counts as bundled directly.
 */
export async function bundledPackagesFromSourceMaps(roots, { extraPackageRoots = [] } = {}) {
  const pending = [];
  for (const { dir, builtIn = dir } of roots) {
    for (const mapPath of await listMaps(dir)) {
      pending.push({ mapPath, base: dirname(join(builtIn, relative(dir, mapPath))) });
    }
  }
  const seenMaps = new Set(pending.map((item) => item.mapPath));
  const packageRoots = new Map(extraPackageRoots.map((root) => [root, null]));
  const carrierMaps = new Map();

  while (pending.length > 0) {
    const { mapPath, base } = pending.pop();
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    for (const { source, sourceRoot } of mapSources(map)) {
      if (namesNoFile(source)) continue;
      const file = resolve(base, sourceRoot, source);
      const chained = `${file}.map`;
      const owner = packageRootOf(file);
      if (owner) {
        if (!packageRoots.has(owner.root)) packageRoots.set(owner.root, owner.name);
        if (existsSync(chained)) {
          if (!carrierMaps.has(owner.root)) carrierMaps.set(owner.root, new Set());
          carrierMaps.get(owner.root).add(chained);
        }
      } else if (!seenMaps.has(chained) && existsSync(chained)) {
        seenMaps.add(chained);
        pending.push({ mapPath: chained, base: dirname(chained) });
      }
    }
  }

  const packages = new Map();
  const realRoots = new Map();
  for (const [root, expectedName] of packageRoots) {
    const path = await realpath(root);
    realRoots.set(root, path);
    if (packages.has(path)) continue;
    const packageJson = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    if (expectedName && packageJson.name !== expectedName) {
      throw new Error(
        `bundled source under ${path} belongs to ${expectedName}, but its package.json names ${packageJson.name}`,
      );
    }
    packages.set(path, { name: packageJson.name, version: packageJson.version, path, packageJson });
  }

  const direct = new Set([...packages.values()].map((pkg) => pkg.name));
  const embedded = new Map();
  for (const [root, maps] of carrierMaps) {
    const carrier = packages.get(realRoots.get(root));
    for (const mapPath of maps) {
      const map = JSON.parse(await readFile(mapPath, 'utf8'));
      for (const { source } of mapSources(map)) {
        if (namesNoFile(source)) continue;
        for (const inlined of embeddedPackagesOf(source)) {
          if (inlined.name === carrier.name || direct.has(inlined.name)) continue;
          if (!embedded.has(carrier.path)) embedded.set(carrier.path, new Map());
          const names = embedded.get(carrier.path);
          if (!names.has(inlined.name) || inlined.version) names.set(inlined.name, inlined.version);
        }
      }
    }
  }
  return { packages, embedded };
}

function reportedLicense(packageJson) {
  if (typeof packageJson.license === 'string') return packageJson.license;
  if (typeof packageJson.license?.type === 'string') return packageJson.license.type;
  if (Array.isArray(packageJson.licenses)) {
    const types = packageJson.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return 'Unknown';
}

/** Shape bundled packages like `pnpm licenses list --json`, which the stager consumes. */
export function inventoryFromBundledPackages(packages) {
  const inventory = {};
  for (const { name, version, path, packageJson } of packages.values()) {
    const license = reportedLicense(packageJson);
    const author =
      typeof packageJson.author === 'string' ? packageJson.author : packageJson.author?.name;
    const homepage = packageJson.homepage ?? packageJson.repository?.url;
    if (!inventory[license]) inventory[license] = [];
    inventory[license].push({
      name,
      versions: [version],
      paths: [path],
      ...(author ? { author } : {}),
      ...(homepage ? { homepage } : {}),
    });
  }
  return inventory;
}

/** Load `legal/embedded-licenses/manifest.json` and verify the texts beside it. */
export async function loadEmbeddedLicenses(root = EMBEDDED_LICENSES_ROOT) {
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.texts || !manifest.carriers) {
    throw new Error(`${manifestPath} must have schemaVersion 1, texts, and carriers`);
  }
  const texts = new Map();
  for (const [file, record] of Object.entries(manifest.texts)) {
    if (file.includes('/') || file.includes('\\')) throw new Error(`invalid text name ${file}`);
    const path = join(root, file);
    if (!existsSync(path)) throw new Error(`missing legal/embedded-licenses/${file}`);
    const content = await readFile(path);
    if (sha256(content) !== record?.sha256) {
      throw new Error(`legal/embedded-licenses/${file} does not match its recorded sha256`);
    }
    texts.set(file, { file, path, content, sha256: record.sha256, source: record.source });
  }
  const referenced = new Set();
  const carriers = new Map();
  for (const [name, entry] of Object.entries(manifest.carriers)) {
    if (typeof entry?.version !== 'string' || !Array.isArray(entry.components)) {
      throw new Error(`embedded-licenses carrier ${name} needs a version and components`);
    }
    for (const component of entry.components) {
      const label = `${name}@${entry.version} component ${component?.name ?? '(unnamed)'}`;
      for (const key of ['name', 'version', 'license']) {
        if (typeof component?.[key] !== 'string') throw new Error(`${label} has no ${key}`);
      }
      if (!Array.isArray(component.texts) || component.texts.length === 0) {
        throw new Error(`${label} names no texts`);
      }
      for (const file of component.texts) {
        if (!texts.has(file)) throw new Error(`${label} names unknown text ${file}`);
        referenced.add(file);
      }
    }
    // Map-path artifacts that name no package, each with the reviewer's reason.
    const unattributed = entry.unattributedReferences ?? {};
    for (const [reference, reason] of Object.entries(unattributed)) {
      if (typeof reason !== 'string' || reason.length === 0) {
        throw new Error(
          `${name}@${entry.version} must explain unattributed reference ${reference}`,
        );
      }
    }
    carriers.set(name, {
      name,
      version: entry.version,
      components: entry.components,
      unattributed: new Set(Object.keys(unattributed)),
    });
  }
  const present = (await readdir(root)).filter((name) => name !== 'manifest.json');
  const orphans = present.filter((name) => !referenced.has(name));
  if (orphans.length > 0) {
    throw new Error(`legal/embedded-licenses has unreferenced files: ${orphans.join(', ')}`);
  }
  return { root, texts, carriers };
}

/** Records for every package a bundled dependency inlined; throws on any unreviewed one. */
export function embeddedLicenseRecords(packages, embedded, registry) {
  const problems = [];
  const records = [];
  const bundledCarriers = new Set();
  for (const [carrierPath, names] of embedded) {
    const carrier = packages.get(carrierPath);
    bundledCarriers.add(carrier.name);
    const entry = registry.carriers.get(carrier.name);
    const found = [...names].map(([name, version]) => (version ? `${name}@${version}` : name));
    if (!entry || entry.version !== carrier.version) {
      problems.push(
        `${carrier.name}@${carrier.version} inlines ${found.join(', ')}; review them and record ${carrier.name}@${carrier.version} in legal/embedded-licenses/manifest.json`,
      );
      continue;
    }
    for (const name of names.keys()) {
      if (entry.unattributed.has(name)) continue;
      if (!entry.components.some((component) => component.name === name)) {
        problems.push(
          `${carrier.name}@${carrier.version} inlines ${name}, which legal/embedded-licenses/manifest.json does not list`,
        );
      }
    }
    for (const component of entry.components) {
      if (!names.has(component.name)) {
        problems.push(
          `legal/embedded-licenses/manifest.json lists ${component.name} in ${carrier.name}@${carrier.version}, whose maps no longer show it`,
        );
        continue;
      }
      records.push({
        name: component.name,
        version: component.version,
        license: component.license,
        embeddedIn: `${carrier.name}@${carrier.version}`,
        texts: component.texts.map((file) => registry.texts.get(file)),
      });
    }
  }
  if (packages.size > 0) {
    for (const name of registry.carriers.keys()) {
      if (!bundledCarriers.has(name)) {
        problems.push(
          `legal/embedded-licenses/manifest.json lists ${name}, which the service bundles no longer inline anything from`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `bundled dependencies inline packages without reviewed license texts (see \`node scripts/service-bundled-licenses.mjs --embedded\`):\n${problems
        .sort()
        .map((problem) => `  - ${problem}`)
        .join('\n')}`,
    );
  }
  return records;
}

/** Vite and Rolldown inject chunk-loading and preload helpers that no map names. */
async function bundlerRuntimeRoots() {
  const viteRoot = dirname(
    createRequire(join(UI_ROOT, 'package.json')).resolve('vite/package.json'),
  );
  const rolldownRoot = dirname(
    createRequire(join(viteRoot, 'package.json')).resolve('rolldown/package.json'),
  );
  return [viteRoot, rolldownRoot];
}

function surfaceRoots(serviceDist) {
  return BUNDLED_SURFACES.map(({ name, builtIn }) => ({
    dir: join(serviceDist, name),
    builtIn,
  })).filter(({ dir }) => existsSync(dir));
}

/** Packages the built service's browser bundles contain, recomputed from their maps. */
export async function serviceBundledPackages({
  serviceDist = SERVICE_DIST,
  surfaces = surfaceRoots(serviceDist),
  extraPackageRoots,
} = {}) {
  if (surfaces.length === 0) return { packages: new Map(), embedded: new Map() };
  return bundledPackagesFromSourceMaps(surfaces, {
    extraPackageRoots: extraPackageRoots ?? (await bundlerRuntimeRoots()),
  });
}

function recordId(record) {
  return `${record.name}@${record.version}${record.embeddedIn ? ` in ${record.embeddedIn}` : ''}`;
}

/** Replace `dist/licenses/npm/` with texts for every package the bundles contain. */
export async function stageServiceBundledLicenses({
  serviceDist = SERVICE_DIST,
  surfaces,
  extraPackageRoots,
  supplemental,
  embeddedRoot = EMBEDDED_LICENSES_ROOT,
} = {}) {
  const legalRoot = serviceBundledLicenseRoot(serviceDist);
  await rm(legalRoot, { recursive: true, force: true });
  const { packages, embedded } = await serviceBundledPackages({
    serviceDist,
    surfaces,
    extraPackageRoots,
  });
  if (packages.size === 0) return { packages: 0, embedded: 0 };
  const records = embeddedLicenseRecords(
    packages,
    embedded,
    await loadEmbeddedLicenses(embeddedRoot),
  );
  // Imported lazily: the stager imports check-notice.mjs, which imports this module.
  const { stageDependencyLicenses } = await import('./stage-third-party-licenses.mjs');
  await stageDependencyLicenses(
    join(serviceDist, 'licenses'),
    inventoryFromBundledPackages(packages),
    { supplemental },
  );

  const manifestPath = join(legalRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await mkdir(join(legalRoot, 'texts'), { recursive: true });
  for (const record of records) {
    const texts = [];
    for (const text of record.texts) {
      const suffix = extname(text.file).toLowerCase();
      const outputName = `${text.sha256}${suffix && suffix.length <= 8 ? suffix : '.txt'}`;
      const outputPath = join(legalRoot, 'texts', outputName);
      if (!existsSync(outputPath)) await writeFile(outputPath, text.content);
      texts.push({ file: `texts/${outputName}`, source: text.source, sha256: text.sha256 });
    }
    manifest.packages.push({ ...record, generatedFallback: false, texts });
  }
  manifest.packages.sort((a, b) => recordId(a).localeCompare(recordId(b)));
  manifest.packageCount = manifest.packages.length;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { packages: manifest.packages.length - records.length, embedded: records.length };
}

/**
 * Fail when the staged manifest no longer matches the bundles beside it.
 * Returns the manifest's records and the installed packages they came from.
 */
export async function verifyServiceBundledLicenses({
  serviceDist = SERVICE_DIST,
  surfaces,
  extraPackageRoots,
  embeddedRoot = EMBEDDED_LICENSES_ROOT,
} = {}) {
  const { packages, embedded } = await serviceBundledPackages({
    serviceDist,
    surfaces,
    extraPackageRoots,
  });
  const legalRoot = serviceBundledLicenseRoot(serviceDist);
  const manifestPath = join(legalRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    if (packages.size === 0) return { packages: [], bundled: packages };
    throw new Error(
      'packages/service/dist/licenses/npm/manifest.json is missing; rebuild @bendyline/gezel-service',
    );
  }
  const embeddedRecords = embeddedLicenseRecords(
    packages,
    embedded,
    await loadEmbeddedLicenses(embeddedRoot),
  );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expected = new Set([
    ...[...packages.values()].map((pkg) => recordId(pkg)),
    ...embeddedRecords.map((record) => recordId(record)),
  ]);
  const staged = new Set(manifest.packages.map((record) => recordId(record)));
  const missing = [...expected].filter((id) => !staged.has(id)).sort();
  const extra = [...staged].filter((id) => !expected.has(id)).sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `service bundled-license manifest is stale; rebuild @bendyline/gezel-service\n  bundled but unlisted: ${missing.join(', ') || 'none'}\n  listed but not bundled: ${extra.join(', ') || 'none'}`,
    );
  }
  for (const record of manifest.packages) {
    if (!Array.isArray(record.texts) || record.texts.length === 0) {
      throw new Error(`${recordId(record)} has no staged license text`);
    }
    for (const text of record.texts) {
      const content = await readFile(join(legalRoot, text.file)).catch(() => null);
      if (!content || sha256(content) !== text.sha256) {
        throw new Error(`${recordId(record)}: ${text.file} is missing or altered`);
      }
    }
  }
  return { packages: manifest.packages, bundled: packages };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--embedded')) {
    const { packages, embedded } = await serviceBundledPackages();
    for (const [carrierPath, names] of embedded) {
      const carrier = packages.get(carrierPath);
      console.log(`${carrier.name}@${carrier.version}`);
      for (const [name, version] of [...names].sort()) {
        console.log(`  ${name}${version ? `@${version}` : ' (version not in its map)'}`);
      }
    }
    return;
  }
  if (args.has('--stage')) {
    const result = await stageServiceBundledLicenses();
    console.log(
      `✓ staged dist/licenses/npm: ${result.packages} bundled packages, ${result.embedded} inlined by dependencies.`,
    );
    return;
  }
  const result = await verifyServiceBundledLicenses();
  console.log(
    `✓ dist/licenses/npm covers all ${result.packages.length} packages in the service's browser bundles.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`✗ service bundled licenses: ${error.message}`);
    process.exitCode = 1;
  });
}
