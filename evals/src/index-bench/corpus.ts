import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { defaultCacheRoot } from '../model-cache.ts';
import { repoRoot } from '../native-bin.ts';

/**
 * Benchmark corpus tooling. A corpus is a pinned-SHA subset of a real local
 * git checkout (squisq), materialized once into the eval cache and seeded
 * into trial workspaces over HTTP. The manifest carries the ground truth the
 * bench grades against: golden retrieval queries, expected areas, and the
 * broad-refactor spec — and `validateCorpus` asserts the tree still matches
 * the manifest, so a SHA bump can't silently rot the golden set.
 *
 * `stripComponents: 1` drops the `packages/` prefix at extraction so the
 * workspace gets `core/`, `formats/`, `react/` as top-level dirs — real
 * "areas" for the deep-pass rollup instead of one monolithic `packages`.
 */

const execFileAsync = promisify(execFile);

export const CORPUS_SOURCE_DIR_ENV = 'GEZEL_INDEX_BENCH_SOURCE_DIR';

export type QueryMatchLevel = 'basename' | 'dir+basename';

export interface GoldenQuery {
  query: string;
  expected: string[];
  matchLevel: QueryMatchLevel;
}

export interface CorpusManifest {
  id: string;
  sha: string;
  sourceDir: string;
  archivePaths: string[];
  stripComponents: number;
  goldenQueries: GoldenQuery[];
  expectedAreas: string[];
  refactor: {
    oldName: string;
    newName: string;
    defFile: string;
    refFileCount: number;
    minRenamedFiles: number;
  };
}

export interface CorpusSourceResolutionOptions {
  /** Explicit checkout path. Relative paths resolve from `cwd`. */
  sourceDir?: string;
  /** Injectable locations keep resolution deterministic in tests. */
  repoDir?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  commitExists?: (sourceDir: string, sha: string) => Promise<boolean>;
}

export interface MaterializeCorpusOptions extends CorpusSourceResolutionOptions {
  cacheRoot?: string;
}

export async function loadCorpusManifest(corpusId: string): Promise<CorpusManifest> {
  const url = new URL(`./corpora/${corpusId}.json`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as CorpusManifest;
}

function absoluteCandidate(path: string, baseDir: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(baseDir, path);
}

/**
 * Candidate checkout locations in precedence order. An explicit option or
 * environment override is authoritative; invalid explicit configuration must
 * fail loudly instead of silently selecting a different checkout. Without an
 * override, manifests resolve relative to the gezel repository and then fall
 * back to conventional sibling/home checkout locations.
 */
export function corpusSourceCandidates(
  manifest: CorpusManifest,
  opts: CorpusSourceResolutionOptions = {},
): string[] {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.sourceDir ?? env[CORPUS_SOURCE_DIR_ENV];
  if (explicit?.trim()) return [absoluteCandidate(explicit.trim(), cwd)];

  const root = opts.repoDir ?? repoRoot();
  const home = opts.homeDir ?? homedir();
  const candidates = [
    absoluteCandidate(manifest.sourceDir, root),
    resolve(root, '..', manifest.id),
    resolve(home, 'gh', manifest.id),
    resolve(home, 'src', manifest.id),
  ];
  return [...new Set(candidates)];
}

async function checkoutHasCommit(sourceDir: string, sha: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', sourceDir, 'cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a readable checkout that contains the manifest's pinned commit. */
export async function resolveCorpusSourceDir(
  manifest: CorpusManifest,
  opts: CorpusSourceResolutionOptions = {},
): Promise<string> {
  const candidates = corpusSourceCandidates(manifest, opts);
  const commitExists = opts.commitExists ?? checkoutHasCommit;
  const checked: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      checked.push(`${candidate} (missing)`);
      continue;
    }
    if (!(await commitExists(candidate, manifest.sha))) {
      checked.push(`${candidate} (does not contain ${manifest.sha.slice(0, 12)})`);
      continue;
    }
    return candidate;
  }

  throw new Error(
    [
      `unable to resolve corpus source for ${manifest.id}@${manifest.sha.slice(0, 12)}`,
      `set ${CORPUS_SOURCE_DIR_ENV} to a git checkout containing the pinned commit`,
      'checked:',
      ...checked.map((candidate) => `  - ${candidate}`),
    ].join('\n'),
  );
}

