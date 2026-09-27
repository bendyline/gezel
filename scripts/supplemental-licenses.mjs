/**
 * License texts for redistributed binaries whose own distribution omits them.
 *
 * onnxruntime-node declares MIT, publishes no license file, and carries
 * Microsoft's proprietary DirectML.dll plus the DirectX Shader Compiler inside
 * its Windows build. The v1.26270.76 installer shipped all of that with only a
 * generated MIT text crediting the npm publisher. `legal/licenses/manifest.json`
 * binds the missing texts to the exact package version, and this module is the
 * one reader both packaging and the SBOM use.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const SUPPLEMENTAL_LICENSES_ROOT = resolve(scriptDir, '..', 'legal', 'licenses');
const UNMANAGED_FILES = new Set(['README.md', 'manifest.json']);

/**
 * Binaries whose presence in any production package demands a reviewed entry
 * in the manifest. Matched on the file's base name so a second package that
 * starts carrying one is caught too, not just the package that does today.
 */
export const LICENSED_BINARY_RULES = Object.freeze([
  { component: 'directml', label: 'Microsoft DirectML', pattern: /^directml(?:\.debug)?\.dll$/i },
  {
    component: 'directx-shader-compiler',
    label: 'DirectX Shader Compiler',
    pattern: /^(?:dxcompiler|dxil)\.dll$/i,
  },
  {
    component: 'onnxruntime',
    label: 'ONNX Runtime native library',
    pattern: /^(?:onnxruntime\.dll|libonnxruntime(?:\.\d+)*\.(?:dylib|so)(?:\.\d+)*)$/i,
  },
  {
    component: 'onnxruntime',
    label: 'ONNX Runtime WebAssembly',
    pattern: /^ort-wasm[\w.-]*\.wasm$/i,
  },
  // onnxruntime-node's install script downloads these on linux-x64 hosts; the
  // CUDA one alone is 316 MB.
  {
    component: 'onnxruntime-gpu-providers',
    label: 'ONNX Runtime execution provider',
    pattern: /^(?:lib)?onnxruntime_providers_\w+\.(?:so|dll|dylib)$/i,
  },
]);

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function requireTexts(texts, known, label) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error(`${label} names no texts`);
  for (const text of texts) {
    if (!known.has(text)) throw new Error(`${label} names unknown text ${String(text)}`);
  }
  return texts;
}

/** Load and verify `legal/licenses/manifest.json` against the texts beside it. */
export async function loadSupplementalLicenses(root = SUPPLEMENTAL_LICENSES_ROOT) {
  const manifestPath = join(root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.texts ||
    !manifest.npmPackages ||
    !manifest.installerBinaries
  ) {
    throw new Error(
      `${manifestPath} must have schemaVersion 1, texts, npmPackages, and installerBinaries`,
    );
  }

  const texts = new Map();
  for (const [file, record] of Object.entries(manifest.texts)) {
    if (file.includes('/') || file.includes('\\'))
      throw new Error(`invalid license text name ${file}`);
    requireString(record?.source, `${file} source`);
    const expected = requireString(record?.sha256, `${file} sha256`).toLowerCase();
    const path = join(root, file);
    if (!existsSync(path))
      throw new Error(`missing supplemental license text legal/licenses/${file}`);
    const content = await readFile(path);
    if (sha256(content) !== expected) {
      throw new Error(
        `legal/licenses/${file} does not match its recorded sha256; restore the upstream text or re-review it`,
      );
    }
    texts.set(file, { file, path, sha256: expected, source: record.source });
  }
  const present = (await readdir(root)).filter((name) => !UNMANAGED_FILES.has(name));
  const orphans = present.filter((name) => !texts.has(name));
  if (orphans.length > 0) {
    throw new Error(`legal/licenses has files missing from manifest.json: ${orphans.join(', ')}`);
  }

  const referenced = new Set();
  const npmPackages = new Map();
  for (const [name, entry] of Object.entries(manifest.npmPackages)) {
    const version = requireString(entry?.version, `${name} version`);
    if (!Array.isArray(entry.components) || entry.components.length === 0) {
      throw new Error(`${name}@${version} has no license components`);
    }
    const ids = new Set();
    const components = entry.components.map((component) => {
      const label = `${name}@${version} component ${component?.id ?? '(unnamed)'}`;
      const id = requireString(component?.id, `${label} id`);
      if (ids.has(id)) throw new Error(`${name}@${version} repeats component ${id}`);
      ids.add(id);
      if (!Array.isArray(component.binaries) || component.binaries.length === 0) {
        throw new Error(`${label} lists no binaries`);
      }
      for (const binary of component.binaries) {
        const path = requireString(binary?.path, `${label} binary path`);
        if (path.startsWith('/') || path.split('/').includes('..')) {
          throw new Error(`${label} has an unsafe binary path ${path}`);
        }
        requireString(binary.target, `${label} ${path} target`);
      }
      for (const text of requireTexts(component.texts, texts, label)) referenced.add(text);
      return {
        ...component,
        name: requireString(component.name, `${label} name`),
        version: requireString(component.version, `${label} version`),
        license: requireString(component.license, `${label} license`),
        proprietary: component.proprietary === true,
      };
    });
    npmPackages.set(name, { name, version, components });
  }

  const installerBinaries = new Map();
  for (const [id, entry] of Object.entries(manifest.installerBinaries)) {
    const label = `installer binary ${id}`;
    requireString(entry?.name, `${label} name`);
    requireString(entry.version, `${label} version`);
    requireString(entry.license, `${label} license`);
    requireString(entry.path, `${label} path`);
    if (!Array.isArray(entry.targets) || entry.targets.length === 0) {
      throw new Error(`${label} has no targets`);
    }
    for (const text of requireTexts(entry.texts, texts, label)) referenced.add(text);
    installerBinaries.set(id, { id, ...entry });
  }

  const unreferenced = [...texts.keys()].filter((file) => !referenced.has(file));
  if (unreferenced.length > 0) {
    throw new Error(`legal/licenses texts assigned to nothing: ${unreferenced.join(', ')}`);
  }
  return { root, texts, npmPackages, installerBinaries };
}

