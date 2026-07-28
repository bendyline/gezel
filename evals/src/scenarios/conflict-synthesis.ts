import { requireOrderedSections } from '@bendyline/gezel/checks';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { provisionScenarioGezel } from './helpers.ts';
import {
  provenanceShellOverwritesPath,
  provenanceShellReadPrecedesMutation,
  provenanceToolArgumentText,
  provenanceToolMutatesPath,
  provenanceToolReadsPath,
} from './tool-provenance.ts';

/**
 * Conflict-synthesis (D2 class 2, multi-doc-synthesis) — N inputs, one
 * structured deliverable, with the CONFLICTS between sources surfaced
 * and reconciled EXPLICITLY. incident-postmortem synthesizes evidence;
 * this scenario's new bar is the reconciliation contract: each planted
 * conflict must appear in the "Conflicts and resolutions" section with
 * BOTH values and BOTH source paths, the canonical value must be used
 * everywhere else, and the superseded value must appear NOWHERE
 * outside that section (quarantined, not laundered into the plan). The
 * final claims must also be backed by persisted successful source reads,
 * and no third date, amount, or owner absent from the seeds may leak in.
 *
 * Three planted conflicts:
 *   A. Launch date — memo-product says 2026-08-15; memo-engineering
 *      says 2026-09-01 and explicitly supersedes product's date.
 *   B. Budget — memo-product says 240,000; finance.csv says 210,000
 *      and the kickoff names finance.csv authoritative for numbers.
 *   C. DRI — memo-oldplan names Priya; org.md (current) names Marcus.
 */

const PROJECT_NAME = 'Skylark Launch Synthesis';
const RESEARCHER_NAME = 'Tamsin';
export const SYNTHESIS_PATH = 'synthesis.md';
export const SYNTHESIS_REQUIRED_SOURCE_PATHS = [
  'memo-product.md',
  'memo-engineering.md',
  'finance.csv',
  'org.md',
  'memo-oldplan.md',
] as const;

export interface SynthesisToolCall {
  name: string;
  success: boolean;
  path?: string;
  argsFull?: string;
  argsSummary?: string;
}

export interface SynthesisReadProvenance {
  ok: boolean;
  missingReads: string[];
  outOfOrderReads: string[];
  missingRecordings: string[];
  detail: string;
}

export interface PlantedConflict {
  id: string;
  label: string;
  /** The value that WINS (and why it wins is in the sources). */
  canonical: RegExp;
  canonicalLabel: string;
  /** The superseded value — quarantined to the Conflicts section. */
  superseded: RegExp;
  supersededLabel: string;
  /** The source that supplied the superseded value. */
  supersededSource: string;
  /** The authoritative source that supplied the winning value. */
  canonicalSource: string;
  /** Evidence that the discussion actually resolves the conflict, not merely lists both values. */
  resolution: RegExp;
}

