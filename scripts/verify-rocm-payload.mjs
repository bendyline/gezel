#!/usr/bin/env node
/**
 * Prove a ROCm llama-server payload carries everything a supported GPU needs.
 *
 * Discovery hands the ROCm build any GPU whose architecture the build records
 * in `gezel-llama-build.json` (packages/core/src/native/rocm-devices.ts), so
 * every recorded architecture must have its rocBLAS kernel library and its
 * kernel pack in the archive, and the record must match what the leg was asked
 * to build. A target that compiled but whose kernels were not copied builds
 * green and fails on that GPU's first matrix multiply.
 *
 * Usage: node scripts/verify-rocm-payload.mjs <payload dir> --targets "gfx1100;gfx1201"
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseKpack } from './trim-rocm-kpack.mjs';

const RUNTIME = {
  win32: ['ggml-hip.dll', 'amdhip64_7.dll', 'hipblas.dll', 'rocblas.dll'],
  linux: ['libggml-hip.so', 'libamdhip64.so.7', 'libhipblas.so.3', 'librocblas.so.5'],
};

/** Problems with the payload at `dir`, empty when it is complete. */
export function verifyRocmPayload(dir, targets) {
  const problems = [];
  const has = (rel) => existsSync(join(dir, rel));

  let metadata = null;
  try {
    metadata = JSON.parse(readFileSync(join(dir, 'gezel-llama-build.json'), 'utf8'));
  } catch (error) {
    problems.push(`gezel-llama-build.json is unreadable: ${error.message}`);
  }
  if (metadata) {
    if (metadata.backend !== 'rocm')
      problems.push(`build metadata says backend ${metadata.backend}, not rocm`);
    const recorded = Array.isArray(metadata.rocmTargets) ? metadata.rocmTargets : [];
    if (recorded.join(';') !== targets.join(';')) {
      problems.push(
        `build metadata records rocmTargets ${recorded.join(';') || '(none)'}, the leg asked for ${targets.join(';')}`,
      );
    }
  }

  const platform = has('ggml-hip.dll') ? 'win32' : 'linux';
  for (const file of RUNTIME[platform]) {
    if (!has(file)) problems.push(`missing ${file}`);
  }

  for (const gfx of targets) {
    if (
      !has(join('rocblas', 'library', `TensileLibrary_lazy_${gfx}.dat`)) &&
      !has(join('rocblas', 'library', gfx, `TensileLibrary_lazy_${gfx}.dat`))
    ) {
      problems.push(`no rocBLAS kernel library for ${gfx}`);
    }
    const pack = join(dir, 'kpack', `blas_lib_${gfx}.kpack`);
    if (!existsSync(pack)) {
      problems.push(`no rocBLAS kernel pack for ${gfx}`);
      continue;
    }
    try {
      const { toc } = parseKpack(readFileSync(pack));
      const binaries = Object.entries(toc.toc).filter(([, arches]) => arches[gfx]);
      if (!binaries.some(([binary]) => /rocblas/i.test(binary))) {
        problems.push(`kernel pack for ${gfx} holds no rocBLAS kernels`);
      }
      if (binaries.some(([binary]) => /rocsolver|rocsparse/i.test(binary))) {
        problems.push(
          `kernel pack for ${gfx} was not trimmed (rocSOLVER/rocSPARSE kernels present)`,
        );
      }
    } catch (error) {
      problems.push(`kernel pack for ${gfx} is unreadable: ${error.message}`);
    }
  }

  // Never shipped: ~170 MB per architecture, turned off at launch.
  if (has(join('hipblaslt', 'library'))) problems.push('hipBLASLt kernel library is bundled');
  const stray = existsSync(join(dir, 'kpack'))
    ? readdirSync(join(dir, 'kpack')).filter(
        (name) => !targets.some((gfx) => name === `blas_lib_${gfx}.kpack`),
      )
    : [];
  if (stray.length > 0) problems.push(`unexpected kernel packs: ${stray.join(', ')}`);
  return problems;
}

function main(argv) {
  const [dir, flag, list] = argv;
  if (!dir || flag !== '--targets' || !list) {
    console.error('usage: verify-rocm-payload.mjs <payload dir> --targets "gfx1100;gfx1201"');
    process.exit(2);
  }
  const targets = list.split(';').filter(Boolean);
  const problems = verifyRocmPayload(dir, targets);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log(`[rocm] payload complete for ${targets.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
