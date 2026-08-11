import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintCommandInputs } from './command-inputs.js';

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'gezel-command-inputs-'));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('fingerprintCommandInputs', () => {
  it('hashes manifests, literal file references, and relative static imports', async () => {
    const manifest = '{"scripts":{"check":"node tools/check.mjs config.json"}}\n';
    const main = "import { value } from './value.js';\nconsole.log(value);\n";
    const dependency = 'export const value = 1;\n';
    const config = '{"enabled":true}\n';
    await mkdir(join(workspace, 'tools'), { recursive: true });
    await writeFile(join(workspace, 'package.json'), manifest);
    await writeFile(join(workspace, 'tools', 'check.mjs'), main);
    await writeFile(join(workspace, 'tools', 'value.js'), dependency);
    await writeFile(join(workspace, 'config.json'), config);

    const files = await fingerprintCommandInputs({
      workspaceDir: workspace,
      body: 'node tools/check.mjs config.json',
      args: [],
      entryFiles: [join(workspace, 'package.json')],
    });

    expect(files).toEqual([
      { path: 'config.json', sha256: sha256(config) },
      { path: 'package.json', sha256: sha256(manifest) },
      { path: 'tools/check.mjs', sha256: sha256(main) },
      { path: 'tools/value.js', sha256: sha256(dependency) },
    ]);
  });

  it('finds a workspace package binary and the target named by its wrapper', async () => {
    const wrapper = '& node "$PSScriptRoot/../fixture-tool/cli.js" $args\n';
    const target = 'console.log("tool");\n';
    await mkdir(join(workspace, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(workspace, 'node_modules', 'fixture-tool'), { recursive: true });
    await writeFile(join(workspace, 'node_modules', '.bin', 'fixture-tool.ps1'), wrapper);
    await writeFile(join(workspace, 'node_modules', 'fixture-tool', 'cli.js'), target);

    const files = await fingerprintCommandInputs({
      workspaceDir: workspace,
      body: 'fixture-tool --version',
      args: [],
    });

    expect(files).toEqual([
      { path: 'node_modules/.bin/fixture-tool.ps1', sha256: sha256(wrapper) },
      { path: 'node_modules/fixture-tool/cli.js', sha256: sha256(target) },
    ]);
  });

  it('does not fingerprint paths outside the project workspace', async () => {
    const outside = join(workspace, '..', `outside-${Date.now()}.mjs`);
    await writeFile(outside, 'console.log("private");\n');
    try {
      const files = await fingerprintCommandInputs({
        workspaceDir: workspace,
        body: `node ../${outside.split(/[\\/]/).at(-1)}`,
        args: [],
      });
      expect(files).toEqual([]);
    } finally {
      await rm(outside, { force: true });
    }
  });
});
