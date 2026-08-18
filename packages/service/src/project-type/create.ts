import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import {
  type CreateTypedProjectRequest,
  type CreateTypedProjectResponse,
  createLogger,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  gezelDir,
  gezelPaths,
  projectCreateTransactionsRoot,
  projectDir,
  projectStorageDir,
} from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import { Store } from '../fs/store.js';
import { applyProjectType, preflightProjectType } from './apply.js';

const log = createLogger('project-type-create');
const EXTERNAL_PROJECT_ENTRIES = ['documents', 'artifacts', 'memories', 'tasks'] as const;
const OWNERSHIP_MARKER = '.gezel-create-operation.json';
const JOURNAL_FILE = 'journal.json';

export interface TypedProjectCreateHooks {
  /** Called after the complete staged aggregate exists, before real roots are touched. */
  beforeCommit?: () => void | Promise<void>;
  /** Called after each atomic publish rename. Useful for tracing and fault-injection tests. */
  afterCommitStep?: (step: {
    kind: 'gezel' | 'project-external' | 'project';
    id: string;
  }) => void | Promise<void>;
}

export interface CreateTypedProjectDeps {
  store: Store;
  catalog: CatalogService;
  hooks?: TypedProjectCreateHooks;
}

interface CommitStep {
  kind: 'gezel' | 'project-external' | 'project';
  id: string;
  hidden: string;
  target: string;
}

interface TypedProjectCreateJournal {
  version: 1;
  operationId: string;
  projectId: string;
  createdAt: string;
  phase: 'committing' | 'committed';
  steps: CommitStep[];
}

export class TypedProjectCreateError extends Error {
  constructor(
    readonly code: 'PROJECT_TYPE_INVALID' | 'PROJECT_CREATE_CONFLICT',
    message: string,
    readonly status: 400 | 409,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TypedProjectCreateError';
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function assertAbsent(path: string, label: string): Promise<void> {
  if (await pathExists(path)) {
    throw new TypedProjectCreateError('PROJECT_CREATE_CONFLICT', `${label} already exists`, 409);
  }
}

async function writeOwnershipMarker(directory: string, operationId: string): Promise<void> {
  await writeFileAtomic(
    join(directory, OWNERSHIP_MARKER),
    `${JSON.stringify({ operationId }, null, 2)}\n`,
    { mode: 0o600, durable: true },
  );
}

async function isOwnedBy(directory: string, operationId: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, OWNERSHIP_MARKER), 'utf8')) as {
      operationId?: unknown;
    };
    return parsed.operationId === operationId;
  } catch {
    return false;
  }
}

async function writeJournal(
  operationRoot: string,
  journal: TypedProjectCreateJournal,
): Promise<void> {
  await writeFileAtomic(
    join(operationRoot, JOURNAL_FILE),
    `${JSON.stringify(journal, null, 2)}\n`,
    { mode: 0o600, durable: true },
  );
}

function parseJournal(raw: string): TypedProjectCreateJournal | null {
  try {
    const value = JSON.parse(raw) as Partial<TypedProjectCreateJournal>;
    if (
      value.version !== 1 ||
      typeof value.operationId !== 'string' ||
      typeof value.projectId !== 'string' ||
      !['committing', 'committed'].includes(value.phase ?? '') ||
      !Array.isArray(value.steps)
    ) {
      return null;
    }
    for (const step of value.steps) {
      if (
        !step ||
        !['gezel', 'project-external', 'project'].includes(step.kind) ||
        typeof step.id !== 'string' ||
        typeof step.hidden !== 'string' ||
        typeof step.target !== 'string'
      ) {
        return null;
      }
    }
    return value as TypedProjectCreateJournal;
  } catch {
    return null;
  }
}

