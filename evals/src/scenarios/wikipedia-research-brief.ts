import type { MockService } from '@bendyline/gezel';
import { evaluateMockExpectations, mockMcpToolsetId } from '../mock/mock-server.ts';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { containsOnlyQualifiedClaim, containsUnqualifiedClaim } from './claim-guards.ts';
import {
  findWorkspaceDeliverableNearMiss,
  provisionScenarioGezel,
  readProjectToolTrace,
} from './helpers.ts';

/**
 * Hermetic research task backed by a real per-trial MCP server. The source
 * cards are served through tools rather than seeded files, so the scenario
 * measures tool discovery, source selection, citation, and calibration
 * while keeping every byte local and repeatable.
 *
 * "Hermetic" is ENFORCED, not assumed. Three layers, because two of them
 * are silent when they fail:
 *   1. The researcher's builtin roster is narrowed to workspace file tools
 *      (installing builtin toolsets replaces the role default), which drops
 *      the `web` group the Researcher role otherwise ships.
 *   2. `webSearch.provider` is pinned to `mock` for the trial. Gezel's
 *      default web-search backend is a REAL, keyless Wikipedia API — the
 *      one source this scenario must not reach.
 *   3. The grader asserts no live-retrieval tool was called at all. Layers
 *      1-2 are configuration and can be undone by an unrelated change;
 *      only this one fails loudly. It matters because live Wikipedia would
 *      supply roughly the same facts, so a non-hermetic trial would still
 *      pass every content gate and quietly stop measuring what it claims.
 */

const PROJECT_NAME = 'Analytical Engine Research Brief';
const RESEARCHER_NAME = 'Elian';
export const WIKIPEDIA_RESEARCH_PATH = 'research-brief.md';

/** Source ids the brief must cite. */
export const WIKIPEDIA_SOURCE_IDS = [
  'WIKI-ADA-1843',
  'WIKI-ENGINE-DESIGN',
  'WIKI-MENABREA-1842',
] as const;

/**
 * A same-named, obviously-irrelevant card returned by the same search. It
 * costs one extra tool result and turns "cite everything you were handed"
 * into an actual selection decision — without it the search step is
 * decorative, since every returned card belonged in the brief.
 */
export const WIKIPEDIA_DECOY_SOURCE_ID = 'WIKI-ENGINE-BAND';

/**
 * Tools that reach the live network. Any successful call to one of these
 * means the brief is no longer sourced only from the local snapshot.
 * Matched on canonical MCP tool names plus the Copilot-native built-ins,
 * so a provider that runs its own tool loop is covered where its calls are
 * visible at all.
 *
 * `wikipedia_search` / `wikipedia_read` are the builtins that hit the live,
 * keyless Wikipedia API — the exact source layer 2 pins away. They are
 * registered separately from `web_search`, so pinning `webSearch.provider`
 * to `mock` does NOT cover them and this assertion is the only layer that
 * fails loudly if they reach the roster. Note the underscore order: the
 * hermetic mock's `search_wikipedia` / `read_wikipedia_sources` are
 * deliberately NOT matched here — those are the tools the brief must use.
 */
const LIVE_RETRIEVAL_TOOLS =
  /^(?:web_search|web_fetch|wikipedia_search|wikipedia_read|fetch_url|open_url|http_request|browser_navigate|browser_[a-z_]+|playwright_[a-z_]+)$/i;

export const WIKIPEDIA_RESEARCH_MISSION = [
  'Research Ada Lovelace and the Analytical Engine using only the local Wikipedia MCP',
  'tools installed for this project. Publish research-brief.md at the workspace root.',
  'The brief must be 700-1,500 words and contain Executive summary, Timeline, Findings',
  'and interpretation, Caveats, and Sources sections. Cite the supplied source ids',
  'WIKI-ADA-1843, WIKI-ENGINE-DESIGN, and WIKI-MENABREA-1842 inline. Distinguish',
  'documented facts from the debated shorthand that Lovelace was the first programmer.',
  'Do not use the live web or claim that the Analytical Engine was completed in 1843.',
].join(' ');

