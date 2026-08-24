import type { Stats } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import type { ProjectFileEntry } from '@bendyline/gezel';
import { isReservedDiffpackArtifactPath, isReservedShadowArtifactPath } from '@bendyline/gezel';
import {
  type ExternalFolders,
  PROJECT_SHADOW_DIR_NAME,
  projectArtifactsDir,
} from '@bendyline/gezel/paths';
import { writeFileAtomic } from './atomic.js';
import { mimeTypeForFilename } from './media-types.js';
import { assertNoTemplatePlaceholderPath, safeJoin } from './safe-paths.js';
import {
  type WalkDirResult,
  listDirEntries,
  safeReadTextFile,
  safeResolveRead,
  safeStatFileSize,
  walkDir,
  walkDirDetailed,
} from './tree.js';

// Artifact drawers routinely contain connector corpora whose record count is
// larger than the generic workspace/prompt walk budget. Keep the generic
// walker conservative while giving project-owned artifacts enough headroom for
// complete corpus and completion-gate enumeration.
const ARTIFACT_WALK_MAX_ENTRIES = 5_000;

export type ProjectArtifactResolveResult =
  | { kind: 'found'; content: string; path: string; fuzzy: boolean }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'missing' };

export type ProjectArtifactSliceResult =
  | {
      kind: 'found';
      content: string;
      path: string;
      fuzzy: boolean;
      linesReturned: number;
      totalLines: number;
      bytesReturned: number;
      totalBytes: number;
      hasMore: boolean;
    }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'missing' };

export type ProjectArtifactGrepResult =
  | {
      kind: 'found';
      matches: Array<{
        lineNumber: number;
        line: string;
        contextBefore?: string[];
        contextAfter?: string[];
      }>;
      totalMatches: number;
      totalLines: number;
      truncated: boolean;
      path: string;
      fuzzy: boolean;
    }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'missing' }
  | { kind: 'invalid-pattern'; error: string };

export interface ProjectArtifactsStoreOptions {
  home: string;
  external?: ExternalFolders;
  touchProject: (projectId: string) => Promise<void>;
}

export class ConnectorCorpusWriteDeniedError extends Error {
  readonly code = 'connector-corpus-readonly' as const;
  constructor() {
    super(
      'The artifacts/data directory contains read-only connector mirrors. Editing or deleting a synced record can cause permanent data loss because its cursor has already advanced.',
    );
    this.name = 'ConnectorCorpusWriteDeniedError';
  }
}

/**
 * The drafted tree and the sealed diffs of a diffpack are machine-owned: the
 * draft store writes `after/`, the sealer writes `files/`, and both go
 * straight to disk. A `write_artifact` landing here would let a model forge a
 * change set it never drafted — the one thing the review surface has to be
 * able to trust. `notes.md` beside them stays writable.
 */
export class DiffpackPathWriteDeniedError extends Error {
  readonly code = 'diffpack-readonly' as const;
  constructor() {
    super(
      "A change proposal's after/ and files/ folders are written by the runtime, not by tools. Use the workspace edit tools while drafting; write your explanation to the pack's notes.md.",
    );
    this.name = 'DiffpackPathWriteDeniedError';
  }
}

export class ShadowPathWriteDeniedError extends Error {
  readonly code = 'shadow-readonly' as const;
  constructor() {
    super(
      'artifacts/shadow/ is the derived shadow-file cache (converted documents, descriptions, transcripts), regenerated automatically by indexing. Write your file elsewhere in artifacts.',
    );
    this.name = 'ShadowPathWriteDeniedError';
  }
}

export class ArtifactPathNotFoundError extends Error {
  readonly code = 'artifact-not-found' as const;
  constructor(path: string) {
    super(`artifact not found: ${path}`);
    this.name = 'ArtifactPathNotFoundError';
  }
}

export class ArtifactPathExistsError extends Error {
  readonly code = 'artifact-exists' as const;
  constructor(path: string) {
    super(`an artifact already exists at ${path}`);
    this.name = 'ArtifactPathExistsError';
  }
}

