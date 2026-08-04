import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectFileEntry } from '@bendyline/gezel';
import { type ExternalFolders, projectArtifactsDir } from '@bendyline/gezel/paths';
import { writeFileAtomic } from './atomic.js';
import { mimeTypeForFilename } from './media-types.js';
import { safeJoin } from './safe-paths.js';
import {
  type WalkDirResult,
  listDirEntries,
  safeReadTextFile,
  safeResolveRead,
  walkDir,
  walkDirDetailed,
} from './tree.js';

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

  async listProjectArtifacts(id: string, subpath = ''): Promise<ProjectFileEntry[]> {
    return listDirEntries(this.projectArtifactsDir(id), subpath);
  }

  async listProjectArtifactsRecursive(
    id: string,
    opts?: { withStats?: boolean },
  ): Promise<ProjectFileEntry[]> {
    return (await this.listProjectArtifactsRecursiveDetailed(id, opts)).entries;
  }

  async listProjectArtifactsRecursiveDetailed(
    id: string,
    opts?: { withStats?: boolean },
  ): Promise<WalkDirResult> {
    return walkDirDetailed(
      this.projectArtifactsDir(id),
      opts?.withStats ? { withStats: true } : {},
    );
  }

  async readProjectArtifact(id: string, filePath: string): Promise<string | null> {
    return safeReadTextFile(this.projectArtifactsDir(id), filePath);
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
    const all = await walkDir(base);
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

  async writeProjectArtifact(id: string, filePath: string, content: string): Promise<void> {
    const base = this.projectArtifactsDir(id);
    const cleaned = normalizeArtifactPath(filePath);
    if (!cleaned) throw new Error('empty artifact path');
    const full = safeJoin(base, cleaned);
    if (!full) throw new Error('path traversal blocked');
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, content);
    await this.touchProject(id);
  }

  async writeProjectArtifactBinary(id: string, filePath: string, data: Buffer): Promise<string> {
    const base = this.projectArtifactsDir(id);
    const cleaned = normalizeArtifactPath(filePath);
    if (!cleaned) throw new Error('empty artifact path');
    const full = safeJoin(base, cleaned);
    if (!full) throw new Error('path traversal blocked');
    await mkdir(dirname(full), { recursive: true });
    await writeFileAtomic(full, data);
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
}

/**
 * Strip leading `./`, `/`, and repeated `artifacts/` prefixes. Defense
 * in depth: the MCP layer already strips these, but direct HTTP callers
 * that pass the full prefix would otherwise create `artifacts/artifacts/`.
 */
function normalizeArtifactPath(p: string): string {
  let out = p.replace(/^\.?\/+/, '').trim();
  while (/^artifacts\/+/i.test(out)) out = out.replace(/^artifacts\/+/i, '');
  return out;
}
