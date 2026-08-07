import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGitInstalled, runGit } from '../git/git.js';
import {
  buildTokenIndex,
  discoverBinCommands,
  discoverFiles,
  discoverNpmScripts,
  discoverVscodeLaunchConfigs,
  discoverWorkspaceScripts,
} from './indexer.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-indexer-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverNpmScripts', () => {
  it('returns each script as a runnable command', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo',
        scripts: { test: 'vitest run', build: 'tsup' },
      }),
    );
    const out = await discoverNpmScripts(root);
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual(['build', 'test']);
    const test = out.find((c) => c.name === 'test')!;
    expect(test.kind).toBe('npm-script');
    expect(test.run).toBe('npm run test');
    expect(test.description).toBe('vitest run');
  });

  it('uses the packageManager declaration for pnpm projects', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo',
        packageManager: 'pnpm@11.15.1+sha512.deadbeef',
        scripts: { build: 'tsup' },
      }),
    );
    // A stale npm lockfile must not override the explicit declaration.
    await writeFile(join(root, 'package-lock.json'), '{}');

    const out = await discoverNpmScripts(root);
    expect(out.find((c) => c.name === 'build')?.run).toBe('pnpm run build');
  });

  it('prefers pnpm when its workspace infrastructure predominates', async () => {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }),
    );
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    // Repositories sometimes retain a stale package-lock during migration.
    await writeFile(join(root, 'package-lock.json'), '{}');

    const out = await discoverNpmScripts(root);
    expect(out.find((c) => c.name === 'test')?.run).toBe('pnpm run test');
  });

  it('inherits package-manager infrastructure from a monorepo parent', async () => {
    const packageDir = join(root, 'packages', 'ui');
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: 'ui', scripts: { build: 'vite build' } }),
    );
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');

    const out = await discoverNpmScripts(packageDir);
    expect(out.find((c) => c.name === 'build')?.run).toBe('pnpm run build');
  });

  it('returns empty when no scripts block', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'empty' }));
    expect(await discoverNpmScripts(root)).toEqual([]);
  });

  it('returns empty when package.json is missing or unparseable', async () => {
    expect(await discoverNpmScripts(root)).toEqual([]);
    await writeFile(join(root, 'package.json'), 'this is not json');
    expect(await discoverNpmScripts(root)).toEqual([]);
  });
});

describe('discoverWorkspaceScripts', () => {
  it('lists files in scripts/ with runnable extensions', async () => {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await writeFile(join(root, 'scripts', 'deploy.sh'), '#!/bin/sh\necho hi');
    await writeFile(join(root, 'scripts', 'build.ts'), 'console.log("hi")');
    await writeFile(join(root, 'scripts', 'README.md'), 'do not list me');
    const out = await discoverWorkspaceScripts(root);
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual(['build.ts', 'deploy.sh']);
    expect(out.every((c) => c.kind === 'workspace-script')).toBe(true);
    expect(out.find((c) => c.name === 'deploy.sh')!.run).toBe('./scripts/deploy.sh');
  });

  it('picks up extensionless files that have a shebang', async () => {
    await mkdir(join(root, 'scripts'), { recursive: true });
    const p = join(root, 'scripts', 'release');
    await writeFile(p, '#!/usr/bin/env bash\necho release');
    await chmod(p, 0o755);
    const out = await discoverWorkspaceScripts(root);
    expect(out.map((c) => c.name)).toEqual(['release']);
  });

  it('returns empty when scripts/ is missing', async () => {
    expect(await discoverWorkspaceScripts(root)).toEqual([]);
  });
});