/** Extract the pinned subset into the eval cache (idempotent per SHA). */
export async function materializeCorpus(
  manifest: CorpusManifest,
  opts: MaterializeCorpusOptions = {},
): Promise<string> {
  const dir = join(
    opts.cacheRoot ?? defaultCacheRoot(),
    'corpora',
    `${manifest.id}-${manifest.sha.slice(0, 12)}`,
  );
  if (existsSync(join(dir, '.complete'))) return dir;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const sourceDir = await resolveCorpusSourceDir(manifest, opts);
  const tarPath = join(dir, '.corpus.tar');
  await execFileAsync(
    'git',
    ['-C', sourceDir, 'archive', '-o', tarPath, manifest.sha, '--', ...manifest.archivePaths],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  await execFileAsync('tar', [
    '-xf',
    tarPath,
    '-C',
    dir,
    `--strip-components=${manifest.stripComponents}`,
  ]);
  await rm(tarPath, { force: true });
  await validateCorpus(manifest, dir);
  await writeFile(join(dir, '.complete'), `${manifest.sha}\n`, 'utf8');
  return dir;
}

/** Every file in the corpus tree, relative forward-slash paths. */
export async function listCorpusFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === '.complete' || entry.name === '.corpus.tar') continue;
      const abs = join(d, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(relative(dir, abs).replaceAll('\\', '/'));
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Assert the materialized tree still matches the manifest's ground truth:
 * every golden expectation exists, the refactor reference count is exact,
 * and every `basename`-level query has a corpus-unique basename (so the QA
 * answer matcher can't quietly go stale).
 */
export async function validateCorpus(manifest: CorpusManifest, dir: string): Promise<void> {
  const files = await listCorpusFiles(dir);
  const fileSet = new Set(files);
  const problems: string[] = [];

  const expectedPaths = [
    manifest.refactor.defFile,
    ...manifest.goldenQueries.flatMap((q) => q.expected),
  ];
  for (const p of expectedPaths) {
    if (!fileSet.has(p)) problems.push(`expected file missing from corpus: ${p}`);
  }

  const refRe = new RegExp(`\\b${manifest.refactor.oldName}\\b`);
  let refFiles = 0;
  for (const p of files) {
    if (!/\.(ts|tsx|md)$/.test(p)) continue;
    const content = await readFile(join(dir, p), 'utf8').catch(() => '');
    if (refRe.test(content)) refFiles++;
  }
  if (refFiles !== manifest.refactor.refFileCount) {
    problems.push(
      `refactor refFileCount drift: manifest says ${manifest.refactor.refFileCount}, corpus has ${refFiles}`,
    );
  }

  const basenameCounts = new Map<string, number>();
  for (const p of files) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    basenameCounts.set(base, (basenameCounts.get(base) ?? 0) + 1);
  }
  for (const q of manifest.goldenQueries) {
    if (q.matchLevel !== 'basename') continue;
    for (const exp of q.expected) {
      const base = exp.slice(exp.lastIndexOf('/') + 1);
      if ((basenameCounts.get(base) ?? 0) !== 1) {
        problems.push(
          `query "${q.query}" uses matchLevel=basename but "${base}" is not corpus-unique — use dir+basename`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `corpus validation failed for ${manifest.id}@${manifest.sha.slice(0, 12)}:\n  ${problems.join('\n  ')}`,
    );
  }
}

/** Seed the corpus into a trial project's workspace over HTTP. */
export async function seedCorpusIntoProject(
  client: GezelClient,
  projectId: string,
  dir: string,
  opts: {
    limitFiles?: number;
    /** Paths to seed FIRST when limiting (golden files), so even smoke runs
     *  can measure a retrieval lift instead of zero-by-construction. */
    priorityPaths?: string[];
    concurrency?: number;
    log?: (line: string) => void;
  } = {},
): Promise<{ seeded: number }> {
  let files = await listCorpusFiles(dir);
  if (opts.limitFiles && opts.limitFiles > 0) {
    const priority = new Set(opts.priorityPaths ?? []);
    files = [...files.filter((f) => priority.has(f)), ...files.filter((f) => !priority.has(f))];
    files = files.slice(0, Math.max(opts.limitFiles, priority.size));
  }
  const concurrency = opts.concurrency ?? 6;
  let next = 0;
  let seeded = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const path = files[i]!;
      const abs = join(dir, path);
      const info = await stat(abs);
      if (info.size > 2 * 1024 * 1024) continue; // corpus subset is source-only; skip stray blobs
      const content = await readFile(abs, 'utf8').catch(() => null);
      if (content === null) continue;
      await client.writeProjectWorkspaceFile(projectId, { path, content });
      seeded++;
      if (seeded % 50 === 0) opts.log?.(`[corpus] seeded ${seeded}/${files.length}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  opts.log?.(`[corpus] seeded ${seeded} files`);
  return { seeded };
}
