import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import {
  type StoryAnchor,
  checkStoryAnchors,
  checkStoryForm,
  storySniffResult,
} from '../story-checks.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Historical fiction from a fact sheet — grounded creative writing.
 *
 * Seeds a fact sheet about an INVENTED obscure historical figure (Griet
 * Aukesdochter, a 1680s Frisian clockmaker's apprentice) and asks for a
 * short story built on those facts. The figure is invented on purpose:
 * a real person would make fact-fidelity ungradable (no ground truth in
 * the repo) and would leak training-data priors unevenly across models —
 * the same reason fictional-sdk invents its SDK. With a seeded sheet,
 * "did the story actually use the material" is deterministic: each fact
 * carries a greppable anchor.
 *
 * What's deterministic (pass/fail): the story exists at story.md, sits
 * in the asked-for length band, opens with a title, is prose rather
 * than a bulleted regurgitation of the sheet, contains real dialogue
 * and enough paragraphs to be scenes rather than a synopsis, avoids the
 * banned stock openings, and weaves in ≥ 7 of the 9 fact anchors.
 *
 * What's the judge's (advisory, --llm-judge): whether it's GOOD — the
 * `judge` spec below scores factualFidelity / narrativeCraft /
 * characterInteriority / proseQuality against the fact sheet.
 */

const PROJECT_NAME = 'The Clockmaker of Hindeloopen';
const WRITER_NAME = 'Femke';
export const STORY_PATH = 'story.md';

export const FACT_SHEET_PATH = 'fact-sheet.md';

export const FACT_SHEET_MD = [
  '# Fact sheet — Griet Aukesdochter (1663–?)',
  '',
  'Collected notes on an obscure figure of the Frisian clockmaking trade.',
  'Everything below is established; nothing here may be contradicted.',
  '',
  '- Born 1663 in Hindeloopen, a small Zuiderzee harbor town in Friesland.',
  '- Daughter of a herring fisherman. Her older brother Jelle was lost at',
  '  sea in a winter storm in 1681; she wore his oilskin coat for the rest',
  '  of her working life.',
  '- At fourteen she began sweeping the workshop of the clockmaker Rinse',
  '  Wybrens; within three years she was cutting gear teeth better than',
  '  his paid journeymen.',
  "- The clockmakers' guild did not admit women. Her work left the shop",
  "  under Rinse's name. She marked the pieces that were truly hers with",
  '  a tiny blackbird engraved under the dial, where only another',
  '  clockmaker would ever find it.',
  '- Her specialty was painted clock dials: ships under sail, ice scenes,',
  '  the harbor at Hindeloopen in winter light.',
  "- By 1687 Rinse's hands had developed a tremor he hid from customers.",
  '- In 1687 the church at Workum commissioned a tower clock from the',
  '  workshop — the largest commission it had ever taken.',
  "- Griet built the tower clock's verge escapement herself, working at",
  "  night, while Rinse kept the commission's public face.",
  '- She kept her gear-ratio calculations in a notebook written in mirror',
  '  writing, so a casual snoop in the workshop would find only nonsense.',
].join('\n');

/**
 * Nine greppable anchors, one per load-bearing fact. The grader requires
 * ≥ 7: leaving a fact or two on the floor is legitimate selection, but a
 * story that uses fewer than seven didn't engage with the material.
 */
export const FACT_ANCHORS: readonly StoryAnchor[] = [
  { id: 'griet', label: 'Griet herself (her name)', pattern: /griet/i },
  { id: 'hindeloopen', label: 'Hindeloopen (her town)', pattern: /hindeloopen/i },
  { id: 'rinse', label: 'the master Rinse Wybrens', pattern: /rinse/i },
  { id: 'jelle', label: 'her brother Jelle, lost at sea', pattern: /jelle/i },
  { id: 'blackbird', label: "the hidden blackbird maker's mark", pattern: /blackbird/i },
  { id: 'workum', label: 'the Workum tower-clock commission', pattern: /workum/i },
  { id: '1687', label: 'the year 1687', pattern: /1687/ },
  { id: 'escapement', label: 'the verge escapement she built', pattern: /escapement/i },
  {
    id: 'clock-dials',
    label: 'her painted clock dials / the clockmaking craft',
    pattern: /clock/i,
  },
];

export const MIN_FACT_ANCHORS = 7;

export const HISTORICAL_FICTION_MISSION_OBJECTIVES = [
  `Write a short story at ${STORY_PATH} (workspace root) built on the facts in`,
  `${FACT_SHEET_PATH}. 1,200 to 3,500 words of flowing prose paragraphs — a real`,
  'story with scenes, not a biography or a bulleted summary. Open with a markdown',
  'title heading. Include spoken dialogue in double quotation marks (at least a',
  'few exchanges). Weave in the specific facts — Griet, Hindeloopen, Rinse,',
  'Jelle, the blackbird mark, the Workum commission, 1687, the escapement, the',
  'painted clock dials — and contradict none of them. Do not open with stock',
  'phrases like "Once upon a time", "in a land far, far away", "long, long ago",',
  'or "It was a dark and stormy night".',
].join(' ');

export const HISTORICAL_FICTION_KICKOFF_MESSAGE = [
  `Please write a short story and save it to \`${STORY_PATH}\` at the workspace`,
  `root. Your source material is \`${FACT_SHEET_PATH}\` in the workspace — read it`,
  "first. It documents Griet Aukesdochter, a clockmaker's apprentice in 1680s",
  'Hindeloopen. I want historical fiction built on those facts, not a summary of',
  'them: pick a dramatic center (the 1687 Workum tower-clock commission and the',
  "escapement she built in secret is the obvious one, but it's your call), write",
  "scenes, and let the details — Rinse's hidden tremor, her brother Jelle's",
  'coat, the blackbird mark under the dial, the painted clock dials — do the',
  'work. Constraints: 1,200 to 3,500 words; flowing prose paragraphs (at least',
  'ten substantial ones), never bullet lists or tables; open with a markdown',
  'title heading (`# ...`); include spoken dialogue in double quotation marks (at',
  'least three exchanges); stay consistent with every fact in the sheet and',
  'invent freely only where the sheet is silent. Do not open with "Once upon a',
  'time", "in a land far, far away", "long, long ago", or "It was a dark and',
  'stormy night" — start inside a specific moment. Write the complete story now',
  `with write_file to \`${STORY_PATH}\`, then refine it if needed.`,
].join(' ');

/**
 * Compact ground truth for the advisory judge — lets it flag invented
 * contradictions without re-reading the full sheet.
 */
const JUDGE_CONTEXT_NOTE = [
  'The story must be consistent with this fact sheet: Griet Aukesdochter, born',
  '1663 in Hindeloopen (Friesland), daughter of a herring fisherman; her brother',
  'Jelle was lost at sea in 1681 and she wore his oilskin coat; she apprenticed',
  'under the clockmaker Rinse Wybrens; the guild did not admit women, so her',
  "work shipped under Rinse's name and she marked her own pieces with a tiny",
  'blackbird engraved under the dial; her specialty was painted clock dials',
  '(ships, ice scenes, the harbor); by 1687 Rinse had a tremor he hid; in 1687',
  'the Workum church commissioned a tower clock and Griet built its verge',
  'escapement herself at night; she kept gear calculations in mirror writing.',
  'Score factualFidelity down for any contradiction of these facts (wrong',
  'decade, wrong relationships, guild admitting her, etc.); invention where the',
  'sheet is silent is fine and expected.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Pure grader.

export function checkHistoricalFictionStory(markdown: string) {
  return storySniffResult(
    checkStoryForm(markdown),
    checkStoryAnchors(markdown, FACT_ANCHORS, MIN_FACT_ANCHORS, 'fact-anchors'),
  );
}

function storyRepairDirective(failReason: string): string {
  if (/fact-anchors/.test(failReason)) {
    return [
      `Patch \`${STORY_PATH}\` to weave in the missing facts named above — as lived`,
      'scene detail (a line of dialogue, an object in the room, a memory), not as',
      'an appended fact list. Keep the story consistent with every fact in',
      `\`${FACT_SHEET_PATH}\`. Your next tool call should be write_file (or`,
      `replace_in_file) on \`${STORY_PATH}\`.`,
    ].join(' ');
  }
  return [
    `Patch \`${STORY_PATH}\` to fix exactly the named gap. The brief: 1,200-3,500`,
    'words of flowing prose with a `# title` heading, at least ten substantial',
    'paragraphs, at least three spoken-dialogue passages in double quotation',
    'marks, no bullet-list or table summaries, and no stock opening phrases.',
    `Your next tool call should be write_file (or replace_in_file) on \`${STORY_PATH}\`.`,
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

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Writing a piece of historical fiction from a fact sheet about Griet ' +
        "Aukesdochter, an obscure 1680s Frisian clockmaker's apprentice. The fact " +
        'sheet is the ground truth; the story dramatizes it without contradicting it.',
      missionObjectives: HISTORICAL_FICTION_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('historical-fiction setup: failed to resolve project id');

  await client.writeProjectWorkspaceFile(projectId, {
    path: FACT_SHEET_PATH,
    content: FACT_SHEET_MD,
  });
  log(`[scenario:setup] seeded ${FACT_SHEET_PATH}`);

  let writer: { id: string };
  try {
    // Role resolves the shipped Copywriter template (creative tuning
    // profile). Task specifics live in the kickoff message — the eval
    // measures the product configuration, not a scenario-tuned prompt.
    const created = await client.createGezel({ name: WRITER_NAME, role: 'Copywriter' });
    writer = { id: created.id };
    log(`[scenario:setup] created writer "${WRITER_NAME}" id=${writer.id}`);
  } catch (err) {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === WRITER_NAME);
    if (!existing) throw err;
    writer = { id: existing.id };
  }
  await client.addGezelToProject(projectId, writer.id);
  await client.sendChatMessage(writer.id, {
    message: HISTORICAL_FICTION_KICKOFF_MESSAGE,
    projectId,
  });
  log(`[scenario:setup] sent kickoff to ${WRITER_NAME}`);
}

export const historicalFictionScenario: EvalScenario = {
  id: 'historical-fiction',
  description:
    "Creative writing, grounded: a fact sheet about an invented obscure historical figure (a 1680s Frisian clockmaker's apprentice) is seeded; the model must write a 1,200-3,500-word short story that weaves in ≥7 of 9 fact anchors as prose scenes with dialogue — not a bulleted regurgitation. Creative quality is scored by the advisory LLM judge.",
  prompt: [
    `Heads up: ${WRITER_NAME} is writing a short story in the "${PROJECT_NAME}"`,
    "project. You do not need to do anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'fact-anchors', pattern: /hindeloopen[\s\S]*blackbird[\s\S]*escapement/ },
    { signal: 'story-length', pattern: /1,200 to 3,500 words/ },
    { signal: 'title', pattern: /title heading/ },
    { signal: 'prose-form', pattern: /prose paragraphs/ },
    { signal: 'dialogue', pattern: /dialogue in double quotation marks/ },
    { signal: 'paragraphs', pattern: /at least\s*ten substantial/ },
    { signal: 'no-cliche-opening', pattern: /once upon a time/ },
  ],
  evidenceTexts: [
    HISTORICAL_FICTION_MISSION_OBJECTIVES,
    HISTORICAL_FICTION_KICKOFF_MESSAGE,
    FACT_SHEET_MD,
  ],
  timeoutMs: 40 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  judge: {
    artifactBasename: STORY_PATH,
    artifactKind: 'markdown',
    contextNote: JUDGE_CONTEXT_NOTE,
    axes: [
      {
        name: 'factualFidelity',
        description:
          'Is the story consistent with the supplied fact sheet, using its details as load-bearing story material rather than name-dropping them?',
      },
      {
        name: 'narrativeCraft',
        description:
          'Scene construction, tension, pacing — does it build and resolve like a story, or read like a costume over a plot summary?',
      },
      {
        name: 'characterInteriority',
        description:
          'Does Griet have a believable inner life — wants, fears, contradictions — shown through action and dialogue rather than stated?',
      },
      {
        name: 'proseQuality',
        description:
          'Sentence-level quality: concrete and specific vs. clichéd, purple, or repetitive.',
      },
    ],
  },
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] historical-fiction project not present yet');
      return { done: false };
    }
    const markdown = await readWorkspaceText(client, projectId, STORY_PATH);
    if (markdown === null) {
      logChanged('sniff', `[scenario] ${STORY_PATH} not present yet`);
      recordSniff?.({ key: 'historical-fiction', score: 0, bytes: 0 });
      await postMissingDeliverableFeedback(ctx, STORY_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        projectId,
      });
      return { done: false };
    }
    const check = checkHistoricalFictionStory(markdown);
    logChanged(
      'sniff',
      `[scenario] historical-fiction bytes=${markdown.length} score=${check.score}/7 signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'historical-fiction',
      score: check.score,
      bytes: markdown.length,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `story passes all form + grounding gates (signals: ${check.signals.join(', ')})`,
      };
    }
    if (check.failReason) {
      await postSniffFeedback(ctx, STORY_PATH, check, {
        projectId,
        sourceText: markdown,
        repairDirective: storyRepairDirective(check.failReason),
      });
    }
    return { done: false };
  },
};
