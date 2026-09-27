import type { CatalogDocument } from '@bendyline/gezel';
import { type AnnotatedOracle, gradeText } from '../annotated/oracle.ts';
import { craftbookScenarioFromSpec } from '../craftbooks/scenario.ts';
import { craftbookEvalSpecMap } from '../craftbooks/specs.ts';
import type { CraftbookEvalGateCheck, CraftbookEvalSpec } from '../craftbooks/types.ts';
import { benchTopics, fillerKnowledgeDocuments } from '../retrieval-bench/corpus/build.ts';
import { compileAndInstallCatalog } from '../retrieval-corpora/catalog.ts';
import { drainEmbeddings, sharedLibraryProjectId } from '../retrieval-corpora/seed.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { DECK_MD, DECOY_FIGURES, HALVARD_FACTS, variant } from './powerpoint-sources.ts';

/**
 * Annotated-work scenarios: does knowledge/index-annotated work produce
 * better deliverables? Each puts the facts a deliverable needs ONLY in an
 * index — a reference catalog or the shared library — next to decoys that
 * look right and are wrong, then grades the deliverable against a fact
 * oracle. Run them under `--retrieval` arms (`bin/ab-retrieval.ts`) so the
 * same work is done with and without per-turn context and the launch
 * reference list; `facts.retrieval` proves which arm actually ran.
 *
 * Every entity is fictional, so a model's memory cannot supply the facts.
 */

const CATALOG = {
  publisherId: 'gezel-bench',
  catalogId: 'annotated-reference',
  version: '1.0.0',
} as const;

const knowledgeKey = (docId: string) =>
  `knowledge://${CATALOG.publisherId}/${CATALOG.catalogId}/${docId}`;

function catalogDoc(id: string, title: string, topic: string, body: string): CatalogDocument {
  return {
    id,
    title,
    slug: id,
    summary: body.slice(0, 120),
    language: 'en',
    topicPath: [topic],
    markdown: `# ${title}\n\n${body}\n`,
  };
}

/**
 * The golden article carries the Halvard brief's figures. The first two sit
 * inside the opening paragraph (a reference snippet or a balanced excerpt
 * reaches them); the last two are deep (only a document read reaches them).
 */
const HALVARD_ARTICLE = catalogDoc(
  'annotated-halvard',
  'Halvard Terminal winter boarding pilot',
  'ports',
  [
    'The Halvard Terminal winter boarding pilot ran across 4 berths during the 2025-26 winter timetable and cut mean boarding time from 21.4 minutes to 12.8 minutes.',
    '',
    'The pilot covered 1,180 scheduled winter sailings. Terminal operations leads introduced marshalled queues, heated waiting shelters on each berth, and a single boarding call per sailing.',
    '',
    '## Reliability and accessibility',
    '',
    'Over the same period the missed-sailing rate fell from 6.7% to 2.1%. Passengers waiting for wheelchair assistance waited 5 minutes on average, down from 14 minutes before the pilot.',
    '',
    '## Open issues',
    '',
    'The most frequent unresolved complaint was the lack of an audible announcement on Berth 3. The next actions are a Berth 3 audio loop, a printed winter timetable card, and a second gangway marshal at 07:00.',
  ].join('\n'),
);

const KELBY_ARTICLE = catalogDoc(
  'annotated-kelby',
  'Kelby Terminal summer boarding pilot',
  'ports',
  'The Kelby Terminal summer boarding pilot ran across 9 berths during the 2025 summer timetable. Mean boarding time fell from 33.9 minutes to 27.2 minutes and the missed-sailing rate fell from 11.5% to 9.4%. The next actions were repainting the berth numbers and extending the kiosk hours.',
);

const HALVARD_BREWING = catalogDoc(
  'annotated-halvard-brewing',
  'Halvard Brewing Company',
  'food',
  'Halvard Brewing Company is a small brewery two streets from the old harbour. Its winter ale is brewed with 4 malts, and the taproom seats 21 guests.',
);

const MORROW_BREWING = catalogDoc(
  'annotated-morrow-brewing',
  'Morrow Brewing Company',
  'food',
  'Morrow Brewing Company brews a night porter that won a regional award in 2019. Its freight of empty casks leaves by rail on Thursdays.',
);

const TOP_DECK = catalogDoc(
  'annotated-top-deck',
  'Top Deck (harbour soda)',
  'food',
  'Top Deck is a lemon soda sold at harbour kiosks, advertised with a deck of cards and the slogan "one message per bottle".',
);

const FILLER = fillerKnowledgeDocuments(40, { seed: 0xa11e, idPrefix: 'annotated-filler' });

