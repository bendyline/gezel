import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * True when two paths are the very same inode. Both trees are materialized by
 * pnpm out of one content-addressable store, so a dependency that lands in the
 * staging deploy AND in the bundle is one hardlinked file with two names on
 * any filesystem pnpm hardlinks into (Linux ext4). macOS clones instead, which
 * is why this only ever fired on CI.
 *
 * Windows reports `ino` as 0 for every entry, so treat 0 as "unknown" rather
 * than letting it collapse every comparison to true.
 */
async function isSameInode(src, dest) {
  try {
    const [a, b] = await Promise.all([lstat(src), lstat(dest)]);
    return a.ino !== 0 && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/**
 * Merge every top-level entry of `sourceModules` into `targetModules`.
 *
 * `fs.cp` rejects a same-inode pair with EINVAL ("src and dest cannot be the
 * same"), which is exactly what the shared pnpm store produces for deps both
 * deploys resolve. Those files are byte-identical by construction, so skipping
 * them is the copy. Filtering per entry (rather than clearing the destination)
 * keeps the already-deployed service tree intact — scope directories like
 * `@types/` hold packages from both graphs.
 */
export async function mergeNodeModules(sourceModules, targetModules) {
  for (const entry of await readdir(sourceModules)) {
    await cp(join(sourceModules, entry), join(targetModules, entry), {
      recursive: true,
      force: true,
      filter: async (src, dest) => !(await isSameInode(src, dest)),
    });
  }
}

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

    const targetModules = join(target, 'node_modules');
    await mergeNodeModules(join(staging, 'node_modules'), targetModules);

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
