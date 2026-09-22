import { assertSafeEntityId } from '../entity-id.js';
import { type ScriptRun, ScriptRunSchema } from '../schemas/script.js';
import { markScriptRunInterrupted } from '../scripts/runs.js';
import { listProjects, projectRoot, requireProject } from './projects.js';
import type { PortableRepository } from './repository.js';

function root(projectId: string) {
  return `${projectRoot(projectId)}/scripts/runs`;
}

export async function writeScriptRun(repo: PortableRepository, value: ScriptRun): Promise<void> {
  const run = ScriptRunSchema.parse(value);
  assertSafeEntityId(run.id);
  await requireProject(repo, run.projectId);
  const date = run.startedAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(run.startedAt)))
    throw new Error('Invalid script run date');
  const path = `${root(run.projectId)}/${date}/${run.id}.json`;
  await repo.transactions.commit(new Map([[path, repo.json(run)]]));
}

export async function getScriptRun(
  repo: PortableRepository,
  projectId: string,
  id: string,
): Promise<ScriptRun | null> {
  assertSafeEntityId(id);
  await requireProject(repo, projectId);
  for (const entry of await repo.list(root(projectId))) {
    if (!entry.isDirectory || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const run = await repo.record(`${root(projectId)}/${entry.name}/${id}.json`, ScriptRunSchema);
    if (run) {
      if (run.id !== id || run.projectId !== projectId)
        throw new Error('Script run identity does not match its file');
      return run;
    }
  }
  return null;
}

/** Interrupted runs are never replayed: a persisted call may already have changed files. */
export async function recoverScriptRuns(repo: PortableRepository): Promise<void> {
  for (const project of await listProjects(repo)) {
    for (const day of await repo.list(root(project.id))) {
      if (!day.isDirectory || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
      for (const entry of await repo.list(`${root(project.id)}/${day.name}`)) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
        const run = await getScriptRun(repo, project.id, entry.name.slice(0, -5));
        if (!run || !markScriptRunInterrupted(run, repo.now())) continue;
        await writeScriptRun(repo, run);
      }
    }
  }
}
