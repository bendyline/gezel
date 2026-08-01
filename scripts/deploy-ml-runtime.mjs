import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Merge the deployment-only Transformers/Kokoro graph into a full runtime
 * bundle. Public npm packages intentionally expose these as optional peers;
 * desktop and relocatable-node artifacts remain full-featured.
 */
export async function deployMlRuntime(repoRoot, target, label) {
  const staging = await mkdtemp(join(tmpdir(), 'gezel-ml-runtime-'));
  const workspaceStatePath = join(repoRoot, 'node_modules', '.pnpm-workspace-state-v1.json');
  const workspaceStateBefore = existsSync(workspaceStatePath)
    ? await readFile(workspaceStatePath)
    : null;

  try {
    const args = [
      '--filter',
      '@bendyline/internal-ml-runtime',
      'deploy',
      '--prod',
      '--legacy',
      '--node-linker=hoisted',
      '--config.allow-unused-patches=true',
      staging,
    ];
    console.log(`[${label}] pnpm ${args.join(' ')}`);
    const { stdout, stderr } = await exec('pnpm', args, {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    if (stdout.trim()) process.stdout.write(stdout);
    if (stderr.trim()) process.stderr.write(stderr);

    const sourceModules = join(staging, 'node_modules');
    const targetModules = join(target, 'node_modules');
    for (const entry of await readdir(sourceModules)) {
      await cp(join(sourceModules, entry), join(targetModules, entry), {
        recursive: true,
        force: true,
      });
    }

    for (const relative of [
      ['@huggingface', 'transformers', 'package.json'],
      ['kokoro-js', 'package.json'],
      ['onnxruntime-node', 'package.json'],
    ]) {
      const expected = join(targetModules, ...relative);
      if (!existsSync(expected)) {
        throw new Error(`[${label}] ML runtime merge missed ${expected}`);
      }
    }
  } finally {
    if (workspaceStateBefore) {
      await writeFile(workspaceStatePath, workspaceStateBefore);
    } else if (existsSync(workspaceStatePath)) {
      await unlink(workspaceStatePath);
    }
    await rm(staging, { recursive: true, force: true });
  }
}
