#!/usr/bin/env node
/**
 * Add redistribution texts to one native build artifact before it is uploaded.
 * CUDA artifacts prefer the EULA installed with the exact toolkit used by that
 * matrix leg, then fall back to a checked-in copy for that supported CUDA minor.
 * ROCm artifacts get the license of every AMD library they carry, from the
 * SDK the library was copied from or, where AMD ships none, from
 * native/rocm-licenses/.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeNoticeInventory } from './check-notice.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const supportedCudaEulas = new Map(
  ['12.4', '12.8', '12.9', '13.0', '13.4'].map((version) => [
    version,
    join(repoRoot, 'native', 'cuda-eulas', `NVIDIA-CUDA-EULA-${version}.txt`),
  ]),
);

function parseArgs(argv) {
  let output;
  let requireCudaEula = false;
  let rocm = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') output = argv[++index];
    else if (argv[index] === '--cuda') requireCudaEula = true;
    else if (argv[index] === '--rocm') rocm = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!output) {
    throw new Error('usage: stage-native-artifact-licenses.mjs --output <dir> [--cuda] [--rocm]');
  }
  return { output: resolve(output), requireCudaEula, rocm };
}

/**
 * Every AMD library a ROCm payload can carry and where its license text
 * comes from: `sdk` names a folder of the ROCm SDK's `share/doc/`, `files` a
 * text in native/rocm-licenses/. The rocBLAS kernels the payload also carries
 * (rocblas/library, kpack/) are rocBLAS's and covered by its entry. A library
 * that matches ROCM_VENDOR_LIBRARY and no entry fails the build: a new
 * dependency gets its license reviewed before it ships.
 */
export const ROCM_VENDOR_LIBRARY =
  /^(?:lib)?(?:amdhip64|amd_comgr|rocm_kpack|hipblas|rocblas|rocsolver|origami|roctx64|hsa-runtime64|rocprofiler-register|rocroller|rocm_sysdeps_|LLVM|clang-cpp)/i;

export const ROCM_LICENSES = [
  { component: 'hip', match: /^(?:lib)?amdhip64/i, files: ['LICENSE-hip-clr.md'] },
  { component: 'amd_comgr', match: /^(?:lib)?amd_comgr/i, sdk: 'amd_comgr' },
  { component: 'rocm-kpack', match: /^(?:lib)?rocm_kpack/i, files: ['LICENSE-rocm-kpack.txt'] },
  { component: 'hipblaslt', match: /^(?:lib)?hipblaslt/i, sdk: 'hipblaslt' },
  { component: 'hipblas', match: /^(?:lib)?hipblas(?!lt)/i, sdk: 'hipblas' },
  { component: 'rocblas', match: /^(?:lib)?rocblas/i, sdk: 'rocblas' },
  { component: 'rocsolver', match: /^(?:lib)?rocsolver/i, sdk: 'rocsolver' },
  { component: 'origami', match: /^(?:lib)?origami/i, sdk: 'origami' },
  { component: 'roctracer', match: /^(?:lib)?roctx64/i, sdk: 'roctracer' },
  { component: 'rocr', match: /^libhsa-runtime64/, sdk: 'rocr' },
  {
    component: 'rocprofiler-register',
    match: /^librocprofiler-register/,
    sdk: 'rocprofiler-register',
  },
  { component: 'rocroller', match: /^librocroller/, files: ['LICENSE-rocroller.md'] },
  { component: 'llvm', match: /^lib(?:LLVM|clang-cpp)/, files: ['LICENSE-llvm.txt'] },
  { component: 'libdrm', match: /^librocm_sysdeps_drm/, files: ['LICENSE-libdrm-MIT.txt'] },
  { component: 'numactl', match: /^librocm_sysdeps_numa/, files: ['LICENSE-numactl-LGPL-2.1.txt'] },
  {
    component: 'elfutils',
    match: /^librocm_sysdeps_elf/,
    files: [
      'LICENSE-elfutils-LGPL-3.0.txt',
      'LICENSE-elfutils-GPL-3.0.txt',
      'LICENSE-elfutils-GPL-2.0.txt',
    ],
  },
  { component: 'zlib', match: /^librocm_sysdeps_z\./, files: ['LICENSE-zlib.txt'] },
  { component: 'zstd', match: /^librocm_sysdeps_zstd/, files: ['LICENSE-zstd-BSD-3-Clause.txt'] },
  { component: 'xz', match: /^librocm_sysdeps_liblzma/, files: ['LICENSE-xz-liblzma-0BSD.txt'] },
  { component: 'bzip2', match: /^librocm_sysdeps_bz2/, files: ['LICENSE-bzip2.txt'] },
];

