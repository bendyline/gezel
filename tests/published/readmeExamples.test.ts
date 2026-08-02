import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './_packages';

const README_PACKAGES = ['app-sdk', 'catalog', 'client', 'core', 'sdk', 'service'] as const;
const cacheRoot = resolve(REPO_ROOT, 'node_modules', '.cache');
mkdirSync(cacheRoot, { recursive: true });
const temporary = mkdtempSync(join(cacheRoot, 'readme-examples-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function firstTypeScriptBlock(readme: string): string {
  const match = /```ts\s*\n([\s\S]*?)\n```/.exec(readme);
  if (!match?.[1]) throw new Error('README has no TypeScript code block');
  return match[1];
}

function diagnosticsFor(file: string): readonly ts.Diagnostic[] {
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    types: ['node'],
    baseUrl: REPO_ROOT,
    ignoreDeprecations: '6.0',
    paths: {
      '@bendyline/gezel-app-sdk': ['packages/app-sdk/dist/index.d.ts'],
      '@bendyline/gezel-catalog': ['packages/catalog/dist/index.d.ts'],
      '@bendyline/gezel-client': ['packages/client/dist/index.d.ts'],
      '@bendyline/gezel': ['packages/core/dist/index.d.ts'],
      '@bendyline/gezel/paths': ['packages/core/dist/paths.d.ts'],
      '@bendyline/gezel/schemas': ['packages/core/dist/schemas/index.d.ts'],
      '@bendyline/gezel-sdk': ['packages/sdk/dist/index.d.ts'],
      '@bendyline/gezel-service': ['packages/service/dist/index.d.ts'],
    },
  });
  return ts.getPreEmitDiagnostics(program);
}

describe('published README examples', () => {
  it.each(README_PACKAGES)('%s primary TypeScript example typechecks', (dir) => {
    const readmePath = resolve(REPO_ROOT, 'packages', dir, 'README.md');
    const examplePath = join(temporary, `${dir}.mts`);
    writeFileSync(examplePath, `${firstTypeScriptBlock(readFileSync(readmePath, 'utf8'))}\n`);

    const diagnostics = diagnosticsFor(examplePath);
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => REPO_ROOT,
      getNewLine: () => '\n',
    });
    if (diagnostics.length > 0) throw new Error(formatted);
    expect(diagnostics).toHaveLength(0);
  });
});