describe('discoverVscodeLaunchConfigs', () => {
  it('parses launch.json with JSONC comments', async () => {
    await mkdir(join(root, '.vscode'), { recursive: true });
    const raw = `// VSCode launch configurations
{
  "version": "0.2.0",
  "configurations": [
    /* Run the Electron main process. */
    { "name": "Electron Main", "type": "node", "program": "\${workspaceFolder}/main.js" },
    { "name": "Renderer", "type": "chrome", "url": "http://localhost:3000" }
  ]
}`;
    await writeFile(join(root, '.vscode', 'launch.json'), raw);
    const out = await discoverVscodeLaunchConfigs(root);
    expect(out.map((c) => c.name).sort()).toEqual(['Electron Main', 'Renderer']);
    expect(out.every((c) => c.kind === 'vscode-launch')).toBe(true);
  });

  it('returns empty when launch.json is malformed', async () => {
    await mkdir(join(root, '.vscode'), { recursive: true });
    await writeFile(join(root, '.vscode', 'launch.json'), 'not json at all');
    expect(await discoverVscodeLaunchConfigs(root)).toEqual([]);
  });

  it('returns empty when launch.json is missing', async () => {
    expect(await discoverVscodeLaunchConfigs(root)).toEqual([]);
  });
});

describe('discoverBinCommands', () => {
  it('enumerates node_modules/.bin and strips Windows suffixes', async () => {
    const binDir = join(root, 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, 'tsx'), '');
    await writeFile(join(binDir, 'tsx.cmd'), '');
    await writeFile(join(binDir, 'vitest'), '');
    const { commands, shapes } = await discoverBinCommands(root);
    const names = commands.map((c) => c.name).sort();
    // tsx and tsx.cmd dedupe to a single 'tsx' entry
    expect(names).toEqual(['tsx', 'vitest']);
    expect(commands.every((c) => c.run.startsWith('npx '))).toBe(true);
    // No oclif manifests in this fixture → no shape entries.
    expect(shapes).toEqual({});
  });

  it('returns empty when .bin missing', async () => {
    const out = await discoverBinCommands(root);
    expect(out.commands).toEqual([]);
    expect(out.shapes).toEqual({});
  });
});

describe('discoverFiles', () => {
  it('walks the tree and skips ignore-listed dirs', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'foo'), { recursive: true });
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'README.md'), 'r');
    await writeFile(join(root, 'src', 'index.ts'), 'x');
    await writeFile(join(root, 'src', 'util.ts'), 'y');
    await writeFile(join(root, 'node_modules', 'foo', 'package.json'), '{}');
    await writeFile(join(root, '.git', 'HEAD'), 'ref');
    await writeFile(join(root, 'dist', 'bundle.js'), 'z');

    const files = await discoverFiles(root);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain('README.md');
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('src/util.ts');
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(false);
  });

  it('uses Git ignore rules to prune generated trees before walking them', async () => {
    if (!(await isGitInstalled())) return;
    await runGit(['init', '-q'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'generated', 'nested'), { recursive: true });
    await writeFile(join(root, '.gitignore'), 'generated/\n');
    await writeFile(join(root, 'src', 'visible.ts'), 'export const visible = true;\n');
    await writeFile(join(root, 'generated', 'nested', 'large.js'), 'ignored');

    const paths = (await discoverFiles(root)).map((file) => file.path);
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('src/visible.ts');
    expect(paths.some((path) => path.startsWith('generated/'))).toBe(false);
  });
});

describe('buildTokenIndex', () => {
  it('tokenizes filenames into the inverted map', () => {
    const idx = buildTokenIndex([
      { path: 'src/components/HomeView.tsx', size: 0, mtimeMs: 0 },
      { path: 'packages/service/src/chat/manager.ts', size: 0, mtimeMs: 0 },
    ]);
    expect(idx.tokens.homeview).toEqual([0]);
    expect(idx.tokens.manager).toEqual([1]);
    // 'src' appears in both
    expect(idx.tokens.src?.sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('drops single-character tokens', () => {
    const idx = buildTokenIndex([{ path: 'a/b.ts', size: 0, mtimeMs: 0 }]);
    expect(idx.tokens.a).toBeUndefined();
    expect(idx.tokens.b).toBeUndefined();
    expect(idx.tokens.ts).toEqual([0]);
  });

  it('round-trips through JSON without losing entries', () => {
    const original = buildTokenIndex([
      { path: 'src/a-b.ts', size: 0, mtimeMs: 0 },
      { path: 'lib/a_c.ts', size: 0, mtimeMs: 0 },
    ]);
    const after = JSON.parse(JSON.stringify(original));
    expect(after.tokens).toEqual(original.tokens);
  });
});
