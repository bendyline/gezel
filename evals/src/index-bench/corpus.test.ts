import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORPUS_SOURCE_DIR_ENV,
  type CorpusManifest,
  corpusSourceCandidates,
  materializeCorpus,
  resolveCorpusSourceDir,
} from './corpus.ts';

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function manifest(sourceDir: string, sha = 'a'.repeat(40)): CorpusManifest {
  return {
    id: 'squisq',
    sha,
    sourceDir,
    archivePaths: ['packages/core'],
    stripComponents: 1,
    goldenQueries: [
      {
        query: 'where is the parser',
        expected: ['core/src/parse.ts'],
        matchLevel: 'dir+basename',
      },
    ],
    expectedAreas: ['core'],
    refactor: {
      oldName: 'parseMarkdown',
      newName: 'parseMarkdownSource',
      defFile: 'core/src/parse.ts',
      refFileCount: 1,
      minRenamedFiles: 1,
    },
  };
}

async function createCorpusRepo(root: string): Promise<{ dir: string; sha: string }> {
  const dir = join(root, 'squisq');
  await mkdir(join(dir, 'packages', 'core', 'src'), { recursive: true });
  await writeFile(
    join(dir, 'packages', 'core', 'src', 'parse.ts'),
    'export function parseMarkdown(source: string): string { return source; }\n',
  );
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'evals@example.invalid'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Gezel Evals'], { cwd: dir });
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: dir });
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
  return { dir, sha: stdout.trim() };
}

describe('corpus source resolution', () => {
  it('resolves a relative manifest path from the gezel repository root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-corpus-resolution-'));
    cleanup.push(root);
    const repoDir = join(root, 'gezel');
    const corpusDir = join(root, 'squisq');
    await Promise.all([mkdir(repoDir), mkdir(corpusDir)]);

    const resolved = await resolveCorpusSourceDir(manifest('../squisq'), {
      repoDir,
      homeDir: join(root, 'home'),
      env: {},
      commitExists: async (candidate) => candidate === corpusDir,
    });

    expect(resolved).toBe(corpusDir);
  });

  it('treats the explicit environment override as authoritative', () => {
    const repoDir = resolve('checkout', 'gezel');
    const override = resolve('elsewhere', 'squisq');
    expect(
      corpusSourceCandidates(manifest('../squisq'), {
        repoDir,
        cwd: repoDir,
        env: { [CORPUS_SOURCE_DIR_ENV]: override },
      }),
    ).toEqual([override]);
  });
});

describe('corpus materialization', () => {
  it('archives a sibling checkout and writes a platform-neutral completion marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gezel-corpus-materialize-'));
    cleanup.push(root);
    const repoDir = join(root, 'gezel');
    const cacheRoot = join(root, 'cache');
    await mkdir(repoDir);
    const corpus = await createCorpusRepo(root);

    const dir = await materializeCorpus(manifest('../squisq', corpus.sha), {
      repoDir,
      cacheRoot,
      homeDir: join(root, 'home'),
      env: {},
    });

    expect(await readFile(join(dir, 'core', 'src', 'parse.ts'), 'utf8')).toContain('parseMarkdown');
    expect(await readFile(join(dir, '.complete'), 'utf8')).toBe(`${corpus.sha}\n`);
  });
});
