import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './_packages';

const README_PACKAGES = [
  'app-sdk',
  'catalog',
  'client',
  'core',
  'gezk',
  'knowledge',
  'script-runtime',
  'sdk',
  'service',
] as const;

/**
 * READMEs whose every TypeScript block must typecheck on its own. Each of
 * these once shipped an example that failed for the first person to copy it
 * (2026-11-11 npm audit): gezk's used three names it never defined, and
 * script-runtime's script had no `meta` block.
 */
const SELF_CONTAINED_README_PACKAGES = ['gezk', 'knowledge', 'script-runtime', 'sdk'] as const;

/** READMEs whose Gezel scripts are run, not only typechecked. */
const SCRIPT_README_PACKAGES = ['sdk', 'script-runtime'] as const;

const cacheRoot = resolve(REPO_ROOT, 'node_modules', '.cache');
mkdirSync(cacheRoot, { recursive: true });
const temporary = mkdtempSync(join(cacheRoot, 'readme-examples-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function readme(dir: string): string {
  return readFileSync(resolve(REPO_ROOT, 'packages', dir, 'README.md'), 'utf8');
}

function typeScriptBlocks(text: string): string[] {
  return [...text.matchAll(/```ts\s*\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? '');
}

function firstTypeScriptBlock(text: string): string {
  const block = typeScriptBlocks(text)[0];
  if (!block) throw new Error('README has no TypeScript code block');
  return block;
}

/** The block that shows a feature, wherever it sits in the README. */
function typeScriptBlockContaining(text: string, needle: string): string {
  const block = typeScriptBlocks(text).find((candidate) => candidate.includes(needle));
  if (!block) throw new Error(`README has no TypeScript block containing "${needle}"`);
  return block;
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
      '@bendyline/gezel-app-sdk/host': ['packages/app-sdk/dist/host.d.ts'],
      '@bendyline/gezel-catalog': ['packages/catalog/dist/index.d.ts'],
      '@bendyline/gezel-client': ['packages/client/dist/index.d.ts'],
      '@bendyline/gezel-client/node': ['packages/client/dist/node.d.ts'],
      '@bendyline/gezel': ['packages/core/dist/index.d.ts'],
      '@bendyline/gezel/paths': ['packages/core/dist/paths.d.ts'],
      '@bendyline/gezel/schemas': ['packages/core/dist/schemas/index.d.ts'],
      '@bendyline/gezel-knowledge': ['packages/knowledge/dist/index.d.ts'],
      '@bendyline/gezel-script-runtime': ['packages/script-runtime/dist/index.d.ts'],
      '@bendyline/gezel-sdk': ['packages/sdk/dist/index.d.ts'],
      '@bendyline/gezel-sdk/portable': ['packages/sdk/dist/portable.d.ts'],
      '@bendyline/gezel-service': ['packages/service/dist/index.d.ts'],
      '@bendyline/gezk': ['packages/gezk/dist/index.d.ts'],
      '@bendyline/gezk/node': ['packages/gezk/dist/node.d.ts'],
    },
  });
  return ts.getPreEmitDiagnostics(program);
}

function expectTypechecks(name: string, block: string): void {
  const examplePath = join(temporary, `${name}.mts`);
  writeFileSync(examplePath, `${block}\n`);
  const diagnostics = diagnosticsFor(examplePath);
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => REPO_ROOT,
        getNewLine: () => '\n',
      }),
    );
  }
  expect(diagnostics).toHaveLength(0);
}

/**
 * Make a bare package name resolvable from `root` without links: a stub
 * package whose entry points re-export the built `dist/` files. Links are
 * avoided because a recursive delete that follows a Windows junction would
 * reach the workspace.
 */
function stubPackage(
  root: string,
  name: string,
  dir: string,
  entries: Record<string, string>,
): void {
  const packageDir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(packageDir, { recursive: true });
  const exportsMap: Record<string, string> = {};
  for (const [subpath, distFile] of Object.entries(entries)) {
    const stub = `${subpath === '.' ? 'index' : subpath.slice(2)}.mjs`;
    const target = pathToFileURL(resolve(REPO_ROOT, 'packages', dir, distFile)).href;
    writeFileSync(join(packageDir, stub), `export * from ${JSON.stringify(target)};\n`);
    exportsMap[subpath] = `./${stub}`;
  }
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name, type: 'module', exports: exportsMap }),
  );
}

/** A schema-valid catalog manifest, as a reader finds it in an extracted archive. */
function fixtureManifest(): Record<string, unknown> {
  return {
    kind: 'gezk-catalog',
    formatVersion: '0.5',
    indexSchemaVersion: 2,
    id: 'readme-example',
    version: '1.0.0',
    name: 'README Example',
    language: 'en',
    publisher: { id: 'gezel-tests', name: 'Gezel Tests' },
    createdAt: '2026-01-01T00:00:00.000Z',
    license: { name: 'MIT', noticePath: 'LICENSES/catalog.txt', attributionRequired: false },
    embedding: {
      id: 'test-hash-embed@1',
      model: { repo: 'test/hash', revision: 'fixture' },
      tokenizer: { kind: 'whitespace' },
      pooling: 'mean',
      normalized: true,
      dimensions: 384,
      maxTokens: 512,
      queryInstruction: '',
      passageInstruction: '',
      vectorEncoding: 'bit+int8',
      distance: { stage1: 'hamming', stage2: 'cosine' },
      quantization: {
        int8: { method: 'symmetric-linear', scale: 127 },
        binary: { method: 'sign', threshold: 0, packing: 'lsb-first' },
      },
    },
    chunking: {
      id: 'markdown-chunks@2',
      unit: 'tokens',
      tokenizer: 'profile',
      target: 420,
      overlap: 64,
      contextHeader: { max: 64 },
    },
    topics: [{ id: 'root', name: 'Root' }],
    router: { shardTargetChunks: 200_000, shards: [], totalCentroids: 0 },
    counts: { documents: 1, chunks: 1, shards: 1 },
    files: [
      { path: 'index/router.db', sizeBytes: 1, sha256: 'a'.repeat(64) },
      { path: 'LICENSES/catalog.txt', sizeBytes: 1, sha256: 'b'.repeat(64) },
    ],
    requires: { formatVersion: '0.5', features: [] },
  };
}

function runModule(dir: string, block: string): ReturnType<typeof spawnSync> {
  const { outputText } = ts.transpileModule(block, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  writeFileSync(join(dir, 'example.mjs'), outputText);
  return spawnSync(process.execPath, ['example.mjs'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('published README examples', () => {
  it.each(README_PACKAGES)('%s primary TypeScript example typechecks', (dir) => {
    expectTypechecks(dir, firstTypeScriptBlock(readme(dir)));
  });

  it('app-sdk hosting example typechecks', () => {
    // The hosting quickstart is the first thing an embedding app copies, and
    // it exercises a different entry point than the connect quickstart above.
    expectTypechecks('app-sdk-host', typeScriptBlockContaining(readme('app-sdk'), 'connectOrHost'));
  });

  it.each(SELF_CONTAINED_README_PACKAGES)('%s: every TypeScript example typechecks', (dir) => {
    const blocks = typeScriptBlocks(readme(dir));
    expect(blocks.length).toBeGreaterThan(0);
    blocks.forEach((block, index) => expectTypechecks(`${dir}-block-${index}`, block));
  });

  it('gezk example verifies a signed manifest and rejects a tampered one', async () => {
    const block = typeScriptBlockContaining(readme('gezk'), 'verifyManifestSignature');
    const gezk = (await import(
      pathToFileURL(resolve(REPO_ROOT, 'packages/gezk/dist/node.js')).href
    )) as typeof import('../../packages/gezk/dist/node.js');
    const keys = gezk.generateKnowledgeSigningKeyPair();
    const signed = gezk.signManifest(
      gezk.KnowledgeCatalogManifestSchema.parse(fixtureManifest()),
      keys.privateKeyPem,
    );

    const dir = mkdtempSync(join(temporary, 'gezk-run-'));
    stubPackage(dir, '@bendyline/gezk', 'gezk', { '.': 'dist/index.js', './node': 'dist/node.js' });
    mkdirSync(join(dir, 'extracted'));
    writeFileSync(
      join(dir, 'trust-anchors.json'),
      JSON.stringify([{ keyId: keys.keyId, publicKeyPem: keys.publicKeyPem }]),
    );

    writeFileSync(join(dir, 'extracted', 'manifest.json'), JSON.stringify(signed));
    const trusted = runModule(dir, block);
    expect(trusted.stderr).toBe('');
    expect(trusted.status).toBe(0);

    writeFileSync(
      join(dir, 'extracted', 'manifest.json'),
      JSON.stringify({ ...signed, name: 'Renamed after signing' }),
    );
    const tampered = runModule(dir, block);
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('untrusted catalog: bad-signature');
  });

  it('README scripts are valid Gezel scripts that run', () => {
    // A README block is a Gezel script when it stamps output through the SDK.
    const scripts = SCRIPT_README_PACKAGES.flatMap((dir) =>
      typeScriptBlocks(readme(dir))
        .filter(
          (block) =>
            block.includes("from '@bendyline/gezel-sdk'") && block.includes('gezel.output('),
        )
        .map((source, index) => ({ label: `${dir}-script-${index}`, source })),
    );
    expect(scripts.map((script) => script.label)).toEqual([
      'sdk-script-0',
      'script-runtime-script-0',
    ]);

    const dir = mkdtempSync(join(temporary, 'scripts-run-'));
    const scriptsFile = join(dir, 'scripts.json');
    writeFileSync(scriptsFile, JSON.stringify(scripts));
    const harness = spawnSync(
      process.execPath,
      [
        resolve(REPO_ROOT, 'tests/published/readme-script-harness.mjs'),
        REPO_ROOT,
        join(dir, 'home'),
        scriptsFile,
      ],
      { cwd: dir, encoding: 'utf8', timeout: 110_000 },
    );
    if (harness.status !== 0) throw new Error(`harness failed:\n${harness.stderr}`);
    const lastLine = harness.stdout.trim().split('\n').at(-1) ?? '[]';
    const results = JSON.parse(lastLine) as Array<{
      label: string;
      errors: string[];
      run: { status: string; output: unknown; error: unknown } | null;
    }>;

    for (const result of results) {
      expect(result.errors, `${result.label} diagnostics`).toEqual([]);
      expect(result.run, `${result.label} run`).toMatchObject({ status: 'ok' });
    }
    expect(results.find((r) => r.label === 'sdk-script-0')?.run?.output).toEqual({
      decision: 'reject',
    });
    expect(results.find((r) => r.label === 'script-runtime-script-0')?.run?.output).toEqual({
      count: expect.any(Number),
    });
  });
});
