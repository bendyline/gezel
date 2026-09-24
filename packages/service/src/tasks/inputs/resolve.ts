import { rm } from 'node:fs/promises';
import {
  type Craftbook,
  type CraftbookInputParam,
  type TaskInputManifest,
  type TaskInputPreviewResponse,
  type TaskInputRecord,
  type TaskInputSource,
  craftbookInputParams,
  createLogger,
  inputSourceFromParamValue,
  nowIso,
  taskInputArtifactDir,
  taskInputManifestPath,
  taskRef,
} from '@bendyline/gezel';
import { safeJoin } from '../../fs/safe-paths.js';
import { type EnumeratedInput, TaskInputError, enumerateInPlaceInput } from './enumerate.js';
import type { InputStagingManager, InputStagingMeta } from './staging.js';

export { TaskInputError } from './enumerate.js';

const log = createLogger('tasks');

export interface TaskInputsStore {
  projectWorkspaceDir(projectId: string): Promise<string>;
  projectArtifactsDir(projectId: string): string;
  writeProjectArtifact(projectId: string, path: string, content: string): Promise<void>;
}

export interface TaskInputsDeps {
  store: TaskInputsStore;
  /** Absent → upload sources are refused (tests, portable hosts). */
  staging?: InputStagingManager | undefined;
}

/** Resolved inputs for one launch, not yet written anywhere. */
export interface TaskInputsPlan {
  records: Record<string, TaskInputRecord>;
  /** param → resolved drawer path; merged into the launch params before interpolation. */
  params: Record<string, string>;
  /** Adopt uploads and write manifests. Run immediately before the task is written. */
  commit(): Promise<void>;
  /** Undo {@link commit} when the task write that followed it failed. */
  rollback(): Promise<void>;
}

interface PlannedInput {
  param: string;
  enumerated: EnumeratedInput;
  from: TaskInputSource['from'];
  upload?: { meta: InputStagingMeta; destRel: string };
}

const UPLOAD_FILES_PREFIX = 'files/';

async function enumerateSource(
  deps: TaskInputsDeps,
  args: {
    projectId: string;
    craftbookId: string;
    input: CraftbookInputParam;
    source: TaskInputSource;
    /** Where an upload will land; required to plan an upload. */
    uploadDestRel?: string;
  },
): Promise<Omit<PlannedInput, 'param'>> {
  const { input, source, projectId } = args;
  const param = input.key;
  if (source.from === 'workspace') {
    const enumerated = await enumerateInPlaceInput({
      param,
      spec: input.spec,
      drawer: 'workspace',
      drawerRoot: await deps.store.projectWorkspaceDir(projectId),
      path: source.path,
    });
    return { enumerated, from: 'workspace' };
  }
  if (source.from === 'artifacts') {
    const enumerated = await enumerateInPlaceInput({
      param,
      spec: input.spec,
      drawer: 'artifacts',
      drawerRoot: deps.store.projectArtifactsDir(projectId),
      path: source.path,
    });
    return { enumerated, from: 'artifacts' };
  }

  if (!deps.staging) {
    throw new TaskInputError(param, 'Files from your computer cannot be used on this host.');
  }
  const meta = await deps.staging.readMeta(projectId, source.stagingId);
  if (!meta) {
    throw new TaskInputError(
      param,
      'The files you picked are no longer waiting to be used — pick them again.',
    );
  }
  if (meta.param !== param || meta.craftbookId !== args.craftbookId) {
    throw new TaskInputError(param, 'Those uploaded files were picked for a different input.');
  }
  // Enumerate the staged tree as a folder whatever the declared kind: the
  // upload's shape is checked against the kind below, with a clearer message
  // than the generic enumerator could give.
  const staged = await enumerateInPlaceInput({
    param,
    spec: { ...input.spec, kind: 'folder' },
    drawer: 'artifacts',
    drawerRoot: deps.staging.areaDir(projectId, source.stagingId),
    path: 'files',
    label: meta.label,
  });
  const destRel = args.uploadDestRel ?? 'files';
  const rebase = (p: string) =>
    `${destRel}/${p.startsWith(UPLOAD_FILES_PREFIX) ? p.slice(UPLOAD_FILES_PREFIX.length) : p}`;
  const files = staged.files.map((f) => ({ ...f, path: rebase(f.path) }));
  const skipped = staged.skipped.map((s) => ({ ...s, path: rebase(s.path) }));
  if (input.spec.kind === 'file' && files.length !== 1) {
    throw new TaskInputError(param, 'This input takes exactly one file.');
  }
  const enumerated: EnumeratedInput = {
    ...staged,
    kind: input.spec.kind,
    path: input.spec.kind === 'file' ? files[0]!.path : destRel,
    files,
    skipped,
  };
  return { enumerated, from: 'upload', upload: { meta, destRel } };
}

