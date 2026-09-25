/**
 * The desktop's side of the prompt-draft port: one project's prompts folder
 * on disk, with atomic writes and a removal that tolerates an editor on
 * Windows still holding a just-written file.
 */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PromptDraftFiles } from '@bendyline/gezel/runtime';
import { writeFileAtomic } from '../fs/atomic.js';

export function nodePromptDraftFiles(rootDir: string): PromptDraftFiles {
  const abs = (path: string) => (path ? join(rootDir, ...path.split('/')) : rootDir);
  const walk = async (
    dir: string,
    out: Array<{ path: string; isDirectory: boolean }>,
  ): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(abs(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      const isDirectory = entry.isDirectory();
      out.push({ path, isDirectory });
      if (isDirectory) await walk(path, out);
    }
  };
  return {
    list: async (dir) => {
      try {
        return (await readdir(abs(dir), { withFileTypes: true })).map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
      } catch {
        return [];
      }
    },
    readText: async (path) => {
      try {
        return await readFile(abs(path), 'utf8');
      } catch {
        return null;
      }
    },
    readBytes: async (path) => {
      try {
        return new Uint8Array(await readFile(abs(path)));
      } catch {
        return null;
      }
    },
    tree: async (dir) => {
      const out: Array<{ path: string; isDirectory: boolean }> = [];
      await walk(dir, out);
      return out;
    },
    apply: async (change) => {
      for (const dir of change.mkdirs ?? []) await mkdir(abs(dir), { recursive: true });
      for (const [path, value] of change.writes ?? []) {
        await mkdir(dirname(abs(path)), { recursive: true });
        await writeFileAtomic(abs(path), value);
      }
      for (const path of change.removes ?? [])
        await rm(abs(path), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}