export const WIKIPEDIA_RESEARCH_KICKOFF = [
  "Prepare a concise research brief at `research-brief.md` about Ada Lovelace's work",
  'on the Analytical Engine. This project has a LOCAL Wikipedia MCP on your tool roster.',
  'First call `search_wikipedia`, then call `read_wikipedia_sources`; use only those',
  'responses as external research. Do not browse the live web. Write 700-1,500 words',
  'with these H2 sections in order: Executive summary; Timeline; Findings and',
  'interpretation; Caveats; Sources. Cite [WIKI-ADA-1843], [WIKI-ENGINE-DESIGN], and',
  "[WIKI-MENABREA-1842] inline next to the claims they support. Cover Menabrea's 1842",
  "paper, Lovelace's 1843 translation and Notes A-G, Note G's Bernoulli-number",
  "algorithm, Babbage's design, and the fact that the Engine was not completed in",
  'their lifetimes. Treat “first programmer” as a debated shorthand, not an',
  'unqualified fact. The search also returns off-topic hits — cite only sources',
  'that actually support the brief. Write the complete file now.',
].join(' ');

export const WIKIPEDIA_MOCK_SERVICES: MockService[] = [
  {
    kind: 'mcp',
    id: 'wikipedia',
    description:
      'A deterministic, offline Wikipedia research surface for the Analytical Engine brief.',
    tools: [
      {
        name: 'search_wikipedia',
        description:
          'Search the local Wikipedia snapshot for Ada Lovelace, the Analytical Engine, and Menabrea.',
        resultTemplate: {
          snapshot: 'offline-2026-08-productivity-eval',
          hits: [
            { title: 'Ada Lovelace', sourceId: 'WIKI-ADA-1843' },
            { title: 'Analytical Engine', sourceId: 'WIKI-ENGINE-DESIGN' },
            { title: 'Luigi Federico Menabrea', sourceId: 'WIKI-MENABREA-1842' },
            { title: 'Analytical Engine (band)', sourceId: 'WIKI-ENGINE-BAND' },
          ],
          note: 'Call read_wikipedia_sources to retrieve the signed source cards. Not every hit is relevant to a history brief.',
        },
      },
      {
        name: 'read_wikipedia_sources',
        description:
          'Read the signed source cards returned by the local Wikipedia snapshot search.',
        resultTemplate: {
          snapshot: 'offline-2026-08-productivity-eval',
          sources: [
            {
              sourceId: 'WIKI-ADA-1843',
              title: 'Ada Lovelace',
              revision: 'local-rev-ada-7',
              extract:
                "In 1843 Lovelace published an English translation of Menabrea's paper with Notes A through G. Note G described an algorithm for computing Bernoulli numbers for the proposed Analytical Engine. The Engine was not completed in her lifetime. Lovelace is often described as the first computer programmer, but historians debate how broadly that shorthand should be applied and how authorship should be divided between Lovelace and Babbage.",
            },
            {
              sourceId: 'WIKI-ENGINE-DESIGN',
              title: 'Analytical Engine',
              revision: 'local-rev-engine-4',
              extract:
                "Charles Babbage designed the Analytical Engine as a general-purpose mechanical computing machine. Its plans separated a store for numbers from a mill for operations and used punched cards for instructions and data. The full machine was never completed during Babbage's or Lovelace's lifetimes.",
            },
            {
              sourceId: 'WIKI-MENABREA-1842',
              title: 'Luigi Federico Menabrea',
              revision: 'local-rev-menabrea-3',
              extract:
                "Menabrea published a French account of Babbage's Analytical Engine in 1842 after attending Babbage's Turin lectures. Lovelace translated that account into English in 1843 and added notes that were substantially longer than the original paper.",
            },
            {
              sourceId: 'WIKI-ENGINE-BAND',
              title: 'Analytical Engine (band)',
              revision: 'local-rev-band-1',
              extract:
                'Analytical Engine is a synthpop trio formed in Leeds in 2019. Their debut album Punch Card Romance charted in 2021. The band takes its name from the Babbage machine but has no connection to computing history.',
            },
          ],
          citationRule:
            'Cite the sourceId in square brackets next to supported claims. Cite only the cards that actually support the brief.',
        },
      },
    ],
  },
];

