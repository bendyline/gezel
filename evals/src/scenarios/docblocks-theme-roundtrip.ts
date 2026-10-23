import { verifyBinaryDocumentBytes } from '@bendyline/gezel';
import { type PptxTheme, buildPptx, readZip } from '../fixtures/office-documents.ts';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { containsUnqualifiedClaim } from './claim-guards.ts';
import {
  findWorkspaceDeliverableNearMiss,
  projectTurnInProgress,
  provisionScenarioGezel,
  readProjectToolTrace,
} from './helpers.ts';
import type { ProvenanceToolCall } from './tool-provenance.ts';

/**
 * DocBlocks theme round-trip — "match our brand deck, then tell me what
 * changed".
 *
 * The DocBlocks craftbook evals all measure one shape: author Markdown,
 * convert, save. This one covers the tools that take an EXISTING document as
 * the source of truth — `infer_theme_from_file`, `apply_inferred_theme`,
 * `inspect_document`, `compare_documents` — and asks for a report whose every
 * value came back from one of them.
 *
 * It runs against the real DocBlocks the daemon bundles. The brand deck is a
 * real PPTX whose theme part carries invented fonts and colors, so the values
 * the report must cite exist only inside that file and come out only through
 * theme inference. The slide count and the comparison figures are whatever
 * the session's own conversion produced, so they are graded against the saved
 * deck and the `compare_documents` result in the session's tool trace — a
 * report that narrates calls it never made, or estimates their output, fails.
 *
 * Deliberately NOT a craftbook eval: a `test.json` sidecar can say "these
 * tools were called", but not "the numbers in the prose are the numbers the
 * tools returned, and the saved deck really carries the brand".
 */

const PROJECT_NAME = 'Brand Theme Alignment';
const DESIGNER_NAME = 'Wieke';
export const THEME_REPORT_PATH = 'theme-report.md';
/** In the artifacts drawer: DocBlocks writes nowhere else. */
export const THEMED_DECK_PATH = 'deliverables/quarterly-review.pptx';
export const BRAND_DECK_PATH = 'source/brand-reference.pptx';
export const REVIEW_SOURCE_PATH = 'source/quarterly-review.md';

/** Invented brand values, carried only by the brand deck's theme part. */
export const BRAND_THEME: PptxTheme = {
  name: 'Halvard Brand',
  headingFont: 'Kelder Grotesk',
  bodyFont: 'Marne Text',
  colors: {
    dark1: '1B2A26',
    light1: 'F4F1EA',
    dark2: '2E5E4E',
    light2: 'E8E2D4',
    accents: ['2E5E4E', 'C2703D', '7A8F3B', '3F6E8C', 'B5A04A', '8C4F6E'],
    hyperlink: '3F6E8C',
    followedHyperlink: '8C4F6E',
  },
};

/**
 * What `infer_theme_from_file` returns for the brand deck. DocBlocks names an
 * imported theme after its file, so the id is fixed by the seed path; the
 * fonts and colors are the brand theme's own.
 */
export const THEME_FACTS = {
  themeId: 'custom-brand-reference-pptx',
  headingFont: BRAND_THEME.headingFont,
  bodyFont: BRAND_THEME.bodyFont,
  primaryHex: `#${BRAND_THEME.colors.accents[0]}`,
  backgroundHex: `#${BRAND_THEME.colors.light1}`,
} as const;

export const THEME_MISSION = [
  'Align the quarterly review deck with the brand deck using only the local DocBlocks tools.',
  'Infer the theme from the brand file, apply it, save the themed deck, inspect it, compare it',
  'with the source, and publish theme-report.md citing the theme id, both fonts, the primary and',
  "background colors, the themed deck's slide count, and what the comparison reported.",
].join(' ');

export const THEME_KICKOFF = [
  `The brand team signed off on \`${BRAND_DECK_PATH}\`. Bring`,
  `\`${REVIEW_SOURCE_PATH}\` in line with it and report what changed.`,
  '',
  'Use the DocBlocks tools on your roster, in this order:',
  '1. `infer_theme_from_file` on the brand deck to read its theme.',
  '2. `apply_inferred_theme` with the quarterly review as the source and the brand deck as',
  '   the theme source.',
  '3. `convert_document` on the themed result to PowerPoint, then `save_artifact` to',
  `   \`${THEMED_DECK_PATH}\` in the artifacts folder.`,
  '4. `inspect_document` on the saved deck for its slide count.',
  `5. \`compare_documents\` between \`${REVIEW_SOURCE_PATH}\` and the saved deck.`,
  '',
  `Then write \`${THEME_REPORT_PATH}\` with these H2 sections in order: Theme applied;`,
  'Slide count; What changed; Recommendation. Cite the exact theme id, heading font, body',
  "font, primary hex, and background hex the tools returned; give the saved deck's slide count",
  'as a number; and under What changed, quote at least one similarity percentage',
  'compare_documents reported. Every value in the report must come from a tool response — do',
  'not estimate, and do not describe a step you did not run.',
].join('\n');

