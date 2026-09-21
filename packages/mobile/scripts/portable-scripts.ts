import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScriptMeta } from '@bendyline/gezel-script-runtime/meta';
import ts from 'typescript';
import type { Plugin } from 'vite';

/** Reuse the desktop standard library; compile once when packaging, never on-device. */
const names = [
  'checkFileExists',
  'checkJsonValid',
  'checkContains',
  'checkWordBand',
  'checkFileMinBytes',
  'checkFileMinLines',
  'checkFileCount',
  'checkOrderedSections',
  'checkTableShape',
  'checkTaskNoteContains',
  'storeRecords',
  'publishCorpusBatches',
] as const;
const scriptsId = 'virtual:gezel-portable-scripts';
const sdkId = 'virtual:gezel-portable-sdk';
const typesId = 'virtual:gezel-portable-sdk-types';
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(
  require.resolve('@bendyline/gezel-script-runtime/package.json'),
);

export function portableScriptsPlugin(): Plugin {
  return {
    name: 'gezel-portable-scripts',
    resolveId(id) {
      return id === scriptsId || id === sdkId || id === typesId ? `\0${id}` : null;
    },
    async load(id) {
      if (id === `\0${typesId}`) {
        const sdkDist = join(
          dirname(runtimeRequire.resolve('@bendyline/gezel-sdk/package.json')),
          'dist',
        );
        const files: { name: string; content: string }[] = [];
        for (const file of (await readdir(sdkDist)).sort()) {
          if (!file.endsWith('.d.ts')) continue;
          const path = join(sdkDist, file);
          this.addWatchFile(path);
          files.push({
            name: `@bendyline/gezel-sdk/${file}`,
            content: await readFile(path, 'utf8'),
          });
        }
        const checks = fileURLToPath(import.meta.resolve('@bendyline/gezel/checks')).replace(
          /\.js$/,
          '.d.ts',
        );
        this.addWatchFile(checks);
        files.push({
          name: '@bendyline/gezel/checks/index.d.ts',
          content: await readFile(checks, 'utf8'),
        });
        const hash = createHash('sha256');
        for (const file of files) hash.update(file.name).update('\0').update(file.content);
        return `export const sdkTypes = ${JSON.stringify({ version: hash.digest('hex'), files })};`;
      }
      if (id === `\0${sdkId}`) {
        const sdkRoot = dirname(runtimeRequire.resolve('@bendyline/gezel-sdk/package.json'));
        const sdk = join(sdkRoot, 'dist/portable.js');
        const checks = join(sdkRoot, 'dist/checks.js');
        this.addWatchFile(sdk);
        this.addWatchFile(checks);
        const [sdkModuleSource, checksModuleSource] = await Promise.all([
          readFile(sdk, 'utf8'),
          readFile(checks, 'utf8'),
        ]);
        return `export const sdkModuleSource = ${JSON.stringify(sdkModuleSource)};\nexport const checksModuleSource = ${JSON.stringify(checksModuleSource)};`;
      }
      if (id !== `\0${scriptsId}`) return null;
      const scripts: Record<string, unknown> = {};
      for (const name of names) {
        const path = fileURLToPath(
          new URL(`../../script-stdlib/scripts/${name}.ts`, import.meta.url),
        );
        this.addWatchFile(path);
        const source = await readFile(path, 'utf8');
        const meta = parseScriptMeta(source, path);
        if (meta.name !== name) throw new Error(`Bundled script metadata differs from ${name}`);
        const result = ts.transpileModule(source, {
          fileName: `${name}.ts`,
          reportDiagnostics: true,
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            isolatedModules: true,
            sourceMap: false,
          },
        });
        const error = result.diagnostics?.find(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        );
        if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
        scripts[name] = {
          source: result.outputText,
          originalSource: source,
          hash: createHash('sha256').update(source).digest('hex'),
          meta,
          scope: 'standard',
        };
      }
      return `export const scripts = ${JSON.stringify(scripts)};`;
    },
  };
}
