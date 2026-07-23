import { FENCE, type MdSection, extractAllFences, isFenceClose } from '../markdown/md-structure.js';
import { type CraftbookDoc, CraftbookDocSchema } from '../schemas/craftbook-doc.js';
import { type NewCraftbookStep, slugifyStepId } from '../schemas/craftbook.js';
import {
  type SegmentedSkillBody,
  type StepFamily,
  matchStepHeading,
  segmentSkillBody,
} from './segment.js';
import type { SkillDoc } from './skill-doc.js';
import { transpileShellBlock } from './transpile-shell.js';

/**
 * ─ SkillDoc → CraftbookDoc mapper ────────────────────────────────────
 *
 * Deterministic: same SkillDoc in, byte-identical doc out (the returned
 * doc has passed `CraftbookDocSchema.parse`, so key order is schema
 * declaration order; ids are slugs; nothing here reads a clock). The
 * governing rule for anything ambiguous: **emit no gate rather than a
 * wrong gate, and fold prose rather than invent structure.**
 */

const PLAN_HEADING = /^##\s+(philosophy|iron law|overview)\b/i;
const IRON_LAW = /^##\s+iron law\b/i;
const IMPORTANT_RULES = /^##\s+important rules\b/i;
const REQUIRED_OUTPUTS = /^##\s+required outputs\b/i;
const PERSONA =
  /\b(?:you are|act as|adopt the (?:persona|role) of)\s+(?:a|an|the)\s+([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*){0,3})/i;
/** Words that end a persona-role capture — they start the description, not the role. */
const PERSONA_STOP_WORDS = new Set([
  'who',
  'that',
  'which',
  'with',
  'and',
  'or',
  'to',
  'for',
  'in',
  'on',
  'at',
  'by',
  'from',
]);
/**
 * Shared host-integration sections gstack's generator injects AFTER the
 * authored H1 for some skills (the pre-H1 preamble strip can't reach
 * them). Dropped ONLY when the AUTO-GENERATED marker was present —
 * hand-authored skills are never touched. Exact headings from the
 * template; prefix matches marked with `*`.
 */
const GENERATED_HOST_SECTIONS = [
  'when to invoke this skill',
  'first-run guidance (one-time)',
  'askuserquestion format',
  'artifacts sync (skill start)',
  'model-specific behavioral patch (claude)',
  'voice',
  'context recovery',
  'writing style*',
  'skill routing',
  'plan mode safe operations',
  'skill invocation during plan mode',
  'prior learnings',
  'capture learnings',
  'brain context (preflight)',
  'prerequisite skill offer',
  'question tuning*',
  'confusion protocol',
  'continuous checkpoint mode',
  'context health (soft directive)',
  'search before building',
  'operational self-improvement',
  'telemetry (run last)',
  'plan status footer',
  'pre-review system audit*',
  'design outside voices*',
  'setup (run this check*',
  'design setup*',
];