/** Relative paths (POSIX) of every rule-matched binary inside one package. */
export async function findLicensedBinaries(packagePath) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      // pnpm links dependencies as siblings; a nested node_modules is another
      // package with its own inventory record.
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const rule = LICENSED_BINARY_RULES.find((candidate) => candidate.pattern.test(entry.name));
      if (rule) found.push({ path: relative(packagePath, path).split(sep).join('/'), rule });
    }
  }
  await walk(packagePath);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Decide which supplemental texts one installed package needs, and whether it
 * carries a rule-matched binary nobody reviewed. `problems` is empty only when
 * every such binary is declared for this exact version and every declared
 * binary is really there.
 */
export async function packageLicenseCoverage({ name, version, packagePath }, supplemental) {
  const problems = [];
  const entry = supplemental.npmPackages.get(name);
  const found = await findLicensedBinaries(packagePath);
  if (entry && entry.version !== version) {
    problems.push(
      `${name}@${version}: legal/licenses/manifest.json was reviewed for ${entry.version}; confirm which native builds the new version carries and update it`,
    );
    return { problems, texts: [], components: [] };
  }

  const declared = new Map();
  for (const component of entry?.components ?? []) {
    for (const binary of component.binaries) declared.set(binary.path, { component, binary });
  }
  for (const binary of found) {
    const component = declared.get(binary.path)?.component;
    if (!component) {
      problems.push(
        `${name}@${version}: ships ${binary.path} (${binary.rule.label}) with no reviewed license texts in legal/licenses/manifest.json`,
      );
    } else if (component.id !== binary.rule.component) {
      problems.push(
        `${name}@${version}: ${binary.path} is declared under ${component.id}, but it is ${binary.rule.label}`,
      );
    }
  }
  // An optional binary is one the package's own install script fetches on
  // some hosts only; everything else is in the published tarball.
  for (const [path, { binary }] of declared) {
    if (binary.optional) continue;
    if (!existsSync(join(packagePath, ...path.split('/')))) {
      problems.push(
        `${name}@${version}: legal/licenses/manifest.json declares ${path}, which is absent`,
      );
    }
  }

  const texts = [];
  const seen = new Set();
  for (const component of entry?.components ?? []) {
    for (const file of component.texts) {
      if (seen.has(file)) continue;
      seen.add(file);
      texts.push(supplemental.texts.get(file));
    }
  }
  return { problems, texts, components: entry?.components ?? [] };
}
