import {
  type CraftbookInputParam,
  craftbookInputParams,
  effectiveInputLimits,
  inputAccepts,
  inputSourceFromParamValue,
  isInputJunkName,
  isOfficeDocumentPath,
  normalizeInputPath,
  taskInputArtifactDir,
  taskInputManifestPath,
} from '../craftbook-inputs.js';
import type {
  Craftbook,
  CraftbookSample,
  TaskInputManifest,
  TaskInputPreviewResponse,
  TaskInputRecord,
  TaskInputSource,
} from '../schemas/index.js';
import { encodeText } from './files.js';
import { type PortableFileArea, listFiles, statFile } from './project-files.js';
import { projectRoot } from './projects.js';
import type { PortableRepository } from './repository.js';

/**
 * Craftbook inputs on a portable host: the same contract the desktop's
 * `tasks/inputs/resolve.ts` keeps (docs/craftbook-inputs.md), over the
 * product repository instead of a disk. A workspace or artifacts pick is read
 * in place; a book's sample is copied into the task's inputs folder in the
 * same transaction that writes the task. Files picked from the device need a
 * streamed staging area the phone does not have yet, so they are refused with
 * a message the person can act on.
 */

/** Where a portable host reads a book's bundled sample files. */
export interface PortableSampleSource {
  read(
    craftbookId: string,
    sample: CraftbookSample,
  ): Promise<Array<{ rel: string; bytes: Uint8Array }> | null>;
}

/** A source the person must change before launch; shown verbatim. */
export class PortableTaskInputError extends Error {
  readonly code = 'task-input' as const;
  constructor(
    readonly param: string,
    message: string,
  ) {
    super(message);
    this.name = 'PortableTaskInputError';
  }
}

export interface PortableTaskInputsPlan {
  records: Record<string, TaskInputRecord>;
  /** param → drawer path; merged into the launch params before interpolation. */
  params: Record<string, string>;
  /** Sample copies and manifests, written with the task. */
  writes: Map<string, Uint8Array>;
}

interface Enumerated {
  kind: CraftbookInputParam['spec']['kind'];
  drawer: 'workspace' | 'artifacts';
  path: string;
  label: string;
  from: TaskInputSource['from'];
  files: TaskInputManifest['files'];
  skipped: TaskInputManifest['skipped'];
  copies: Array<{ dest: string; bytes: Uint8Array }>;
}

function labelFor(path: string, fallback: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').at(-1) || fallback;
}

async function enumerateInPlace(
  repo: PortableRepository,
  projectId: string,
  input: CraftbookInputParam,
  area: PortableFileArea,
  rawPath: string,
): Promise<Enumerated> {
  const param = input.key;
  const path = normalizeInputPath(rawPath);
  const limits = effectiveInputLimits(input.spec);
  const drawer = area === 'artifacts' ? 'artifacts' : 'workspace';
  const stat = path ? await statFile(repo, area, projectId, path) : null;
  if (path && !stat) {
    throw new PortableTaskInputError(param, `Nothing is at "${path}" in this project.`);
  }
  const files: TaskInputManifest['files'] = [];
  const skipped: TaskInputManifest['skipped'] = [];
  if (stat && !stat.isDirectory) {
    if (!inputAccepts(input.spec, path)) {
      throw new PortableTaskInputError(
        param,
        `"${path}" is not a kind of file this craftbook reads.`,
      );
    }
    if (stat.size > limits.maxFileBytes) {
      throw new PortableTaskInputError(param, `"${path}" is too large for this craftbook.`);
    }
    files.push({ path, name: labelFor(path, path), bytes: stat.size });
  } else {
    if (input.spec.kind === 'file') {
      throw new PortableTaskInputError(param, 'This input takes one file, not a folder.');
    }
    const listing = await listFiles(repo, area, projectId, path, true);
    let total = 0;
    for (const entry of listing.entries) {
      if (entry.isDirectory) continue;
      if (isInputJunkName(entry.name)) continue;
      if (!inputAccepts(input.spec, entry.path)) {
        skipped.push({ path: entry.path, reason: 'not-accepted' });
        continue;
      }
      const size = (await statFile(repo, area, projectId, entry.path))?.size ?? 0;
      if (size > limits.maxFileBytes) {
        skipped.push({ path: entry.path, reason: 'too-large' });
        continue;
      }
      if (files.length >= limits.maxFiles || total + size > limits.maxBytes) {
        throw new PortableTaskInputError(
          param,
          'That folder holds more than this craftbook takes.',
        );
      }
      total += size;
      files.push({ path: entry.path, name: entry.name, bytes: size });
    }
    if (files.length === 0) {
      throw new PortableTaskInputError(param, 'That folder has no files this craftbook reads.');
    }
  }
  return {
    kind: input.spec.kind,
    drawer,
    path: path || '.',
    label: labelFor(path, area === 'artifacts' ? 'artifacts' : 'workspace'),
    from: area === 'artifacts' ? 'artifacts' : 'workspace',
    files,
    skipped,
    copies: [],
  };
}

