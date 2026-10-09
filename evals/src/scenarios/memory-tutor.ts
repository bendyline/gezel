import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * The memory gate from the engagement plan: the same three-turn Spanish
 * lesson with a fresh language-trainer tutor and with one holding 20 scored
 * entries — what it learned about the learner ("About you"), its own
 * corrections and worked examples, and the project's progress notes. A
 * frontier judge grades both transcripts on the same axes; the remembered
 * arm should personalise and target known mistakes without the fresh arm
 * inventing a history it never had.
 *
 * Memories reach the lean tutor only through per-turn retrieval (it has no
 * memory tools). Trials keep the embedder off by default, so this also
 * measures the keyword recall phones depend on; set
 * GEZEL_MEMORY_EVAL_EMBEDDINGS=1 to measure semantic recall instead.
 */

const TURNS = [
  'Hola! I want to practise for my trip. Can we do a short role-play?',
  'Sí. Yo soy cansado del viaje y yo gusto el café con leche.',
  'What should I focus on this week?',
] as const;

const TURN_STALL_MS = 8 * 60_000;

type Seed = {
  scope: 'user' | 'gezel' | 'project';
  kind: 'fact' | 'decision' | 'pref' | 'status' | 'correction' | 'example';
  text: string;
};

/** Twenty entries a scored tutor would have written over a few weeks with this learner. */
export const REMEMBERED_SEEDS: readonly Seed[] = [
  { scope: 'user', kind: 'fact', text: 'The learner is called Sam.' },
  { scope: 'user', kind: 'fact', text: 'Sam is travelling to Valencia in May.' },
  { scope: 'user', kind: 'fact', text: 'Sam works as a nurse and wants hospital vocabulary.' },
  {
    scope: 'user',
    kind: 'pref',
    text: 'Sam prefers short exchanges with one correction at a time.',
  },
  { scope: 'user', kind: 'pref', text: 'Sam enjoys role-plays set in a café or a market.' },
  {
    scope: 'gezel',
    kind: 'correction',
    text: 'Sam uses ser for feelings: said "soy cansado"; correct is "estoy cansado".',
  },
  {
    scope: 'gezel',
    kind: 'correction',
    text: 'Sam builds gustar like English: "yo gusto el café" should be "me gusta el café".',
  },
  {
    scope: 'gezel',
    kind: 'correction',
    text: 'Sam drops the personal a: "veo mi madre" should be "veo a mi madre".',
  },
  {
    scope: 'gezel',
    kind: 'correction',
    text: 'Sam says "la problema"; it is "el problema".',
  },
  {
    scope: 'gezel',
    kind: 'correction',
    text: 'Sam says "soy 30 años"; age takes tener: "tengo 30 años".',
  },
  {
    scope: 'gezel',
    kind: 'correction',
    text: 'Sam uses por for purpose: "estudio por aprobar" should be "para aprobar".',
  },
  {
    scope: 'gezel',
    kind: 'correction',
    text: 'Sam uses tú with shop staff; usted is safer with strangers in Valencia.',
  },
  {
    scope: 'gezel',
    kind: 'example',
    text: 'Showing a short menu before a café role-play got Sam answering in full sentences.',
  },
  {
    scope: 'gezel',
    kind: 'example',
    text: 'Asking Sam to retell a role-play in the past tense surfaced preterite errors.',
  },
  {
    scope: 'gezel',
    kind: 'example',
    text: 'A two-line recap of the session’s corrections at the end helped Sam remember them.',
  },
  { scope: 'project', kind: 'status', text: 'Sam is at level A2 and working on the preterite.' },
  {
    scope: 'project',
    kind: 'decision',
    text: 'Sessions alternate a role-play with a five-question review.',
  },
  { scope: 'project', kind: 'fact', text: 'Sam reviewed food and drink vocabulary last week.' },
  {
    scope: 'project',
    kind: 'fact',
    text: 'Sam’s most frequent mistakes are ser versus estar and gustar.',
  },
  {
    scope: 'project',
    kind: 'fact',
    text: 'Sam’s next goal is ordering food and asking for directions.',
  },
];

interface TutorState {
  projectId: string;
  gezelId: string;
  turn: number;
  sentAt: string;
  transcript: Array<{ learner: string; tutor: string }>;
}

// Module-level: the runner hands setup and successCheck different ctx
// objects, and trials run sequentially in-process.
let currentState: TutorState | null = null;

async function latestTutorReply(client: GezelClient, s: TutorState): Promise<string | null> {
  const { sessions } = await client.listChatSessions({
    gezelId: s.gezelId,
    projectId: s.projectId,
  });
  for (const summary of sessions) {
    if (summary.lastActivityAt <= s.sentAt) continue;
    const session = await client.getChatSession(summary.id).catch(() => null);
    if (!session) continue;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]!;
      if (m.role !== 'assistant') continue;
      if (m.at <= s.sentAt) break;
      if (m.content.trim().length > 0) return m.content;
    }
  }
  return null;
}

function renderTranscript(s: TutorState, remembered: boolean): string {
  const lines = [
    `# Spanish lesson transcript (${remembered ? 'tutor with 20 memories' : 'fresh tutor'})`,
    '',
  ];
  for (const [index, exchange] of s.transcript.entries()) {
    lines.push(`## Turn ${index + 1}`, '', `**Learner:** ${exchange.learner}`, '');
    lines.push(`**Tutor:** ${exchange.tutor}`, '');
  }
  return lines.join('\n');
}