/**
 * Owns the project-level artifacts tree.
 *
 * Store remains the public facade for callers. Keeping the artifact-specific
 * fuzzy lookup, slicing, grep, and write-touch behavior here stops Store from
 * absorbing another complete file-browser implementation.
 */
export class ProjectArtifactsStore {
  private readonly home: string;
  private readonly external?: ExternalFolders;
  private readonly touchProject: (projectId: string) => Promise<void>;

  constructor(opts: ProjectArtifactsStoreOptions) {
    this.home = opts.home;
    this.external = opts.external;
    this.touchProject = opts.touchProject;
  }

  projectArtifactsDir(id: string): string {
    return projectArtifactsDir(this.home, id, this.external);
  }

  async listProjectArtifacts(
    id: string,
    subpath = '',
    opts?: { includeHidden?: boolean },
  ): Promise<ProjectFileEntry[]> {
    const entries = await listDirEntries(this.projectArtifactsDir(id), subpath, {
      includeHidden: opts?.includeHidden === true,
    });
    // The reserved shadow cache stays out of listings (it would drown real
    // artifacts); explicit-path reads under shadow/ still work. `includeHidden`
    // is the user asking to see it anyway.
    if (subpath !== '' || opts?.includeHidden) return entries;
    return entries.filter((e) => !(e.isDirectory && e.name === PROJECT_SHADOW_DIR_NAME));
  }

  async listProjectArtifactsRecursive(
    id: string,
    opts?: { withStats?: boolean; includeHidden?: boolean; subpath?: string },
  ): Promise<ProjectFileEntry[]> {
    return (await this.listProjectArtifactsRecursiveDetailed(id, opts)).entries;
  }

  /**
   * Recursive artifact walk, optionally rooted at `subpath`.
   *
   * `subpath` is not a post-filter: the walk starts inside the subtree, so a
   * caller asking for one connector corpus is not competing with the rest of
   * the drawer for the walker's entry budget. Filtering a root-rooted walk
   * instead would return a truncated slice of a truncated listing — which is
   * how a 509-file PR corpus came back as 485 entries under a drawer-wide cap
   * and a scoped request silently looked complete. Entry paths stay relative
   * to the artifacts root either way, so every result is directly readable.
   */
  async listProjectArtifactsRecursiveDetailed(
    id: string,
    opts?: { withStats?: boolean; includeHidden?: boolean; subpath?: string },
  ): Promise<WalkDirResult> {
    const root = this.projectArtifactsDir(id);
    const subpath = normalizeArtifactPath(opts?.subpath ?? '').replace(/\/+$/, '');
    const base = subpath === '' ? root : safeJoin(root, subpath);
    if (base === null) return { entries: [], truncated: false };
    const walked = await walkDirDetailed(base, {
      maxEntries: ARTIFACT_WALK_MAX_ENTRIES,
      ...(opts?.withStats ? { withStats: true } : {}),
      ...(opts?.includeHidden ? { includeHidden: true } : {}),
      // The reserved shadow cache only exists at the drawer root; scoping the
      // walk into a subtree makes a same-named folder there an ordinary one.
      ...(subpath === '' ? { skipRootDirs: SHADOW_SKIP } : {}),
    });
    if (subpath === '') return walked;
    return {
      ...walked,
      entries: walked.entries.map((entry) => ({ ...entry, path: `${subpath}/${entry.path}` })),
    };
  }

  async readProjectArtifact(id: string, filePath: string): Promise<string | null> {
    return safeReadTextFile(this.projectArtifactsDir(id), filePath);
  }

  /** On-disk byte size of an artifact, or null when it is not a readable file. */
  async projectArtifactSize(id: string, filePath: string): Promise<number | null> {
    return safeStatFileSize(this.projectArtifactsDir(id), filePath);
  }