function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)?.length ?? 0;
}

function orderedSectionPositions(markdown: string, names: string[]): number[] {
  return names.map((name) => markdown.search(new RegExp(`^##\\s+${name}\\s*$`, 'im')));
}

/** Every signal is counted, so `scoreMax` is always present (unlike the base shape). */
export interface WikipediaResearchResult extends SniffResult {
  scoreMax: number;
}

export function checkWikipediaResearchBrief(markdown: string): WikipediaResearchResult {
  const signals: string[] = [];
  const missing: string[] = [];
  let failReason: string | undefined;
  const pass = (signal: string) => signals.push(signal);
  const fail = (signal: string, reason: string) => {
    missing.push(signal);
    failReason ??= reason;
  };

  const words = wordCount(markdown);
  if (words >= 700 && words <= 1_500) pass('word-band');
  else fail('word-band', `research brief is ${words} words; required range is 700-1,500`);

  const sectionNames = [
    'Executive summary',
    'Timeline',
    'Findings and interpretation',
    'Caveats',
    'Sources',
  ];
  const positions = orderedSectionPositions(markdown, sectionNames);
  if (
    positions.every((position) => position >= 0) &&
    positions.every((p, i) => i === 0 || p > positions[i - 1]!)
  ) {
    pass('ordered-sections');
  } else {
    fail('ordered-sections', `missing or out-of-order H2 sections: ${sectionNames.join(', ')}`);
  }

  // Each fact is one independent signal. An earlier revision chained the
  // 1843 translation, Lovelace, and "Notes A-G" through two proximity
  // windows, which failed a correct brief that put the translation in
  // Timeline and the Notes in Findings — the gate measured paragraph
  // layout, not comprehension.
  const facts: Array<[string, RegExp, string]> = [
    [
      'menabrea-1842',
      /menabrea[\s\S]{0,160}1842|1842[\s\S]{0,160}menabrea/i,
      "Menabrea's 1842 paper",
    ],
    [
      'lovelace-1843',
      /lovelace[\s\S]{0,180}1843|1843[\s\S]{0,180}lovelace/i,
      "Lovelace's 1843 translation",
    ],
    [
      'notes-a-g',
      /notes?\s+a\s*(?:[-–—]|through|to|,\s*b[\s\S]{0,40}?and)\s*g\b/i,
      'the Notes A-G Lovelace appended',
    ],
    ['bernoulli', /note\s+g[\s\S]{0,180}bernoulli/i, "Note G's Bernoulli-number algorithm"],
    [
      'babbage-design',
      /babbage[\s\S]{0,160}(?:design|general-purpose|store|mill)/i,
      "Babbage's Engine design",
    ],
    [
      'not-completed',
      /(?:not|never)\s+(?:fully\s+)?completed|wasn['’]?t\s+(?:fully\s+)?completed/i,
      'the Engine was not completed in their lifetimes',
    ],
  ];
  for (const [signal, pattern, label] of facts) {
    if (pattern.test(markdown)) pass(signal);
    else fail(signal, `missing grounded finding: ${label}`);
  }

  const citationPattern = (id: string) =>
    new RegExp(`\\[${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'i');
  const missingCitations = WIKIPEDIA_SOURCE_IDS.filter((id) => !citationPattern(id).test(markdown));
  if (missingCitations.length === 0) pass('source-citations');
  else fail('source-citations', `missing inline source ids: ${missingCitations.join(', ')}`);

  if (!citationPattern(WIKIPEDIA_DECOY_SOURCE_ID).test(markdown)) pass('no-decoy-citation');
  else
    fail(
      'no-decoy-citation',
      `${WIKIPEDIA_DECOY_SOURCE_ID} is a synthpop band, not a source for this brief — remove the citation`,
    );

  // Segment-scoped, not document-scoped: the old gate accepted an outright
  // assertion of "first programmer" as long as the word "debate" appeared
  // anywhere in the file, including about something else entirely.
  const calibrated = containsOnlyQualifiedClaim(
    markdown,
    /first (?:computer )?programmer/i,
    /debate|contested|disputed|qualified|shorthand|often (?:called|described)|historians? (?:differ|disagree)/i,
  );
  if (calibrated) pass('claim-calibration');
  else
    fail(
      'claim-calibration',
      'every mention of the “first programmer” label must be hedged in the same sentence as debated shorthand',
    );

  // Negation-aware: "nothing resembling the engine was completed in 1843"
  // is a correct sentence that the old document-wide regex failed.
  const falseCompletion =
    containsUnqualifiedClaim(
      markdown,
      /(?:analytical )?engine[\s\S]{0,40}(?:built|completed|operational)[\s\S]{0,30}(?:in|by)\s*1843/i,
      /\b(?:not|never|nothing|no|unfinished|incomplete)\b|wasn['’]?t|hadn['’]?t/i,
    ) ||
    containsUnqualifiedClaim(
      markdown,
      /(?:ada\s+)?lovelace[\s\S]{0,40}(?:built|completed|constructed)[\s\S]{0,30}engine/i,
      /\b(?:not|never|nothing|no)\b|wasn['’]?t|didn['’]?t/i,
    );
  if (!falseCompletion) pass('no-false-completion');
  else
    fail(
      'no-false-completion',
      'false claim present: the Analytical Engine was not completed in 1843 and Lovelace did not build it',
    );

  return {
    ok: missing.length === 0,
    signals,
    score: signals.length,
    scoreMax: signals.length + missing.length,
    ...(failReason ? { failReason, missingRequiredSignals: missing } : {}),
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

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log, mocks } = ctx;
  if (!mocks) throw new Error('wikipedia-research setup: local Wikipedia MCP did not start');

  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'A hermetic research project. External-looking facts must come from the local Wikipedia MCP snapshot; live web access is out of scope.',
      missionObjectives: WIKIPEDIA_RESEARCH_MISSION,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('wikipedia-research setup: failed to resolve project id');

  // Hermeticity layer 2 (see the module header). Gezel's default
  // web-search backend is the REAL Wikipedia API — keyless and always
  // available — so leaving this unset points the one forbidden tool at
  // the one source that would make a non-hermetic trial look like a pass.
  try {
    await client.updateConfig({ webSearch: { provider: 'mock' } });
    log('[scenario:setup] pinned webSearch.provider=mock (no live retrieval backend)');
  } catch (error) {
    // Not fatal — the roster narrowing below already removes `web`, and
    // the grader asserts the negative regardless. Loud, because a silent
    // skip here is how the hermetic claim would rot.
    log(`[scenario:setup] WARNING could not pin webSearch.provider: ${String(error)}`);
  }

  mocks.bindProject(projectId);
  await client.writeProjectWorkspaceFile(projectId, {
    path: 'mocks/services.md',
    content: mocks.servicesMarkdown(),
  });
  await client.installToolset(mockMcpToolsetId('wikipedia'), {
    scope: { kind: 'project', projectId },
  });
  log('[scenario:setup] installed the local Wikipedia MCP toolset');

  const researcher = await provisionScenarioGezel(ctx, {
    preferredName: RESEARCHER_NAME,
    role: 'Researcher',
    label: 'researcher',
  });
  await client.addGezelToProject(projectId, researcher.id);
  // Hermeticity layer 1. Installing builtin toolsets REPLACES the role
  // default (`toolsetsGroupOverride`) rather than adding to it, so this
  // list is the researcher's entire builtin roster — which is how the
  // Researcher role's `web` and `browser-automation` groups come off. The
  // project-scoped mock MCP is unaffected: only builtin groups feed the
  // override. Adding a group here re-opens the live web.
  for (const toolsetId of ['builtin.workspace-fs-read', 'builtin.workspace-fs-write']) {
    await client.installToolset(toolsetId, { scope: { kind: 'gezel', gezelId: researcher.id } });
  }
  await client.sendChatMessage(researcher.id, {
    message: WIKIPEDIA_RESEARCH_KICKOFF,
    projectId,
  });
  log(`[scenario:setup] sent research kickoff to ${researcher.name}`);
}

export const wikipediaResearchScenario: EvalScenario = {
  id: 'wikipedia-research-brief',
  description:
    'Hermetic tool-backed research: discover and call a local Wikipedia MCP, select the three relevant signed source cards out of four returned hits, synthesize them into a 700-1,500-word cited brief, preserve chronology, and calibrate a disputed historical claim. Live retrieval is blocked by configuration AND asserted against in the grader.',
  prompt: [
    `${RESEARCHER_NAME} is preparing the research brief in the "${PROJECT_NAME}" project.`,
    'No Meester action is needed; just acknowledge this note.',
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'word-band', pattern: /700-1,500 words/ },
    {
      signal: 'ordered-sections',
      pattern:
        /executive summary[\s\S]*timeline[\s\S]*findings and interpretation[\s\S]*caveats[\s\S]*sources/,
    },
    {
      signal: 'source-citations',
      pattern: /wiki-ada-1843[\s\S]*wiki-engine-design[\s\S]*wiki-menabrea-1842/,
    },
    { signal: 'claim-calibration', pattern: /first programmer[”"]? as a debated shorthand/ },
    { signal: 'not-completed', pattern: /engine was not completed/ },
    { signal: 'notes-a-g', pattern: /notes a-g/ },
    { signal: 'no-decoy-citation', pattern: /off-topic hits — cite only sources/ },
  ],
  evidenceTexts: [WIKIPEDIA_RESEARCH_MISSION, WIKIPEDIA_RESEARCH_KICKOFF],
  mockServices: WIKIPEDIA_MOCK_SERVICES,
  timeoutMs: 35 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  judge: {
    artifactBasename: WIKIPEDIA_RESEARCH_PATH,
    artifactKind: 'markdown',
    contextNote:
      'All historical evidence comes from the three signed local Wikipedia source cards. The “first programmer” label must remain calibrated rather than asserted as uncontested fact.',
    axes: [
      {
        name: 'synthesis',
        description: 'Builds an argument across sources rather than listing source summaries.',
      },
      {
        name: 'grounding',
        description: 'Claims and dates stay faithful to the signed local source cards.',
      },
      {
        name: 'citationQuality',
        description:
          'Source ids appear near the claims they support and make provenance easy to audit.',
      },
      {
        name: 'calibration',
        description:
          'Separates documented facts, interpretation, and disputed historical shorthand.',
      },
    ],
  },
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const projectId = await findProjectId(ctx.client);
    if (!projectId) {
      ctx.logChanged('project', '[scenario] wikipedia research project not present yet');
      return { done: false };
    }
    const markdown = await readWorkspaceText(ctx.client, projectId, WIKIPEDIA_RESEARCH_PATH);
    if (markdown === null) {
      ctx.logChanged('sniff', `[scenario] ${WIKIPEDIA_RESEARCH_PATH} not present yet`);
      ctx.recordSniff?.({ key: 'wikipedia-research-brief', score: 0, bytes: 0 });
      const nearMiss = await findWorkspaceDeliverableNearMiss(
        ctx.client,
        projectId,
        WIKIPEDIA_RESEARCH_PATH,
      );
      await postMissingDeliverableFeedback(ctx, WIKIPEDIA_RESEARCH_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        nearMiss,
        projectId,
      });
      return { done: false };
    }

    // A missing mock runtime is a broken harness, not a model that failed
    // the task. Booking it as a content failure would pollute the `model`
    // column of every pass-rate table this scenario appears in.
    if (!ctx.mocks) {
      ctx.requestTerminalFailure?.({
        reason: 'local Wikipedia MCP runtime missing — scenario cannot be graded',
        failureMode: 'spawn-error',
      });
      return { done: false };
    }

    const contentCheck = checkWikipediaResearchBrief(markdown);
    const mockFailures = evaluateMockExpectations(
      [{ service: 'wikipedia', requiredTools: ['search_wikipedia', 'read_wikipedia_sources'] }],
      ctx.mocks,
    );
    const liveRetrieval = await findLiveRetrievalCalls(ctx, projectId);
    const provenanceFailures = [
      ...mockFailures,
      ...(liveRetrieval.length > 0
        ? [
            `live retrieval is forbidden in this scenario but ${liveRetrieval.join(', ')} was called; the brief must be sourced only from the local Wikipedia MCP`,
          ]
        : []),
    ];

    const provenanceOk = provenanceFailures.length === 0;
    const check: SniffResult = provenanceOk
      ? {
          ...contentCheck,
          signals: [...contentCheck.signals, 'mcp-research-provenance'],
          score: contentCheck.score + 1,
          scoreMax: contentCheck.scoreMax + 1,
        }
      : {
          ...contentCheck,
          ok: false,
          scoreMax: contentCheck.scoreMax + 1,
          // Keep the content failure alongside the provenance one. Dropping
          // it meant a model that skipped the tools AND wrote a thin brief
          // got no content feedback at all for a whole nudge cycle.
          failReason: [provenanceFailures[0], contentCheck.failReason]
            .filter(Boolean)
            .join('; also: '),
          missingRequiredSignals: [
            ...(contentCheck.missingRequiredSignals ?? []),
            'mcp-research-provenance',
          ],
        };

    ctx.logChanged(
      'sniff',
      `[scenario] wikipedia-research bytes=${markdown.length} score=${check.score}/${check.scoreMax} signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    ctx.recordSniff?.({
      key: 'wikipedia-research-brief',
      score: check.score,
      bytes: markdown.length,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `research brief is tool-grounded and passes all content gates (${check.signals.join(', ')})`,
      };
    }
    if (check.failReason) {
      // A provenance failure needs a TOOL CALL, not another edit, so the
      // nudge switches off the "expected deliverable" framing and asks for
      // a read-then-rewrite instead of a patch.
      const needsToolCall = !provenanceOk;
      await postSniffFeedback(ctx, WIKIPEDIA_RESEARCH_PATH, check, {
        projectId,
        sourceText: markdown,
        expectedDeliverable: needsToolCall ? null : undefined,
        postReadMutationTarget: needsToolCall ? WIKIPEDIA_RESEARCH_PATH : undefined,
        repairDirective: needsToolCall
          ? 'Call the named local Wikipedia MCP tool(s) now; writing that you used them does not count, and the live web is off-limits. Then revise research-brief.md from their returned source cards.'
          : 'Patch research-brief.md to fix the named content or citation gap while preserving already-correct sections.',
      });
    }
    return { done: false };
  },
};

/**
 * Names of live-retrieval tools this trial actually called. Empty when the
 * trace is unreadable — an unknown trace must not be reported as a
 * violation, and the mock-call requirement already fails loudly if the
 * model never reached the local snapshot at all.
 */
async function findLiveRetrievalCalls(ctx: EvalContext, projectId: string): Promise<string[]> {
  const trace = await readProjectToolTrace(ctx.client, projectId);
  if (!trace) return [];
  const hits = new Set<string>();
  for (const call of trace) {
    if (call.success && LIVE_RETRIEVAL_TOOLS.test(call.name)) hits.add(call.name);
  }
  return [...hits].sort();
}
