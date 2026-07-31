#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Locate `cuobjdump`. A partial toolkit install (the CI legs pull only nvcc +
 * cudart + cublas) leaves it off PATH entirely, so prefer the toolkit root the
 * workflow exports before falling back to a bare PATH lookup.
 */
export function resolveCuobjdump(env = process.env) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const root of [env.CUDA_PATH, env.CUDA_HOME]) {
    if (!root) continue;
    const candidate = join(root, 'bin', `cuobjdump${suffix}`);
    if (existsSync(candidate)) return candidate;
  }
  return `cuobjdump${suffix}`;
}

export function normalizeExpectedCudaArchitectures(value) {
  return String(value ?? '')
    .split(';')
    .map((entry) => entry.trim().replace(/-(?:real|virtual)$/, ''))
    .filter(Boolean);
}

export function parseCuobjdumpArchitectures(output) {
  return [...String(output).matchAll(/\bsm_([0-9]+[a-z]?)\b/gi)]
    .map((match) => match[1].toLowerCase())
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
}

export function assertCudaArchitectures({ expected, elfOutput, ptxOutput = '' }) {
  const wanted = normalizeExpectedCudaArchitectures(expected);
  if (wanted.length === 0) throw new Error('expected CUDA architecture list is empty');

  const real = parseCuobjdumpArchitectures(elfOutput);
  const virtual = parseCuobjdumpArchitectures(ptxOutput);
  const available = new Set([...real, ...virtual]);
  const missing = wanted.filter((arch) => !available.has(arch.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(
      `CUDA payload missing expected architecture(s): ${missing.join(', ')}; ` +
        `found cubin=[${real.join(', ') || 'none'}] ptx=[${virtual.join(', ') || 'none'}]`,
    );
  }
  return { expected: wanted, cubin: real, ptx: virtual };
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function verifyCudaArchitectureFile({ library, expected, cuobjdump = resolveCuobjdump() }) {
  if (!library || !existsSync(library)) throw new Error(`CUDA library not found: ${library ?? ''}`);
  let elfOutput;
  let ptxOutput;
  try {
    elfOutput = execFileSync(cuobjdump, ['--list-elf', library], { encoding: 'utf8' });
    ptxOutput = execFileSync(cuobjdump, ['--list-ptx', library], { encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `cuobjdump not found (tried "${cuobjdump}"). Install the cuda-cuobjdump package for the toolkit version in use, or pass --cuobjdump <path>.`,
      );
    }
    throw error;
  }
  return assertCudaArchitectures({ expected, elfOutput, ptxOutput });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = verifyCudaArchitectureFile({
      library: valueAfter('--library'),
      expected: valueAfter('--expected'),
      cuobjdump: valueAfter('--cuobjdump') ?? resolveCuobjdump(),
    });
    console.log(
      `[cuda-arch] verified expected=[${result.expected.join(', ')}] ` +
        `cubin=[${result.cubin.join(', ') || 'none'}] ptx=[${result.ptx.join(', ') || 'none'}]`,
    );
  } catch (error) {
    console.error(`[cuda-arch] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