async function seedCatalog(ctx: EvalContext, documents: CatalogDocument[]): Promise<void> {
  await compileAndInstallCatalog(
    ctx.client,
    {
      ...CATALOG,
      name: 'Annotated Work Reference',
      description: 'Reference fixture for the annotated-work scenarios.',
      topics: benchTopics(),
      documents: [...documents, ...FILLER],
    },
    (line) => ctx.log(`[annotated] ${line}`),
  );
}

/** Load the daemon's embedder so the launch and the first turn take the semantic path. */
async function warmEmbeddings(ctx: EvalContext, projectId = 'default'): Promise<void> {
  await ctx.client.retrieval.previewRetrieval(projectId, {
    surface: 'search',
    query: 'warm up',
    warm: true,
  });
}

/**
 * Run a craftbook scenario with a reference catalog seeded BEFORE its setup,
 * because the workflow task — and so its launch reference list — is created
 * inside that setup.
 */
function withCatalog(
  scenario: EvalScenario,
  documents: CatalogDocument[],
  oracle: AnnotatedOracle,
): EvalScenario {
  const inner = scenario.setup;
  return {
    ...scenario,
    requiresEmbeddings: true,
    retrievalOracle: oracle.retrieval,
    async setup(ctx) {
      await seedCatalog(ctx, documents);
      await warmEmbeddings(ctx);
      await inner?.(ctx);
    },
  };
}

// ── B1: deck whose facts live only in the catalog ─────────────────────────

export const DECK_KNOWLEDGE_ORACLE: AnnotatedOracle = {
  scenarioId: 'annotated-deck-knowledge',
  facts: HALVARD_FACTS,
  forbidden: DECOY_FIGURES,
  deliverable: { kind: 'workspace-file', path: DECK_MD },
  retrieval: {
    golden: [knowledgeKey(HALVARD_ARTICLE.id)],
    decoys: [knowledgeKey(KELBY_ARTICLE.id), knowledgeKey(HALVARD_BREWING.id)],
  },
};

// ── B3: deck about a subject nothing in the index covers ──────────────────

const ABSENT_FORBIDDEN = [
  'Kelby',
  '33.9',
  '27.2',
  '11.5',
  '21.4',
  '12.8',
  '6.7%',
  'Halvard',
  'Morrow Brewing',
  'porter',
  'Top Deck',
];

export const DECK_ABSENT_ORACLE: AnnotatedOracle = {
  scenarioId: 'annotated-deck-absent',
  facts: [],
  forbidden: ABSENT_FORBIDDEN,
  deliverable: { kind: 'workspace-file', path: DECK_MD },
  retrieval: {
    golden: [],
    decoys: [
      knowledgeKey(KELBY_ARTICLE.id),
      knowledgeKey(HALVARD_ARTICLE.id),
      knowledgeKey(MORROW_BREWING.id),
      knowledgeKey(TOP_DECK.id),
    ],
  },
};

