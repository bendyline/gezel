import { FENCE, findFirstH1, isFenceClose, splitSections } from '../markdown/md-structure.js';

/**
 * ─ Generated-preamble stripping ──────────────────────────────────────
 *
 * gstack SKILL.md files are GENERATED from `SKILL.md.tmpl`: a shared
 * host-integration preamble (update checks, session tracking, host
 * quirks, AskUserQuestion formatting) is injected before the authored
 * body. That preamble is 2–5x the authored content and is meaningless —
 * sometimes actively wrong — inside gezel. Detection is strictly
 * marker-based so hand-authored Claude skills are never touched:
 *
 *   1. The body must open with the AUTO-GENERATED template marker.
 *   2. The authored body starts at the first FENCE-AWARE H1 — bash
 *      comments inside preamble fences look exactly like H1s, which is
 *      why a naive `^# ` scan would truncate mid-preamble.
 *   3. The `## When to invoke this skill` section of the dropped region
 *      carries the full untruncated description — harvested, not lost.
 *   4. Marker present but no H1: keep everything (never guess).
 *
 * One class of injected noise inside the authored body is also dropped:
 * the telemetry echo fence (`… >> ~/.gstack/analytics/skill-usage.jsonl`)
 * that the generator plants right after the H1.
 */

const GENERATED_MARKER = /<!--\s*AUTO-GENERATED from SKILL\.md\.tmpl/;
const WHEN_TO_INVOKE = /^##\s+when to invoke this skill\s*$/i;
const TELEMETRY = /analytics\/skill-usage\.jsonl/;
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', '']);

export interface StrippedSkillBody {
  generated: boolean;
  title?: string;
  body: string;
  whenToInvoke?: string;
}

export function stripGeneratedPreamble(content: string): StrippedSkillBody {
  const lines = content.split(/\r?\n/);
  const h1 = findFirstH1(lines);

  if (!GENERATED_MARKER.test(content)) {
    return {
      generated: false,
      ...(h1 ? { title: h1.title } : {}),
      body: content,
    };
  }

  if (!h1) {
    // Defensive: a generated file whose authored body lost its H1. Keep
    // everything rather than guessing at a boundary.
    return { generated: true, body: content };
  }

  const preambleLines = lines.slice(0, h1.index);
  const bodyLines = lines.slice(h1.index);

  const preambleSections = splitSections(preambleLines);
  const whenSection = preambleSections.sections.find((s) => WHEN_TO_INVOKE.test(s.heading));
  const whenToInvoke = whenSection?.body.trim();

  return {
    generated: true,
    title: h1.title,
    body: dropTelemetryFences(bodyLines).join('\n'),
    ...(whenToInvoke ? { whenToInvoke } : {}),
  };
}

/**
 * Remove shell fences whose content mentions the gstack telemetry file.
 * Line-level so surrounding prose is untouched; a dropped fence also
 * swallows one immediately-preceding blank line to avoid double gaps.
 */
function dropTelemetryFences(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line.trim());
    if (fence && SHELL_LANGS.has(fence[2]!.trim().toLowerCase())) {
      const marker = fence[1]!;
      let j = i + 1;
      const buf: string[] = [];
      let closed = false;
      while (j < lines.length) {
        if (isFenceClose(lines[j]!, marker)) {
          closed = true;
          break;
        }
        buf.push(lines[j]!);
        j++;
      }
      if (closed && TELEMETRY.test(buf.join('\n'))) {
        if (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
        i = j + 1;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out;
}