function samePath(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function expectedCommitSteps(
  store: Store,
  operationId: string,
  projectId: string,
  gezelIds: string[],
): CommitStep[] {
  const localProjectsRoot = join(store.homePath, 'projects');
  const externalProjectsRoot = gezelPaths(store.homePath, store.externalFolders).projects;
  const actualGezelsRoot = gezelPaths(store.homePath, store.externalFolders).gezels;
  const steps: CommitStep[] = gezelIds.map((id) => ({
    kind: 'gezel',
    id,
    hidden: join(actualGezelsRoot, '.gezel-create-staging', operationId, id),
    target: gezelDir(store.homePath, id, store.externalFolders),
  }));
  const localTarget = projectStorageDir(store.homePath, projectId);
  const externalTarget = projectDir(store.homePath, projectId, store.externalFolders);
  if (!samePath(localTarget, externalTarget)) {
    steps.push({
      kind: 'project-external',
      id: projectId,
      hidden: join(externalProjectsRoot, '.gezel-create-staging', operationId, projectId),
      target: externalTarget,
    });
  }
  steps.push({
    kind: 'project',
    id: projectId,
    hidden: join(localProjectsRoot, '.gezel-create-staging', operationId, projectId),
    target: localTarget,
  });
  return steps;
}

function validateJournalForStore(
  store: Store,
  operationRoot: string,
  journal: TypedProjectCreateJournal,
): boolean {
  if (basename(operationRoot) !== journal.operationId) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(journal.operationId)) return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(journal.projectId)) return false;

  const gezelIds: string[] = [];
  let sawNonGezel = false;
  for (const step of journal.steps) {
    if (step.kind === 'gezel' && !sawNonGezel) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(step.id)) return false;
      gezelIds.push(step.id);
    } else {
      sawNonGezel = true;
    }
  }
  if (new Set(gezelIds).size !== gezelIds.length) return false;
  const expected = expectedCommitSteps(store, journal.operationId, journal.projectId, gezelIds);
  if (expected.length !== journal.steps.length) return false;
  return expected.every((wanted, index) => {
    const actual = journal.steps[index];
    return (
      actual?.kind === wanted.kind &&
      actual.id === wanted.id &&
      samePath(actual.hidden, wanted.hidden) &&
      samePath(actual.target, wanted.target)
    );
  });
}

function hiddenRecoveryRoots(store: Store, operationId: string): string[] {
  return [
    join(store.homePath, 'projects', '.gezel-create-staging', operationId),
    join(
      gezelPaths(store.homePath, store.externalFolders).projects,
      '.gezel-create-staging',
      operationId,
    ),
    join(
      gezelPaths(store.homePath, store.externalFolders).gezels,
      '.gezel-create-staging',
      operationId,
    ),
  ];
}

async function cleanupEmptyHiddenParents(store: Store): Promise<void> {
  const parents = new Set([
    join(store.homePath, 'projects', '.gezel-create-staging'),
    join(gezelPaths(store.homePath, store.externalFolders).projects, '.gezel-create-staging'),
    join(gezelPaths(store.homePath, store.externalFolders).gezels, '.gezel-create-staging'),
  ]);
  for (const parent of parents) {
    try {
      await rmdir(parent);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw err;
    }
  }
}

async function chooseProjectId(store: Store, name: string): Promise<string> {
  const base = slugify(name) || randomUUID().slice(0, 8);
  const localRoot = join(store.homePath, 'projects');
  const externalRoot = gezelPaths(store.homePath, store.externalFolders).projects;
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const local = join(localRoot, candidate);
    const external = join(externalRoot, candidate);
    if (await pathExists(local)) continue;
    if (normalize(external) !== normalize(local) && (await pathExists(external))) continue;
    return candidate;
  }
  throw new Error(`project id collision overflow for "${base}"`);
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
}

async function moveExternalProjectEntries(
  localHidden: string,
  externalHidden: string,
): Promise<void> {
  await mkdir(externalHidden, { recursive: true });
  for (const entry of EXTERNAL_PROJECT_ENTRIES) {
    const source = join(localHidden, entry);
    if (!(await pathExists(source))) continue;
    const target = join(externalHidden, entry);
    await copyDirectory(source, target);
    await rm(source, { recursive: true, force: true });
  }
}

