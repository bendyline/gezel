import type { MockService } from '@bendyline/gezel';
import { verifyBinaryDocumentBytes } from '@bendyline/gezel';
import { evaluateMockExpectations, mockMcpToolsetId } from '../mock/mock-server.ts';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { containsUnqualifiedClaim } from './claim-guards.ts';
import { findWorkspaceDeliverableNearMiss, provisionScenarioGezel } from './helpers.ts';

/**
 * DocBlocks theme round-trip — "match our brand deck, then tell me what
 * changed".
 *
 * The three bundled DocBlocks craftbook evals all measure the same shape:
 * author Markdown, convert, save. That leaves five tools in the pinned
 * 19-tool DocBlocks inventory with no coverage at all —
 * `infer_theme_from_file`, `apply_inferred_theme`, `inspect_document`,
 * `compare_documents`, `list_transform_styles` — and, more importantly, no
 * coverage of the capability they add: taking an EXISTING document as the
 * source of truth and reporting a verified difference against it.
 *
 * What makes this gradeable rather than vibes: every value the report must
 * cite is invented and only obtainable by calling a tool. The brand theme's
 * fonts and hex colors, the before/after page counts, the specific style
 * conflict — none appear in the seeded brief or anywhere a model could
 * guess. So a fabricated report ("applied the corporate theme, everything
 * looks great") fails on grounding, and a report that merely *narrates*
 * tool calls it never made fails the provenance gate. That is the failure
 * this scenario exists to catch: the model that describes doing the work.
 *
 * Deliberately NOT a craftbook eval. A `test.json` sidecar can express
 * "these tools were called" and "this file matches a regex", but not "the
 * numbers in the prose are the numbers the tools returned, and the deck
 * really is a ZIP".
 */

const PROJECT_NAME = 'Brand Theme Alignment';
const DESIGNER_NAME = 'Wieke';
export const THEME_REPORT_PATH = 'theme-report.md';
export const THEMED_DECK_PATH = 'deliverables/quarterly-review.pptx';

/**
 * Invented facts the mock returns. Nothing here is inferable from the
 * seeded brief — citing them correctly is only possible after a real call,
 * which is what makes the grounding gates meaningful.
 */
export const THEME_FACTS = {
  themeId: 'BRAND-THEME-7F2A',
  headingFont: 'Kelder Grotesk',
  bodyFont: 'Marne Text',
  accentHex: '#2E5E4E',
  backgroundHex: '#F4F1EA',
  pagesBefore: 11,
  pagesAfter: 9,
  conflictStyle: 'Callout Emphasis',
} as const;

export const THEME_MISSION = [
  'Align the quarterly review deck with the brand deck using only the local DocBlocks tools.',
  'Infer the theme from the brand file, apply it, re-inspect, compare the two revisions, and',
  'publish theme-report.md citing the theme id, both fonts, both hex colors, the before and',
  'after page counts, and the one style that could not be applied cleanly.',
].join(' ');

export const THEME_KICKOFF = [
  'The brand team signed off on `source/brand-reference.pptx`. Bring',
  '`source/quarterly-review.md` in line with it and report what changed.',
  '',
  'Use the DocBlocks tools on your roster, in this order:',
  '1. `infer_theme_from_file` on the brand reference to read its theme.',
  '2. `inspect_document` on the current deck to record its page count BEFORE any change.',
  '3. `apply_inferred_theme` to apply that theme to the quarterly review.',
  '4. `convert_document` then `save_artifact` to produce the themed deck at',
  `   \`${THEMED_DECK_PATH}\`.`,
  '5. `inspect_document` again for the page count AFTER, and `compare_documents` to get the',
  '   list of styles that did not transfer cleanly.',
  '',
  `Then write \`${THEME_REPORT_PATH}\` with these H2 sections in order: Theme applied;`,
  'Page count; Style conflicts; Recommendation. Cite the exact theme id, heading font, body',
  'font, accent hex, and background hex the tools returned; give the before and after page',
  'counts as numbers; and name the one style that conflicted. Every value in the report must',
  'come from a tool response — do not estimate, and do not describe a step you did not run.',
].join('\n');

