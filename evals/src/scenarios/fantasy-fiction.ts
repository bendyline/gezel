import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import {
  type StoryAnchor,
  checkStoryAnchors,
  checkStoryForm,
  storySniffResult,
} from '../story-checks.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Fantasy fiction from a constrained brief — pure invention.
 *
 * The companion piece to historical-fiction: no seeded material at all.
 * The brief asks for an original "dragons and castles" short story with
 * four required story elements, each carrying a greppable anchor (a
 * dragon, a castle, a bargain with a real price, a deep-winter setting)
 * so "did it follow the brief" stays deterministic even though the
 * content is 100% invented. The brief also bans the stock openings —
 * the cheapest observable proxy for "didn't reach for the first cliché."
 *
 * Everything about whether the invention is any GOOD — originality,
 * plot coherence, prose, emotional weight — belongs to the advisory
 * judge (`--llm-judge`) via the axes below. Keeping the pass/fail gate
 * to brief-compliance means a model can't fail the eval for writing a
 * weird story, only for not writing a story.
 */

const PROJECT_NAME = 'The Winter Bargain';
const WRITER_NAME = 'Casper';
export const STORY_PATH = 'story.md';

/** All four required elements must appear — they're the brief, not color. */
export const ELEMENT_ANCHORS: readonly StoryAnchor[] = [
  { id: 'dragon', label: 'the dragon', pattern: /dragon/i },
  { id: 'castle', label: 'the castle', pattern: /castle/i },
  { id: 'bargain', label: 'the bargain', pattern: /bargain/i },
  { id: 'winter', label: 'the deep-winter setting', pattern: /winter|snow|frost|ice/i },
];

export const FANTASY_FICTION_MISSION_OBJECTIVES = [
  `Write an original short fantasy story at ${STORY_PATH} (workspace root).`,
  '1,200 to 3,500 words of flowing prose paragraphs with a markdown title',
  'heading. Required elements: a dragon (give it a name), a castle, a bargain',
  'between the dragon and someone of the castle whose price is actually paid on',
  'the page, and a deep-winter setting (snow, frost, ice). Include spoken',
  'dialogue in double quotation marks. No bullet-list or table summaries. Do not',
  'open with stock phrases like "Once upon a time", "in a land far, far away",',
  '"long, long ago", or "It was a dark and stormy night".',
].join(' ');

export const FANTASY_FICTION_KICKOFF_MESSAGE = [
  `Please write an original short fantasy story and save it to \`${STORY_PATH}\``,
  'at the workspace root. The brief: dragons and castles — but yours. Required',
  'elements: a dragon (give it a name and a want beyond hoarding), a castle, a',
  'bargain struck between the dragon and someone of the castle where the price',
  'is real and gets paid on the page, and a deep-winter setting — snow, frost,',
  'ice, cold that matters to the plot. Surprise me everywhere else: I would',
  'rather read a strange, specific story than a competent generic one. Avoid the',
  'stock furniture (prophecies, chosen ones, wise old wizards) unless you are',
  'subverting it on purpose. Constraints: 1,200 to 3,500 words; flowing prose',
  'paragraphs (at least ten substantial ones), never bullet lists or tables;',
  'open with a markdown title heading (`# ...`); include spoken dialogue in',
  'double quotation marks (at least three exchanges). Do not open with "Once',
  'upon a time", "in a land far, far away", "long, long ago", or "It was a dark',
  'and stormy night" — start inside a specific moment. Write the complete story',
  `now with write_file to \`${STORY_PATH}\`, then refine it if needed.`,
].join(' ');

const JUDGE_CONTEXT_NOTE = [
  'The brief demanded: a named dragon with a want beyond hoarding, a castle, a',
  'bargain whose price is actually paid on the page (not just agreed to), a',
  'deep-winter setting that matters to the plot, and originality — the writer',
  'was explicitly told to avoid stock furniture (prophecies, chosen ones, wise',
  'old wizards) unless deliberately subverted, and that a strange specific story',
  'beats a competent generic one. Score originality down for interchangeable',
  "genre boilerplate; score plotCoherence down if the bargain's price is",
  'declared but never dramatized.',
].join(' ');

// ─────────────────────────────────────────────────────────────────────
// Pure grader.