function deckSpec(opts: {
  scenarioId: string;
  objective: string;
  prompt: string;
  topic: string;
  grounded: boolean;
  checks?: CraftbookEvalGateCheck[];
}): CraftbookEvalSpec {
  const source = craftbookEvalSpecMap().get('powerpoint-deck');
  if (!source) throw new Error('Missing powerpoint-deck craftbook spec');
  const spec = variant(source, {
    scenarioId: opts.scenarioId,
    title: source.title,
    objective: opts.objective,
    prompt: opts.prompt,
    craftbookParams: { topic: opts.topic },
    files: [],
    citations: 'or-attestation',
    grounded: opts.grounded,
    ...(opts.grounded ? { forbidden: DECOY_FIGURES } : {}),
    ...(opts.checks ? { checks: opts.checks } : {}),
    qualityFocus: ['grounded figures', 'no decoy figures'],
  });
  return {
    ...spec,
    launchDescription: 'product',
    setup: {
      ...spec.setup!,
      projectName: `Annotated work — ${opts.scenarioId}`,
      about: 'Decks and briefings for terminal operations leads.',
      missionObjectives: opts.prompt,
    },
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function annotatedDeckScenarios(): EvalScenario[] {
  const knowledge = withCatalog(
    craftbookScenarioFromSpec(
      deckSpec({
        scenarioId: DECK_KNOWLEDGE_ORACLE.scenarioId,
        objective:
          'A topic-only deck whose figures exist only in an installed reference catalog, next to a near-miss terminal with different figures.',
        prompt:
          'Can you make a PowerPoint about the Halvard Terminal winter boarding pilot for our ops leads?',
        topic: 'the Halvard Terminal winter boarding pilot',
        grounded: true,
      }),
    ),
    [HALVARD_ARTICLE, KELBY_ARTICLE, HALVARD_BREWING, TOP_DECK],
    DECK_KNOWLEDGE_ORACLE,
  );
  const absent = withCatalog(
    craftbookScenarioFromSpec(
      deckSpec({
        scenarioId: DECK_ABSENT_ORACLE.scenarioId,
        objective:
          'A topic-only deck about a subject the index does not cover; neighbouring terminals and look-alike names must not leak in.',
        prompt: 'Can you make a PowerPoint about the Morrow Terminal night freight trial?',
        topic: 'the Morrow Terminal night freight trial',
        grounded: false,
        checks: ABSENT_FORBIDDEN.map((text) => ({
          kind: 'notContains',
          file: DECK_MD,
          pattern: escapeRegex(text),
          flags: 'i',
          label: `no "${text}" from a neighbouring document`,
        })),
      }),
    ),
    [KELBY_ARTICLE, HALVARD_ARTICLE, MORROW_BREWING, TOP_DECK],
    DECK_ABSENT_ORACLE,
  );
  return [knowledge, absent];
}

// ── B5: a chat question the shared library answers ───────────────────────

const POLICY_ROOT = 'annotated/policies';
const CURRENT_POLICY = `${POLICY_ROOT}/returns-v3.md`;
const SUPERSEDED_POLICY = `${POLICY_ROOT}/returns-v2.md`;

const POLICY_DOCS: Array<{ path: string; content: string }> = [
  {
    path: CURRENT_POLICY,
    content:
      '# Returns policy — version 3 (effective 1 March 2026)\n\nCustomers may return small appliances, including Pellow kettles, within 60 days of delivery. Returns made more than 30 days after delivery carry a 10% restocking fee. Refunds go back to the original payment method within 5 working days.\n',
  },
  {
    path: SUPERSEDED_POLICY,
    content:
      '# Returns policy — version 2 (2024)\n\nSmall appliances, including Pellow kettles, may be returned within 21 days of delivery. A €5 handling fee applies to every return.\n',
  },
  {
    path: `${POLICY_ROOT}/shipping.md`,
    content:
      '# Shipping policy\n\nOrders over €40 ship free. Standard delivery takes 2 to 4 working days; express delivery arrives the next working day for orders placed before 14:00.\n',
  },
  {
    path: `${POLICY_ROOT}/warranty.md`,
    content:
      '# Warranty\n\nSmall appliances carry a two-year manufacturer warranty covering defects, not damage from misuse. Warranty claims need the order number and a photo of the fault.\n',
  },
  {
    path: `${POLICY_ROOT}/gift-cards.md`,
    content:
      '# Gift cards\n\nGift cards are valid for three years and cannot be exchanged for cash. Lost cards can be replaced with proof of purchase.\n',
  },
];

export const CHAT_POLICY_ORACLE: AnnotatedOracle = {
  scenarioId: 'annotated-chat-policy',
  facts: [
    { id: 'window', label: '60-day return window', required: ['60 days', '60-day', 'sixty days'] },
    {
      id: 'fee',
      label: '10% restocking fee',
      required: ['10%', '10 %', '10 percent', 'ten percent'],
    },
  ],
  forbidden: ['21 days', '21-day', '€5', '5 euro', '€ 5'],
  deliverable: { kind: 'final-reply', gezelName: 'Noor' },
  retrieval: {
    golden: [`shared:${CURRENT_POLICY}`],
    decoys: [`shared:${SUPERSEDED_POLICY}`],
  },
};

const CHAT_QUESTION =
  'A customer wants to return their Pellow kettle five weeks after delivery. Can they, and will there be a fee?';

/**
 * The closed variant's whole roster. Installing any builtin group on a gezel
 * replaces its role kit, so leaving out `memory` (holds `search`),
 * `workspace-fs-read`, `documents`, `doc-intel`, and `code-intel` leaves the
 * worker no way to look anything up: whatever it knows about the policy
 * came from per-turn injection.
 */
const CLOSED_ROSTER = ['builtin.interaction'];
const LOOKUP_TOOLS = ['search', 'read_document', 'search_documents', 'read_file', 'grep_files'];

export const CLOSED_CHAT_POLICY_ORACLE: AnnotatedOracle = {
  ...CHAT_POLICY_ORACLE,
  scenarioId: 'annotated-chat-policy-closed',
};

/**
 * A support question whose answer is only in the shared library. Open: the
 * worker keeps its search tools, so injection competes with looking it up.
 * Closed: it has none, which isolates what injection alone contributes.
 */
function chatPolicyScenario(variant: 'open' | 'closed'): EvalScenario {
  const oracle = variant === 'open' ? CHAT_POLICY_ORACLE : CLOSED_CHAT_POLICY_ORACLE;
  let state: { projectId: string; workerId: string } | null = null;
  return {
    id: oracle.scenarioId,
    description:
      variant === 'open'
        ? 'A support question whose answer is only in the shared document library, next to a superseded version of the same policy. Graded on the current figures and the absence of the superseded ones.'
        : 'The same support question, asked of a worker with no search or read tools, so only per-turn injection can put the current policy in front of it.',
    prompt: CHAT_QUESTION,
    skipInitialPrompt: true,
    requiresEmbeddings: true,
    retrievalOracle: oracle.retrieval,
    timeoutMs: 20 * 60_000,
    async setup(ctx) {
      state = null;
      const { client, log } = ctx;
      for (const doc of POLICY_DOCS) await client.writeDocument(doc.path, doc.content);
      const sharedId = await sharedLibraryProjectId(client);
      if (sharedId) {
        await drainEmbeddings(client, sharedId, Date.now() + 10 * 60_000, (line) =>
          log(`[annotated:shared] ${line}`),
        );
      }
      const project = await client.createProject({ name: 'Customer support' });
      const worker = await client.createGezel({ name: 'Noor', role: 'Customer support agent' });
      await client.addGezelToProject(project.id, worker.id);
      if (variant === 'closed') {
        for (const id of CLOSED_ROSTER) {
          await client.installToolset(id, { scope: { kind: 'gezel', gezelId: worker.id } });
        }
      }
      await warmEmbeddings(ctx, project.id);
      await client.sendChatMessage(worker.id, { message: CHAT_QUESTION, projectId: project.id });
      state = { projectId: project.id, workerId: worker.id };
      log(`[annotated] asked ${worker.id} in ${project.id} (${variant})`);
    },
    async successCheck(ctx): Promise<SuccessCheckResult> {
      if (!state) return { done: true, success: false, reason: 'setup did not run' };
      const { sessions } = await ctx.client.listChatSessions({
        gezelId: state.workerId,
        projectId: state.projectId,
      });
      const latest = [...sessions].sort((a, b) =>
        b.lastActivityAt.localeCompare(a.lastActivityAt),
      )[0];
      if (!latest) return { done: false };
      const session = await ctx.client.getChatSession(latest.id);
      if (session.turnStartedAt) return { done: false };
      const reply = [...session.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.content?.trim());
      if (!reply) return { done: false };
      if (variant === 'closed') {
        // A closed arm that could still look things up measures nothing.
        const wired = await ctx.client.listSessionTools(latest.id).catch(() => null);
        const leaked = (wired?.tools ?? [])
          .map((tool) => tool.name)
          .filter((name) => LOOKUP_TOOLS.includes(name));
        if (!wired || leaked.length > 0) {
          return {
            done: true,
            success: false,
            reason: wired
              ? `closed worker still had lookup tools: ${leaked.join(', ')}`
              : "could not read the closed worker's tool roster",
          };
        }
      }
      const grade = gradeText(reply.content, oracle);
      const success = grade.missing.length === 0 && grade.forbiddenHits.length === 0;
      const reason = `facts ${grade.found.length}/${oracle.facts.length}${grade.missing.length ? ` (missing ${grade.missing.join(', ')})` : ''}${grade.forbiddenHits.length ? `; superseded figures: ${grade.forbiddenHits.join(', ')}` : ''}`;
      return success
        ? { done: true, success: true, reason, diagnostics: { grade } }
        : { done: true, success: false, reason, diagnostics: { grade } };
    },
  };
}

export const annotatedChatPolicyScenario = chatPolicyScenario('open');
export const annotatedChatPolicyClosedScenario = chatPolicyScenario('closed');

/** Every annotated-work oracle, by scenario id — the A/B bin grades trials with these. */
export const ANNOTATED_ORACLES: Record<string, AnnotatedOracle> = {
  [DECK_KNOWLEDGE_ORACLE.scenarioId]: DECK_KNOWLEDGE_ORACLE,
  [DECK_ABSENT_ORACLE.scenarioId]: DECK_ABSENT_ORACLE,
  [CHAT_POLICY_ORACLE.scenarioId]: CHAT_POLICY_ORACLE,
  [CLOSED_CHAT_POLICY_ORACLE.scenarioId]: CLOSED_CHAT_POLICY_ORACLE,
};
