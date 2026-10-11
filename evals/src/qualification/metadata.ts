import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { gildeDataDir } from '@bendyline/gezel-catalog';
import type { EvalScenario, TrialOptions } from '../types.ts';
import { digest } from './boundary.ts';
import { isEvalInputPath, sourceIdentity } from './source-identity.ts';

export interface TreeIdentity {
  sha256: string;
  files: number;
  manifest?: Record<string, string>;
}

/** Ignore only source-backed Python caches, not arbitrary files in a cache directory. */
async function generatedPythonBytecode(path: string): Promise<boolean> {
  if (!path.endsWith('.pyc')) return false;
  const dir = dirname(path);
  const cached = basename(dir) === '__pycache__';
  const match = cached ? /^(.+?)\.[^.]+(?:\.opt-\d+)?\.pyc$/.exec(basename(path)) : null;
  if (cached && !match) return false;
  const source = cached ? join(dirname(dir), `${match![1]}.py`) : path.slice(0, -1);
  return lstat(source).then(
    (stat) => stat.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    },
  );
}

/** Content identity, not mtime; symlinks are omitted to avoid traversing user homes. */
export async function treeIdentity(
  root: string,
  options: {
    ignorePythonBytecode?: boolean;
    includeManifest?: boolean;
    includePath?: (path: string) => boolean;
  } = {},
): Promise<TreeIdentity> {
  const hash = createHash('sha256');
  const manifest: Record<string, string> = {};
  let files = 0;
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (options.includePath && !options.includePath(relative(root, path))) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        if (options.ignorePythonBytecode && (await generatedPythonBytecode(path))) continue;
        const name = relative(root, path);
        const bytes = await readFile(path);
        hash.update(name).update('\0').update(bytes).update('\0');
        if (options.includeManifest)
          manifest[name] = createHash('sha256').update(bytes).digest('hex');
        files++;
      }
    }
  }
  await visit(root);
  return { sha256: hash.digest('hex'), files, ...(options.includeManifest ? { manifest } : {}) };
}

/** Python imports rewrite .pyc files during normal MLX startup; their .py source is authoritative. */
export async function serviceBuildIdentity(root: string) {
  return {
    algorithm: 'service-content-v2',
    ...(await treeIdentity(root, { ignorePythonBytecode: true, includeManifest: true })),
  };
}

export async function captureQualificationIdentity(
  root: string,
  scope: 'repository' | 'eval' = 'repository',
) {
  const unavailable: string[] = [];
  async function capture<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch {
      unavailable.push(name);
      return null;
    }
  }
  const source = await capture('source', () => sourceIdentity(root, scope));
  const service = await capture('service-build', () =>
    serviceBuildIdentity(join(root, 'packages/service/dist')),
  );
  const gilde = await capture('gilde-content', async () => {
    const dataDir = gildeDataDir();
    const content = await treeIdentity(dataDir);
    const manifest = await readFile(join(dataDir, '..', 'package.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    return { dataDir, version: manifest?.version ?? null, ...content };
  });
  const fixtures = await capture('fixture-source', () =>
    treeIdentity(
      join(root, 'evals/src'),
      scope === 'eval'
        ? {
            includeManifest: true,
            includePath: (path) => isEvalInputPath(`evals/src/${path}`),
          }
        : {},
    ),
  );
  return { source, service, gilde, fixtures, unavailable };
}

export async function writeQualificationMetadata(
  root: string,
  runDir: string,
  scenario: EvalScenario,
  opts: TrialOptions,
): Promise<void> {
  const identity = await captureQualificationIdentity(root);
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
        ...identity,
        scenario: { id: scenario.id, prompt: scenario.prompt, promptHash: digest(scenario.prompt) },
        treatment,
        treatmentHash: digest(treatment),
      },
      null,
      2,
    ),
  );
}