export function checkFantasyFictionStory(markdown: string) {
  return storySniffResult(
    checkStoryForm(markdown),
    checkStoryAnchors(markdown, ELEMENT_ANCHORS, ELEMENT_ANCHORS.length, 'required-elements'),
  );
}

function storyRepairDirective(failReason: string): string {
  if (/required-elements/.test(failReason)) {
    return [
      `Patch \`${STORY_PATH}\` to work in the missing required elements named above`,
      '— as dramatized story material (scenes, dialogue, consequences), not a',
      'mention. The four required elements are: a named dragon, a castle, a',
      'bargain whose price is paid on the page, and a deep-winter setting. Your',
      `next tool call should be write_file (or replace_in_file) on \`${STORY_PATH}\`.`,
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
        'An original short fantasy story — dragons and castles — written to a ' +
        'constrained brief: four required story elements, a length band, and a ban ' +
        "on stock openings. Everything else is the writer's invention.",
      missionObjectives: FANTASY_FICTION_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('fantasy-fiction setup: failed to resolve project id');

  let writer: { id: string };
  try {
    // Role resolves the shipped Copywriter template (creative tuning
    // profile); the brief lives in the kickoff message.
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
    message: FANTASY_FICTION_KICKOFF_MESSAGE,
    projectId,
  });
  log(`[scenario:setup] sent kickoff to ${WRITER_NAME}`);
}

export const fantasyFictionScenario: EvalScenario = {
  id: 'fantasy-fiction',
  description:
    'Creative writing, invented: an original "dragons and castles" short story from a constrained brief — four required story elements (named dragon, castle, bargain with a paid price, deep-winter setting), 1,200-3,500 words of prose scenes with dialogue, stock openings banned. Creative quality is scored by the advisory LLM judge.',
  prompt: [
    `Heads up: ${WRITER_NAME} is writing a short story in the "${PROJECT_NAME}"`,
    "project. You do not need to do anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'required-elements', pattern: /dragon[\s\S]*castle[\s\S]*bargain[\s\S]*winter/ },
    { signal: 'story-length', pattern: /1,200 to 3,500 words/ },
    { signal: 'title', pattern: /title heading/ },
    { signal: 'prose-form', pattern: /prose paragraphs/ },
    { signal: 'dialogue', pattern: /dialogue in double quotation marks/ },
    { signal: 'paragraphs', pattern: /at least\s*ten substantial/ },
    { signal: 'no-cliche-opening', pattern: /once upon a time/ },
  ],
  evidenceTexts: [FANTASY_FICTION_MISSION_OBJECTIVES, FANTASY_FICTION_KICKOFF_MESSAGE],
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
        name: 'originality',
        description:
          'Does the story make specific, surprising choices, or is it interchangeable genre boilerplate (prophecy, chosen one, wise wizard played straight)?',
      },
      {
        name: 'plotCoherence',
        description:
          "Does the story hold together causally — setup, turn, resolution — and is the bargain's price actually dramatized on the page?",
      },
      {
        name: 'proseQuality',
        description:
          'Sentence-level quality: concrete and specific vs. clichéd, purple, or repetitive.',
      },
      {
        name: 'emotionalResonance',
        description:
          'Does the ending land with earned weight, or does it merely stop? Do you feel anything for anyone in it?',
      },
    ],
  },
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] fantasy-fiction project not present yet');
      return { done: false };
    }
    const markdown = await readWorkspaceText(client, projectId, STORY_PATH);
    if (markdown === null) {
      logChanged('sniff', `[scenario] ${STORY_PATH} not present yet`);
      recordSniff?.({ key: 'fantasy-fiction', score: 0, bytes: 0 });
      await postMissingDeliverableFeedback(ctx, STORY_PATH, {
        minPolls: 18,
        repeatEvery: 18,
        maxNudges: 2,
        projectId,
      });
      return { done: false };
    }
    const check = checkFantasyFictionStory(markdown);
    logChanged(
      'sniff',
      `[scenario] fantasy-fiction bytes=${markdown.length} score=${check.score}/7 signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'fantasy-fiction',
      score: check.score,
      bytes: markdown.length,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `story passes all form + brief-compliance gates (signals: ${check.signals.join(', ')})`,
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