export const THEME_SEED_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'source/quarterly-review.md',
    content: [
      '# Quarterly review — returns desk',
      '',
      '## Where we landed',
      'The returns pilot covered 18 SKUs. Median first response moved from 18 hours to 6.',
      '',
      '## What we are watching',
      'Preventable refund leakage fell from 14.2% to 8.9%, but status silence after photo',
      'submission is still the top unresolved complaint.',
      '',
      '## Next',
      'Automated status emails, barcode-exception training, and a weekly Finance export.',
    ].join('\n'),
  },
  {
    path: 'source/brand-reference.pptx.txt',
    content: [
      'Stand-in for the binary brand deck. The real file is registered with DocBlocks as',
      '`source/brand-reference.pptx`; read its theme with `infer_theme_from_file` rather than',
      'opening it as text. This placeholder deliberately contains no theme values.',
    ].join('\n'),
  },
];

export const THEME_MOCK_SERVICES: MockService[] = [
  {
    kind: 'mcp',
    id: 'docblocks',
    toolsetId: 'docblocks',
    description:
      'Deterministic fake DocBlocks MCP for theme inference, application, inspection, and revision comparison.',
    tools: [
      {
        name: 'list_roots',
        description: 'List the workspace read root and the artifacts write root.',
        resultTemplate: {
          roots: [
            { id: 'workspace', name: 'workspace', capabilities: ['read'] },
            { id: 'artifacts', name: 'artifacts', capabilities: ['read', 'write'] },
          ],
        },
      },
      {
        name: 'infer_theme_from_file',
        description: 'Read the theme (fonts, palette, spacing) out of an existing document.',
        resultTemplate: {
          themeId: THEME_FACTS.themeId,
          source: 'source/brand-reference.pptx',
          fonts: { heading: THEME_FACTS.headingFont, body: THEME_FACTS.bodyFont },
          palette: { accent: THEME_FACTS.accentHex, background: THEME_FACTS.backgroundHex },
          spacing: { titleSlideMarginPt: 48, bodyMarginPt: 32 },
        },
      },
      {
        name: 'inspect_document',
        description: 'Report structural facts about a document revision.',
        resultTemplate: {
          revisions: [
            { label: 'before', path: 'source/quarterly-review.md', pages: THEME_FACTS.pagesBefore },
            { label: 'after', path: THEMED_DECK_PATH, pages: THEME_FACTS.pagesAfter },
          ],
          note: 'Applying the brand theme tightens spacing, so the themed deck is shorter.',
        },
      },
      {
        name: 'list_transform_styles',
        description: 'List the style transforms available when applying an inferred theme.',
        resultTemplate: {
          styles: ['Title', 'Heading 1', 'Heading 2', 'Body', 'Callout Emphasis', 'Table Grid'],
        },
      },
      {
        name: 'apply_inferred_theme',
        description: 'Apply a previously inferred theme to a document source.',
        resultTemplate: {
          applied: true,
          themeId: THEME_FACTS.themeId,
          appliedStyles: ['Title', 'Heading 1', 'Heading 2', 'Body', 'Table Grid'],
          skippedStyles: [THEME_FACTS.conflictStyle],
        },
      },
      {
        name: 'convert_document',
        description: 'Convert the themed Markdown to a deterministic PPTX artifact URI.',
        resultTemplate: {
          artifacts: [
            {
              format: 'pptx',
              uri: 'mock://docblocks/quarterly-review.pptx',
              sha256: '5555555555555555555555555555555555555555555555555555555555555555',
            },
          ],
          diagnostics: [],
        },
      },
      {
        name: 'save_artifact',
        description: 'Save the themed PPTX to the requested workspace path.',
        resultTemplate: { ok: true, bytes: 2400 },
        writeFixture: {
          surface: 'workspace',
          pathArgument: 'destination.path',
          fixture: 'minimal-pptx',
        },
      },
      {
        name: 'compare_documents',
        description: 'Diff two document revisions and report what did not transfer.',
        resultTemplate: {
          pagesBefore: THEME_FACTS.pagesBefore,
          pagesAfter: THEME_FACTS.pagesAfter,
          unresolved: [
            {
              style: THEME_FACTS.conflictStyle,
              reason: 'no matching style in the brand theme; left at the source formatting',
            },
          ],
          contentPreserved: true,
        },
      },
    ],
  },
];

interface ThemeSignal {
  signal: string;
  ok: boolean;
  reason: string;
}

export interface ThemeReportResult extends SniffResult {
  scoreMax: number;
}

/**
 * Grade the report against the values the tools actually returned.
 *
 * Every gate below is a GROUNDING gate, not a prose-shape gate: the report
 * has to carry an invented font name, an invented hex, an invented page
 * count. Approximate or remembered values fail, which is the point — this
 * is the one scenario in the suite where "sounds right" is worth zero.
 */
