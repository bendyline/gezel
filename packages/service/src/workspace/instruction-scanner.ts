import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveredInstruction } from '@bendyline/gezel';

/**
 * Discovers the workspace-root instruction files other AI harnesses drop
 * in a repo, so gezel can adopt them as the project's `@project` gezel:
 *
 *   - `AGENTS.md`                       (cross-harness standard)
 *   - `CLAUDE.md`                       (Claude Code)
 *   - `.github/copilot-instructions.md` (GitHub Copilot)
 *
 * Files are returned in precedence order (AGENTS > CLAUDE > copilot) so
 * the sync engine can pick a winner (primary mode) or concatenate them
 * (concat mode). The `hash` lets the sync skip re-derivation when nothing
 * changed — important because the indexer re-runs every 60s.
 *
 * Pure I/O + parse, mirroring {@link discoverWorkspaceSkills}: no state,
 * no writes.
 */

/** Cap per-file content so a giant instruction file doesn't bloat the index / a system prompt. */
const MAX_CONTENT_CHARS = 64_000;

const INSTRUCTION_FILES = [
  { rel: 'AGENTS.md', origin: 'agents' as const },
  { rel: 'CLAUDE.md', origin: 'claude' as const },
  { rel: '.github/copilot-instructions.md', origin: 'copilot' as const },
];

export async function discoverInstructionFiles(
  workspaceDir: string,
): Promise<DiscoveredInstruction[]> {
  const out: DiscoveredInstruction[] = [];
  for (const entry of INSTRUCTION_FILES) {
    const abs = join(workspaceDir, entry.rel);
    let raw: string;
    let mtimeMs: number;
    try {
      const [content, st] = await Promise.all([readFile(abs, 'utf8'), stat(abs)]);
      raw = content;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    const content = raw.slice(0, MAX_CONTENT_CHARS);
    out.push({
      source: entry.rel,
      origin: entry.origin,
      content,
      hash: sha256(content),
      mtimeMs,
    });
  }
  return out;
}

/**
 * Pick the winning instruction content given the discovered files and a
 * merge mode. `primary` (default) takes the highest-precedence present
 * file verbatim; `concat` joins all present files in precedence order
 * under `## Source: <file>` headers. Returns null when none are present.
 */
export function resolveInstructionAbout(
  instructions: DiscoveredInstruction[],
  mergeMode: 'primary' | 'concat' = 'primary',
  preferred?: string,
): { content: string; sourceFile: string; hash: string } | null {
  if (instructions.length === 0) return null;
  if (mergeMode === 'concat') {
    const content = instructions
      .map((i) => `## Source: ${i.source}\n\n${i.content.trim()}`)
      .join('\n\n---\n\n');
    return { content, sourceFile: instructions[0]!.source, hash: sha256(content) };
  }
  const chosen =
    (preferred && instructions.find((i) => i.source === preferred)) || instructions[0]!;
  return { content: chosen.content, sourceFile: chosen.source, hash: chosen.hash };
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
