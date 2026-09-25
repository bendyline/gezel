import type { Dirent } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type CraftbookParamInput,
  type TaskInputDrawer,
  type TaskInputManifest,
  type TaskInputSkipReason,
  effectiveInputLimits,
  inputAccepts,
  isInputJunkName,
  isOfficeDocumentPath,
  isOutsideInInternalPath,
  isReservedDiffpackArtifactPath,
  isReservedShadowArtifactPath,
  isReservedTabularArtifactPath,
  normalizeInputPath,
} from '@bendyline/gezel';
import { PathSafetyError, resolveInside } from '../../fs/safe-paths.js';
import { discoverWorkspaceFiles } from '../../workspace/file-walk.js';

/** The file set one input resolves to, before anything is written. */
export interface EnumeratedInput {
  kind: CraftbookParamInput['kind'];
  drawer: TaskInputDrawer;
  /** Drawer-relative; `.` for the drawer root. */
  path: string;
  label: string;
  files: TaskInputManifest['files'];
  skipped: TaskInputManifest['skipped'];
  totalBytes: number;
  hasOfficeDocuments: boolean;
}

/** A source the user must change before launch. The message is shown to them verbatim. */
export class TaskInputError extends Error {
  readonly code = 'task-input' as const;
  constructor(
    readonly param: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskInputError';
  }
}

const MAX_SKIPPED_LISTED = 200;

/**
 * Walk slack beyond `maxFiles`: enough to tell "a few unaccepted files mixed
 * in" from "far too big a folder" without enumerating a whole disk.
 */
const WALK_SLACK = 2_000;

interface ListedFile {
  path: string;
  size: number;
}

/**
 * A plain walk for folders gezel holds on the user's behalf (the artifacts
 * drawer, an upload's staging area). Unlike the workspace walker it applies
 * no `.gitignore` and skips no build-output names: everything here was put
 * here on purpose, and a folder called `out/` in someone's notes is content.
 * Never follows symlinks.
 */
async function walkPlainFolder(
  root: string,
  maxFiles: number,
): Promise<{ files: ListedFile[]; capped: boolean }> {
  const files: ListedFile[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (isInputJunkName(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        queue.push(childRel);
      } else if (entry.isFile()) {
        const info = await lstat(join(root, childRel)).catch(() => null);
        if (!info?.isFile()) continue;
        files.push({ path: childRel, size: info.size });
        if (files.length >= maxFiles) return { files, capped: true };
      }
    }
  }
  return { files, capped: false };
}

async function listFolder(
  drawer: TaskInputDrawer,
  abs: string,
  maxFiles: number,
): Promise<{ files: ListedFile[]; capped: boolean }> {
  if (drawer !== 'workspace') return walkPlainFolder(abs, maxFiles);
  const listing = await discoverWorkspaceFiles(abs, {
    maxFiles,
    gitTimeoutMs: 10_000,
    ignorePath: (p) => p.split('/').some((segment) => isInputJunkName(segment)),
  });
  return {
    files: listing.files.map((f) => ({ path: f.path, size: f.size })),
    capped: listing.capped,
  };
}

function joinDrawerPath(base: string, rel: string): string {
  return base === '.' ? rel : `${base}/${rel}`;
}

/**
 * Converted-document twins sit beside their source (`brief.docx` →
 * `brief_files/brief.md` in the artifacts drawer, `brief.docx_files/` for
 * outside-in editing). The source is already in the set, so its twin would
 * be the same content twice — and a model offered both may read the stale one.
 */
function isConvertedTwin(relPath: string, sourceStems: ReadonlySet<string>): boolean {
  if (isOutsideInInternalPath(relPath)) return true;
  const segments = relPath.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    if (!segment.endsWith('_files')) continue;
    const stem = [...segments.slice(0, i), segment.slice(0, -'_files'.length)].join('/');
    if (sourceStems.has(stem)) return true;
  }
  return false;
}

/** `a/brief.docx` → `a/brief`: the key a `brief_files/` twin folder names. */
function stemsOf(paths: Iterable<string>): Set<string> {
  const stems = new Set<string>();
  for (const path of paths) {
    const slash = path.lastIndexOf('/');
    const dot = path.lastIndexOf('.');
    if (dot > slash + 1) stems.add(path.slice(0, dot));
  }
  return stems;
}

function refuseReservedArtifactPath(param: string, path: string): void {
  if (
    isReservedShadowArtifactPath(path) ||
    isReservedTabularArtifactPath(path) ||
    isReservedDiffpackArtifactPath(path)
  ) {
    throw new TaskInputError(
      param,
      `"${path}" is a folder gezel maintains for itself, not source material. Pick a folder of your own files.`,
    );
  }
}