function manifestFor(planned: PlannedInput): TaskInputManifest {
  const e = planned.enumerated;
  return {
    param: planned.param,
    kind: e.kind,
    drawer: e.drawer,
    path: e.path,
    from: planned.from,
    label: e.label,
    createdAt: nowIso(),
    totalBytes: e.totalBytes,
    files: e.files,
    skipped: e.skipped,
  };
}

/**
 * Resolve a launch's craftbook inputs against the book's declared input
 * params. Called from `TaskManager.create` once the task number is known and
 * before interpolation, so `{{param}}` lands as the resolved path in every
 * prompt, gate, and spawn template. Returns null when the book declares no
 * inputs. Throws `TaskInputError` for anything the user has to fix.
 */
export async function planTaskInputs(
  deps: TaskInputsDeps,
  args: {
    projectId: string;
    craftbookId: string;
    paramSchema: Craftbook['paramSchema'];
    /** Caller-supplied params; an input's string value is the fallback source. */
    params: Record<string, string>;
    sources?: Record<string, TaskInputSource>;
    /** `tasks/<num>` — the task's artifacts folder. */
    taskDir: string;
    /** For the launch log line; defaults to the task folder. */
    taskRef?: string;
    /** Cron/night-shift hosts: one-off uploaded bytes cannot recur. */
    recurring: boolean;
  },
): Promise<TaskInputsPlan | null> {
  const inputs = craftbookInputParams(args.paramSchema);
  const declared = new Set(inputs.map((i) => i.key));
  for (const key of Object.keys(args.sources ?? {})) {
    if (!declared.has(key)) {
      throw new TaskInputError(key, `"${key}" is not an input this craftbook takes.`);
    }
  }
  if (inputs.length === 0) return null;

  const planned: PlannedInput[] = [];
  for (const input of inputs) {
    const source = args.sources?.[input.key] ?? inputSourceFromParamValue(args.params[input.key]);
    if (!source) {
      if (input.required) {
        throw new TaskInputError(
          input.key,
          `Choose the ${input.title.toLowerCase()} this craftbook works on.`,
        );
      }
      continue;
    }
    if (source.from === 'upload' && args.recurring) {
      throw new TaskInputError(
        input.key,
        'A recurring task cannot use files picked from your computer — they would be the same files every run. Pick a folder in this project instead.',
      );
    }
    const result = await enumerateSource(deps, {
      projectId: args.projectId,
      craftbookId: args.craftbookId,
      input,
      source,
      uploadDestRel: taskInputArtifactDir(args.taskDir, input.key),
    });
    planned.push({ param: input.key, ...result });
  }
  if (planned.length === 0) return null;

  const records: Record<string, TaskInputRecord> = {};
  const params: Record<string, string> = {};
  for (const p of planned) {
    const e = p.enumerated;
    records[p.param] = {
      kind: e.kind,
      drawer: e.drawer,
      path: e.path,
      from: p.from,
      label: e.label,
      manifest: taskInputManifestPath(args.taskDir, p.param),
      fileCount: e.files.length,
      totalBytes: e.totalBytes,
      skippedCount: e.skipped.length,
      ...(e.hasOfficeDocuments ? { hasOfficeDocuments: true } : {}),
    };
    params[p.param] = e.path;
  }

  const artifactsDir = deps.store.projectArtifactsDir(args.projectId);
  const adopted: Array<{ meta: InputStagingMeta; abs: string }> = [];
  const written: string[] = [];

  return {
    records,
    params,
    async commit() {
      for (const p of planned) {
        if (p.upload && deps.staging) {
          const abs = safeJoin(artifactsDir, p.upload.destRel);
          if (!abs) throw new TaskInputError(p.param, 'The upload destination is not usable.');
          await deps.staging.adopt(args.projectId, p.upload.meta.stagingId, abs);
          adopted.push({ meta: p.upload.meta, abs });
        }
        const manifestPath = records[p.param]!.manifest;
        await deps.store.writeProjectArtifact(
          args.projectId,
          manifestPath,
          `${JSON.stringify(manifestFor(p), null, 2)}\n`,
        );
        written.push(manifestPath);
        const e = p.enumerated;
        log.info(
          `${args.taskRef ?? `${args.projectId}/${args.taskDir}`} input ${p.param} from=${p.from} drawer=${e.drawer} files=${e.files.length} bytes=${e.totalBytes} skipped=${e.skipped.length}`,
        );
      }
    },
    async rollback() {
      for (const { meta, abs } of adopted.reverse()) {
        await deps.staging
          ?.restore(args.projectId, meta, abs)
          .catch((err) => log.warn(`could not return upload ${meta.stagingId}: ${String(err)}`));
      }
      for (const rel of written) {
        const abs = safeJoin(artifactsDir, rel);
        if (abs) await rm(abs, { force: true }).catch(() => undefined);
      }
    },
  };
}