export const PLANTED_CONFLICTS: PlantedConflict[] = [
  {
    id: 'launch-date',
    label: 'launch date',
    canonical: /2026-09-01|september\s*1/i,
    canonicalLabel: '2026-09-01',
    superseded: /2026-08-15|august\s*15/i,
    supersededLabel: '2026-08-15',
    supersededSource: 'memo-product.md',
    canonicalSource: 'memo-engineering.md',
    resolution: /supersed|engineering(?:\s+memo)?\s+(?:wins|controls|prevails)/i,
  },
  {
    id: 'budget',
    label: 'launch budget',
    canonical: /210[,.]?000/,
    canonicalLabel: '210,000',
    superseded: /240[,.]?000/,
    supersededLabel: '240,000',
    supersededSource: 'memo-product.md',
    canonicalSource: 'finance.csv',
    resolution:
      /\bauthoritative\b|\bauthority\s*:|finance(?:\.csv)?`?\s+(?:wins|controls|prevails)/i,
  },
  {
    id: 'dri',
    label: 'launch DRI',
    canonical: /marcus/i,
    canonicalLabel: 'Marcus',
    superseded: /priya/i,
    supersededLabel: 'Priya',
    supersededSource: 'memo-oldplan.md',
    canonicalSource: 'org.md',
    resolution: /current|reorg|org(?:\.md|\s+chart)?\s+(?:wins|controls|prevails)/i,
  },
];

export const SYNTHESIS_SEED_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'memo-product.md',
    content: [
      '# Product memo — Skylark launch (May)',
      '',
      'We are targeting a launch on 2026-08-15. The launch budget is 240,000 EUR,',
      'covering the campaign, the event, and two contractors. Product wants the',
      'onboarding revamp in scope.',
    ].join('\n'),
  },
  {
    path: 'memo-engineering.md',
    content: [
      '# Engineering memo — Skylark readiness (June)',
      '',
      'The August date is not achievable: the migration alone takes six weeks.',
      'This memo SUPERSEDES the product memo on timing — the launch date is',
      '2026-09-01. Feature scope per the product memo otherwise stands.',
    ].join('\n'),
  },
  {
    path: 'finance.csv',
    content: [
      'line_item,amount_eur',
      'campaign,120000',
      'launch_event,50000',
      'contractors,40000',
      'total_budget,210000',
    ].join('\n'),
  },
  {
    path: 'org.md',
    content: [
      '# Org chart — current',
      '',
      '- Launch DRI: Marcus (since June 1).',
      '- Campaign lead: Iris.',
      '- Engineering lead: Deniz.',
    ].join('\n'),
  },
  {
    path: 'memo-oldplan.md',
    content: [
      '# Old launch plan (March — historical)',
      '',
      'Priya is the launch DRI. Weekly syncs on Tuesdays. This plan predates the',
      'reorg; see org.md for current ownership.',
    ].join('\n'),
  },
  {
    path: 'style.md',
    content: [
      '# House style (noise for this task)',
      '',
      'Use sentence case for headings. Dates in ISO where possible.',
    ].join('\n'),
  },
];

export const SYNTHESIS_MISSION_OBJECTIVES = [
  'Synthesize the five source documents into synthesis.md with sections Overview,',
  'Consolidated plan, Conflicts and resolutions, Open questions. The sources disagree;',
  'every conflict goes in the "Conflicts and resolutions" section quoting BOTH values',
  'and BOTH source files and stating which wins and why. finance.csv is authoritative',
  'for numbers; the engineering memo supersedes product on timing; org.md is current',
  'for ownership. Superseded values (the August 15 date, the 240,000 budget, Priya as',
  'DRI) must not appear anywhere outside the conflicts section. Cite source files',
  'throughout.',
].join(' ');

export const SYNTHESIS_KICKOFF_MESSAGE = [
  'Please synthesize the launch documents into one brief at `synthesis.md`',
  '(workspace root). Read all five sources first: memo-product.md,',
  'memo-engineering.md, finance.csv, org.md, memo-oldplan.md (style.md is just house',
  'style). Structure: four sections in order — Overview, Consolidated plan,',
  'Conflicts and resolutions, Open questions. The sources CONFLICT in places; do not',
  'paper over it. Every conflict goes in the "Conflicts and resolutions" section,',
  'quoting BOTH values with BOTH file names (e.g. `memo-product.md`), and stating',
  'which value wins and why: finance.csv is authoritative for numbers, the',
  'engineering memo supersedes product on timing, org.md is current for ownership.',
  'Everywhere OUTSIDE that section, use only the winning values — a superseded date,',
  'budget, or name appearing in the plan itself means the reconciliation failed.',
  'Cite the source file (backticked filename) for at least six claims. Write the',
  'complete synthesis.md now with write_file.',
].join(' ');

function toolCallArgumentText(call: SynthesisToolCall): string {
  return provenanceToolArgumentText(call);
}

function successfulReadBefore(
  toolTrace: readonly SynthesisToolCall[],
  path: string,
  beforeIndex: number,
): boolean {
  return toolTrace.some(
    (call, index) =>
      (index < beforeIndex && provenanceToolReadsPath(call, path)) ||
      (index === beforeIndex && provenanceShellReadPrecedesMutation(call, path, SYNTHESIS_PATH)),
  );
}

function pathWasRead(toolTrace: readonly SynthesisToolCall[], path: string): boolean {
  return toolTrace.some((call) => provenanceToolReadsPath(call, path));
}

function lastValueRecordingIndex(toolTrace: readonly SynthesisToolCall[], value: RegExp): number {
  for (let index = toolTrace.length - 1; index >= 0; index--) {
    const call = toolTrace[index];
    if (
      call &&
      provenanceToolMutatesPath(call, SYNTHESIS_PATH) &&
      (value.test(toolCallArgumentText(call)) ||
        provenanceShellOverwritesPath(call, SYNTHESIS_PATH))
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Require each final canonical and superseded claim to have been committed
 * only after both sources for that conflict were successfully read. A bad
 * early draft can be rehabilitated by later reads plus a corrective rewrite,
 * but checker-fed values with no source reads cannot pass.
 */
export function checkSynthesisReadProvenance(
  toolTrace: readonly SynthesisToolCall[],
): SynthesisReadProvenance {
  const requirements = PLANTED_CONFLICTS.flatMap((conflict) => {
    const readPaths = [conflict.supersededSource, conflict.canonicalSource];
    return [
      {
        label: `${conflict.label} authoritative claim`,
        value: conflict.canonical,
        readPaths,
      },
      {
        label: `${conflict.label} superseded claim`,
        value: conflict.superseded,
        readPaths,
      },
    ];
  });
  const missingReads = new Set<string>();
  const outOfOrderReads = new Set<string>();
  const missingRecordings: string[] = [];

  for (const requirement of requirements) {
    const recordingIndex = lastValueRecordingIndex(toolTrace, requirement.value);
    if (recordingIndex < 0) {
      missingRecordings.push(requirement.label);
      continue;
    }
    for (const path of requirement.readPaths) {
      if (successfulReadBefore(toolTrace, path, recordingIndex)) continue;
      if (pathWasRead(toolTrace, path)) {
        outOfOrderReads.add(`${path} before ${requirement.label}`);
      } else {
        missingReads.add(path);
      }
    }
  }

  const detail =
    missingReads.size > 0
      ? `source-read provenance missing successful read_file call(s): ${[...missingReads].join(', ')}`
      : outOfOrderReads.size > 0
        ? `source-read provenance is out of order: ${[...outOfOrderReads].join(', ')}`
        : missingRecordings.length > 0
          ? `source-read provenance cannot identify committed final claim recording(s): ${missingRecordings.join(', ')}`
          : 'all final conflict claims were recorded after their authoritative source reads';
  return {
    ok: missingReads.size === 0 && outOfOrderReads.size === 0 && missingRecordings.length === 0,
    missingReads: [...missingReads],
    outOfOrderReads: [...outOfOrderReads],
    missingRecordings,
    detail,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pure grader.

const REQUIRED_SECTIONS = [
  'Overview',
  'Consolidated plan',
  'Conflicts and resolutions',
  'Open questions',
];

/** Slice one section from its heading to the next heading at the same or
 * higher level. Deeper headings belong to the section; treating a `###
 * Launch date` subsection as the end made well-structured syntheses
 * impossible to grade. */
function sliceSection(
  markdown: string,
  title: string,
): { inSlice: string; outside: string } | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`, 'im');
  const m = re.exec(markdown);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = markdown.slice(start);
  const level = m[1]?.length ?? 1;
  const next = new RegExp(`^#{1,${level}}\\s+\\S`, 'm').exec(rest);
  const end = next ? start + next.index : markdown.length;
  return {
    inSlice: markdown.slice(start, end),
    outside: markdown.slice(0, m.index) + markdown.slice(end),
  };
}

