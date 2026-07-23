import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBinCommands } from './indexer.js';
import { normalizeOclifManifest, resolveBinPackageDir } from './oclif.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-oclif-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build a synthetic node_modules/<pkg> with a bin symlink + oclif manifest. */
async function installFakeCli(
  workspaceDir: string,
  pkgName: string,
  manifest: unknown,
  packageVersion = '1.0.0',
): Promise<void> {
  const pkgDir = join(workspaceDir, 'node_modules', pkgName);
  await mkdir(join(pkgDir, 'bin'), { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkgName, version: packageVersion, bin: { [pkgName]: 'bin/run.js' } }),
  );
  await writeFile(join(pkgDir, 'bin', 'run.js'), '#!/usr/bin/env node\n');
  await writeFile(join(pkgDir, 'oclif.manifest.json'), JSON.stringify(manifest));
  // Symlink from .bin into the package's run script.
  const binDir = join(workspaceDir, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  await symlink(join('..', pkgName, 'bin', 'run.js'), join(binDir, pkgName));
}

describe('normalizeOclifManifest (pure)', () => {
  it('handles a minimal manifest with one no-flag command', () => {
    const out = normalizeOclifManifest(
      'mini',
      {
        version: '1.0.0',
        commands: {
          hello: { summary: 'Print hello.' },
        },
      },
      { name: 'mini-cli', version: '1.0.0' },
    );
    expect(out.promotedRows.map((r) => r.name)).toEqual(['mini hello']);
    expect(out.shapes['mini hello']).toBeDefined();
    expect(out.shapes['mini hello']!.summary).toBe('Print hello.');
    expect(out.shapes['mini hello']!.flags).toBeUndefined();
  });

  it('flattens flags + args + examples', () => {
    const out = normalizeOclifManifest(
      'flat',
      {
        version: '1.0.0',
        commands: {
          build: {
            summary: 'Build the project',
            description: 'Build the project.\n\nDoes a thing.',
            flags: {
              watch: { name: 'watch', type: 'boolean', char: 'w', description: 'Watch mode' },
              format: {
                name: 'format',
                type: 'option',
                options: ['esm', 'cjs'],
                default: 'esm',
                required: true,
              },
            },
            args: { entry: { name: 'entry', required: true, description: 'Entry file' } },
            examples: ['flat build', { command: 'flat build --watch' }],
            usage: 'flat build [FLAGS] ENTRY',
          },
        },
      },
      { name: 'flat-cli', version: '2.3.4' },
    );
    expect(out.promotedRows.map((r) => r.name)).toEqual(['flat build']);
    const shape = out.shapes['flat build']!;
    expect(shape.packageVersion).toBe('2.3.4');
    expect(shape.flags?.map((f) => f.name).sort()).toEqual(['format', 'watch']);
    const format = shape.flags?.find((f) => f.name === 'format')!;
    expect(format.type).toBe('option');
    expect(format.required).toBe(true);
    expect(format.default).toBe('esm');
    expect(format.options).toEqual(['esm', 'cjs']);
    const watch = shape.flags?.find((f) => f.name === 'watch')!;
    expect(watch.type).toBe('boolean');
    expect(watch.char).toBe('w');
    expect(shape.args).toEqual([{ name: 'entry', required: true, description: 'Entry file' }]);
    expect(shape.examples).toEqual(['flat build', 'flat build --watch']);
    expect(shape.usage).toBe('flat build [FLAGS] ENTRY');
  });

  it('promotes only first-level subcommands and stashes deeper ones', () => {
    const out = normalizeOclifManifest(
      'gh',
      {
        version: '1.0.0',
        topicSeparator: ' ',
        commands: {
          'pr create': { summary: 'Open a PR' },
          'pr list': { summary: 'List PRs' },
          'pr review approve': { summary: 'Approve a PR' },
          'issue close': { summary: 'Close an issue' },
        },
      },
      { name: 'gh-cli', version: '1.0.0' },
    );
    // Only `gh pr` and `gh issue` are promoted; `gh pr create`, etc., stay
    // accessible through the shape map but not as rows.
    expect(out.promotedRows.map((r) => r.name).sort()).toEqual(['gh issue', 'gh pr']);
    const pr = out.shapes['gh pr']!;
    expect(pr.subcommands?.map((s) => s.fullName).sort()).toEqual([
      'gh pr create',
      'gh pr list',
      'gh pr review',
    ]);
    // The deeper ones are in the shapes map keyed by their full names.
    expect(out.shapes['gh pr create']).toBeDefined();
    expect(out.shapes['gh pr review approve']).toBeDefined();
  });

  it('falls back to colon separator when topicSeparator absent', () => {
    const out = normalizeOclifManifest(
      'colon',
      {
        version: '1.0.0',
        commands: {
          'pr:create': { summary: 'Open a PR' },
          'pr:list': { summary: 'List PRs' },
        },
      },
      { name: 'colon-cli', version: '1.0.0' },
    );
    expect(out.promotedRows.map((r) => r.name).sort()).toEqual(['colon pr']);
    expect(out.shapes['colon pr create']).toBeDefined();
  });

  it('drops all promotions when over the cap, but keeps the full shape map', () => {
    const commands: Record<string, { summary?: string }> = {};
    for (let i = 0; i < 250; i++) commands[`cmd${i}`] = { summary: `cmd ${i}` };
    const out = normalizeOclifManifest(
      'huge',
      { version: '1.0.0', commands },
      { name: 'huge-cli', version: '1.0.0' },
    );
    expect(out.promotedRows).toEqual([]);
    // Shape map still complete so future UX can mine it.
    expect(Object.keys(out.shapes).length).toBeGreaterThan(200);
  });
});