function isGeneratedHostSection(heading: string): boolean {
  const text = heading
    .replace(/^##\s+/, '')
    .trim()
    .toLowerCase();
  for (const entry of GENERATED_HOST_SECTIONS) {
    if (entry.endsWith('*')) {
      if (text.startsWith(entry.slice(0, -1))) return true;
    } else if (text === entry) {
      return true;
    }
  }
  return false;
}
const DELIVERABLE_BULLET =
  /^[-*]\s+(?:write|save|create|produce)\b[^`\n]*`([^`\n]+\.[a-z0-9]{1,8})`/im;
const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh']);
const PERSONA_ABOUT_CAP = 4000;

export interface SkillPersona {
  role: string;
  about: string;
}

export interface ConvertedScript {
  name: string;
  body: string;
  sourceBlock: string;
  stepId: string;
  origin: 'static';
}

export interface UntranslatedBlock {
  stepId: string;
  code: string;
}

export interface SkillConversionOptions {
  /** Book-id prefix — `'proj-skill-'` for project-local books, `''` for catalog. */
  idPrefix?: string;
  /** Catalog lane only; runtime lanes must not stamp times into the doc. */
  releasedAt?: string;
  /** Workspace-relative SKILL.md path, for provenance + companion paths. */
  sourcePath?: string;
  /** Attempt static shell→TS conversion (default true). */
  transpileShell?: boolean;
  /**
   * Drop the `> Converted from …` provenance/notes block from the
   * description. The runtime lane keeps it (it cites the user's own repo
   * path — useful); the catalog lane omits it so shipped books read as
   * ordinary skills, not conversions.
   */
  omitProvenance?: boolean;
}

export interface SkillConversionResult {
  doc: CraftbookDoc;
  scripts: ConvertedScript[];
  untranslated: UntranslatedBlock[];
  /** Dropped/unmapped source features, sorted — the honesty ledger. */
  notes: string[];
  persona?: SkillPersona;
}

export function skillToCraftbookDoc(
  skill: SkillDoc,
  opts: SkillConversionOptions = {},
): SkillConversionResult {
  const transpile = opts.transpileShell !== false;
  const rawSeg = segmentSkillBody(skill.body);
  // Generated skills interleave shared host-template sections AFTER the
  // authored H1 (the pre-H1 preamble strip can't reach them) — drop the
  // known set so converted prompts carry the procedure, not gstack's
  // host plumbing. Hand-authored skills pass through untouched.
  const droppedHostSections = skill.generated
    ? rawSeg.sections.filter((s) => isGeneratedHostSection(s.heading)).length
    : 0;
  const filteredSeg = droppedHostSections > 0 ? segmentFilteringHostSections(rawSeg) : rawSeg;
  // Fenced blocks that are provably host-specific plumbing (gstack CLI
  // paths, `~/.gstack/` state, gbrain) are non-portable AND broken in
  // gezel — strip them from every section so they never reach a prompt.
  let droppedHostBlocks = 0;
  const scrubSection = (body: string): string => {
    const { text, dropped } = stripHostPlumbingFences(body);
    droppedHostBlocks += dropped;
    return text;
  };
  const seg: SegmentedSkillBody = {
    ...filteredSeg,
    intro: scrubSection(filteredSeg.intro),
    sections: filteredSeg.sections.map((s) => ({ ...s, body: scrubSection(s.body) })),
  };
  const multiStep = seg.family !== null && seg.stepIndices.length >= 2;

  const slug = slugifyStepId(skill.name);
  const bookId = `${opts.idPrefix ?? ''}${slug}`;
  const scriptStem = /^[a-z]/.test(slug) ? slug : `skill-${slug}`;
  const notes = new Set<string>();

  if (skill.allowedTools.length > 0) {
    notes.add(
      `allowed-tools (${skill.allowedTools.join(', ')}) not mapped — gezel tool access comes from the session's toolsets`,
    );
  }
  if (skill.hooks.length > 0) {
    notes.add(
      `${skill.hooks.length} hook declaration(s) not auto-converted — source hooks run host shell scripts`,
    );
  }
  if (skill.interactive) notes.add('interactive flag noted (no gezel equivalent)');
  if (skill.sensitive) notes.add('sensitive flag noted (no gezel equivalent)');
  const extraKeys = Object.keys(skill.extraFrontmatter).sort();
  if (extraKeys.length > 0) notes.add(`frontmatter keys not mapped: ${extraKeys.join(', ')}`);
  if (droppedHostSections > 0) {
    notes.add(`${droppedHostSections} injected host-template section(s) dropped`);
  }
  if (droppedHostBlocks > 0) {
    notes.add(`${droppedHostBlocks} host-plumbing reference(s) removed (non-portable)`);
  }

  const scripts: ConvertedScript[] = [];
  const untranslated: UntranslatedBlock[] = [];
  let scriptCounter = 0;
  const convertFences = (body: string, stepId: string): NewCraftbookStep['onExit'] => {
    const refs: Array<{ name: string; scope: 'craftbook'; autoAdvanceOnSuccess: false }> = [];
    for (const fence of extractAllFences(body)) {
      if (!SHELL_LANGS.has(fence.lang)) continue;
      if (fence.code.trim().length === 0) continue;
      if (!transpile) {
        untranslated.push({ stepId, code: fence.code });
        continue;
      }
      const name = `${scriptStem}-s${scriptCounter + 1}`;
      const result = transpileShellBlock(fence.code, name);
      if (result) {
        scriptCounter += 1;
        scripts.push({
          name,
          body: result.body,
          sourceBlock: fence.code,
          stepId,
          origin: 'static',
        });
        refs.push({ name, scope: 'craftbook', autoAdvanceOnSuccess: false });
      } else {
        untranslated.push({ stepId, code: fence.code });
      }
    }
    return refs.length > 0 ? refs : undefined;
  };

  const steps: NewCraftbookStep[] = [];
  const planParts: string[] = [];
  let deliverablePath: string | undefined;
  const considerDeliverable = (body: string) => {
    if (deliverablePath !== undefined) return;
    const m = DELIVERABLE_BULLET.exec(body);
    if (m && isSafeRelativePath(m[1]!)) deliverablePath = m[1]!;
  };

  if (multiStep) {
    const stepIndexSet = new Set(seg.stepIndices);
    const entryExtras: string[] = [];
    let ironLawQuote: string | undefined;
    const followers = new Map<number, string[]>();
    const trailing: string[] = [];

    seg.sections.forEach((section, index) => {
      if (stepIndexSet.has(index)) return;
      if (index < seg.stepIndices[0]!) {
        if (PLAN_HEADING.test(section.heading)) {
          planParts.push(`${section.heading}\n\n${section.body.trim()}`);
          if (IRON_LAW.test(section.heading)) ironLawQuote = blockquote('Iron Law', section.body);
        } else {
          entryExtras.push(demote(section));
        }
        return;
      }
      if (REQUIRED_OUTPUTS.test(section.heading)) considerDeliverable(section.body);
      if (index > seg.stepIndices[seg.stepIndices.length - 1]!) {
        if (IMPORTANT_RULES.test(section.heading)) {
          planParts.push(`${section.heading}\n\n${section.body.trim()}`);
        }
        trailing.push(demote(section));
        return;
      }
      const owner = [...seg.stepIndices].reverse().find((s) => s < index)!;
      const list = followers.get(owner) ?? [];
      list.push(demote(section));
      followers.set(owner, list);
    });

    const usedIds = new Set<string>();
    seg.stepIndices.forEach((sectionIndex, position) => {
      const section = seg.sections[sectionIndex]!;
      const match = matchStepHeading(section.heading)!;
      let id = slugifyStepId(`${match.family} ${match.ordinal}`);
      while (usedIds.has(id)) id = `${id}-2`;
      usedIds.add(id);

      const isEntry = position === 0;
      const isTerminal = position === seg.stepIndices.length - 1;
      const promptParts: string[] = [];
      if (isEntry && ironLawQuote) promptParts.push(ironLawQuote);
      if (isEntry) promptParts.push(...entryExtras);
      promptParts.push(section.body.trim());
      promptParts.push(...(followers.get(sectionIndex) ?? []));
      if (isTerminal) promptParts.push(...trailing);
      considerDeliverable(section.body);

      const stepId = id;
      const onExit = convertFences(section.body, stepId);
      steps.push({
        id: stepId,
        name: section.heading.replace(/^##\s+/, ''),
        prompt: promptParts.filter((p) => p.trim().length > 0).join('\n\n'),
        ...(onExit ? { onExit } : {}),
        ...(isTerminal ? { terminal: true } : { next: idForPosition(seg, position + 1, usedIds) }),
      } as NewCraftbookStep);
    });
  } else {
    // Single-step: reconstruct the prompt from the SCRUBBED, host-filtered
    // `seg` (never raw skill.body — that would smuggle back the dropped
    // host sections and plumbing blocks). Prompt text and fence-conversion
    // both read the same reconstructed body.
    const stepId = 'run';
    const parts: string[] = [];
    if (seg.intro.trim().length > 0) parts.push(seg.intro.trim());
    for (const section of seg.sections) {
      parts.push(`${section.heading}\n\n${section.body.trim()}`);
      if (REQUIRED_OUTPUTS.test(section.heading)) considerDeliverable(section.body);
    }
    const body = parts.join('\n\n').trim() || skill.name;
    const onExit = convertFences(body, stepId);
    steps.push({
      id: stepId,
      name: seg.title ?? skill.name,
      prompt: body,
      ...(onExit ? { onExit } : {}),
      terminal: true,
    } as NewCraftbookStep);
  }

  if (deliverablePath !== undefined) {
    const terminal = steps[steps.length - 1]! as NewCraftbookStep & {
      deliverable?: { path: string };
    };
    terminal.deliverable = { path: deliverablePath };
  }

  if (untranslated.length > 0) {
    notes.add(`${untranslated.length} shell block(s) kept as prose (not statically convertible)`);
  }

  const persona = detectPersona(seg.intro);
  if (persona) {
    for (const step of steps) {
      (step as NewCraftbookStep & { suggestedRole?: string }).suggestedRole = persona.role;
    }
  }

  const sortedNotes = [...notes].sort();
  const description = buildDescription(skill, seg.intro, sortedNotes, opts.sourcePath, {
    omitProvenance: opts.omitProvenance === true,
  });

  const rawDoc: Record<string, unknown> = {
    id: bookId,
    name: seg.title ?? skill.name,
    description,
    ...(planParts.length > 0 ? { plan: planParts.join('\n\n') } : {}),
    entryStepId: steps[0]!.id,
    ...(skill.triggers.length > 0 ? { triggers: skill.triggers } : {}),
    ...(/^[a-z][a-z0-9-]*$/.test(slug) ? { command: slug } : {}),
    steps,
    ...(scripts.length > 0
      ? { scripts: Object.fromEntries(scripts.map((s) => [s.name, s.body])) }
      : {}),
    version: skill.version && /^\d+\.\d+\.\d+$/.test(skill.version) ? skill.version : '1.0.0',
    ...(opts.releasedAt ? { releasedAt: opts.releasedAt } : {}),
  };

  const doc = CraftbookDocSchema.parse(rawDoc);
  return {
    doc,
    scripts,
    untranslated,
    notes: sortedNotes,
    ...(persona ? { persona } : {}),
  };
}

function idForPosition(
  seg: ReturnType<typeof segmentSkillBody>,
  position: number,
  usedIds: Set<string>,
): string {
  const section = seg.sections[seg.stepIndices[position]!]!;
  const match = matchStepHeading(section.heading)!;
  let id = slugifyStepId(`${match.family} ${match.ordinal}`);
  // Mirror the collision suffixing the assignment loop will apply when it
  // reaches this position (ids are assigned in order, so any collision for
  // a FUTURE position comes only from ids already in `usedIds`).
  while (usedIds.has(id)) id = `${id}-2`;
  return id;
}

function demote(section: MdSection): string {
  return `${section.heading.replace(/^##\s+/, '### ')}\n\n${section.body.trim()}`;
}

/**
 * Host artifacts that only exist inside gstack (the source skills'
 * origin): its CLI paths, `~/.gstack/` state, the gbrain memory tool.
 * A fenced block that
 * touches any of these is pure host plumbing — non-portable and broken
 * in gezel. Deliberately narrow: never matches a plain `npm test` or a
 * real code example.
 */
const HOST_PLUMBING_FENCE = /\.gstack\/|skills\/gstack\/|\bgstack-[a-z]|\bgbrain\b/i;
/**
 * A prose line naming gstack/gbrain by word — always host-integration in
 * a source skill (an output path, a CLI, an ethos reference). Dropped
 * line-by-line so the user-facing procedure never says "gstack".
 */
const HOST_REFERENCE_LINE = /\bgstack\b|\bgbrain\b/i;

/**
 * Remove host-specific plumbing from a section body: fenced blocks that
 * are gstack host plumbing go wholesale; individual prose/table lines
 * that name gstack/gbrain are dropped (real code fences are preserved
 * verbatim — we never line-scrub inside kept code). Consecutive blanks
 * left behind are collapsed. Returns cleaned text + count removed.
 */
function stripHostPlumbingFences(body: string): { text: string; dropped: number } {
  const lines = body.split('\n');
  const out: string[] = [];
  let dropped = 0;
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE.exec(lines[i]!.trim());
    if (fence) {
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
      if (closed) {
        if (HOST_PLUMBING_FENCE.test(buf.join('\n'))) {
          dropped++;
          if (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
        } else {
          // Keep the fence, but drop interior lines that name gstack/gbrain
          // (sample data, brand footers) so no user-facing "gstack" ships.
          out.push(lines[i]!);
          for (const inner of buf) {
            if (HOST_REFERENCE_LINE.test(inner)) dropped++;
            else out.push(inner);
          }
          out.push(lines[j]!);
        }
        i = j + 1;
        continue;
      }
    }
    if (HOST_REFERENCE_LINE.test(lines[i]!)) {
      dropped++;
      i++;
      continue;
    }
    out.push(lines[i]!);
    i++;
  }
  // Collapse runs of blank lines the drops leave behind.
  const collapsed: string[] = [];
  for (const line of out) {
    if (line.trim() === '' && collapsed[collapsed.length - 1]?.trim() === '') continue;
    collapsed.push(line);
  }
  return { text: collapsed.join('\n'), dropped };
}

/** Re-run the segmentation rules over the sections that survive the host filter. */
function segmentFilteringHostSections(seg: SegmentedSkillBody): SegmentedSkillBody {
  const kept = seg.sections.filter((s) => !isGeneratedHostSection(s.heading));
  const matches: Record<StepFamily, number[]> = { phase: [], step: [], num: [] };
  kept.forEach((section, index) => {
    const match = matchStepHeading(section.heading);
    if (match) matches[match.family].push(index);
  });
  let family: StepFamily | null = null;
  for (const candidate of ['phase', 'step', 'num'] as StepFamily[]) {
    if (
      matches[candidate].length >= 2 &&
      (family === null || matches[candidate].length > matches[family].length)
    ) {
      family = candidate;
    }
  }
  return {
    ...(seg.title !== undefined ? { title: seg.title } : {}),
    intro: seg.intro,
    sections: kept,
    stepIndices: family ? matches[family] : [],
    family,
  };
}

function blockquote(label: string, body: string): string {
  const lines = body.trim().split('\n');
  return [`> **${label}:**`, ...lines.map((l) => `> ${l}`)].join('\n');
}

function detectPersona(intro: string): SkillPersona | undefined {
  // Match against emphasis-stripped text so "a **YC office hours
  // partner**" captures cleanly; then truncate the 1-4 word capture at
  // the first stop word ("principal engineer who refuses…" → "principal
  // engineer").
  const plain = intro.replace(/[*_`]/g, '');
  const match = PERSONA.exec(plain);
  if (!match) return undefined;
  const words: string[] = [];
  for (const word of match[1]!.split(/\s+/)) {
    if (PERSONA_STOP_WORDS.has(word.toLowerCase())) break;
    words.push(word);
  }
  const role = words
    .join(' ')
    .replace(/[\s\p{P}]+$/u, '')
    .trim();
  if (role.length < 3) return undefined;
  const identity = intro
    .replace(/`([a-z_]+)\([^`]*\)`/gi, '$1')
    .trim()
    .slice(0, PERSONA_ABOUT_CAP);
  return { role, about: `## Identity\n\n${identity}\n` };
}

function buildDescription(
  skill: SkillDoc,
  intro: string,
  notes: string[],
  sourcePath: string | undefined,
  opts: { omitProvenance: boolean },
): string {
  const parts: string[] = [];
  const fmDesc = skill.description?.replace(/\s*\(gstack\)\s*$/i, '').trim();
  const when = skill.whenToInvoke?.trim();
  if (fmDesc && when && normalize(when).startsWith(normalize(fmDesc).slice(0, 40))) {
    parts.push(when);
  } else {
    if (fmDesc) parts.push(fmDesc);
    if (when) parts.push(when);
  }
  if (intro.trim().length > 0) parts.push(intro.trim());

  if (!opts.omitProvenance) {
    const provenance: string[] = [];
    const source = sourcePath ? `\`${sourcePath}\`` : 'a SKILL.md skill';
    provenance.push(
      `> Converted from ${source} (skill "${skill.name}"${skill.version ? ` v${skill.version}` : ''}).`,
    );
    for (const note of notes) provenance.push(`> - ${note}`);
    parts.push(provenance.join('\n'));
  }

  if (skill.files.length > 0) {
    const dir = sourcePath ? sourcePath.replace(/\/?SKILL\.md$/i, '') : '';
    const fileLines = skill.files.map(
      (f) => `- \`${dir ? `${dir}/${f.relPath}` : f.relPath}\` (${f.kind})`,
    );
    parts.push(
      [
        '### Companion files',
        '',
        'These ship with the source skill in this workspace — read them when a step calls for them; never work from memory of them.',
        '',
        ...fileLines,
      ].join('\n'),
    );
  }

  return parts.join('\n\n');
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isSafeRelativePath(p: string): boolean {
  return !p.startsWith('/') && !p.startsWith('~') && !p.includes('..') && !p.includes(':');
}
