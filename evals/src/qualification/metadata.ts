import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import type { EvalScenario, TrialOptions } from '../types.ts';
import { digest } from './boundary.ts';

/** Content identity, not mtime; symlinks are omitted to avoid traversing user homes. */
export async function treeIdentity(root: string): Promise<{ sha256: string; files: number }> {
  const hash = createHash('sha256');
  let files = 0;
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        hash
          .update(relative(root, path))
          .update('\0')
          .update(await readFile(path))
          .update('\0');
        files++;
      }
    }
  }
  await visit(root);
  return { sha256: hash.digest('hex'), files };
}

export async function writeQualificationMetadata(
  root: string,
  runDir: string,
  scenario: EvalScenario,
  opts: TrialOptions,
): Promise<void> {
  const unavailable: string[] = [];
  async function capture<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      unavailable.push(name);
      return null;
    }
  }
  const source = await capture('source', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    const head = git('rev-parse', 'HEAD').toString().trim();
    const hash = createHash('sha256').update(git('diff', '--binary', 'HEAD'));
    const untracked = git('ls-files', '--others', '--exclude-standard', '-z')
      .toString()
      .split('\0')
      .filter(Boolean)
      .sort();
    for (const path of untracked)
      hash
        .update(path)
        .update('\0')
        .update(await readFile(join(root, path)))
        .update('\0');
    return { head, workingTreeSha256: hash.digest('hex'), untrackedFiles: untracked.length };
  });
  const service = await capture('service-build', () =>
    treeIdentity(join(root, 'packages/service/dist')),
  );
  const gilde = await capture('gilde-content', async () => {
    const dataDir = gildeDataDir();
    const content = await treeIdentity(dataDir);
    const manifest = await readFile(join(dataDir, '..', 'package.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    return { dataDir, version: manifest?.version ?? null, ...content };
  });
  const fixtures = await capture('fixture-source', () => treeIdentity(join(root, 'evals/src')));
  const treatment = {
    provider: opts.engine ?? 'llama-cpp',
    model: opts.modelId,
    generalist: opts.generalistMode ?? 'auto',
    repairPolicy: scenario.repairPolicy ?? 'harness',
    qualification: opts.qualification,
    forceBehaviors: opts.forceBehaviors ?? [],
    removeBehaviors: opts.removeBehaviors ?? [],
    inheritedForceBehaviors: process.env.GEZEL_FORCE_BEHAVIORS ?? null,
    inheritedRemoveBehaviors: process.env.GEZEL_REMOVE_BEHAVIORS ?? null,
    retrieval: opts.retrieval ?? null,
    keurmeester: opts.keurmeester ?? null,
    imageModelId: opts.imageModelId ?? null,
    modelNetworkAccess: scenario.modelNetworkAccess ?? null,
    autoRecallEnabled: false,
    reasoningEffortOverride: opts.llamaCppReasoningEffort ?? null,
    timeoutMs: opts.timeoutMs ?? scenario.timeoutMs ?? null,
  };
  await writeFile(
    join(runDir, 'measurement.json'),
    JSON.stringify(
      {
        version: 1,
        recordedAt: new Date().toISOString(),
        source,
        service,
        gilde,
        fixtures,
        scenario: { id: scenario.id, prompt: scenario.prompt, promptHash: digest(scenario.prompt) },
        treatment,
        treatmentHash: digest(treatment),
        unavailable,
      },
      null,
      2,
    ),
  );
}
