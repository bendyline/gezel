import type { SniffResult } from './success-check.ts';

/**
 * Shared deterministic gates for the creative-writing scenarios
 * (historical-fiction, fantasy-fiction).
 *
 * Creative quality itself is NOT decided here — that's the advisory
 * LLM-judge layer (llm-judge.ts) with per-scenario axes. What CAN be
 * decided deterministically is whether the deliverable is a *story that
 * followed the brief* rather than a summary, an outline, or a fact-sheet
 * regurgitation:
 *
 *   - it's in the length band the brief asked for
 *   - it opens with a title heading
 *   - it's flowing prose, not bullets/tables (the regurgitation shape)
 *   - it contains actual scenes (dialogue in quotation marks)
 *   - it has enough paragraphs to be a story, not a synopsis
 *   - it doesn't open on a stock phrase the brief bans
 *   - it weaves in the required subject anchors (seeded facts, or the
 *     brief's required story elements)
 *
 * Every gate's vocabulary must be satisfiable from the scenario's own
 * user-shaped text — see grader-lint.test.ts. Keep gates here in sync
 * with what the kickoff messages actually ask for.
 */

export interface StoryAnchor {
  id: string;
  /** Human label used in failReason messages ("the Workum commission"). */
  label: string;
  pattern: RegExp;
}

export interface StoryFormThresholds {
  minBytes: number;
  maxBytes: number;
  /** Minimum count of prose paragraphs (blank-line blocks ≥ 120 chars that aren't headings/bullets/tables). */
  minParagraphs: number;
  /** Minimum count of quoted dialogue passages. */
  minDialogueLines: number;
  /** Maximum fraction of non-empty lines that are bullet/numbered items. */
  maxBulletRatio: number;
}

export const DEFAULT_STORY_FORM: StoryFormThresholds = {
  minBytes: 5 * 1024,
  maxBytes: 24 * 1024,
  minParagraphs: 10,
  minDialogueLines: 3,
  maxBulletRatio: 0.1,
};

/**
 * Stock openings both briefs explicitly ban. Checked against the first
 * 400 characters of body text (after the title heading) so a story can
 * still *mention* the phrase later, e.g. in dialogue mocking it.
 */
const CLICHE_OPENINGS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '"Once upon a time"', pattern: /once upon a time/i },
  { label: '"in a land far, far away"', pattern: /in a land far,? far away/i },
  { label: '"long, long ago"', pattern: /long,? long ago/i },
  { label: '"It was a dark and stormy night"', pattern: /it was a dark and stormy night/i },
];