/** One H1 per slide, so the themed deck has a slide count worth reporting. */
export const REVIEW_SOURCE = [
  '# Quarterly review — returns desk',
  '',
  'Operations update for the returns desk, third quarter.',
  '',
  '# Where we landed',
  '',
  'The returns pilot covered 18 SKUs. Median first response moved from 18 hours to 6.',
  '',
  '# What we are watching',
  '',
  'Preventable refund leakage fell from 14.2% to 8.9%, but status silence after photo',
  'submission is still the top unresolved complaint.',
  '',
  '# Next',
  '',
  'Automated status emails, barcode-exception training, and a weekly Finance export.',
].join('\n');

export function brandDeckBytes(): Uint8Array {
  return buildPptx(
    [
      {
        title: 'Returns desk — brand reference',
        bullets: ['Type and color for operations decks'],
      },
      { title: 'Section slide', bullets: ['One idea per slide', 'Figures in the primary color'] },
    ],
    BRAND_THEME,
  );
}

const REQUIRED_TOOLS = [
  'infer_theme_from_file',
  'apply_inferred_theme',
  'convert_document',
  'save_artifact',
  'inspect_document',
  'compare_documents',
];

/** What the session's own tools produced, read back for grading. */
export interface ThemeEvidence {
  /** Slides in the saved deck, or null when it is not there yet. */
  slideCount: number | null;
  /** Percentages `compare_documents` returned, as written ("21%"). */
  comparePercents: string[];
  /** Whether `compare_documents` reported the two documents equivalent. */
  compareEquivalent: boolean | null;
}

interface ThemeSignal {
  signal: string;
  ok: boolean;
  reason: string;
}

export interface ThemeReportResult extends SniffResult {
  scoreMax: number;
}

