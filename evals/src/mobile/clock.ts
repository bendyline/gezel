import { spawnSync } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

/** Compile the shared clock unchanged into a native-test resource; no product bridge/global. */
export async function mobileEvalClockSource(): Promise<string> {
  const source = await readFile(
    new URL('../../../packages/core/src/suspend-clock.ts', import.meta.url),
    'utf8',
  );
  const compiled = transpileModule(source, {
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.CommonJS,
      removeComments: true,
    },
  }).outputText.replace(/^"use strict";\r?\n/, '');
  const wrapped = `/* Generated from core/suspend-clock.ts by the mobile eval launcher. Test bundles only. */\nglobalThis.__gezelMobileEvalClock = {};\n((exports)=>{\n${compiled}\n})(globalThis.__gezelMobileEvalClock);\n`;
  const format = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../../node_modules/@biomejs/biome/bin/biome', import.meta.url)),
      'format',
      '--stdin-file-path',
      'packages/mobile/evals/mobile-eval-clock.js',
    ],
    { input: wrapped, encoding: 'utf8' },
  );
  if (format.error || format.status !== 0)
    throw new Error('Could not format the generated shared clock test resource', {
      cause: format.error ?? format.stderr,
    });
  return format.stdout;
}

export async function writeMobileEvalClock(): Promise<void> {
  const destination = fileURLToPath(
    new URL('../../../packages/mobile/evals/mobile-eval-clock.js', import.meta.url),
  );
  await writeMobileTestResource(destination, await mobileEvalClockSource());
}

/** Parallel Android/iOS contract launches must never copy a partially rewritten resource. */
export async function writeMobileTestResource(destination: string, source: string): Promise<void> {
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, source);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await writeMobileEvalClock();
