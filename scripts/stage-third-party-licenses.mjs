#!/usr/bin/env node
/**
 * Build the legal bundle placed at resources/licenses/ in every desktop app.
 *
 * Production dependency texts come from the exact package paths reported by
 * `pnpm licenses list --prod --json`; identical texts are content-addressed so
 * hundreds of MIT dependencies do not bloat installers with duplicate files.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyNoticeInventory } from './check-notice.mjs';
import { readProductionLicenseInventory } from './production-dependency-inventory.mjs';

const execFileP = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const defaultDestination = join(repoRoot, 'packages', 'app', 'dist', 'licenses');
const destination = process.argv[2] ? resolve(process.argv[2]) : defaultDestination;
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i;
const CUDA_LIBRARY = /(?:^|lib)(?:cudart|cublas)/i;

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function copyFile(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}

async function listFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  if (existsSync(root)) await walk(root);
  return files;
}

async function packageLicenseFiles(packagePath) {
  const files = [];
  for (const entry of await readdir(packagePath, { withFileTypes: true })) {
    if (entry.isFile() && LICENSE_FILE.test(entry.name)) files.push(join(packagePath, entry.name));
    if (entry.isDirectory() && /^(?:licenses?|legal)$/i.test(entry.name)) {
      for (const nested of await readdir(join(packagePath, entry.name), { withFileTypes: true })) {
        if (nested.isFile()) files.push(join(packagePath, entry.name, nested.name));
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function stageDependencyLicenses() {
  const inventory = readProductionLicenseInventory();
  const textsDir = join(destination, 'npm', 'texts');
  await mkdir(textsDir, { recursive: true });
  const records = [];
  const missing = [];
  const installed = [];
  const canonicalByLicense = new Map();

  for (const [reportedLicense, packages] of Object.entries(inventory)) {
    if (!Array.isArray(packages)) throw new Error('pnpm returned an invalid license inventory');
    for (const pkg of packages) {
      if (!pkg || typeof pkg.name !== 'string' || !Array.isArray(pkg.versions)) {
        throw new Error('pnpm returned an invalid package license record');
      }
      const paths = Array.isArray(pkg.paths) ? pkg.paths : [];
      for (let index = 0; index < pkg.versions.length; index += 1) {
        const version = pkg.versions[index];
        const packagePath = paths[index];
        // Optional dependencies for other operating systems are represented
        // with a null path. They are not in this platform's installer.
        if (typeof packagePath !== 'string' || packagePath.length === 0) continue;
        const packageJsonPath = join(packagePath, 'package.json');
        if (!existsSync(packageJsonPath)) {
          missing.push(`${pkg.name}@${version}: package path does not exist (${packagePath})`);
          continue;
        }
        const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
        if (packageJson.name !== pkg.name || packageJson.version !== version) {
          missing.push(
            `${pkg.name}@${version}: pnpm path resolves to ${packageJson.name}@${packageJson.version}`,
          );
          continue;
        }

        // Workspace Gezel packages are covered by the repository LICENSE
        // copied at the bundle root.
        let sources = [];
        if (pkg.name.startsWith('@bendyline/gezel')) {
          sources = [join(repoRoot, 'LICENSE')];
        } else {
          sources = await packageLicenseFiles(packagePath);
        }
        if (sources.length > 0 && !canonicalByLicense.has(reportedLicense)) {
          canonicalByLicense.set(reportedLicense, sources);
        }
        installed.push({ reportedLicense, pkg, version, packageJson, sources });
      }
    }
  }

  for (const item of installed) {
    const { reportedLicense, pkg, version, packageJson } = item;
    let materials = item.sources.map((source) => ({ source, name: basename(source) }));
    let generatedFallback = false;
    if (materials.length === 0) {
      generatedFallback = true;
      materials = fallbackLicenseMaterials({
        reportedLicense,
        pkg,
        version,
        packageJson,
        canonicalByLicense,
      });
    }
    if (materials.length === 0) {
      missing.push(`${pkg.name}@${version}: no license text or approved canonical fallback`);
      continue;
    }

    try {
      const texts = [];
      for (const material of materials) {
        const content = material.content ?? (await readFile(material.source));
        if (content.length === 0) {
          throw new Error(`empty legal material ${material.source ?? material.name}`);
        }
        const digest = sha256(content);
        const suffix = extname(material.name).toLowerCase();
        const outputName = `${digest}${suffix && suffix.length <= 8 ? suffix : '.txt'}`;
        const outputPath = join(textsDir, outputName);
        if (!existsSync(outputPath)) await writeFile(outputPath, content);
        texts.push({
          file: `texts/${outputName}`,
          source: material.name,
          sha256: digest,
        });
      }
      records.push({
        name: pkg.name,
        version,
        license: reportedLicense,
        generatedFallback,
        texts,
      });
    } catch (error) {
      missing.push(`${pkg.name}@${version}: ${error.message}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `production packages are missing redistributable license material:\n${missing
        .sort()
        .map((item) => `  - ${item}`)
        .join('\n')}`,
    );
  }

  records.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const manifest = {
    schemaVersion: 1,
    packageCount: records.length,
    packages: records,
  };
  await writeFile(
    join(destination, 'npm', 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return records.length;
}

function attributionHeader({ reportedLicense, pkg, version, packageJson }) {
  const author =
    typeof pkg.author === 'string'
      ? pkg.author
      : typeof packageJson.author === 'string'
        ? packageJson.author
        : packageJson.author?.name;
  const homepage = pkg.homepage ?? packageJson.homepage ?? packageJson.repository?.url;
  return [
    `Package: ${pkg.name}@${version}`,
    `License declared by package: ${reportedLicense}`,
    author ? `Author/attribution from package metadata: ${author}` : null,
    homepage ? `Upstream: ${homepage}` : null,
    '',
    'The published package contains no standalone license file. This copy',
    'preserves its package attribution and the complete terms of the license',
    'expression it declares.',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function fallbackLicenseMaterials(input) {
  const { reportedLicense, pkg, version, packageJson, canonicalByLicense } = input;
  const header = attributionHeader(input);
  const holder =
    (typeof pkg.author === 'string' ? pkg.author : null) ??
    (typeof packageJson.author === 'string' ? packageJson.author : packageJson.author?.name) ??
    `${pkg.name} contributors`;
  if (reportedLicense === 'MIT' || reportedLicense === 'MIT OR Apache') {
    const choice = reportedLicense === 'MIT OR Apache' ? 'Gezel elects the MIT option.\n\n' : '';
    return [
      {
        name: 'GENERATED-LICENSE-MIT.txt',
        content: Buffer.from(
          `${header}${choice}MIT License\n\nCopyright ${holder}\n\n${MIT_TERMS}\n`,
        ),
      },
    ];
  }
  if (reportedLicense === 'ISC') {
    return [
      {
        name: 'GENERATED-LICENSE-ISC.txt',
        content: Buffer.from(
          [
            `${header}ISC License\n\nCopyright ${holder}\n`,
            'Permission to use, copy, modify, and/or distribute this software for any',
            'purpose with or without fee is hereby granted, provided that the above',
            'copyright notice and this permission notice appear in all copies.\n',
            'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES',
            'WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF',
            'MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR',
            'ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES',
            'WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN',
            'ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF',
            'OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n',
          ].join('\n'),
        ),
      },
    ];
  }

  const standards = {
    'GPL-2.0-or-later': ['GPL-2.0.txt'],
  }[reportedLicense];
  if (standards) {
    return [
      { name: 'PACKAGE-ATTRIBUTION.txt', content: Buffer.from(header) },
      ...standards.map((name) => ({ source: join(repoRoot, 'legal', 'licenses', name), name })),
    ];
  }

  const canonical = canonicalByLicense.get(reportedLicense);
  if (canonical?.length) {
    return [
      { name: 'PACKAGE-ATTRIBUTION.txt', content: Buffer.from(header) },
      ...canonical.map((source) => ({ source, name: basename(source) })),
    ];
  }
  return [];
}

async function stageFontLicenses() {
  const sourceRoot = join(repoRoot, 'packages', 'ui', 'src', 'assets', 'fonts');
  const targetRoot = join(destination, 'fonts');
  await copyFile(join(sourceRoot, 'README.md'), join(targetRoot, 'README.md'));
  await copyFile(
    join(sourceRoot, 'LICENSE-CC-BY-SA-4.0.txt'),
    join(targetRoot, 'LICENSE-CC-BY-SA-4.0.txt'),
  );
  await cp(join(sourceRoot, 'licenses'), join(targetRoot, 'licenses'), { recursive: true });
}

async function stagePolicyLicenses() {
  await cp(join(repoRoot, 'legal', 'licenses'), join(destination, 'standards'), {
    recursive: true,
  });
}

async function ensureElectronDistribution(electronRoot, version) {
  const chromiumLicenses = join(electronRoot, 'dist', 'LICENSES.chromium.html');
  if (existsSync(chromiumLicenses) && (await stat(chromiumLicenses)).size > 0) return;

  // pnpm deploy --prod can leave the workspace's Electron dev dependency
  // linked while pruning the distribution downloaded by Electron's
  // lifecycle script. Packaging still needs the distribution, and the full
  // Chromium attribution file exists only in that archive (not in the npm
  // package itself), so materialize the exact pinned release on demand.
  const installer = join(electronRoot, 'install.js');
  if (!existsSync(installer)) {
    throw new Error(`Electron ${version} has no installer at ${installer}`);
  }
  console.log(
    `[stage-third-party-licenses] Electron ${version} distribution is missing; downloading it for redistribution notices`,
  );
  try {
    await execFileP(process.execPath, [installer], {
      cwd: electronRoot,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`failed to download Electron ${version}: ${detail}`);
  }
  if (!existsSync(chromiumLicenses) || (await stat(chromiumLicenses)).size === 0) {
    throw new Error(
      `Electron ${version} installed without its Chromium redistribution text: ${chromiumLicenses}`,
    );
  }
}

async function stageBundledRuntimeLicenses(expected) {
  const appRoot = join(repoRoot, 'packages', 'app');
  const targetRoot = join(destination, 'runtimes');
  const requireFromApp = createRequire(join(appRoot, 'package.json'));
  const electronPackagePath = requireFromApp.resolve('electron/package.json');
  const electronRoot = dirname(electronPackagePath);
  const electronPackage = JSON.parse(await readFile(electronPackagePath, 'utf8'));
  const nodeRoot = join(appRoot, 'dist', 'node-bundle');
  const pnpmRoot = join(appRoot, 'dist', 'pnpm-bundle');
  const nodeVersion = (await readFile(join(nodeRoot, 'version.txt'), 'utf8')).trim();
  const pnpmVersion = (await readFile(join(pnpmRoot, 'version.txt'), 'utf8')).trim();
  const versions = {
    Electron: electronPackage.version,
    'Node.js': nodeVersion,
    pnpm: pnpmVersion,
  };
  for (const [name, version] of Object.entries(versions)) {
    if (version !== expected.versions[name]) {
      throw new Error(
        `${name} legal material is for ${version}; NOTICE/runtime pin expects ${expected.versions[name]}`,
      );
    }
  }
  await ensureElectronDistribution(electronRoot, versions.Electron);

  const entries = [
    {
      name: 'Electron',
      version: versions.Electron,
      files: [
        // Electron's npm package carries the same pinned MIT terms even when
        // pnpm has pruned its optional downloaded distribution.
        { source: join(electronRoot, 'LICENSE'), target: 'electron-LICENSE.txt' },
        {
          source: join(electronRoot, 'dist', 'LICENSES.chromium.html'),
          target: 'electron-LICENSES.chromium.html',
        },
      ],
    },
    {
      name: 'Node.js',
      version: versions['Node.js'],
      files: [{ source: join(nodeRoot, 'LICENSE.txt'), target: 'node-LICENSE.txt' }],
    },
    {
      name: 'pnpm',
      version: versions.pnpm,
      files: [{ source: join(pnpmRoot, 'LICENSE.txt'), target: 'pnpm-LICENSE.txt' }],
    },
  ];
  for (const entry of entries) {
    for (const file of entry.files) {
      if (!existsSync(file.source) || (await stat(file.source)).size === 0) {
        throw new Error(`missing ${entry.name} redistribution text: ${file.source}`);
      }
      await copyFile(file.source, join(targetRoot, file.target));
    }
  }
  await writeFile(
    join(targetRoot, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runtimeCount: entries.length,
        runtimes: entries.map((entry) => ({
          name: entry.name,
          version: entry.version,
          files: entry.files.map((file) => file.target),
        })),
      },
      null,
      2,
    )}\n`,
  );
  return entries.length;
}

async function stageNativeLicenses() {
  await cp(join(repoRoot, 'native', 'licenses'), join(destination, 'native'), { recursive: true });

  const nativeRoot = join(repoRoot, 'packages', 'app', 'native-bin');
  if (!existsSync(nativeRoot)) return 0;
  let cudaPayloads = 0;
  for (const entry of await readdir(nativeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const platformRoot = join(nativeRoot, entry.name);
    const files = await listFiles(platformRoot);
    if (!files.some((path) => CUDA_LIBRARY.test(basename(path)))) continue;
    cudaPayloads += 1;
    const eula = files.find((path) => basename(path) === 'NVIDIA-CUDA-EULA.txt');
    if (!eula) {
      throw new Error(
        `CUDA runtime libraries in packages/app/native-bin/${entry.name} have no THIRD_PARTY_LICENSES/NVIDIA-CUDA-EULA.txt; rebuild the native release`,
      );
    }
    await copyFile(eula, join(destination, 'native', `NVIDIA-CUDA-EULA-${entry.name}.txt`));
  }
  return cudaPayloads;
}

async function writeBundleManifest(summary) {
  const files = [];
  for (const path of await listFiles(destination)) {
    if (path === join(destination, 'manifest.json')) continue;
    const content = await readFile(path);
    files.push({
      path: relative(destination, path).replaceAll('\\', '/'),
      size: (await stat(path)).size,
      sha256: sha256(content),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(
    join(destination, 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, ...summary, files }, null, 2)}\n`,
  );
}

async function main() {
  const notice = await verifyNoticeInventory();
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await copyFile(join(repoRoot, 'LICENSE'), join(destination, 'LICENSE.txt'));
  await copyFile(join(repoRoot, 'NOTICE.md'), join(destination, 'NOTICE.md'));
  await stagePolicyLicenses();
  await stageFontLicenses();
  const cudaPayloads = await stageNativeLicenses();
  const bundledRuntimes = await stageBundledRuntimeLicenses(notice.runtimes);
  const productionPackages = await stageDependencyLicenses();
  await writeBundleManifest({
    productionPackages,
    nativeEngines: notice.native.engines,
    fontFamilies: notice.fonts.families,
    bundledRuntimes,
    cudaPayloads,
  });
  console.log(
    `\u2713 staged legal bundle at ${relative(repoRoot, destination)} ` +
      `(${productionPackages} production packages, ${notice.native.engines} native engines, ` +
      `${notice.fonts.families} font families, ${bundledRuntimes} bundled runtimes, ` +
      `${cudaPayloads} CUDA payloads).`,
  );
}

main().catch((error) => {
  console.error(`\u2717 failed to stage third-party licenses: ${error.message}`);
  process.exitCode = 1;
});