function makeScenario(remembered: boolean): EvalScenario {
  const id = remembered ? 'memory-tutor-remembered' : 'memory-tutor-fresh';
  const setup = async (ctx: EvalContext): Promise<void> => {
    currentState = null;
    const { client, log } = ctx;
    const created = await client.createTypedProject({
      name: 'Spanish practice',
      projectType: { typeId: 'language-trainer', params: { language: 'Spanish' } },
    });
    const project = created.project;
    const gezelId = project.voormanGezelId ?? project.gezelIds?.[0];
    if (!gezelId) throw new Error('the language-trainer type staffed no tutor');
    if (remembered) {
      for (const seed of REMEMBERED_SEEDS) {
        await client.saveMemory({
          scope: seed.scope,
          id: seed.scope === 'user' ? 'user' : seed.scope === 'gezel' ? gezelId : project.id,
          text: seed.text,
          kind: seed.kind,
          source: { project: project.id, gezel: gezelId },
        });
      }
      log(`[memory] seeded ${REMEMBERED_SEEDS.length} entries`);
    }
    currentState = {
      projectId: project.id,
      gezelId,
      turn: 0,
      sentAt: new Date().toISOString(),
      transcript: [],
    };
    await client.sendChatMessage(gezelId, { projectId: project.id, message: TURNS[0] });
    log('[memory] turn 1 sent');
  };

  return {
    id,
    description: remembered
      ? 'A three-turn Spanish lesson with a language-trainer tutor holding 20 scored memories (the learner, its corrections and examples, the project’s progress). Pair with memory-tutor-fresh; the judge grades personalisation and targeted correction.'
      : 'The same three-turn Spanish lesson with a fresh language-trainer tutor: the baseline for memory-tutor-remembered, and a check that a tutor with no memories invents no history.',
    prompt: 'Turns are driven from successCheck; this prompt is never sent.',
    skipInitialPrompt: true,
    // Memories reach the tutor only through per-turn retrieval, which trials
    // leave off unless asked. Balanced is the desktop default.
    retrieval: {
      mode: 'balanced',
      references: false,
      embeddings: process.env.GEZEL_MEMORY_EVAL_EMBEDDINGS === '1',
    },
    timeoutMs: 40 * 60_000,
    judge: {
      artifactBasename: 'transcript.md',
      artifactKind: 'markdown',
      axes: [
        {
          name: 'personalisation',
          description:
            'Uses what is known about this learner (name, goals, trip, preferences) where it helps the lesson. A tutor with no knowledge of the learner scores low here, not zero, if it asks rather than guesses.',
        },
        {
          name: 'targetedCorrection',
          description:
            'Corrects the learner’s actual mistakes ("soy cansado", "yo gusto") accurately, and connects them to recurring weaknesses when it knows of them.',
        },
        {
          name: 'groundedness',
          description:
            'Claims only what the conversation or the tutor’s supplied memories support. Inventing past sessions, levels or facts about the learner scores 0-3.',
        },
        {
          name: 'teaching',
          description:
            'Overall quality as a short, encouraging lesson: clear, at an A2 learner’s level, one thing at a time.',
        },
      ],
      contextNote: remembered
        ? `The tutor had these memories available (it may recall any subset):\n${REMEMBERED_SEEDS.map((seed) => `- [${seed.scope}/${seed.kind}] ${seed.text}`).join('\n')}`
        : 'The tutor had no memories of this learner. Any reference to past sessions, a level, or personal facts not stated in the transcript is invented.',
    },
    successCheck: async (ctx): Promise<SuccessCheckResult> => {
      const s = currentState;
      if (!s) return { done: true, success: false, reason: 'setup did not run' };
      const { client, log } = ctx;
      const reply = await latestTutorReply(client, s);
      const stalled = reply === null && Date.now() - Date.parse(s.sentAt) > TURN_STALL_MS;
      if (reply === null && !stalled) return { done: false };

      s.transcript.push({ learner: TURNS[s.turn]!, tutor: reply ?? '(no reply)' });
      log(`[memory] turn ${s.turn + 1} ${stalled ? 'stalled' : 'answered'}`);
      s.turn++;
      if (s.turn < TURNS.length) {
        s.sentAt = new Date().toISOString();
        await client.sendChatMessage(s.gezelId, {
          projectId: s.projectId,
          message: TURNS[s.turn]!,
        });
        log(`[memory] turn ${s.turn + 1} sent`);
        return { done: false };
      }

      await client.writeProjectArtifact(
        s.projectId,
        'memory-eval/transcript.md',
        renderTranscript(s, remembered),
      );
      const answered = s.transcript.filter((exchange) => exchange.tutor !== '(no reply)').length;
      return {
        done: true,
        success: answered === TURNS.length,
        reason: `${answered}/${TURNS.length} turns answered; grade with --llm-judge and compare the two arms`,
      };
    },
    setup,
  };
}

export const memoryTutorFreshScenario = makeScenario(false);
export const memoryTutorRememberedScenario = makeScenario(true);
