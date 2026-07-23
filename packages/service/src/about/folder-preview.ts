import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectFolderPreviewResponse } from '@bendyline/gezel';

/**
 * Agent-doc filenames we look for at a folder's root to pre-fill a new
 * project's About. Compared case-insensitively, so `AGENTS.md`, `Claude.md`,
 * etc. all match. When several exist we pick the one with the most content —
 * a `CLAUDE.md` that just `@import`s `AGENTS.md` is nearly empty, so the doc
 * that actually carries the guidance wins.
 */
const AGENT_DOC_NAMES = new Set(['agents.md', 'claude.md', 'agent.md']);

/**
 * About is injected verbatim into every system prompt for the project, so cap
 * how much of a long agent doc we pull in. The user can trim it further in the
 * (optional) About field before creating.
 */
const ABOUT_CAP = 4000;

/** Last path segment, tolerating either separator and trailing slashes. */
export function folderBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/**
 * Peek at a folder before it becomes a project: derive the suggested name from
 * its basename and, when the folder holds an agent doc at its root, read that
 * doc into About. Never throws — an unreadable or missing folder still yields a
 * usable name so the dialog can populate.
 */
export async function previewFolder(path: string): Promise<ProjectFolderPreviewResponse> {
  const name = folderBaseName(path);
  let entries: string[];
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return { name };
    entries = await readdir(path);
  } catch {
    return { name };
  }
  const candidates = entries.filter((entry) => AGENT_DOC_NAMES.has(entry.toLowerCase()));
  let best: { file: string; content: string } | null = null;
  for (const file of candidates) {
    try {
      const content = await readFile(join(path, file), 'utf8');
      if (!best || content.length > best.content.length) best = { file, content };
    } catch {
      /* unreadable individual doc — skip it */
    }
  }
  const trimmed = best?.content.trim() ?? '';
  if (!best || !trimmed) return { name };
  const about =
    trimmed.length > ABOUT_CAP
      ? `${trimmed.slice(0, ABOUT_CAP).trimEnd()}\n\n…(truncated)`
      : trimmed;
  return { name, about, source: best.file };
}
