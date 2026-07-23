#!/usr/bin/env node
/**
 * Add redistribution texts to one native build artifact before it is uploaded.
 * CUDA artifacts must also carry the EULA installed with the exact toolkit
 * used by that matrix leg.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNoticeInventory } from './check-notice.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

function parseArgs(argv) {
  let output;
  let requireCudaEula = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') output = argv[++index];
    else if (argv[index] === '--cuda') requireCudaEula = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!output) throw new Error('usage: stage-native-artifact-licenses.mjs --output <dir> [--cuda]');
  return { output: resolve(output), requireCudaEula };
}

async function findCudaEula() {
  const roots = new Set(
    [
      process.env.CUDA_PATH,
      process.env.CUDA_HOME,
      process.platform === 'win32'
        ? join(
            process.env.ProgramFiles ?? 'C:\\Program Files',
            'NVIDIA GPU Computing Toolkit',
            'CUDA',
          )
        : '/usr/local',
    ].filter(Boolean),
  );
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

  for (const root of roots) {
    const found = await walk(root, 0);
    if (found) return found;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await verifyNoticeInventory();
  if (!existsSync(args.output)) throw new Error(`native output does not exist: ${args.output}`);
  const legalRoot = join(args.output, 'THIRD_PARTY_LICENSES');
  await mkdir(legalRoot, { recursive: true });
  await cp(join(repoRoot, 'native', 'licenses'), join(legalRoot, 'native'), { recursive: true });

  if (args.requireCudaEula) {
    const eula = await findCudaEula();
    if (!eula) {
      throw new Error(
        'CUDA artifact has no discoverable NVIDIA CUDA Toolkit EULA. ' +
          'Expected EULA.txt under CUDA_PATH/CUDA_HOME or the platform toolkit directory.',
      );
    }
    const target = join(legalRoot, 'NVIDIA-CUDA-EULA.txt');
    await cp(eula, target);
    console.log(`[native-licenses] CUDA EULA: ${eula} -> ${target}`);
  }
  console.log(`[native-licenses] staged legal texts in ${legalRoot}`);
}

main().catch((error) => {
  console.error(`\u2717 failed to stage native legal texts: ${error.message}`);
  process.exitCode = 1;
});
