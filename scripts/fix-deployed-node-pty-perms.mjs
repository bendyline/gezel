import { chmod, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Restore execute permission on every macOS node-pty spawn-helper in a deployment tree. */
export async function fixDeployedNodePtyPermissions(root) {
  if (process.platform !== 'darwin') return 0;
  let fixed = 0;

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'spawn-helper' || !path.includes('/node-pty/')) {
        continue;
      }
      const current = (await stat(path)).mode;
      const wanted = current | 0o111;
      if (current === wanted) continue;
      await chmod(path, wanted);
      fixed += 1;
    }
  }

  await walk(join(root, 'node_modules'));
  if (fixed > 0) {
    console.log(`[node-pty] restored execute permission on ${fixed} deployed spawn-helper(s)`);
  }
  return fixed;
}
