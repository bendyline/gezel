import type { GezelClient } from '@bendyline/gezel-client/node';
import {
  type GoldenQuery,
  loadCorpusManifest,
  materializeCorpus,
  seedCorpusIntoProject,
} from '../index-bench/corpus.ts';
import { matchesExpected } from '../index-bench/metrics.ts';
import { maybeWarmProject } from '../index-bench/warm.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Codebase Q&A probe: six "where does X live" questions on the pinned
 * squisq corpus, asked sequentially to one developer gezel (the
 * codebase-evolution phase-machine pattern — successCheck grades the
 * answer, then sends the next question). Each answer must cite the golden
 * file; the matcher tolerance (basename vs dir+basename) comes from the
 * manifest, whose uniqueness assumptions corpus validation asserts.
 *
 * Pass ≥ 4/6. Run warm-vs-cold via ab-index — the delta is the index's
 * contribution to "the agent knows where things are".
 */

// Default 6 (the first golden queries) keeps the standard warm/cold probe
// fast. GEZEL_QA_QUESTION_COUNT widens it to the full golden set — needed when
// A/B-ing a lever whose retrieval win lands on a later query (e.g. windowing
// recovers "parse raw markdown", golden #12, invisible to the first 6). Pass
// threshold scales to 2/3 of whatever set is asked.
const QUESTION_COUNT = Math.max(
  1,
  Number.parseInt(process.env.GEZEL_QA_QUESTION_COUNT ?? '6', 10) || 6,
);
const PASS_THRESHOLD = Math.ceil((QUESTION_COUNT * 2) / 3);
// Per-question stall deadline: a turn that aborts without ever producing a
// visible reply would otherwise wedge the poll loop until the trial watchdog
// kills the whole run. Mark it wrong and move on — one dead turn costs one
// question, not the remaining N.
const QUESTION_STALL_MS = 8 * 60_000;

interface QaState {
  projectId: string;
  gezelId: string;
  questions: GoldenQuery[];
  current: number;
  askedAt: string;
  verdicts: Array<{ question: string; correct: boolean; cited: string }>;
}

// Module-level, not WeakMap<EvalContext>: the runner hands setup and
// successCheck different ctx objects; trials run sequentially in-process.
let currentState: QaState | null = null;

function questionText(q: GoldenQuery, index: number): string {
  return `Question ${index + 1} of ${QUESTION_COUNT}: in this project, ${q.query}? Reply with the file path and one sentence about it.`;
}

async function latestAssistantReply(
  client: GezelClient,
  gezelId: string,
  projectId: string,
  afterIso: string,
): Promise<string | null> {
  const { sessions } = await client.listChatSessions({ gezelId, projectId });
  for (const summary of sessions) {
    if (summary.lastActivityAt <= afterIso) continue;
    const session = await client.getChatSession(summary.id).catch(() => null);
    if (!session) continue;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i]!;
      if (m.role !== 'assistant') continue;
      if (m.at <= afterIso) break;
      if (m.content.trim().length > 0) return m.content;
    }
  }
  return null;
}

async function setup(ctx: EvalContext): Promise<void> {
  currentState = null;
  const { client, log } = ctx;
  const manifest = await loadCorpusManifest(process.env.GEZEL_INDEX_BENCH_CORPUS ?? 'squisq');
  const corpusDir = await materializeCorpus(manifest);
  const project = await client.createProject({
    name: 'squisq-qa',
    about:
      'A pinned subset of the squisq markdown/document library (core, formats, react packages). TypeScript.',
    missionObjectives: 'Answer questions about where functionality lives in this codebase.',
  });
  await seedCorpusIntoProject(client, project.id, corpusDir, { log });
  await maybeWarmProject(ctx, project.id);

  const dev = await client.createGezel({ name: 'Sanne', role: 'Developer' }).catch(async () => {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === 'Sanne');
    if (!existing) throw new Error('failed to create developer gezel');
    return existing;
  });

  const questions = manifest.goldenQueries.slice(0, QUESTION_COUNT);
  const askedAt = new Date().toISOString();
  currentState = {
    projectId: project.id,
    gezelId: dev.id,
    questions,
    current: 0,
    askedAt,
    verdicts: [],
  };
  await client.sendChatMessage(dev.id, {
    projectId: project.id,
    message: questionText(questions[0]!, 0),
  });
  log('[qa] question 1 sent');
}

export const squisqCodebaseQaScenario: EvalScenario = {
  id: 'squisq-codebase-qa',
  description:
    'Six sequential "where does X live" questions on the pinned squisq corpus, graded against golden file paths. The warm-vs-cold delta measures index-backed orientation.',
  prompt: 'Questions are driven from successCheck; this prompt is never sent.',
  skipInitialPrompt: true,
  timeoutMs: 90 * 60_000,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const s = currentState;
    if (!s) return { done: true, success: false, reason: 'setup did not run' };
    const { client, log, logChanged } = ctx;

    const reply = await latestAssistantReply(client, s.gezelId, s.projectId, s.askedAt);
    const stalled = reply === null && Date.now() - Date.parse(s.askedAt) > QUESTION_STALL_MS;
    if (reply === null && !stalled) return { done: false };

    const q = s.questions[s.current]!;
    const substantial = reply !== null && reply.trim().length > 100;
    const cited =
      reply !== null && q.expected.some((exp) => matchesExpected(reply, exp, q.matchLevel));
    const correct = substantial && cited;
    s.verdicts.push({ question: q.query, correct, cited: cited ? q.expected[0]! : 'none' });
    logChanged(
      `q${s.current}`,
      `[qa] Q${s.current + 1} ${correct ? 'CORRECT' : stalled ? 'STALLED (no reply)' : 'wrong'} (${q.expected[0]})`,
    );

    s.current++;
    if (s.current < s.questions.length) {
      // Fresh session per question. One accumulating session turned the
      // probe into a session-endurance test, not an index test — by Q8 the
      // executor sat at the 32K ceiling, compaction one-shots timed out,
      // turns aborted mid-answer, and a 12-question run blew the 90-minute
      // trial ceiling (wild-caught, qwen3.5-9b: 28-minute Q2).
      // ARCHIVE (not resetChat — that only drops provider state; the message
      // history survives and the next send resumes it): the next send then
      // auto-creates a clean session, which also matches real usage
      // ("where is X?" asked in a fresh chat).
      const { sessions } = await client
        .listChatSessions({ gezelId: s.gezelId, projectId: s.projectId })
        .catch(() => ({ sessions: [] }));
      for (const sess of sessions) {
        if (!sess.archived) await client.archiveChatSession(sess.id).catch(() => undefined);
      }
      s.askedAt = new Date().toISOString();
      await client.sendChatMessage(s.gezelId, {
        projectId: s.projectId,
        message: questionText(s.questions[s.current]!, s.current),
      });
      log(`[qa] question ${s.current + 1} sent`);
      return { done: false };
    }

    const correctCount = s.verdicts.filter((v) => v.correct).length;
    await client
      .writeProjectArtifact(
        s.projectId,
        'index-bench/qa-verdicts.json',
        JSON.stringify(s.verdicts, null, 2),
      )
      .catch(() => undefined);
    return {
      done: true,
      success: correctCount >= PASS_THRESHOLD,
      reason: `${correctCount}/${s.questions.length} questions answered with the correct file`,
    };
  },
  setup,
};
