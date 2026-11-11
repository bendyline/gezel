import { constants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type ReferencedFile, type Task, taskDeliverableCandidates } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { CliError } from './connection.js';

type ArtifactClient = Pick<GezelClient, 'listProjectArtifacts' | 'fetchProjectArtifactBlob'>;
type OutputClient = Pick<GezelClient, 'listProjectArtifacts' | 'resolveReferenceFileLocation'>;

/**
 * What a task made, from a listing of its folder in the artifacts drawer
 * (`artifacts/tasks/<num>/`): drawer-relative `path` and folder-relative
 * `name`. Its `inputs/` are the person's own files coming back, so they stay
 * out, and nothing whose path leaves the folder counts.
 */
function madeFiles(
  files: ReadonlyArray<{ path: string; isDirectory?: boolean }>,
  artifactDir: string,
): Array<{ path: string; name: string }> {
  const made: Array<{ path: string; name: string }> = [];
  for (const file of files) {
    if (file.isDirectory) continue;
    const name = relative(artifactDir, file.path).split(sep).join('/');
    if (!name || name.startsWith('..') || isAbsolute(name)) continue;
    if (name === 'inputs' || name.startsWith('inputs/')) continue;
    made.push({ path: file.path, name });
  }
  return made;
}

/**
 * Copy what a finished task made into a folder the person chose:
 * `gezel do <book> --out ./gezel-out`. Reads go through the API, so it works
 * against a daemon on another filesystem — a container — exactly as against a
 * local one.
 */
export async function copyTaskOutput(
  client: ArtifactClient,
  projectId: string,
  artifactDir: string,
  outDir: string,
): Promise<string[]> {
  const root = resolve(outDir);
  const listing = await client.listProjectArtifacts(projectId, artifactDir, true);
  const copied: string[] = [];
  for (const { path, name } of madeFiles(listing.files, artifactDir)) {
    const target = join(root, name);
    // A listing is the daemon's word; never write outside the folder asked for.
    if (relative(root, target).startsWith('..')) continue;
    const blob = await client.fetchProjectArtifactBlob(projectId, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await blob.arrayBuffer()));
    copied.push(name);
  }
  if (listing.truncated) {
    throw new CliError(
      `The task made more files than one listing returns; ${copied.length} were copied to ${root}. Open the rest from the task's folder in Gezel.`,
    );
  }
  return copied;
}

export interface TaskOutputFile {
  /** In the project's artifacts drawer, or in the project's own folder. */
  kind: ReferencedFile['kind'];
  /** Relative to the drawer or the folder, as Gezel names it. */
  relativePath: string;
  /** Absolute path on the computer running the Gezel service; null when it could not say. */
  path: string | null;
  /**
   * Whether this command can open `path`. False when the service is remote, in
   * a container, or a machine service whose home only it can read.
   */
  readable: boolean;
  /** The file the person asked for, as the book's own steps promise it. */
  deliverable: boolean;
}

export interface TaskOutput {
  /** The task's folder, drawer-relative (`tasks/<num>`). */
  folderRelativePath: string | null;
  /** The task's folder, absolute on the computer running the Gezel service. */
  folder: string | null;
  folderReadable: boolean;
  /** The deliverable first, then everything else in the task's folder. */
  files: TaskOutputFile[];
}

/** Absolute paths are looked up one request each; a task rarely makes more. */
const LOCATE_LIMIT = 100;

/**
 * Where a finished task's result is. The deliverable comes from
 * `taskDeliverableCandidates`, the ranking the app's completion card uses: a
 * file the book's steps promise outranks its working papers (`scope.md`,
 * `verdict.md`). Paths are the service's own answer, so they are right for a
 * home this command never sees.
 */