  async readProjectArtifactBinary(
    id: string,
    filePath: string,
  ): Promise<{ data: Buffer; mimeType: string } | null> {
    const base = this.projectArtifactsDir(id);
    const cleaned = normalizeArtifactPath(filePath);
    if (!cleaned) return null;
    const full = await safeResolveRead(base, cleaned);
    if (!full) return null;
    try {
      const data = await readFile(full);
      return { data, mimeType: mimeTypeForFilename(cleaned) };
    } catch {
      return null;
    }
  }

  async resolveProjectArtifact(
    id: string,
    filePath: string,
  ): Promise<ProjectArtifactResolveResult> {
    const base = this.projectArtifactsDir(id);
    const cleaned = normalizeArtifactPath(filePath);
    if (!cleaned) return { kind: 'missing' };
    const exact = await safeReadTextFile(base, cleaned);
    if (exact !== null) {
      return { kind: 'found', content: exact, path: cleaned, fuzzy: false };
    }
    const targetBase = cleaned.split('/').pop()?.toLowerCase() ?? '';
    if (!targetBase) return { kind: 'missing' };
    // Shadow twins must not hijack fuzzy basename lookups — a converted
    // `architecture.md` would otherwise shadow the artifact the model meant.
    const all = await walkDir(base, { skipRootDirs: SHADOW_SKIP });
    const matches = all.filter((e) => !e.isDirectory && e.name.toLowerCase() === targetBase);
    if (matches.length === 1) {
      const hit = matches[0]!;
      const content = await safeReadTextFile(base, hit.path);
      if (content === null) return { kind: 'missing' };
      return { kind: 'found', content, path: hit.path, fuzzy: true };
    }
    if (matches.length > 1) {
      return { kind: 'ambiguous', candidates: matches.map((m) => m.path) };
    }
    return { kind: 'missing' };
  }

  async readProjectArtifactSlice(
    id: string,
    filePath: string,
    opts?: {
      lines?: { start: number; count: number };
      head?: number;
      tail?: number;
    },
  ): Promise<ProjectArtifactSliceResult> {
    const resolved = await this.resolveProjectArtifact(id, filePath);
    if (resolved.kind !== 'found') return resolved;
    const full = resolved.content;
    // Single normalize-then-split pass. We compute totalLines once;
    // if the model paginates, each call repeats this work, but at
    // realistic artifact sizes (single-digit MB) the cost is
    // sub-millisecond. Optimize when we see real >10 MB artifacts.
    const allLines = full.split('\n');
    const totalLines = allLines.length;
    const totalBytes = full.length;

    let sliceContent = full;
    let linesReturned = totalLines;
    let hasMore = false;

    if (opts?.lines) {
      const { start, count } = opts.lines;
      // 1-indexed start, inclusive. Clamp to the file's line range.
      const startIdx = Math.max(1, Math.floor(start)) - 1;
      const endIdx = Math.min(totalLines, startIdx + Math.max(0, Math.floor(count)));
      const slice = allLines.slice(startIdx, endIdx);
      sliceContent = slice.join('\n');
      linesReturned = slice.length;
      hasMore = endIdx < totalLines || startIdx > 0;
    } else if (typeof opts?.head === 'number') {
      const n = Math.max(0, Math.floor(opts.head));
      const slice = allLines.slice(0, n);
      sliceContent = slice.join('\n');
      linesReturned = slice.length;
      hasMore = n < totalLines;
    } else if (typeof opts?.tail === 'number') {
      const n = Math.max(0, Math.floor(opts.tail));
      const startIdx = Math.max(0, totalLines - n);
      const slice = allLines.slice(startIdx);
      sliceContent = slice.join('\n');
      linesReturned = slice.length;
      hasMore = startIdx > 0;
    }

    return {
      kind: 'found',
      content: sliceContent,
      path: resolved.path,
      fuzzy: resolved.fuzzy,
      linesReturned,
      totalLines,
      bytesReturned: sliceContent.length,
      totalBytes,
      hasMore,
    };
  }

