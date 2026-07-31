#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

export function verifyCudaArchitectureFile({ library, expected, cuobjdump = 'cuobjdump' }) {
  if (!library || !existsSync(library)) throw new Error(`CUDA library not found: ${library ?? ''}`);
  const elfOutput = execFileSync(cuobjdump, ['--list-elf', library], { encoding: 'utf8' });
  const ptxOutput = execFileSync(cuobjdump, ['--list-ptx', library], { encoding: 'utf8' });
  return assertCudaArchitectures({ expected, elfOutput, ptxOutput });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = verifyCudaArchitectureFile({
      library: valueAfter('--library'),
      expected: valueAfter('--expected'),
      cuobjdump: valueAfter('--cuobjdump') ?? 'cuobjdump',
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