export async function describeTaskOutput(
  client: OutputClient,
  task: Task,
  canRead: (path: string) => Promise<boolean> = readableHere,
): Promise<TaskOutput> {
  const folderRelativePath = task.artifactDir ?? null;
  const made = folderRelativePath
    ? madeFiles(
        (await client.listProjectArtifacts(task.projectId, folderRelativePath, true)).files,
        folderRelativePath,
      )
    : [];
  const madePaths = new Set(made.map((file) => file.path.toLowerCase()));
  const locate = async (file: ReferencedFile): Promise<string | null> =>
    client
      .resolveReferenceFileLocation(task.projectId, file)
      .then((located) => located.path)
      .catch(() => null);

  let deliverable: { file: ReferencedFile; path: string | null } | null = null;
  // A book can promise a file its run never made, so take the best that exists.
  for (const candidate of taskDeliverableCandidates(
    task,
    made.map((file) => ({ kind: 'artifact' as const, path: file.path })),
  ).slice(0, 5)) {
    if (candidate.kind === 'artifact') {
      if (!madePaths.has(candidate.path.toLowerCase())) continue;
      deliverable = { file: candidate, path: await locate(candidate) };
      break;
    }
    const path = await locate(candidate);
    if (path) {
      deliverable = { file: candidate, path };
      break;
    }
  }

  const files: TaskOutputFile[] = [];
  const add = async (file: ReferencedFile, path: string | null, isDeliverable: boolean) =>
    files.push({
      kind: file.kind,
      relativePath: file.path,
      path,
      readable: path !== null && (await canRead(path)),
      deliverable: isDeliverable,
    });
  if (deliverable) await add(deliverable.file, deliverable.path, true);
  let folder: string | null = null;
  for (const file of made) {
    const ref: ReferencedFile = { kind: 'artifact', path: file.path };
    if (deliverable?.file.kind === 'artifact' && sameFile(deliverable.file.path, file.path)) {
      folder ??= hostFolder(deliverable.path, file.name);
      continue;
    }
    const path = files.length < LOCATE_LIMIT ? await locate(ref) : null;
    folder ??= hostFolder(path, file.name);
    await add(ref, path, false);
  }
  return {
    folderRelativePath,
    folder,
    folderReadable: folder !== null && (await canRead(folder)),
    files,
  };
}

/** The same description once `--out` has copied the task's folder to `outDir`. */
export function withCopiedOutput(output: TaskOutput, outDir: string): TaskOutput {
  const folder = resolve(outDir);
  const prefix = output.folderRelativePath ? `${output.folderRelativePath}/` : null;
  return {
    ...output,
    folder,
    folderReadable: true,
    files: output.files.map((file) =>
      file.kind === 'artifact' && prefix && file.relativePath.startsWith(prefix)
        ? {
            ...file,
            path: join(folder, ...file.relativePath.slice(prefix.length).split('/')),
            readable: true,
          }
        : file,
    ),
  };
}

/**
 * What a person reads after a task completes: the result's path, what else
 * the task made, and (on stderr, unless they already used it) how to copy it
 * all next to them.
 */
export function formatTaskOutput(
  output: TaskOutput,
  ref: string,
  opts: { copied?: boolean } = {},
): { lines: string[]; hint: string | null } {
  const lines: string[] = [];
  const result = output.files.find((file) => file.deliverable);
  if (result) {
    lines.push(
      result.readable && result.path
        ? `Result: ${result.path}`
        : `Result: ${result.relativePath}, kept by the Gezel service`,
    );
  }
  const prefix = output.folderRelativePath ? `${output.folderRelativePath}/` : '';
  const others = output.files
    .filter((file) => !file.deliverable && file.kind === 'artifact')
    .map((file) =>
      prefix && file.relativePath.startsWith(prefix)
        ? file.relativePath.slice(prefix.length)
        : file.relativePath,
    );
  if (others.length > 0) {
    const shown =
      others.length > 6 ? [...others.slice(0, 5), `and ${others.length - 5} more`] : others;
    lines.push(`${result ? 'Also made' : 'Made'}: ${shown.join(', ')}`);
  }
  const inFolder = output.files.some((file) => file.kind === 'artifact');
  if (inFolder && output.folder && output.folderReadable) lines.push(`Folder: ${output.folder}`);
  const hint =
    inFolder && !opts.copied
      ? `${output.folderReadable ? 'Copy them next to you' : 'They are kept by the Gezel service; copy them here'} with \`gezel task wait ${ref} --out <folder>\`.`
      : null;
  return { lines, hint };
}

function sameFile(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The task folder's absolute path, from one file's absolute path and its name
 * inside the folder. The path is the service's, so either separator may appear.
 */
export function hostFolder(path: string | null, nameInFolder: string): string | null {
  if (!path) return null;
  let end = path.length;
  for (let depth = nameInFolder.split('/').length; depth > 0; depth -= 1) {
    end = Math.max(path.lastIndexOf('/', end - 1), path.lastIndexOf('\\', end - 1));
    if (end <= 0) return null;
  }
  return path.slice(0, end);
}

async function readableHere(path: string): Promise<boolean> {
  return access(path, constants.R_OK).then(
    () => true,
    () => false,
  );
}
