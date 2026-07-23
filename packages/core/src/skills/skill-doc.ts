import matter from 'gray-matter';
import { stripGeneratedPreamble } from './preamble.js';

/**
 * ─ SkillDoc — the parsed intermediate form of a SKILL.md ─────────────
 *
 * One skill file (Claude `.claude/skills` or gstack format: YAML
 * frontmatter + markdown body) parsed into a plain struct. Parsing is
 * pure and deterministic — no fs, no LLM, never throws: malformed
 * frontmatter degrades to an empty frontmatter with the whole text as
 * body, because arbitrary third-party skills must always produce *some*
 * convertible document.
 */

export type SkillFileKind = 'section' | 'reference' | 'template' | 'script' | 'bin' | 'other';

/** A companion file discovered next to the SKILL.md (never read by core). */
export interface SkillFileRef {
  relPath: string;
  kind: SkillFileKind;
  bytes: number;
}

/** A flattened `hooks:` frontmatter declaration (Claude hook shape). */
export interface SkillHookDecl {
  phase: 'PreToolUse' | 'PostToolUse';
  matcher: string;
  command: string;
  statusMessage?: string;
}

export interface SkillDoc {
  name: string;
  version?: string;
  description?: string;
  /** `triggers` + `voice-triggers`, deduped case-insensitively, document order. */
  triggers: string[];
  allowedTools: string[];
  interactive?: boolean;
  sensitive?: boolean;
  hooks: SkillHookDecl[];
  /** Frontmatter keys we recognize but don't map (gbrain, preamble-tier, …). */
  extraFrontmatter: Record<string, unknown>;
  /** True when the AUTO-GENERATED template marker was present. */
  generated: boolean;
  /** First fence-aware H1 title of the authored body, when present. */
  title?: string;
  /** Authored body: preamble stripped when generated, telemetry fences dropped. */
  body: string;
  /** `## When to invoke this skill` harvested from a stripped preamble. */
  whenToInvoke?: string;
  /** The full body before any stripping — the provenance-hash basis. */
  rawBody: string;
  files: SkillFileRef[];
}

const CONSUMED_KEYS = new Set([
  'name',
  'version',
  'description',
  'triggers',
  'voice-triggers',
  'allowed-tools',
  'interactive',
  'sensitive',
  'hooks',
]);

export interface ParseSkillDocOptions {
  /** Name to use when frontmatter has none (usually the skill's directory name). */
  fallbackName: string;
  files?: SkillFileRef[];
}

export function parseSkillDoc(raw: string, opts: ParseSkillDocOptions): SkillDoc {
  let fm: Record<string, unknown> = {};
  let content = raw;
  try {
    const parsed = matter(raw);
    fm = (parsed.data ?? {}) as Record<string, unknown>;
    content = parsed.content;
  } catch {
    // Broken YAML in a third-party skill: keep the whole text as body.
  }

  const stripped = stripGeneratedPreamble(content);

  const extraFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!CONSUMED_KEYS.has(key)) extraFrontmatter[key] = value;
  }

  return {
    name: asString(fm.name) ?? opts.fallbackName,
    ...(asString(fm.version) !== undefined ? { version: asString(fm.version) } : {}),
    ...(asString(fm.description) !== undefined ? { description: asString(fm.description) } : {}),
    triggers: dedupeCaseInsensitive([
      ...asStringArray(fm.triggers),
      ...asStringArray(fm['voice-triggers']),
    ]),
    allowedTools: asStringArray(fm['allowed-tools']),
    ...(typeof fm.interactive === 'boolean' ? { interactive: fm.interactive } : {}),
    ...(typeof fm.sensitive === 'boolean' ? { sensitive: fm.sensitive } : {}),
    hooks: flattenHookDecls(fm.hooks),
    extraFrontmatter,
    generated: stripped.generated,
    ...(stripped.title !== undefined ? { title: stripped.title } : {}),
    body: stripped.body,
    ...(stripped.whenToInvoke !== undefined ? { whenToInvoke: stripped.whenToInvoke } : {}),
    rawBody: content,
    files: [...(opts.files ?? [])].sort((a, b) => a.relPath.localeCompare(b.relPath)),
  };
}

/**
 * Flatten the Claude hook frontmatter shape:
 * `{ PreToolUse: [{ matcher, hooks: [{ type: 'command', command, statusMessage }] }] }`
 * into `SkillHookDecl[]`. Anything that isn't a command hook is dropped —
 * the converter only ever *notes* these, it never executes them.
 */
function flattenHookDecls(value: unknown): SkillHookDecl[] {
  if (typeof value !== 'object' || value === null) return [];
  const out: SkillHookDecl[] = [];
  for (const phase of ['PreToolUse', 'PostToolUse'] as const) {
    const entries = (value as Record<string, unknown>)[phase];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue;
      const matcher = asString((entry as Record<string, unknown>).matcher) ?? '.*';
      const hooks = (entry as Record<string, unknown>).hooks;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (typeof hook !== 'object' || hook === null) continue;
        const h = hook as Record<string, unknown>;
        if (h.type !== 'command') continue;
        const command = asString(h.command);
        if (!command) continue;
        out.push({
          phase,
          matcher,
          command,
          ...(asString(h.statusMessage) !== undefined
            ? { statusMessage: asString(h.statusMessage) }
            : {}),
        });
      }
    }
  }
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}