export function checkThemeReport(markdown: string): ThemeReportResult {
  const outcomes: ThemeSignal[] = [];
  const check = (signal: string, ok: boolean, reason: string) =>
    outcomes.push({ signal, ok, reason });

  const sectionNames = ['Theme applied', 'Page count', 'Style conflicts', 'Recommendation'];
  const positions = sectionNames.map((name) =>
    markdown.search(new RegExp(`^##\\s+${name}\\s*$`, 'im')),
  );
  check(
    'ordered-sections',
    positions.every((position) => position >= 0) &&
      positions.every((p, i) => i === 0 || p > positions[i - 1]!),
    `theme report needs ordered H2 sections: ${sectionNames.join(', ')}`,
  );

  check(
    'theme-id',
    new RegExp(THEME_FACTS.themeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(markdown),
    `cite the exact theme id ${THEME_FACTS.themeId} returned by infer_theme_from_file`,
  );
  check(
    'fonts',
    new RegExp(THEME_FACTS.headingFont, 'i').test(markdown) &&
      new RegExp(THEME_FACTS.bodyFont, 'i').test(markdown),
    `name both inferred fonts: ${THEME_FACTS.headingFont} (heading) and ${THEME_FACTS.bodyFont} (body)`,
  );
  // Hex is compared case-insensitively but exactly otherwise — a
  // near-miss colour is a fabricated colour.
  check(
    'palette',
    new RegExp(THEME_FACTS.accentHex, 'i').test(markdown) &&
      new RegExp(THEME_FACTS.backgroundHex, 'i').test(markdown),
    `cite both palette values exactly: ${THEME_FACTS.accentHex} accent and ${THEME_FACTS.backgroundHex} background`,
  );

  const beforeAfter = new RegExp(
    `\\b${THEME_FACTS.pagesBefore}\\b[\\s\\S]{0,160}?\\b${THEME_FACTS.pagesAfter}\\b`,
  ).test(markdown);
  check(
    'page-delta',
    beforeAfter,
    `report the page count before (${THEME_FACTS.pagesBefore}) and after (${THEME_FACTS.pagesAfter}), in that order`,
  );

  check(
    'style-conflict',
    new RegExp(THEME_FACTS.conflictStyle, 'i').test(markdown),
    `name the one style that did not transfer: ${THEME_FACTS.conflictStyle}`,
  );

  // The conflict must be reported as unresolved. A report that lists the
  // style and then claims everything applied cleanly has described a
  // different outcome than the one compare_documents returned.
  check(
    'conflict-not-whitewashed',
    !containsUnqualifiedClaim(
      markdown,
      /(?:all|every)\s+styles?[\s\S]{0,40}(?:applied|transferred|matched)|no\s+(?:style\s+)?conflicts?|without\s+(?:any\s+)?conflicts?/i,
      /except|apart from|other than|aside from|besides/i,
    ),
    'the report claims every style applied cleanly, contradicting the reported conflict',
  );

  check(
    'recommendation',
    /^##\s+Recommendation\s*$[\s\S]{40,}/im.test(markdown),
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

async function readWorkspaceBytes(
  client: EvalContext['client'],
  projectId: string,
  filePath: string,
): Promise<Uint8Array | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log, mocks } = ctx;
  if (!mocks) throw new Error('docblocks-theme-roundtrip setup: local DocBlocks MCP did not start');

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

  for (const file of THEME_SEED_FILES) {
    await client.writeProjectWorkspaceFile(projectId, file);
  }
  mocks.bindProject(projectId);
  await client.writeProjectWorkspaceFile(projectId, {
    path: 'mocks/services.md',
    content: mocks.servicesMarkdown(),
  });
  await client.installToolset(mockMcpToolsetId('docblocks'), {
    scope: { kind: 'project', projectId },
  });
  log('[scenario:setup] installed the local DocBlocks MCP toolset');

  const designer = await provisionScenarioGezel(ctx, {
    preferredName: DESIGNER_NAME,
    role: 'Copywriter',
    label: 'document producer',
  });
  await client.addGezelToProject(projectId, designer.id);
  // Installing builtin toolsets REPLACES the role default, so this list is
  // the whole builtin roster — matching the other two hand-authored
  // productivity scenarios so tool-block size stays comparable across them.
  for (const toolsetId of ['builtin.workspace-fs-read', 'builtin.workspace-fs-write']) {
    await client.installToolset(toolsetId, { scope: { kind: 'gezel', gezelId: designer.id } });
  }
  await client.sendChatMessage(designer.id, { message: THEME_KICKOFF, projectId });
  log(`[scenario:setup] sent theme round-trip kickoff to ${designer.name}`);
}

const REQUIRED_TOOLS = [
  'infer_theme_from_file',
  'inspect_document',
  'apply_inferred_theme',
  'save_artifact',
  'compare_documents',
];

export const docblocksThemeRoundtripScenario: EvalScenario = {
  id: 'docblocks-theme-roundtrip',
  description:
    'DocBlocks theme round-trip: infer a theme from an existing brand document, apply it, re-inspect, compare revisions, and publish a report whose every cited value (theme id, two fonts, two hex colors, before/after page counts, the one unresolved style) came from a tool response. Grades tool provenance, a real PPTX container, and grounding against invented facts no model can guess.',
  prompt: [
    `${DESIGNER_NAME} is aligning the quarterly review deck in the "${PROJECT_NAME}" project.`,
    'No Meester action is needed; just acknowledge this note.',
  ].join(' '),
  // Patterns are whitespace-tolerant on purpose: the kickoff is a wrapped
  // string array, so a line break lands wherever the source happens to
  // wrap. A literal-space pattern here failed this very lint.
  requiredPromptEvidence: [
    {
      signal: 'ordered-sections',
      pattern: /theme applied;\s+page count;\s+style conflicts;\s+recommendation/,
    },
    { signal: 'theme-id', pattern: /cite the exact theme id/ },
    { signal: 'fonts', pattern: /heading font,\s+body\s+font/ },
    { signal: 'palette', pattern: /accent hex, and background hex/ },
    { signal: 'page-delta', pattern: /before and after page\s+counts as numbers/ },
    { signal: 'style-conflict', pattern: /name the one style that conflicted/ },
  ],
  evidenceTexts: [THEME_MISSION, THEME_KICKOFF],
  mockServices: THEME_MOCK_SERVICES,
  timeoutMs: 30 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  judge: {
    artifactBasename: THEME_REPORT_PATH,
    artifactKind: 'markdown',
    contextNote:
      'Every theme value in this report should be traceable to a DocBlocks tool response. Reward a report that makes the provenance auditable and states the unresolved style plainly.',
    axes: [
      {
        name: 'grounding',
        description: 'Cited theme values match what the tools returned, with no invented detail.',
      },
      {
        name: 'auditability',
        description: 'A reader can tell which tool produced each reported fact.',
      },
      {
        name: 'candor',
        description: 'The unresolved style conflict is stated plainly rather than smoothed over.',
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
    if (!ctx.mocks) {
      ctx.requestTerminalFailure?.({
        reason: 'local DocBlocks MCP runtime missing — scenario cannot be graded',
        failureMode: 'spawn-error',
      });
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

    const contentCheck = checkThemeReport(markdown);

    // Provenance: the named tools were really called…
    const mockFailures = evaluateMockExpectations(
      [{ service: 'docblocks', requiredTools: REQUIRED_TOOLS }],
      ctx.mocks,
    );
    // …and the themed deck is a real container, not the Markdown source
    // renamed. `save_artifact` materializes a real PPTX, so a deck that
    // fails this was written by hand around the tool rather than by it.
    const deckBytes = await readWorkspaceBytes(ctx.client, projectId, THEMED_DECK_PATH);
    const deckVerdict =
      deckBytes === null
        ? `${THEMED_DECK_PATH} was never saved — call save_artifact with that destination path`
        : verifyBinaryDocumentBytes(THEMED_DECK_PATH, deckBytes).ok
          ? null
          : verifyBinaryDocumentBytes(THEMED_DECK_PATH, deckBytes).detail;

    const provenanceFailures = [...mockFailures, ...(deckVerdict ? [deckVerdict] : [])];
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
        reason: `theme report is tool-grounded and the themed deck is a real PPTX (${check.signals.join(', ')})`,
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
          ? `Call the named DocBlocks tool(s) now and save the deck through save_artifact — writing about a step, or writing text to ${THEMED_DECK_PATH}, does not count. Then rewrite ${THEME_REPORT_PATH} from the values the tools returned.`
          : `Patch ${THEME_REPORT_PATH} to carry the exact values the DocBlocks tools returned. Do not estimate a font, colour, or page count — re-read the tool responses.`,
      });
    }
    return { done: false };
  },
};