/** Slice out the Conflicts section (heading → next peer/parent heading). */
export function sliceConflictsSection(
  markdown: string,
): { inSlice: string; outside: string } | null {
  return sliceSection(markdown, 'Conflicts and resolutions');
}

function citedClaimCount(markdown: string): number {
  const knownSources = new Set(
    SYNTHESIS_SEED_FILES.map((file) => file.path).filter((path) => path !== 'style.md'),
  );
  return markdown
    .split(/(?<=[.!?])\s+|\n+/)
    .map((unit) => unit.trim())
    .filter((unit) => {
      if (!unit || /^#+\s/.test(unit)) return false;
      const citations = [...unit.matchAll(/`([\w-]+\.(?:md|csv))`/g)];
      if (!citations.some((match) => knownSources.has(match[1] ?? ''))) return false;
      const prose = unit
        .replace(/`[\w-]+\.(?:md|csv)`/g, '')
        .replace(/\W+/g, ' ')
        .trim();
      return prose.split(/\s+/).filter(Boolean).length >= 3;
    }).length;
}

/**
 * Split the conflicts section into local discussion entries. A planted
 * conflict must be reconciled inside one entry; values and citations from
 * unrelated bullets/paragraphs must not combine into a false pass.
 */
function splitLooseConflictEntries(markdown: string): string[] {
  return markdown
    .split(/\n(?=\s*(?:#{2,6}\s+|\d+[.)]\s+|[-*+]\s+|\|))/)
    .flatMap((chunk) => chunk.split(/\n\s*\n+/))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * A conventional conflict discussion often uses a standalone label followed
 * by sibling bullets:
 *
 *   **Launch date:**
 *   - product says ...
 *   - engineering says ...
 *   - resolution ...
 *
 * Those bullets are one local discussion, not three unrelated entries. Group
 * them until the next explicit bold label or heading. The boundary is
 * load-bearing: values under one conflict label must never combine with source
 * names or a resolution under a different label/section. Unlabelled numbered
 * and bullet lists retain the stricter entry-per-item behavior above.
 */
function conflictDiscussionEntries(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const entries: string[] = [];
  let looseLines: string[] = [];
  let groupedLines: string[] | null = null;
  let groupedNumberedItemSeen = false;

  const isExplicitGroupBoundary = (line: string): boolean =>
    /^\s*#{2,6}\s+\S/.test(line) || /^\s*(?:[-*+]\s+)?\*\*[^*\n]+\*\*\s*$/.test(line);
  const isNumberedEntry = (line: string): boolean => /^\s*\d+[.)]\s+/.test(line);

  const flushLoose = () => {
    if (looseLines.length === 0) return;
    entries.push(...splitLooseConflictEntries(looseLines.join('\n')));
    looseLines = [];
  };
  const flushGrouped = () => {
    const entry = groupedLines?.join('\n').trim();
    if (entry) entries.push(entry);
    groupedLines = null;
    groupedNumberedItemSeen = false;
  };

  for (const line of lines) {
    if (isExplicitGroupBoundary(line) || (isNumberedEntry(line) && !groupedLines)) {
      flushGrouped();
      flushLoose();
      groupedLines = [line];
      groupedNumberedItemSeen = isNumberedEntry(line);
      continue;
    }

    if (groupedLines) {
      // Preserve separate numbered conflicts nested below a shared heading.
      // The first numbered item belongs to the label; a later numbered item
      // starts a new local entry instead of laundering tokens across items.
      if (isNumberedEntry(line) && groupedNumberedItemSeen) {
        flushGrouped();
        groupedLines = [line];
        groupedNumberedItemSeen = true;
        continue;
      }
      groupedLines.push(line);
      if (isNumberedEntry(line)) groupedNumberedItemSeen = true;
      continue;
    }

    looseLines.push(line);
  }

  flushGrouped();
  flushLoose();
  return entries;
}

/**
 * Clauses are deliberately narrower than a whole conflict entry. This
 * binds a value to the source that actually asserted it, instead of merely
 * accepting both values and both filenames somewhere in the same section.
 * Wrapped markdown lines remain one clause; contrast words and sentence
 * boundaries separate competing assertions.
 */
function assertionClauses(markdown: string): string[] {
  return markdown
    .replace(/\s*\n\s*/g, ' ')
    .split(/(?:[.!?;]\s+|,\s*(?:but|while|whereas)\s+|\s+(?:but|while|whereas)\s+)/i)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function clauseBindsValueToSource(clauses: string[], value: RegExp, source: string): boolean {
  return clauses.some((clause) => value.test(clause) && clause.includes(source));
}

function conflictDiscussion(conflictsSection: string, conflict: PlantedConflict): string | null {
  return (
    conflictDiscussionEntries(conflictsSection).find(
      (entry) => conflict.canonical.test(entry) && conflict.superseded.test(entry),
    ) ?? null
  );
}

const SUPPORTED_ISO_DATES = new Set(['2026-08-15', '2026-09-01']);
const SUPPORTED_NAMED_DATES = new Set(['august-15', 'september-1', 'june-1']);
const SUPPORTED_AMOUNTS_EUR = new Set([40_000, 50_000, 120_000, 210_000, 240_000]);

function unsupportedDateClaim(text: string): boolean {
  for (const match of text.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g)) {
    if (!SUPPORTED_ISO_DATES.has(match[0])) return true;
  }
  const monthDate =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(20\d{2}))?\b/gi;
  for (const match of text.matchAll(monthDate)) {
    const key = `${match[1]?.toLowerCase()}-${Number(match[2])}`;
    const year = match[3];
    if (!SUPPORTED_NAMED_DATES.has(key) || (year !== undefined && year !== '2026')) return true;
  }
  return false;
}

function normalizedAmount(raw: string): number | null {
  const multiplier = /[kK]\b/.test(raw) ? 1_000 : /[mM]\b/.test(raw) ? 1_000_000 : 1;
  const numeric = raw.replace(/(?:EUR|USD)/gi, '').replace(/[$€\s,kKmM.]/g, '');
  if (!/^\d+$/.test(numeric)) return null;
  return Number(numeric) * multiplier;
}

function unsupportedBudgetClaim(text: string): boolean {
  const amountPattern =
    /[$€]\s*\d[\d,.]*\s*[kKmM]?|\b\d{1,3}(?:[,.]\d{3})+\s*(?:EUR|USD)?\b|\b\d{4,}\s*(?:EUR|USD)\b|\b\d+(?:\.\d+)?\s*[kK]\b/g;
  for (const match of text.matchAll(amountPattern)) {
    const amount = normalizedAmount(match[0]);
    if (amount !== null && !SUPPORTED_AMOUNTS_EUR.has(amount)) return true;
  }
  return false;
}

function unsupportedDriClaim(text: string): boolean {
  const name = String.raw`([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)`;
  const patterns = [
    new RegExp(String.raw`\b(?:assigned\s+to|led\s+by)\s+${name}\b`, 'g'),
    new RegExp(
      String.raw`\b${name}\s+(?:is|will\s+be|serves?\s+as|remains)\s+(?:the\s+)?(?:launch\s+)?(?:DRI|responsible\s+party)\b`,
      'g',
    ),
    new RegExp(
      String.raw`\b${name}\s+as\s+(?:the\s+)?(?:launch\s+)?(?:DRI|responsible\s+party)\b`,
      'g',
    ),
    new RegExp(String.raw`\b(?:DRI|responsible\s+party)\s*(?:is|:)\s*${name}\b`, 'g'),
    new RegExp(String.raw`\b${name}\s+(?:owns|leads)\s+(?:the\s+)?launch\b`, 'g'),
    new RegExp(
      String.raw`\b(?:owner|ownership|launch\s+lead)\s*(?:is|:|belongs\s+to)\s*${name}\b`,
      'g',
    ),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.toLowerCase();
      if (candidate !== 'marcus' && candidate !== 'priya') return true;
    }
  }
  return false;
}

function sourceSupportFailures(markdown: string): string[] {
  const failures: string[] = [];
  if (unsupportedDateClaim(markdown)) {
    failures.push(
      'unsupported date claim not present in the seeded sources: re-read the timing fields in memo-product.md and memo-engineering.md, then replace every launch date with a source-backed value',
    );
  }
  if (unsupportedBudgetClaim(markdown)) {
    failures.push(
      'unsupported budget claim not present in the seeded sources: re-read finance.csv total_budget and line-item amounts, then replace every claimed amount with a source-backed value',
    );
  }
  if (unsupportedDriClaim(markdown)) {
    failures.push(
      'unsupported DRI or ownership claim not present in the seeded sources: re-read org.md and memo-oldplan.md, then use only source-backed owners and keep the historical owner inside the reconciliation',
    );
  }
  return failures;
}

export function checkSynthesis(
  markdown: string,
  toolTrace: readonly SynthesisToolCall[],
): SniffResult {
  const signals: string[] = [];
  const failures: string[] = [];
  const fail = (reason: string) => {
    if (!failures.includes(reason)) failures.push(reason);
  };

  const sections = requireOrderedSections(markdown, REQUIRED_SECTIONS);
  if (sections.ok) signals.push('ordered-sections');
  else fail(`missing/mis-ordered section: add an "## ${sections.missing}" heading in order`);

  const slices = sliceConflictsSection(markdown);
  const consolidatedPlan = sliceSection(markdown, 'Consolidated plan');
  if (!slices) {
    fail('no "Conflicts and resolutions" section found — the reconciliation lives there');
  }

  for (const conflict of PLANTED_CONFLICTS) {
    if (!slices) break;
    const { inSlice, outside } = slices;
    const discussion = conflictDiscussion(inSlice, conflict);
    const clauses = discussion ? assertionClauses(discussion) : [];
    const canonicalGrounded = clauseBindsValueToSource(
      clauses,
      conflict.canonical,
      conflict.canonicalSource,
    );
    const supersededGrounded = clauseBindsValueToSource(
      clauses,
      conflict.superseded,
      conflict.supersededSource,
    );
    const resolved = discussion ? conflict.resolution.test(discussion) : false;
    if (discussion && canonicalGrounded && supersededGrounded && resolved) {
      signals.push(`conflict-${conflict.id}-surfaced`);
    } else {
      fail(
        `conflict (${conflict.label}) is not source-bound: re-read ${conflict.supersededSource} and ${conflict.canonicalSource}, then state each file's observed ${conflict.label} field in one Conflicts entry and explain which source controls it`,
      );
    }
    if (!conflict.superseded.test(outside)) {
      signals.push(`conflict-${conflict.id}-quarantined`);
    } else {
      fail(
        `conflict (${conflict.label}): a superseded value appears outside the Conflicts section; re-read ${conflict.supersededSource} and ${conflict.canonicalSource}, then keep the historical value only in its reconciliation entry`,
      );
    }
    if (consolidatedPlan && conflict.canonical.test(consolidatedPlan.inSlice)) {
      signals.push(`conflict-${conflict.id}-canonical-used`);
    } else {
      fail(
        `conflict (${conflict.label}): the Consolidated plan lacks the authoritative value; re-read ${conflict.canonicalSource} and record its observed field in the plan`,
      );
    }
  }

  const sourceFailures = sourceSupportFailures(markdown);
  if (sourceFailures.length === 0) signals.push('claims-source-supported');
  else for (const failure of sourceFailures) fail(failure);

  const provenance = checkSynthesisReadProvenance(toolTrace);
  if (provenance.ok) signals.push('source-reads-grounded');
  else fail(provenance.detail);

  const citations = citedClaimCount(markdown);
  if (citations >= 6) signals.push('citations');
  else
    fail(
      `only ${citations} substantively cited claim(s) — cite a real seeded source file for at least six separate claims`,
    );

  const requiredCount = 1 + PLANTED_CONFLICTS.length * 3 + 1 + 1 + 1;
  const failReason =
    failures.length > 0 ? failures.map((reason) => `- ${reason}`).join('\n') : null;
  return {
    ok: signals.length >= requiredCount,
    signals,
    score: signals.length,
    scoreMax: requiredCount,
    ...(failReason ? { failReason } : {}),
  };
}

export function synthesisRepairDirective(failReason = ''): string {
  const sourceReadRequired = /source-read provenance/i.test(failReason);
  return [
    sourceReadRequired
      ? 'SOURCE_READ_REQUIRED: the final claims are not backed by successful, ordered source reads.'
      : 'SOURCE_GROUNDED_REPAIR: repair every actionable gap listed by the scenario check.',
    'First call read_file on memo-product.md, memo-engineering.md, finance.csv, org.md, and memo-oldplan.md.',
    `Then patch \`${SYNTHESIS_PATH}\` using only the values you observed in those files.`,
    'Bind each conflicting field to both source filenames in one Conflicts entry, state which authority controls it, keep historical values out of the other sections, and remove any date, amount, or owner not supported by a cited source.',
    'The final claim-recording mutations must occur after their corresponding reads. Do not copy factual values from this message or prior checker feedback.',
    'Use replace_in_file or replace_lines for focused corrections; use write_file only when several sections need a coherent grounded rewrite.',
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────
// Harness plumbing.

async function findProjectId(client: EvalContext['client']): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: EvalContext['client'],
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

async function readSynthesisToolTrace(
  client: EvalContext['client'],
  projectId: string,
): Promise<SynthesisToolCall[] | null> {
  try {
    const { sessions } = await client.listChatSessions({ projectId });
    const fullSessions = await Promise.all(
      sessions.map((session) => client.getChatSession(session.id)),
    );
    const events: Array<{
      atMs: number;
      sessionIndex: number;
      messageIndex: number;
      callIndex: number;
      call: SynthesisToolCall;
    }> = [];
    for (let sessionIndex = 0; sessionIndex < fullSessions.length; sessionIndex++) {
      const session = fullSessions[sessionIndex];
      for (let messageIndex = 0; messageIndex < (session?.messages.length ?? 0); messageIndex++) {
        const message = session?.messages[messageIndex];
        for (let callIndex = 0; callIndex < (message?.toolCalls?.length ?? 0); callIndex++) {
          const call = message?.toolCalls?.[callIndex];
          if (!call) continue;
          const parsedAt = Date.parse(message?.at ?? '');
          events.push({
            atMs: Number.isFinite(parsedAt) ? parsedAt : Number.MAX_SAFE_INTEGER,
            sessionIndex,
            messageIndex,
            callIndex,
            call,
          });
        }
      }
    }
    events.sort(
      (a, b) =>
        a.atMs - b.atMs ||
        a.sessionIndex - b.sessionIndex ||
        a.messageIndex - b.messageIndex ||
        a.callIndex - b.callIndex,
    );
    return events.map((event) => event.call);
  } catch {
    return null;
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Synthesizing the Skylark launch documents — product and engineering memos, the ' +
        'finance sheet, and the org chart — into one consolidated brief with conflicts ' +
        'between sources reconciled explicitly.',
      missionObjectives: SYNTHESIS_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('conflict-synthesis setup: failed to resolve project id');

  for (const f of SYNTHESIS_SEED_FILES) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${SYNTHESIS_SEED_FILES.length} source files`);

  const researcher = await provisionScenarioGezel(ctx, {
    preferredName: RESEARCHER_NAME,
    role: 'Researcher',
    label: 'researcher',
  });
  await client.addGezelToProject(projectId, researcher.id);
  await client.sendChatMessage(researcher.id, { message: SYNTHESIS_KICKOFF_MESSAGE, projectId });
  log(`[scenario:setup] sent kickoff to ${researcher.name}`);
}

export const conflictSynthesisScenario: EvalScenario = {
  id: 'conflict-synthesis',
  description:
    'Multi-doc synthesis with explicit reconciliation: five sources plant three conflicts (launch date, budget, DRI); each must be surfaced in the Conflicts section with both values + both sources, the winner used everywhere else, the superseded value quarantined, all claims source-read-grounded, and unsupported alternatives rejected.',
  prompt: [
    `Heads up: ${RESEARCHER_NAME} is synthesizing the launch documents in the`,
    `"${PROJECT_NAME}" project. You do not need to do anything — just confirm`,
    "you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    {
      signal: 'ordered-sections',
      pattern: /overview, consolidated plan,\s*conflicts and resolutions, open questions/,
    },
    {
      signal: 'conflict-launch-date-surfaced',
      pattern: /engineering memo supersedes product on timing/,
    },
    { signal: 'conflict-budget-surfaced', pattern: /finance\.csv is authoritative for numbers/ },
    { signal: 'conflict-dri-surfaced', pattern: /org\.md is current for ownership/ },
    { signal: 'citations', pattern: /six claims/ },
  ],
  evidenceTexts: [SYNTHESIS_MISSION_OBJECTIVES, SYNTHESIS_KICKOFF_MESSAGE],
  timeoutMs: 30 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] synthesis project not present yet');
      return { done: false };
    }
    const [markdown, toolTrace] = await Promise.all([
      readWorkspaceText(client, projectId, SYNTHESIS_PATH),
      readSynthesisToolTrace(client, projectId),
    ]);
    if (markdown === null) {
      logChanged('sniff', `[scenario] ${SYNTHESIS_PATH} not present yet`);
      recordSniff?.({ key: 'conflict-synthesis', score: 0, bytes: 0 });
      await postMissingDeliverableFeedback(ctx, SYNTHESIS_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        projectId,
      });
      return { done: false };
    }
    if (toolTrace === null) {
      logChanged(
        'tool-trace',
        '[scenario] chat tool trace unavailable — cannot verify ordered source reads yet',
      );
      return { done: false };
    }
    const check = checkSynthesis(markdown, toolTrace);
    logChanged(
      'sniff',
      `[scenario] conflict-synthesis bytes=${markdown.length} score=${check.score}/${check.scoreMax} signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason.replace(/\s+/g, ' ')}"` : ''}`,
    );
    recordSniff?.({
      key: 'conflict-synthesis',
      score: check.score,
      bytes: markdown.length,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `all three conflicts reconciled explicitly with citations (signals: ${check.signals.join(', ')})`,
      };
    }
    if (check.failReason) {
      await postSniffFeedback(ctx, SYNTHESIS_PATH, check, {
        projectId,
        sourceText: markdown,
        expectedDeliverable: null,
        repairDirective: synthesisRepairDirective(check.failReason),
      });
    }
    return { done: false };
  },
};