const SECTION_NAMES = ['Theme applied', 'Slide count', 'What changed', 'Recommendation'];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The body under a section heading, up to the next heading of any depth. */
function sectionBody(markdown: string, name: string): string | null {
  const match = new RegExp(`^#{1,3}\\s+${escapeRegExp(name)}\\s*$`, 'im').exec(markdown);
  if (!match) return null;
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^#{1,3}\s+\S/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/**
 * Grade the report against the brand facts and the session's own results.
 *
 * Every gate is a grounding gate: the report has to carry invented fonts and
 * hex colors only theme inference returns, the slide count of the deck the
 * session saved, and a figure `compare_documents` actually reported.
 */
export function checkThemeReport(markdown: string, evidence: ThemeEvidence): ThemeReportResult {
  const outcomes: ThemeSignal[] = [];
  const check = (signal: string, ok: boolean, reason: string) =>
    outcomes.push({ signal, ok, reason });

  // Any heading depth: what the gate expresses is four labelled sections in
  // order, and an H1 report satisfies that as well as an H2 one (qwen3.5-4b
  // used H1 on every trial of the 2026-09-04 sweep, with correct content).
  const positions = SECTION_NAMES.map((name) =>
    markdown.search(new RegExp(`^#{1,3}\\s+${escapeRegExp(name)}\\s*$`, 'im')),
  );
  check(
    'ordered-sections',
    positions.every((position) => position >= 0) &&
      positions.every((p, i) => i === 0 || p > positions[i - 1]!),
    `theme report needs these sections as headings, in order: ${SECTION_NAMES.join(', ')}`,
  );

  check(
    'theme-id',
    new RegExp(escapeRegExp(THEME_FACTS.themeId), 'i').test(markdown),
    `cite the exact theme id ${THEME_FACTS.themeId} returned by infer_theme_from_file`,
  );
  check(
    'fonts',
    new RegExp(THEME_FACTS.headingFont, 'i').test(markdown) &&
      new RegExp(THEME_FACTS.bodyFont, 'i').test(markdown),
    `name both inferred fonts: ${THEME_FACTS.headingFont} (heading) and ${THEME_FACTS.bodyFont} (body)`,
  );
  // Case-insensitive but otherwise exact: a near-miss color is an invented one.
  check(
    'palette',
    new RegExp(THEME_FACTS.primaryHex, 'i').test(markdown) &&
      new RegExp(THEME_FACTS.backgroundHex, 'i').test(markdown),
    `cite both colors exactly: ${THEME_FACTS.primaryHex} primary and ${THEME_FACTS.backgroundHex} background`,
  );

  const slideSection = sectionBody(markdown, 'Slide count') ?? '';
  check(
    'slide-count',
    evidence.slideCount !== null && new RegExp(`\\b${evidence.slideCount}\\b`).test(slideSection),
    evidence.slideCount === null
      ? `save the themed deck to ${THEMED_DECK_PATH} so its slide count can be reported`
      : `under Slide count, give the saved deck's slide count (${evidence.slideCount}) as a number`,
  );

  const changedSection = sectionBody(markdown, 'What changed') ?? '';
  check(
    'compare-cited',
    evidence.comparePercents.some((percent) =>
      new RegExp(`(?<![\\d.])${escapeRegExp(percent)}`).test(changedSection),
    ),
    evidence.comparePercents.length === 0
      ? 'call compare_documents on the source and the saved deck, then quote what it reported'
      : `under What changed, quote a similarity percentage compare_documents reported (${evidence.comparePercents.slice(0, 3).join(', ')})`,
  );

  // A comparison that found differences must not be reported as a clean
  // carry-over: that describes a different outcome than the tool returned.
  check(
    'differences-not-whitewashed',
    evidence.compareEquivalent !== false ||
      !containsUnqualifiedClaim(
        changedSection,
        /\bno\s+(?:content\s+)?changes\b|\bidentical\b|\bnothing\s+(?:was\s+)?lost\b|\bfully\s+(?:retained|preserved)\b/i,
        /except|apart from|other than|aside from|besides|but\b|however/i,
      ),
    'compare_documents found differences; the report says nothing changed',
  );

  check(
    'recommendation',
    /^#{1,3}\s+Recommendation\s*$[\s\S]{40,}/im.test(markdown),
    'the Recommendation section needs an actual recommendation, not a heading',
  );

  const signals = outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.signal);
  const unmet = outcomes.filter((outcome) => !outcome.ok);
  return {
    ok: unmet.length === 0,
    signals,
    score: signals.length,
    scoreMax: outcomes.length,
    ...(unmet[0]
      ? { failReason: unmet[0].reason, missingRequiredSignals: unmet.map((o) => o.signal) }
      : {}),
  };
}