describe('resolveBinPackageDir (POSIX symlink)', () => {
  // The whole pipeline relies on `readlink` so we skip on Windows
  // CI where symlinks need admin. This still covers the macOS dev path.
  const isPosix = process.platform !== 'win32';

  it.runIf(isPosix)('follows .bin symlink to the package root', async () => {
    await installFakeCli(root, 'foo-cli', {
      version: '1.0.0',
      commands: { hello: { summary: 'hi' } },
    });
    const resolved = await resolveBinPackageDir(root, 'foo-cli');
    expect(resolved).toBe(join(root, 'node_modules', 'foo-cli'));
  });

  it.runIf(isPosix)('falls back to node_modules/<binName> when bin not present', async () => {
    const pkgDir = join(root, 'node_modules', 'no-bin-cli');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'no-bin-cli' }));
    const resolved = await resolveBinPackageDir(root, 'no-bin-cli');
    expect(resolved).toBe(pkgDir);
  });

  it('returns null when nothing matches', async () => {
    const resolved = await resolveBinPackageDir(root, 'never-installed');
    expect(resolved).toBeNull();
  });
});

describe('discoverBinCommands (end-to-end with oclif fixture)', () => {
  const isPosix = process.platform !== 'win32';

  it.runIf(isPosix)('emits parent + promoted subcommand rows + shapes', async () => {
    await installFakeCli(root, 'demo-cli', {
      version: '1.0.0',
      topicSeparator: ' ',
      commands: {
        build: { summary: 'Build it' },
        watch: { summary: 'Watch it' },
      },
    });
    const { commands, shapes } = await discoverBinCommands(root);
    const names = commands.map((c) => c.name).sort();
    expect(names).toEqual(['demo-cli', 'demo-cli build', 'demo-cli watch']);
    // Parent inherits a stock description since we didn't add a root cmd.
    const parent = commands.find((c) => c.name === 'demo-cli')!;
    expect(parent.run).toBe('npx demo-cli');
    // Promoted child has the manifest summary as its description.
    const child = commands.find((c) => c.name === 'demo-cli build')!;
    expect(child.run).toBe('demo-cli build');
    expect(child.description).toBe('Build it');
    // Shape map keys match the rendered names.
    expect(Object.keys(shapes).sort()).toContain('demo-cli build');
    expect(Object.keys(shapes).sort()).toContain('demo-cli watch');
  });

  it.runIf(isPosix)('silently degrades when manifest is malformed', async () => {
    const pkgDir = join(root, 'node_modules', 'broken-cli');
    await mkdir(join(pkgDir, 'bin'), { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'broken-cli', version: '0.0.0' }),
    );
    await writeFile(join(pkgDir, 'bin', 'run.js'), '#!/usr/bin/env node\n');
    await writeFile(join(pkgDir, 'oclif.manifest.json'), 'not valid json');
    const binDir = join(root, 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    await symlink(join('..', 'broken-cli', 'bin', 'run.js'), join(binDir, 'broken-cli'));
    const { commands, shapes } = await discoverBinCommands(root);
    expect(commands.map((c) => c.name)).toEqual(['broken-cli']);
    expect(shapes).toEqual({});
  });
});