async function bestEffortHistory(
  store: Store,
  response: CreateTypedProjectResponse,
): Promise<void> {
  const history = store.historyManager;
  if (!history) return;
  const { project, applied } = response;
  const events: Parameters<typeof history.log>[0][] = [
    {
      kind: 'project.created',
      projectId: project.id,
      summary: `Created project "${project.name}"`,
      details: { name: project.name, description: project.description },
    },
    ...applied.gezelsCreated.map((gezel) => ({
      kind: 'gezel.created' as const,
      gezelId: gezel.id,
      summary: `Created "${gezel.name}"`,
      details: { name: gezel.name, templateId: gezel.templateId },
    })),
    {
      kind: 'project.updated',
      projectId: project.id,
      summary: `Applied project type ${applied.typeId}@${applied.version}`,
      details: { projectType: applied.typeId, version: applied.version },
    },
  ];
  for (const event of events) {
    try {
      await history.log(event);
    } catch (err) {
      log.warn(
        `[create] post-commit history write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Build a typed project out-of-band, then publish it with the always-local
 * project directory as the final listability commit point. Project data and
 * generated gezels are first copied into hidden sibling directories so every
 * publish step is a same-filesystem rename. A failed commit removes only paths
 * this operation proved absent and then created itself.
 */
export async function createTypedProject(
  deps: CreateTypedProjectDeps,
  input: CreateTypedProjectRequest,
): Promise<CreateTypedProjectResponse> {
  const { store, catalog, hooks } = deps;
  try {
    await preflightProjectType({ catalog }, input.projectType);
  } catch (err) {
    throw new TypedProjectCreateError(
      'PROJECT_TYPE_INVALID',
      err instanceof Error ? err.message : String(err),
      400,
      { cause: err },
    );
  }

  const releaseProjectCreation = await store.acquireProjectCreationLock();
  try {
    const operationId = randomUUID();
    const operationRoot = join(projectCreateTransactionsRoot(store.homePath), operationId);
    const stageHome = join(operationRoot, 'home');
    const projectId = await chooseProjectId(store, input.name);
    const actualLocalProject = projectStorageDir(store.homePath, projectId);
    const actualExternalProject = projectDir(store.homePath, projectId, store.externalFolders);
    const localProjectsRoot = join(store.homePath, 'projects');
    const externalProjectsRoot = gezelPaths(store.homePath, store.externalFolders).projects;
    const actualGezelsRoot = gezelPaths(store.homePath, store.externalFolders).gezels;
    const hiddenLocalProject = join(
      localProjectsRoot,
      '.gezel-create-staging',
      operationId,
      projectId,
    );
    const hiddenExternalProject = join(
      externalProjectsRoot,
      '.gezel-create-staging',
      operationId,
      projectId,
    );
    const hiddenGezelsRoot = join(actualGezelsRoot, '.gezel-create-staging', operationId);
    const cleanupRoots = new Set<string>([
      operationRoot,
      join(localProjectsRoot, '.gezel-create-staging', operationId),
      join(externalProjectsRoot, '.gezel-create-staging', operationId),
      hiddenGezelsRoot,
    ]);

    const committed: CommitStep[] = [];
    let response: CreateTypedProjectResponse | null = null;
    let preserveOperationRoot = false;
    try {
      const stageStore = new Store({ home: stageHome });
      await stageStore.createProject(
        {
          name: input.name,
          description: input.description,
          mode: input.mode,
          icon: input.icon,
        },
        { id: projectId },
      );
      const applied = await applyProjectType(
        { store: stageStore, catalog, home: stageHome },
        { projectId, ...input.projectType },
      );
      const stagedProject = await stageStore.getProject(projectId);
      if (!stagedProject || stagedProject.projectType?.id !== applied.typeId) {
        throw new Error(`typed project ${projectId} did not finish staging`);
      }
      if (
        new Set(applied.gezelsCreated.map((gezel) => gezel.id)).size !==
        applied.gezelsCreated.length
      ) {
        throw new Error(`project type ${applied.typeId} generated duplicate gezel ids`);
      }

      // Collision checks are against the real Store roots, never the empty
      // staging home. Repeat immediately before publication to catch races.
      await assertAbsent(actualLocalProject, `project ${projectId}`);
      if (normalize(actualExternalProject) !== normalize(actualLocalProject)) {
        await assertAbsent(actualExternalProject, `external project ${projectId}`);
      }
      for (const gezel of applied.gezelsCreated) {
        await assertAbsent(
          gezelDir(store.homePath, gezel.id, store.externalFolders),
          `gezel ${gezel.id}`,
        );
      }

      const stagedProjectDir = projectStorageDir(stageHome, projectId);
      await copyDirectory(stagedProjectDir, hiddenLocalProject);
      const splitExternal = normalize(actualExternalProject) !== normalize(actualLocalProject);
      if (splitExternal) {
        await moveExternalProjectEntries(hiddenLocalProject, hiddenExternalProject);
      }

      const steps: CommitStep[] = [];
      for (const gezel of applied.gezelsCreated) {
        const hidden = join(hiddenGezelsRoot, gezel.id);
        await copyDirectory(gezelDir(stageHome, gezel.id), hidden);
        await writeOwnershipMarker(hidden, operationId);
        steps.push({
          kind: 'gezel',
          id: gezel.id,
          hidden,
          target: gezelDir(store.homePath, gezel.id, store.externalFolders),
        });
      }
      if (splitExternal) {
        await writeOwnershipMarker(hiddenExternalProject, operationId);
        steps.push({
          kind: 'project-external',
          id: projectId,
          hidden: hiddenExternalProject,
          target: actualExternalProject,
        });
      }
      // Always-local project metadata is the final step. listProjects() only
      // enumerates this root, so the project cannot appear before it is whole.
      await writeOwnershipMarker(hiddenLocalProject, operationId);
      steps.push({
        kind: 'project',
        id: projectId,
        hidden: hiddenLocalProject,
        target: actualLocalProject,
      });

      await writeJournal(operationRoot, {
        version: 1,
        operationId,
        projectId,
        createdAt: new Date().toISOString(),
        phase: 'committing',
        steps,
      });
      await hooks?.beforeCommit?.();
      for (const step of steps) {
        await assertAbsent(step.target, `${step.kind} ${step.id}`);
      }
      for (const step of steps) {
        await mkdir(dirname(step.target), { recursive: true });
        await rename(step.hidden, step.target);
        committed.push(step);
        await hooks?.afterCommitStep?.({ kind: step.kind, id: step.id });
      }

      const project = await store.getProject(projectId);
      if (!project) throw new Error(`project ${projectId} missing after commit`);
      response = { project, applied };
      await writeJournal(operationRoot, {
        version: 1,
        operationId,
        projectId,
        createdAt: new Date().toISOString(),
        phase: 'committed',
        steps,
      });

      // Keep the journal until every ownership marker is gone. If marker
      // cleanup itself fails, startup recovery sees the final project marker,
      // treats the commit as complete, and finishes this housekeeping without
      // rolling back user-visible data.
      for (const step of steps) {
        try {
          await rm(join(step.target, OWNERSHIP_MARKER));
        } catch (err) {
          if (!isMissing(err)) {
            preserveOperationRoot = true;
            log.warn(
              `[create] marker cleanup failed for ${step.target}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    } catch (err) {
      // Reverse only transaction-owned paths whose absence was asserted before
      // rename. This cannot remove a pre-existing project/gezel.
      for (const step of committed.reverse()) {
        try {
          if (await isOwnedBy(step.target, operationId)) {
            await rm(step.target, { recursive: true, force: true });
          } else if (await pathExists(step.target)) {
            preserveOperationRoot = true;
            log.error(`[create] refused to roll back unowned path ${step.target}`);
          }
        } catch (rollbackErr) {
          preserveOperationRoot = true;
          log.error(
            `[create] rollback failed for ${step.target}: ${
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
            }`,
          );
        }
      }
      throw err;
    } finally {
      for (const root of cleanupRoots) {
        if (root === operationRoot && preserveOperationRoot) continue;
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
      }
      await cleanupEmptyHiddenParents(store).catch(() => undefined);
    }

    if (!response) throw new Error(`typed project ${projectId} did not commit`);
    await bestEffortHistory(store, response);
    return response;
  } finally {
    releaseProjectCreation();
  }
}

/** Visible for startup repair/tests: list abandoned transaction work dirs. */
export async function listTypedProjectStagingRoots(home: string): Promise<string[]> {
  const root = projectCreateTransactionsRoot(home);
  try {
    return (await readdir(root)).map((entry) => join(root, entry));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/**
 * Recover transactions interrupted between atomic publish renames. The local
 * project directory is the commit point and is always last:
 *
 * - final project owns the operation marker -> commit completed; retain every
 *   target and remove markers/journal;
 * - final project absent -> remove only marker-owned targets and hidden dirs;
 * - a target exists without our marker -> never touch it; retain the journal
 *   and report the recovery failure for operator inspection.
 */
export async function recoverTypedProjectCreations(store: Store): Promise<void> {
  for (const operationRoot of await listTypedProjectStagingRoots(store.homePath)) {
    let journal: TypedProjectCreateJournal | null = null;
    try {
      journal = parseJournal(await readFile(join(operationRoot, JOURNAL_FILE), 'utf8'));
    } catch (err) {
      if (!isMissing(err)) {
        log.warn(
          `[recovery] cannot read ${operationRoot}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!journal) {
      // No commit journal means the process died during isolated staging;
      // none of its data could have reached a real root.
      const operationId = basename(operationRoot);
      if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(operationId)) {
        for (const hiddenRoot of new Set(hiddenRecoveryRoots(store, operationId))) {
          await rm(hiddenRoot, { recursive: true, force: true }).catch(() => undefined);
        }
        await cleanupEmptyHiddenParents(store).catch(() => undefined);
      }
      await rm(operationRoot, { recursive: true, force: true });
      continue;
    }
    if (!validateJournalForStore(store, operationRoot, journal)) {
      log.error(`[recovery] refusing invalid transaction journal ${operationRoot}`);
      continue;
    }

    // Classification is deliberately a separate pass. An uncommitted journal
    // with even one existing unowned target is ambiguous; touching earlier
    // marker-owned targets before discovering it could make the installation
    // less consistent than the crash did.
    const states = await Promise.all(
      journal.steps.map(async (step) => {
        const exists = await pathExists(step.target);
        return {
          step,
          exists,
          owned: exists && (await isOwnedBy(step.target, journal.operationId)),
        };
      }),
    );
    const finalState = states.find(({ step }) => step.kind === 'project');
    const committed =
      states.every(({ exists }) => exists) &&
      finalState?.exists === true &&
      (journal.phase === 'committed' || finalState.owned);
    if (!committed) {
      const ambiguous = states.find(({ exists, owned }) => exists && !owned);
      const finalButIncomplete = finalState?.exists === true;
      if (ambiguous || finalButIncomplete) {
        log.error(
          `[recovery] ambiguous transaction ${journal.operationId}; refusing all mutations${
            ambiguous ? ` (unowned ${ambiguous.step.target})` : ''
          }`,
        );
        continue;
      }
    }

    for (const { step, exists, owned } of states) {
      if (!exists) continue;
      if (committed) {
        if (owned) await rm(join(step.target, OWNERSHIP_MARKER), { force: true });
      } else {
        // The ambiguity pass proved every existing target is marker-owned.
        await rm(step.target, { recursive: true, force: true });
      }
    }
    for (const hiddenRoot of new Set(hiddenRecoveryRoots(store, journal.operationId))) {
      await rm(hiddenRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    await cleanupEmptyHiddenParents(store).catch(() => undefined);
    await rm(operationRoot, { recursive: true, force: true });
  }
}
