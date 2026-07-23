import { type MdSection, splitSections } from '../markdown/md-structure.js';

/**
 * ─ Skill body segmentation ───────────────────────────────────────────
 *
 * Splits an authored skill body into H1 title, intro prose, and its H2
 * sections, and decides whether the skill is a multi-step procedure.
 *
 * Step recognition is deliberately narrow: only `## Phase N`, `## Step
 * N` (N = `1`, `2A`, `2.5`, `2.75`, optional `: title` / `— title`
 * suffix, `(MANDATORY)`-style parentheticals staying in the title) and
 * `## 1. <title>` numbered headings count. Multi-step mode requires at
 * least TWO sections matching one family — a single "Phase 1" or an
 * essay-shaped skill falls back to a single-step conversion, because a
 * wrongly-split book is worse than an unsplit one.
 */

export type StepFamily = 'phase' | 'step' | 'num';

const PHASE_RE = /^##\s+phase\s+(\d+(?:\.\d+)*[a-z]?)\s*(?:[:.–—-]\s*)?(.*)$/i;
const STEP_RE = /^##\s+step\s+(\d+(?:\.\d+)*[a-z]?)\s*(?:[:.–—-]\s*)?(.*)$/i;
const NUM_RE = /^##\s+(\d+)[.)]\s+(.+)$/;

export interface StepMatch {
  family: StepFamily;
  ordinal: string;
  title: string;
}

export interface SegmentedSkillBody {
  /** H1 text when the body opens with one. */
  title?: string;
  /** Prose between the H1 (or start) and the first H2. */
  intro: string;
  /** Every H2 section, in document order. */
  sections: MdSection[];
  /** Indices into `sections` recognized as steps of the winning family. */
  stepIndices: number[];
  /** The winning family, or null when single-step mode applies. */
  family: StepFamily | null;
}

export function matchStepHeading(heading: string): StepMatch | null {
  const phase = PHASE_RE.exec(heading);
  if (phase) return { family: 'phase', ordinal: phase[1]!, title: phase[2]!.trim() };
  const step = STEP_RE.exec(heading);
  if (step) return { family: 'step', ordinal: step[1]!, title: step[2]!.trim() };
  const num = NUM_RE.exec(heading);
  if (num) return { family: 'num', ordinal: num[1]!, title: num[2]!.trim() };
  return null;
}

export function segmentSkillBody(body: string): SegmentedSkillBody {
  const lines = body.split(/\r?\n/);

  // Peel a leading H1 (the preamble stripper leaves the authored body
  // starting at it). Only a FIRST-line H1 counts as the title here.
  let title: string | undefined;
  let startIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) {
      title = h1[1]!;
      startIndex = i + 1;
    }
    break;
  }

  const split = splitSections(lines.slice(startIndex));

  const matchesByFamily: Record<StepFamily, number[]> = { phase: [], step: [], num: [] };
  split.sections.forEach((section, index) => {
    const match = matchStepHeading(section.heading);
    if (match) matchesByFamily[match.family].push(index);
  });

  // Winner = most matches; ties break phase > step > num (phase is the
  // dominant idiom in the wild). Below two matches: single-step mode.
  const families: StepFamily[] = ['phase', 'step', 'num'];
  let family: StepFamily | null = null;
  for (const candidate of families) {
    if (
      matchesByFamily[candidate].length >= 2 &&
      (family === null || matchesByFamily[candidate].length > matchesByFamily[family].length)
    ) {
      family = candidate;
    }
  }

  return {
    ...(title !== undefined ? { title } : {}),
    intro: split.preamble.trim(),
    sections: split.sections,
    stepIndices: family ? matchesByFamily[family] : [],
    family,
  };
}