  async grepProjectArtifact(
    id: string,
    filePath: string,
    opts: {
      pattern: string;
      caseInsensitive?: boolean;
      contextLines?: number;
      maxMatches?: number;
    },
  ): Promise<ProjectArtifactGrepResult> {
    const resolved = await this.resolveProjectArtifact(id, filePath);
    if (resolved.kind !== 'found') return resolved;
    const flags = opts.caseInsensitive === false ? '' : 'i';
    let re: RegExp;
    try {
      re = new RegExp(opts.pattern, flags);
    } catch (err) {
      return { kind: 'invalid-pattern', error: err instanceof Error ? err.message : String(err) };
    }
    const lines = resolved.content.split('\n');
    const totalLines = lines.length;
    const contextLines = Math.max(0, Math.min(10, opts.contextLines ?? 0));
    const maxMatches = Math.max(1, Math.min(100, opts.maxMatches ?? 20));
    const matches: Array<{
      lineNumber: number;
      line: string;
      contextBefore?: string[];
      contextAfter?: string[];
    }> = [];
    let totalMatches = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!re.test(line)) continue;
      totalMatches += 1;
      if (matches.length >= maxMatches) continue;
      const entry: {
        lineNumber: number;
        line: string;
        contextBefore?: string[];
        contextAfter?: string[];
      } = {
        lineNumber: i + 1,
        line,
      };
      if (contextLines > 0) {
        entry.contextBefore = lines.slice(Math.max(0, i - contextLines), i);
        entry.contextAfter = lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines));
      }
      matches.push(entry);
    }
    return {
      kind: 'found',
      matches,
      totalMatches,
      totalLines,
      truncated: totalMatches > matches.length,
      path: resolved.path,
      fuzzy: resolved.fuzzy,
    };
  }

  async writeProjectArtifact(
    id: string,
    filePath: string,
    content: string,
    opts?: { initiatedByGezel?: boolean },
  ): Promise<void> {
    const base = this.projectArtifactsDir(id);
    const cleaned = normalizeArtifactPath(filePath);
    if (!cleaned) throw new Error('empty artifact path');
    assertNoTemplatePlaceholderPath(cleaned);
    if (opts?.initiatedByGezel && isProtectedConnectorCorpusPath(cleaned)) {
      throw new ConnectorCorpusWriteDeniedError();
    }
    // Unconditional (unlike the gezel-only corpus guard): the shadow cache's
    // only legitimate writer is the indexer's converter, which bypasses this
    // store entirely, so every write arriving here is a mistake.
    if (isReservedShadowArtifactPath(cleaned)) throw new ShadowPathWriteDeniedError();
    if (isReservedDiffpackArtifactPath(cleaned)) throw new DiffpackPathWriteDeniedError();
    const full = safeJoin(base, cleaned);
    if (!full) throw new Error('path traversal blocked');
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, content);
    await this.touchProject(id);
  }

  async writeProjectArtifactBinary(
    id: string,
    filePath: string,
    data: Buffer,
    options?: { createOnly?: boolean },
  ): Promise<string> {
    const base = this.projectArtifactsDir(id);
    const cleaned = normalizeArtifactPath(filePath);
    if (!cleaned) throw new Error('empty artifact path');
    assertNoTemplatePlaceholderPath(cleaned);
    if (isReservedShadowArtifactPath(cleaned)) throw new ShadowPathWriteDeniedError();
    if (isReservedDiffpackArtifactPath(cleaned)) throw new DiffpackPathWriteDeniedError();
    const full = safeJoin(base, cleaned);
    if (!full) throw new Error('path traversal blocked');
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, data, { noReplace: options?.createOnly });
    await this.touchProject(id);
    return cleaned;
  }

  async deleteProjectArtifact(id: string, filePath: string): Promise<void> {
    const base = this.projectArtifactsDir(id);
    const cleaned = normalizeArtifactPath(filePath);
    if (!cleaned) return;
    const full = safeJoin(base, cleaned);
    if (!full) throw new Error('path traversal blocked');
    await rm(full, { recursive: true, force: true });
    await this.touchProject(id);
  }

  async createProjectArtifactFolder(id: string, folderPath: string): Promise<string> {
    const base = this.projectArtifactsDir(id);
    const cleaned = normalizeArtifactPath(folderPath);
    if (!cleaned) throw new Error('empty artifact path');
    assertNoTemplatePlaceholderPath(cleaned);
    if (isReservedShadowArtifactPath(cleaned)) throw new ShadowPathWriteDeniedError();
    if (isReservedDiffpackArtifactPath(cleaned)) throw new DiffpackPathWriteDeniedError();
    const full = safeJoin(base, cleaned);
    if (!full) throw new Error('path traversal blocked');
    await mkdir(full, { recursive: true });
    await this.touchProject(id);
    return cleaned;
  }

  /**
   * Move/rename within the artifacts drawer. Same refusals as the documents
   * library — the drawer root, a folder into its own subtree, and overwriting
   * an existing path — so a rename can never silently destroy an artifact.
   */
  async renameProjectArtifactPath(
    id: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ fromPath: string; toPath: string }> {
    const base = this.projectArtifactsDir(id);
    const from = normalizeArtifactPath(fromPath);
    const to = normalizeArtifactPath(toPath);
    if (!from || !to) throw new Error('the artifacts root cannot be renamed');
    assertNoTemplatePlaceholderPath(to);
    if (isReservedShadowArtifactPath(from) || isReservedShadowArtifactPath(to)) {
      throw new ShadowPathWriteDeniedError();
    }
    const fromFull = safeJoin(base, from);
    const toFull = safeJoin(base, to);
    if (!fromFull || !toFull) throw new Error('path traversal blocked');
    if (fromFull === toFull) return { fromPath: from, toPath: to };

    let sourceStat: Stats;
    try {
      sourceStat = await stat(fromFull);
    } catch {
      throw new ArtifactPathNotFoundError(from);
    }
    if (await pathExists(toFull)) throw new ArtifactPathExistsError(to);
    if (sourceStat.isDirectory()) {
      const relativeTarget = relative(fromFull, toFull);
      if (relativeTarget && !relativeTarget.startsWith('..') && !isAbsolute(relativeTarget)) {
        throw new Error('a folder cannot be moved inside itself');
      }
    }
    await mkdir(dirname(toFull), { recursive: true });
    await rename(fromFull, toFull);
    await this.touchProject(id);
    return { fromPath: from, toPath: to };
  }
}