async function enumerateSample(
  book: Craftbook,
  input: CraftbookInputParam,
  sampleId: string,
  samples: PortableSampleSource | undefined,
  taskDir: string,
): Promise<Enumerated> {
  const param = input.key;
  const sample = book.samples?.find((s) => s.id === sampleId && s.param === param);
  const read = sample && samples ? await samples.read(book.id, sample) : null;
  if (!sample || !read || read.length === 0) {
    throw new PortableTaskInputError(param, 'That sample is not available for this craftbook.');
  }
  if (input.spec.kind === 'file' && read.length !== 1) {
    throw new PortableTaskInputError(param, 'This input takes exactly one file.');
  }
  const dest = taskInputArtifactDir(taskDir, param);
  const files = read.map((f) => ({
    path: `${dest}/${f.rel}`,
    name: f.rel.split('/').at(-1) ?? f.rel,
    bytes: f.bytes.byteLength,
  }));
  return {
    kind: input.spec.kind,
    drawer: 'artifacts',
    path: input.spec.kind === 'file' ? files[0]!.path : dest,
    label: sample.title,
    from: 'sample',
    files,
    skipped: [],
    copies: read.map((f) => ({ dest: `${dest}/${f.rel}`, bytes: f.bytes })),
  };
}

async function enumerate(
  repo: PortableRepository,
  projectId: string,
  book: Craftbook,
  input: CraftbookInputParam,
  source: TaskInputSource,
  samples: PortableSampleSource | undefined,
  taskDir: string,
): Promise<Enumerated> {
  if (source.from === 'workspace')
    return enumerateInPlace(repo, projectId, input, 'workspace', source.path);
  if (source.from === 'artifacts')
    return enumerateInPlace(repo, projectId, input, 'artifacts', source.path);
  if (source.from === 'sample')
    return enumerateSample(book, input, source.sampleId, samples, taskDir);
  throw new PortableTaskInputError(
    input.key,
    'Files from this device cannot be used yet — put them in the project first, then pick them there.',
  );
}

/**
 * Resolve a launch's inputs against the book's declared input params. Null
 * when the book declares none. Throws `PortableTaskInputError` for anything
 * the person has to fix.
 */
export async function planPortableTaskInputs(args: {
  repo: PortableRepository;
  projectId: string;
  book: Craftbook;
  sources?: Record<string, TaskInputSource>;
  params: Record<string, string>;
  taskDir: string;
  samples?: PortableSampleSource;
  now: string;
}): Promise<PortableTaskInputsPlan | null> {
  const inputs = craftbookInputParams(args.book.paramSchema);
  const declared = new Set(inputs.map((i) => i.key));
  for (const key of Object.keys(args.sources ?? {})) {
    if (!declared.has(key)) {
      throw new PortableTaskInputError(key, `"${key}" is not an input this craftbook takes.`);
    }
  }
  if (inputs.length === 0) return null;
  const records: Record<string, TaskInputRecord> = {};
  const params: Record<string, string> = {};
  const writes = new Map<string, Uint8Array>();
  const artifacts = `${projectRoot(args.projectId)}/artifacts`;
  for (const input of inputs) {
    const source = args.sources?.[input.key] ?? inputSourceFromParamValue(args.params[input.key]);
    if (!source) {
      if (input.required) {
        throw new PortableTaskInputError(
          input.key,
          `Choose the ${input.title.toLowerCase()} this craftbook works on.`,
        );
      }
      continue;
    }
    const e = await enumerate(
      args.repo,
      args.projectId,
      args.book,
      input,
      source,
      args.samples,
      args.taskDir,
    );
    for (const copy of e.copies) writes.set(`${artifacts}/${copy.dest}`, copy.bytes);
    const manifestPath = taskInputManifestPath(args.taskDir, input.key);
    const totalBytes = e.files.reduce((sum, f) => sum + f.bytes, 0);
    const manifest: TaskInputManifest = {
      param: input.key,
      kind: e.kind,
      drawer: e.drawer,
      path: e.path,
      from: e.from,
      label: e.label,
      createdAt: args.now,
      totalBytes,
      files: e.files,
      skipped: e.skipped,
    };
    writes.set(
      `${artifacts}/${manifestPath}`,
      encodeText(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    const hasOffice = e.files.some((f) => isOfficeDocumentPath(f.path));
    records[input.key] = {
      kind: e.kind,
      drawer: e.drawer,
      path: e.path,
      from: e.from,
      label: e.label,
      manifest: manifestPath,
      fileCount: e.files.length,
      totalBytes,
      skippedCount: e.skipped.length,
      ...(hasOffice ? { hasOfficeDocuments: true } : {}),
    };
    params[input.key] = e.path;
  }
  return Object.keys(records).length > 0 ? { records, params, writes } : null;
}

/** Dry-run one input for the launcher's "37 files" line. Writes nothing. */
export async function previewPortableTaskInput(args: {
  repo: PortableRepository;
  projectId: string;
  book: Craftbook;
  param: string;
  source: TaskInputSource;
  samples?: PortableSampleSource;
}): Promise<TaskInputPreviewResponse> {
  const input = craftbookInputParams(args.book.paramSchema).find((i) => i.key === args.param);
  if (!input) {
    throw new PortableTaskInputError(
      args.param,
      `"${args.param}" is not an input this craftbook takes.`,
    );
  }
  try {
    const e = await enumerate(
      args.repo,
      args.projectId,
      args.book,
      input,
      args.source,
      args.samples,
      'tasks/preview',
    );
    return {
      kind: e.kind,
      drawer: e.drawer,
      path: e.path,
      label: e.label,
      fileCount: e.files.length,
      totalBytes: e.files.reduce((sum, f) => sum + f.bytes, 0),
      skipped: e.skipped,
    };
  } catch (error) {
    if (!(error instanceof PortableTaskInputError)) throw error;
    return {
      kind: input.spec.kind,
      drawer: args.source.from === 'workspace' ? 'workspace' : 'artifacts',
      path: 'path' in args.source ? args.source.path : '',
      label: '',
      fileCount: 0,
      totalBytes: 0,
      skipped: [],
      error: error.message,
    };
  }
}
