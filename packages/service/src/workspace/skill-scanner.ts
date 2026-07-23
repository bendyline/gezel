import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { DiscoveredSkill, SkillFileRef } from '@bendyline/gezel';
import { parseSkillDoc } from '@bendyline/gezel';

/**
 * Discovers gstack-style skills inside a project workspace. Skills are
 * Markdown files named `SKILL.md` (case-sensitive) that live under one
 * of the canonical install paths:
 *
 *   - `.claude/skills/<name>/SKILL.md`   (Claude Code's convention)
 *   - `.gstack/skills/<name>/SKILL.md`   (gstack's own install path)
 *   - `agents/skills/<name>/SKILL.md`    (OpenAI Codex / generic agents)
 *
 * Parsing is the pure core parser (`parseSkillDoc`): real YAML
 * frontmatter, generated-preamble stripping (gstack SKILL.md files carry
 * 2-5x their authored size in injected host preamble), telemetry-fence
 * dropping. The body cap applies AFTER stripping so a 97KB generated
 * office-hours file keeps its full ~30KB authored procedure. One level
 * of companion dirs (sections/, references/, templates/, scripts/,
 * bin/) is listed — never read — so converted craftbooks can cite the
 * paths.
 */

/** Cap per-skill body size so a runaway SKILL.md doesn't bloat the index. */
const MAX_BODY_CHARS = 64_000;

/** Subtrees we never descend into when looking for skill folders. */
const SKILL_PARENT_DIRS = [
  { rel: '.claude/skills', origin: 'claude' as const },
  { rel: '.gstack/skills', origin: 'gstack' as const },
  { rel: 'agents/skills', origin: 'agents' as const },
];

const COMPANION_DIRS: Array<{ dir: string; kind: SkillFileRef['kind'] }> = [
  { dir: 'sections', kind: 'section' },
  { dir: 'references', kind: 'reference' },
  { dir: 'templates', kind: 'template' },
  { dir: 'scripts', kind: 'script' },
  { dir: 'bin', kind: 'bin' },
];

export async function discoverWorkspaceSkills(workspaceDir: string): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];
  for (const parent of SKILL_PARENT_DIRS) {
    const parentAbs = join(workspaceDir, parent.rel);
    let entries: string[];
    try {
      entries = await readdir(parentAbs);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(parentAbs, name);
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const skillFile = join(dir, 'SKILL.md');
      let raw: string;
      try {
        raw = await readFile(skillFile, 'utf8');
      } catch {
        continue;
      }
      const files = await listCompanionFiles(dir);
      const parsed = parseSkillFile(raw, name, files);
      out.push({
        name: parsed.name,
        source: relative(workspaceDir, skillFile),
        origin: parent.origin,
        ...(parsed.description ? { description: parsed.description } : {}),
        ...(parsed.triggers && parsed.triggers.length > 0 ? { triggers: parsed.triggers } : {}),
        ...(parsed.version ? { version: parsed.version } : {}),
        body: parsed.body.slice(0, MAX_BODY_CHARS),
        ...(parsed.generated ? { generated: true } : {}),
        hasShellScripts: parsed.hasShellScripts,
        ...(parsed.files.length > 0 ? { files: parsed.files } : {}),
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

interface ParsedSkill {
  name: string;
  description?: string;
  triggers?: string[];
  version?: string;
  generated: boolean;
  body: string;
  hasShellScripts: boolean;
  files: SkillFileRef[];
}

/**
 * Parse a SKILL.md file — a thin service-shape wrapper over the core
 * `parseSkillDoc` (real YAML, preamble stripping, telemetry-fence drop).
 * The heavy lifting and its edge cases are tested in core; this wrapper
 * exists so the scanner's callers keep a stable, minimal shape.
 */
export function parseSkillFile(
  raw: string,
  fallbackName: string,
  files: SkillFileRef[] = [],
): ParsedSkill {
  const doc = parseSkillDoc(raw.replace(/^﻿/, ''), { fallbackName, files });
  return {
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    ...(doc.triggers.length > 0 ? { triggers: doc.triggers } : {}),
    ...(doc.version ? { version: doc.version } : {}),
    generated: doc.generated,
    body: doc.body,
    hasShellScripts: /```(?:bash|sh|shell|zsh)\b/i.test(doc.body),
    files: doc.files,
  };
}

/** One directory level of each companion dir — names and sizes only. */
async function listCompanionFiles(skillDir: string): Promise<SkillFileRef[]> {
  const out: SkillFileRef[] = [];
  for (const { dir, kind } of COMPANION_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(join(skillDir, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const st = await stat(join(skillDir, dir, entry));
        if (st.isFile()) out.push({ relPath: `${dir}/${entry}`, kind, bytes: st.size });
      } catch {
        /* raced away — skip */
      }
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}