async function pathExists(full: string): Promise<boolean> {
  try {
    await stat(full);
    return true;
  } catch {
    return false;
  }
}

const SHADOW_SKIP: ReadonlySet<string> = new Set([PROJECT_SHADOW_DIR_NAME]);

/**
 * Strip leading `./`, `/`, and repeated `artifacts/` prefixes. Defense
 * in depth: the MCP layer already strips these, but direct HTTP callers
 * that pass the full prefix would otherwise create `artifacts/artifacts/`.
 *
 * Exported for the reference routes, which join a caller-supplied path
 * under the artifacts root themselves instead of going through this
 * store — a References-pane path carrying the drawer prefix (models copy
 * it out of craftbook corpus scopes) resolved to `artifacts/artifacts/…`
 * and 404'd on a file that was plainly on disk.
 */
export function normalizeArtifactPath(p: string): string {
  let out = p.replace(/^\.?\/+/, '').trim();
  while (/^artifacts\/+/i.test(out)) out = out.replace(/^artifacts\/+/i, '');
  return out;
}

function isProtectedConnectorCorpusPath(path: string): boolean {
  const segments = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');
  const collapsed: string[] = [];
  for (const segment of segments) {
    if (segment === '..') collapsed.pop();
    else collapsed.push(segment);
  }
  if (collapsed[0]?.toLowerCase() !== 'data') return false;
  return !collapsed.slice(1).some((segment) => segment.startsWith('_'));
}