/**
 * Enumerate one in-place source — a workspace or artifacts path — against the
 * book's input spec. Nothing is copied or written. Throws `TaskInputError`
 * when the source cannot be used as-is; never silently truncates, because a
 * run that quietly worked on half the files reports success on the wrong set.
 */
export async function enumerateInPlaceInput(args: {
  param: string;
  spec: CraftbookParamInput;
  drawer: TaskInputDrawer;
  drawerRoot: string;
  path: string;
  label?: string;
}): Promise<EnumeratedInput> {
  const { param, spec, drawer, drawerRoot } = args;
  const rel = normalizeInputPath(args.path);
  const where = drawer === 'artifacts' ? 'the artifacts drawer' : 'this project';
  if (drawer === 'artifacts') {
    if (!rel) throw new TaskInputError(param, 'Pick a folder inside the artifacts drawer.');
    refuseReservedArtifactPath(param, rel);
  }
  if (!rel && spec.kind === 'file') {
    throw new TaskInputError(param, 'Pick a file, not the whole project.');
  }

  let abs = drawerRoot;
  if (rel) {
    try {
      abs = await resolveInside(drawerRoot, rel);
    } catch (err) {
      if (err instanceof PathSafetyError) {
        throw new TaskInputError(param, `"${rel}" is not a path inside ${where}.`);
      }
      throw err;
    }
  }
  const info = await stat(abs).catch(() => null);
  if (!info) throw new TaskInputError(param, `"${rel || '.'}" does not exist in ${where}.`);

  const limits = effectiveInputLimits(spec);
  const path = rel || '.';
  const label = args.label ?? (rel ? basename(rel) : 'project workspace');

  if (spec.kind === 'file') {
    if (!info.isFile()) throw new TaskInputError(param, `"${rel}" is a folder; pick one file.`);
    if (!inputAccepts(spec, rel)) {
      throw new TaskInputError(
        param,
        `"${basename(rel)}" is not a file type this craftbook reads (${spec.accept?.join(', ')}).`,
      );
    }
    if (info.size > limits.maxFileBytes) {
      throw new TaskInputError(param, `"${basename(rel)}" is larger than this craftbook accepts.`);
    }
    return {
      kind: 'file',
      drawer,
      path,
      label,
      files: [{ path: rel, name: basename(rel), bytes: info.size }],
      skipped: [],
      totalBytes: info.size,
      hasOfficeDocuments: isOfficeDocumentPath(rel),
    };
  }

  if (!info.isDirectory()) throw new TaskInputError(param, `"${rel}" is a file; pick a folder.`);
  const listing = await listFolder(drawer, abs, limits.maxFiles + WALK_SLACK);
  const sourceStems = stemsOf(listing.files.map((f) => f.path));
  const files: EnumeratedInput['files'] = [];
  const skipped: EnumeratedInput['skipped'] = [];
  let totalBytes = 0;
  const skip = (p: string, reason: TaskInputSkipReason) => {
    if (skipped.length < MAX_SKIPPED_LISTED) skipped.push({ path: p, reason });
  };
  for (const file of [...listing.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const drawerPath = rel ? joinDrawerPath(rel, file.path) : file.path;
    if (drawer === 'artifacts' && isConvertedTwin(file.path, sourceStems)) continue;
    if (!inputAccepts(spec, file.path)) {
      skip(drawerPath, 'not-accepted');
      continue;
    }
    if (file.size > limits.maxFileBytes) {
      skip(drawerPath, 'too-large');
      continue;
    }
    files.push({ path: drawerPath, name: basename(file.path), bytes: file.size });
    totalBytes += file.size;
  }

  if (listing.capped || files.length > limits.maxFiles) {
    throw new TaskInputError(
      param,
      `"${label}" holds more than ${limits.maxFiles} files this craftbook can take. Pick a smaller folder.`,
    );
  }
  if (totalBytes > limits.maxBytes) {
    throw new TaskInputError(
      param,
      `"${label}" is larger than this craftbook can take. Pick a smaller folder.`,
    );
  }
  if (files.length === 0) {
    const accepted = spec.accept ? ` (${spec.accept.join(', ')})` : '';
    throw new TaskInputError(param, `"${label}" has no files this craftbook reads${accepted}.`);
  }
  return {
    kind: 'folder',
    drawer,
    path,
    label,
    files,
    skipped,
    totalBytes,
    hasOfficeDocuments: files.some((f) => isOfficeDocumentPath(f.path)),
  };
}