async function stageRocmLicenses(output, legalRoot) {
  const sdkRoot = process.env.ROCM_PATH || process.env.HIP_PATH;
  if (!sdkRoot)
    throw new Error('--rocm needs ROCM_PATH or HIP_PATH naming the ROCm SDK the payload came from');
  const libraries = (await readdir(output, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && ROCM_VENDOR_LIBRARY.test(entry.name))
    .map((entry) => entry.name);
  if (libraries.length === 0) throw new Error(`--rocm: no AMD libraries in ${output}`);
  const target = join(legalRoot, 'AMD-ROCm');
  await mkdir(target, { recursive: true });
  const index = [];
  const staged = new Set();
  for (const library of libraries.sort()) {
    const entry = ROCM_LICENSES.find((candidate) => candidate.match.test(library));
    if (!entry)
      throw new Error(
        `${library} is an AMD library with no reviewed license entry (ROCM_LICENSES)`,
      );
    index.push(`${library}: ${entry.component}`);
    if (staged.has(entry.component)) continue;
    staged.add(entry.component);
    if (entry.sdk) {
      const docDir = join(sdkRoot, 'share', 'doc', entry.sdk);
      const texts = existsSync(docDir)
        ? (await readdir(docDir)).filter((name) => /^licen[cs]e/i.test(name))
        : [];
      if (texts.length === 0)
        throw new Error(`the ROCm SDK has no license text for ${entry.component} under ${docDir}`);
      for (const name of texts)
        await cp(join(docDir, name), join(target, `${entry.component}-${name}`));
    } else {
      for (const name of entry.files) {
        await cp(join(repoRoot, 'native', 'rocm-licenses', name), join(target, name));
      }
    }
  }
  await writeFile(
    join(target, 'README.txt'),
    [
      'AMD ROCm runtime libraries in this payload and the license each is under:',
      '',
      ...index,
      '',
      "The rocBLAS kernels under rocblas/library and kpack/ are rocBLAS's.",
      '',
    ].join('\n'),
  );
  console.log(
    `[native-licenses] ROCm: ${staged.size} licenses for ${libraries.length} libraries -> ${target}`,
  );
}

async function findCudaEula() {
  const configuredRoots = [process.env.CUDA_PATH, process.env.CUDA_HOME].filter(Boolean);
  const exactNames = new Set([
    'EULA.txt',
    'CUDA_EULA.txt',
    'CUDA_Toolkit_End_User_License_Agreement.txt',
  ]);

  async function walk(root, depth) {
    if (depth > 4 || !existsSync(root)) return null;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !exactNames.has(entry.name)) continue;
      const path = join(root, entry.name);
      const text = await readFile(path, 'utf8');
      if (/NVIDIA/i.test(text) && /CUDA/i.test(text)) return path;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (depth === 0 && root === '/usr/local' && !entry.name.startsWith('cuda')) continue;
      const found = await walk(join(root, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const root of new Set(configuredRoots)) {
    const found = await walk(root, 0);
    if (found) return found;
  }

  for (const root of configuredRoots) {
    const match = root.match(/(?:cuda[-\\/ ]*|v)(\d+)[._-](\d+)/i);
    if (!match) continue;
    const version = `${match[1]}.${match[2]}`;
    const fallback = supportedCudaEulas.get(version);
    if (!fallback) {
      throw new Error(
        `CUDA ${version} has no checked-in EULA fallback. ` +
          `Add native/cuda-eulas/NVIDIA-CUDA-EULA-${version}.txt before building it.`,
      );
    }
    if (!existsSync(fallback)) {
      throw new Error(`checked-in CUDA ${version} EULA fallback is missing: ${fallback}`);
    }
    return fallback;
  }

  const platformRoot =
    process.platform === 'win32'
      ? join(
          process.env.ProgramFiles ?? 'C:\\Program Files',
          'NVIDIA GPU Computing Toolkit',
          'CUDA',
        )
      : '/usr/local';
  const platformEula = await walk(platformRoot, 0);
  if (platformEula) return platformEula;

  throw new Error(
    'CUDA artifact has no discoverable NVIDIA CUDA Toolkit EULA and the CUDA minor ' +
      'could not be inferred from CUDA_PATH/CUDA_HOME for a checked-in fallback.',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await verifyNativeNoticeInventory();
  if (!existsSync(args.output)) throw new Error(`native output does not exist: ${args.output}`);
  const legalRoot = join(args.output, 'THIRD_PARTY_LICENSES');
  await mkdir(legalRoot, { recursive: true });
  await cp(join(repoRoot, 'native', 'licenses'), join(legalRoot, 'native'), { recursive: true });

  if (args.requireCudaEula) {
    const eula = await findCudaEula();
    const target = join(legalRoot, 'NVIDIA-CUDA-EULA.txt');
    await cp(eula, target);
    console.log(`[native-licenses] CUDA EULA: ${eula} -> ${target}`);
  }
  if (args.rocm) await stageRocmLicenses(args.output, legalRoot);
  console.log(`[native-licenses] staged legal texts in ${legalRoot}`);
}

main().catch((error) => {
  console.error(`\u2717 failed to stage native legal texts: ${error.message}`);
  process.exitCode = 1;
});