const BULLET_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const HEADING_LINE = /^\s*#{1,6}\s/;
/** A quoted dialogue passage: straight or curly double quotes around ≥ 2 chars. */
const DIALOGUE_PASSAGE = /["“][^"“”\n]{2,}["”]/g;

/** The story's body text with the leading title heading (if any) removed. */
function bodyAfterTitle(markdown: string): string {
  const lines = markdown.split('\n');
  const firstContent = lines.findIndex((l) => l.trim().length > 0);
  if (firstContent >= 0 && HEADING_LINE.test(lines[firstContent] ?? '')) {
    return lines
      .slice(firstContent + 1)
      .join('\n')
      .trim();
  }
  return markdown.trim();
}

export function countProseParagraphs(markdown: string, minChars = 120): number {
  return bodyAfterTitle(markdown)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(
      (block) =>
        block.length >= minChars &&
        !HEADING_LINE.test(block) &&
        !BULLET_LINE.test(block) &&
        !TABLE_ROW.test(block.split('\n')[0] ?? '') &&
        !block.startsWith('>') &&
        !block.startsWith('```'),
    ).length;
}

export function countDialoguePassages(markdown: string): number {
  return (markdown.match(DIALOGUE_PASSAGE) ?? []).length;
}

export interface StoryFormCheck {
  signals: string[];
  failures: string[];
}

/**
 * The six form gates shared by both creative-writing scenarios. Signals:
 * `story-length`, `title`, `prose-form`, `dialogue`, `paragraphs`,
 * `no-cliche-opening`. Failure messages are written to be forwarded
 * verbatim into team chat by the sniff-feedback layer, so they name the
 * concrete fix.
 */
export function checkStoryForm(
  markdown: string,
  t: StoryFormThresholds = DEFAULT_STORY_FORM,
): StoryFormCheck {
  const signals: string[] = [];
  const failures: string[] = [];

  const bytes = markdown.length;
  if (bytes >= t.minBytes && bytes <= t.maxBytes) signals.push('story-length');
  else if (bytes < t.minBytes)
    failures.push(
      `story-length: ${bytes}B (need ≥ ${Math.round(t.minBytes / 1024)} KB — expand scenes with concrete sensory detail and dialogue, don't pad)`,
    );
  else
    failures.push(
      `story-length: ${bytes}B (exceeds the ${Math.round(t.maxBytes / 1024)} KB cap — tighten, this is a short story not a novella)`,
    );

  const firstLine = markdown.split('\n').find((l) => l.trim().length > 0) ?? '';
  if (HEADING_LINE.test(firstLine)) signals.push('title');
  else failures.push('title: the story must open with a markdown title heading (`# <title>`)');

  const lines = markdown.split('\n').filter((l) => l.trim().length > 0);
  const bulletLines = lines.filter((l) => BULLET_LINE.test(l)).length;
  const tableRows = lines.filter((l) => TABLE_ROW.test(l)).length;
  const bulletRatio = lines.length > 0 ? bulletLines / lines.length : 0;
  if (bulletRatio <= t.maxBulletRatio && tableRows <= 2) signals.push('prose-form');
  else
    failures.push(
      `prose-form: ${bulletLines} bullet lines / ${tableRows} table rows — write flowing prose paragraphs, not a bulleted or tabulated summary of the material`,
    );

  const dialogueCount = countDialoguePassages(markdown);
  if (dialogueCount >= t.minDialogueLines) signals.push('dialogue');
  else
    failures.push(
      `dialogue: ${dialogueCount} quoted passages (need ≥ ${t.minDialogueLines} — give the characters spoken dialogue in double quotation marks)`,
    );

  const paragraphs = countProseParagraphs(markdown);
  if (paragraphs >= t.minParagraphs) signals.push('paragraphs');
  else
    failures.push(
      `paragraphs: ${paragraphs} substantial prose paragraphs (need ≥ ${t.minParagraphs} — develop full scenes, not a synopsis)`,
    );

  const opening = bodyAfterTitle(markdown).slice(0, 400);
  const cliche = CLICHE_OPENINGS.find((c) => c.pattern.test(opening));
  if (!cliche) signals.push('no-cliche-opening');
  else
    failures.push(
      `no-cliche-opening: the story opens on ${cliche.label} — start in a specific moment instead of a stock phrase`,
    );

  return { signals, failures };
}

/**
 * Count subject anchors present in the story. `minPresent` decides the
 * single `<signalName>` signal: seeded-fact scenarios allow a couple of
 * facts to go unused (selection is part of the craft); required-element
 * briefs set `minPresent` to `anchors.length`.
 */
export interface StoryAnchorCheck {
  signalName: string;
  ok: boolean;
  present: string[];
  missing: StoryAnchor[];
  failure?: string;
}

export function checkStoryAnchors(
  markdown: string,
  anchors: readonly StoryAnchor[],
  minPresent: number,
  signalName: string,
): StoryAnchorCheck {
  const present = anchors.filter((a) => a.pattern.test(markdown)).map((a) => a.id);
  const missing = anchors.filter((a) => !a.pattern.test(markdown));
  if (present.length >= minPresent) return { signalName, ok: true, present, missing };
  return {
    signalName,
    ok: false,
    present,
    missing,
    failure: `${signalName}: only ${present.length}/${anchors.length} present (need ≥ ${minPresent}) — missing: ${missing.map((a) => a.label).join(', ')}`,
  };
}

const FORM_SIGNAL_NAMES = [
  'story-length',
  'title',
  'prose-form',
  'dialogue',
  'paragraphs',
  'no-cliche-opening',
] as const;

/** Assemble the standard SniffResult from form + anchor checks. */
export function storySniffResult(form: StoryFormCheck, anchor: StoryAnchorCheck): SniffResult {
  const signals = [...form.signals, ...(anchor.ok ? [anchor.signalName] : [])];
  const failures = [...form.failures, ...(anchor.failure ? [anchor.failure] : [])];
  const missingRequiredSignals = [
    ...FORM_SIGNAL_NAMES.filter((s) => !form.signals.includes(s)),
    ...(anchor.ok ? [] : [anchor.signalName]),
  ];
  return {
    ok: failures.length === 0,
    signals,
    score: signals.length,
    ...(failures.length > 0 ? { failReason: failures[0] } : {}),
    ...(missingRequiredSignals.length > 0 ? { missingRequiredSignals } : {}),
  };
}
