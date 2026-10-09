import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { isGitInstalled, runGit } from '../git/git.js';
import { ContentIndex } from './content-index.js';
import type { EnrichDeps } from './enrich.js';

// The promise the product makes when a person adds a folder: gezel reads and
// indexes it, and changes nothing in it. Every pass that touches a project's
// workspace runs here against an external, read-only folder, and the folder
// must come out byte-for-byte and stat-for-stat the same.

const PNG_800x600 = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]),
  Buffer.alloc(8),
]);

let ws: string;
let home: string;
let ci: ContentIndex;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-readonly-ws-'));
  home = await mkdtemp(join(tmpdir(), 'gezel-readonly-home-'));
  ci = new ContentIndex(
    {
      projectIndexingEnabled: async () => true,
      projectWorkspaceDir: async () => ws,
      projectArtifactsDir: () => join(home, 'artifacts'),
      // An added folder: external workingDir, no write policy → read-only.
      getProject: async () => ({ id: 'p1', name: 'Folder', workingDir: ws }),
    } as unknown as Store,
    home,
  );
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/** Every entry under `root` (`.git` included) with its kind, size, mtime and content hash. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    const st = await lstat(dir);
    out.set(`${relative(root, dir) || '.'}/`, `dir ${st.mtimeMs}`);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const fst = await lstat(abs);
      const hash = createHash('sha256')
        .update(await readFile(abs))
        .digest('hex');
      out.set(relative(root, abs), `${fst.size} ${fst.mtimeMs} ${hash}`);
    }
  };
  await walk(root);
  return out;
}

async function git(args: string[]): Promise<void> {
  await runGit(args, { cwd: ws });
}

describe('the read-only promise', () => {
  it('indexes, enriches, maps and reads git state without changing anything in the folder', async () => {
    await mkdir(join(ws, 'src'), { recursive: true });
    await mkdir(join(ws, 'photos'), { recursive: true });
    await writeFile(join(ws, 'README.md'), '# Allotment\n\nPlot notes and the watering rota.\n');
    await writeFile(join(ws, 'notes.txt'), 'Tomatoes went in on the 3rd.\n');
    await writeFile(
      join(ws, 'src', 'rota.ts'),
      'export function nextWaterer(names: string[], day: number): string {\n  return names[day % names.length] ?? "";\n}\n',
    );
    await writeFile(join(ws, 'photos', 'beans.png'), PNG_800x600);
    const hasGit = await isGitInstalled();
    if (hasGit) {
      await git(['init', '-q']);
      await git(['add', '-A']);
      await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']);
      // A stat change with identical content: `git status` re-hashes the file
      // and, given the lock, rewrites `.git/index` to record the new stat.
      const later = new Date(Date.now() + 60_000);
      await utimes(join(ws, 'notes.txt'), later, later);
    }

    const before = await snapshot(ws);

    await ci.refresh('p1');
    const deps: EnrichDeps = {
      summarize: async () => 'Keeps the allotment watering rota.',
      embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
      model: 'test',
    };
    await ci.enrich('p1', deps, 20);
    await ci.aiShadows('p1', { describeImage: async () => ({ body: 'A row of beans.' }) }, 10);
    await ci.fileMap('p1');
    await ci.refresh('p1');
    if (hasGit) await git(['status', '--porcelain']);

    expect(await snapshot(ws)).toEqual(before);
    expect(await ci.hasIndex('p1')).toBe(true);
  });
});