/** `TaskManager.create`'s call: everything the plan needs is on the request and the book. */
export function planLaunchInputs(
  deps: TaskInputsDeps,
  args: {
    projectId: string;
    num: number;
    book: Pick<Craftbook, 'id' | 'paramSchema'>;
    request: { craftbookId?: string; inputs?: Record<string, TaskInputSource>; cron?: unknown };
    params: Record<string, string>;
  },
): Promise<TaskInputsPlan | null> {
  return planTaskInputs(deps, {
    projectId: args.projectId,
    craftbookId: args.request.craftbookId ?? args.book.id,
    paramSchema: args.book.paramSchema,
    params: args.params,
    ...(args.request.inputs ? { sources: args.request.inputs } : {}),
    taskDir: `tasks/${args.num}`,
    taskRef: taskRef(args.projectId, args.num),
    recurring: Boolean(args.request.cron),
  });
}

/** Write the task with its inputs committed first — and undone if either step fails. */
export async function writeTaskWithInputs(
  plan: TaskInputsPlan | null,
  write: () => Promise<void>,
): Promise<void> {
  try {
    await plan?.commit();
    await write();
  } catch (err) {
    await plan?.rollback();
    throw err;
  }
}

/** The per-input summary the `task.created` history event carries. */
export function inputsHistoryDetails(
  inputs: Record<string, TaskInputRecord>,
): Record<string, Pick<TaskInputRecord, 'from' | 'drawer' | 'path' | 'fileCount'>> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, r]) => [
      key,
      { from: r.from, drawer: r.drawer, path: r.path, fileCount: r.fileCount },
    ]),
  );
}

/**
 * Dry-run one source for the launcher: what a launch would pick up, or the
 * message it would fail with. Writes nothing.
 */
export async function previewTaskInput(
  deps: TaskInputsDeps,
  args: {
    projectId: string;
    craftbookId: string;
    paramSchema: Craftbook['paramSchema'];
    param: string;
    source: TaskInputSource;
  },
): Promise<TaskInputPreviewResponse> {
  const input = craftbookInputParams(args.paramSchema).find((i) => i.key === args.param);
  if (!input)
    throw new TaskInputError(args.param, `"${args.param}" is not an input this craftbook takes.`);
  try {
    const { enumerated } = await enumerateSource(deps, {
      projectId: args.projectId,
      craftbookId: args.craftbookId,
      input,
      source: args.source,
    });
    return {
      kind: enumerated.kind,
      drawer: enumerated.drawer,
      path: enumerated.path,
      label: enumerated.label,
      fileCount: enumerated.files.length,
      totalBytes: enumerated.totalBytes,
      skipped: enumerated.skipped,
    };
  } catch (err) {
    if (!(err instanceof TaskInputError)) throw err;
    return {
      kind: input.spec.kind,
      drawer: args.source.from === 'workspace' ? 'workspace' : 'artifacts',
      path: 'path' in args.source ? args.source.path : '',
      label: '',
      fileCount: 0,
      totalBytes: 0,
      skipped: [],
      error: err.message,
    };
  }
}