/** Slides in a PPTX, counted from its slide parts. */
export function pptxSlideCount(bytes: Uint8Array): number {
  return [...readZip(bytes).keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .length;
}

/** Whether a PPTX's slides use either brand font — a plain conversion would not. */
export function pptxCarriesBrandFonts(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder();
  for (const [name, data] of readZip(bytes)) {
    if (!/^ppt\/(?:slides|slideMasters|theme)\//.test(name)) continue;
    const xml = decoder.decode(data);
    if (xml.includes(THEME_FACTS.headingFont) || xml.includes(THEME_FACTS.bodyFont)) return true;
  }
  return false;
}

/** Percentages and the equivalence verdict from the session's `compare_documents` results. */
export function compareEvidence(trace: readonly ProvenanceToolCall[]): {
  percents: string[];
  equivalent: boolean | null;
} {
  const percents = new Set<string>();
  let equivalent: boolean | null = null;
  for (const call of trace) {
    if (call.name !== 'compare_documents' || !call.success || !call.resultText) continue;
    for (const match of call.resultText.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
      percents.add(`${match[1]}%`);
    }
    const score = /"score"\s*:\s*(0(?:\.\d+)?|1(?:\.0+)?)/.exec(call.resultText);
    if (score) percents.add(`${Math.round(Number(score[1]) * 100)}%`);
    const verdict = /"equivalent"\s*:\s*(true|false)/.exec(call.resultText);
    if (verdict) equivalent = verdict[1] === 'true';
  }
  return { percents: [...percents], equivalent };
}

async function findProjectId(client: EvalContext['client']): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((project) => project.name === PROJECT_NAME)?.id ?? null;
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

async function readArtifactBytes(
  client: EvalContext['client'],
  projectId: string,
  filePath: string,
): Promise<Uint8Array | null> {
  try {
    const blob = await client.fetchProjectArtifactBlob(projectId, filePath);
    return new Uint8Array(await blob.arrayBuffer());
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
        'Brand-alignment project. The brand deck is the source of truth for theme values, and every theme fact must come from the local DocBlocks tools rather than from memory.',
      missionObjectives: THEME_MISSION,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('docblocks-theme-roundtrip setup: failed to resolve project id');

  await client.writeProjectWorkspaceFile(projectId, {
    path: REVIEW_SOURCE_PATH,
    content: REVIEW_SOURCE,
  });
  await client.writeProjectWorkspaceBinary(
    projectId,
    BRAND_DECK_PATH,
    brandDeckBytes(),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  );

  const designer = await provisionScenarioGezel(ctx, {
    preferredName: DESIGNER_NAME,
    role: 'Copywriter',
    label: 'document producer',
  });
  await client.addGezelToProject(projectId, designer.id);
  // Installing builtin toolsets REPLACES the role default, so this list is
  // the whole builtin roster — matching the other two hand-authored
  // productivity scenarios so tool-block size stays comparable across them.
  // DocBlocks itself is bundled with the daemon and needs no install.
  for (const toolsetId of ['builtin.workspace-fs-read', 'builtin.workspace-fs-write']) {
    await client.installToolset(toolsetId, { scope: { kind: 'gezel', gezelId: designer.id } });
  }
  await client.sendChatMessage(designer.id, { message: THEME_KICKOFF, projectId });
  log(`[scenario:setup] sent theme round-trip kickoff to ${designer.name}`);
}

export const docblocksThemeRoundtripScenario: EvalScenario = {
  id: 'docblocks-theme-roundtrip',
  description:
    "DocBlocks theme round-trip on the bundled DocBlocks: infer a theme from a real brand deck, apply it, save the themed deck, inspect and compare it, and publish a report whose cited values (theme id, two fonts, two hex colors, the saved deck's slide count, a comparison figure) all came from tool responses. Grades tool provenance, a real PPTX that carries the brand, and grounding against values no model can guess.",
  prompt: [
    `${DESIGNER_NAME} is aligning the quarterly review deck in the "${PROJECT_NAME}" project.`,
    'No Meester action is needed; just acknowledge this note.',
  ].join(' '),
  // Whitespace-tolerant: the kickoff is a wrapped string array, so a line
  // break lands wherever the source happens to wrap.
  requiredPromptEvidence: [
    {
      signal: 'ordered-sections',
      pattern: /theme applied;\s+slide count;\s+what changed;\s+recommendation/,
    },
    { signal: 'theme-id', pattern: /cite the exact theme id/ },
    { signal: 'fonts', pattern: /heading font,\s+body\s+font/ },
    { signal: 'palette', pattern: /primary hex, and background hex/ },
    { signal: 'slide-count', pattern: /slide count\s+as a number/ },
    { signal: 'compare-cited', pattern: /similarity percentage\s+compare_documents reported/ },
  ],
  evidenceTexts: [THEME_MISSION, THEME_KICKOFF],
  requiresDocblocks: true,
  timeoutMs: 30 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  // The judge sees the rubric, the brief, the kickoff and the report — never
  // the tool transcript — so an axis is worth carrying only if it is
  // decidable from the report against facts stated here.
  judge: {
    artifactBasename: THEME_REPORT_PATH,
    artifactKind: 'markdown',
    contextNote: [
      'Theme inference returned exactly these values:',
      `theme id ${THEME_FACTS.themeId}; heading font ${THEME_FACTS.headingFont};`,
      `body font ${THEME_FACTS.bodyFont}; primary ${THEME_FACTS.primaryHex};`,
      `background ${THEME_FACTS.backgroundHex}. The slide count and comparison figures`,
      "depend on the session's own conversion, and a deterministic gate already checks",
      'them against the saved deck and the comparison result. Judge what it cannot:',
      'whether the report adds detail no tool returned, states the differences plainly,',
      'and ends somewhere useful. Do not mark a report down for lacking per-fact tool',
      'attribution — the brief does not ask for it.',
    ].join(' '),
    axes: [
      {
        name: 'grounding',
        description:
          'No invented detail: every specific claim is one of the values listed above, a ' +
          'slide count or comparison figure, or is plainly hedged. Fonts or colors beyond ' +
          'that list are fabrication.',
      },
      {
        name: 'candor',
        description:
          'Differences the comparison found are stated plainly rather than smoothed over.',
      },
      {
        name: 'usefulness',
        description: 'The recommendation is a decision someone could act on this week.',
      },
    ],
  },
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const projectId = await findProjectId(ctx.client);
    if (!projectId) {
      ctx.logChanged('project', '[scenario] theme round-trip project not present yet');
      return { done: false };
    }

    const markdown = await readWorkspaceText(ctx.client, projectId, THEME_REPORT_PATH);
    if (markdown === null) {
      ctx.logChanged('sniff', `[scenario] ${THEME_REPORT_PATH} not present yet`);
      ctx.recordSniff?.({ key: 'docblocks-theme-roundtrip', score: 0, bytes: 0 });
      const nearMiss = await findWorkspaceDeliverableNearMiss(
        ctx.client,
        projectId,
        THEME_REPORT_PATH,
      );
      await postMissingDeliverableFeedback(ctx, THEME_REPORT_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        nearMiss,
        projectId,
      });
      return { done: false };
    }

    // Tool calls commit when their turn ends; until then the trace is
    // missing the very calls that would satisfy provenance.
    const trace = await readProjectToolTrace(ctx.client, projectId);
    if (trace === null || (await projectTurnInProgress(ctx.client, projectId))) {
      ctx.logChanged('sniff', '[scenario] theme report present; waiting for the turn to commit');
      return { done: false };
    }

    const deckBytes = await readArtifactBytes(ctx.client, projectId, THEMED_DECK_PATH);
    const deckReal =
      deckBytes !== null && verifyBinaryDocumentBytes(THEMED_DECK_PATH, deckBytes).ok;
    const compare = compareEvidence(trace);
    const contentCheck = checkThemeReport(markdown, {
      slideCount: deckReal ? pptxSlideCount(deckBytes) : null,
      comparePercents: compare.percents,
      compareEquivalent: compare.equivalent,
    });

    // Provenance: each named tool succeeded at least once, and the saved deck
    // is a real PPTX carrying the brand — which a conversion that skipped the
    // theme would not.
    const missingTools = REQUIRED_TOOLS.filter(
      (name) => !trace.some((call) => call.name === name && call.success),
    );
    const provenanceFailures = [
      ...missingTools.map(
        (name) => `${name} never succeeded; call it — describing the step does not count`,
      ),
      ...(deckBytes === null
        ? [`${THEMED_DECK_PATH} was never saved — call save_artifact with that destination path`]
        : !deckReal
          ? [verifyBinaryDocumentBytes(THEMED_DECK_PATH, deckBytes).detail]
          : !pptxCarriesBrandFonts(deckBytes)
            ? [
                `${THEMED_DECK_PATH} does not use the brand fonts — convert the result of apply_inferred_theme, not the plain source`,
              ]
            : []),
    ];
    const provenanceOk = provenanceFailures.length === 0;

    const check: SniffResult = provenanceOk
      ? {
          ...contentCheck,
          signals: [...contentCheck.signals, 'docblocks-provenance'],
          score: contentCheck.score + 1,
          scoreMax: contentCheck.scoreMax + 1,
        }
      : {
          ...contentCheck,
          ok: false,
          scoreMax: contentCheck.scoreMax + 1,
          failReason: [provenanceFailures[0], contentCheck.failReason]
            .filter(Boolean)
            .join('; also: '),
          missingRequiredSignals: [
            ...(contentCheck.missingRequiredSignals ?? []),
            'docblocks-provenance',
          ],
        };

    ctx.logChanged(
      'sniff',
      `[scenario] docblocks-theme bytes=${markdown.length} score=${check.score}/${check.scoreMax} signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    ctx.recordSniff?.({
      key: 'docblocks-theme-roundtrip',
      score: check.score,
      bytes: markdown.length,
      repairFilePath: THEME_REPORT_PATH,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `theme report is tool-grounded and the saved deck carries the brand (${check.signals.join(', ')})`,
      };
    }
    if (check.failReason) {
      const needsToolCall = !provenanceOk;
      await postSniffFeedback(ctx, THEME_REPORT_PATH, check, {
        projectId,
        sourceText: markdown,
        expectedDeliverable: needsToolCall ? null : undefined,
        postReadMutationTarget: needsToolCall ? THEME_REPORT_PATH : undefined,
        repairDirective: needsToolCall
          ? `Call the named DocBlocks tool(s) now and save the themed deck through save_artifact to ${THEMED_DECK_PATH} — writing about a step does not count. Then rewrite ${THEME_REPORT_PATH} from the values the tools returned.`
          : `Patch ${THEME_REPORT_PATH} to carry the exact values the DocBlocks tools returned. Do not estimate a font, color, slide count or percentage — re-read the tool responses.`,
      });
    }
    return { done: false };
  },
};
