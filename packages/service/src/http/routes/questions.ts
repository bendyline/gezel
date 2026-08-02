import { randomUUID } from 'node:crypto';
import {
  AnswerQuestionRequestSchema,
  AskQuestionRequestSchema,
  type Question,
  createLogger,
  nowIso,
  parseTaskRef,
  prettifyToolName,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { formatAnswerSeed, outstandingSessionQuestion } from '../../chat/question-format.js';
import { applyCommandApprovalAnswer } from '../../workspace/command-approval-answer.js';
import { applyNpmInstallApprovals, intentPackages } from '../../workspace/npm.js';
import type { ServiceContext } from '../context.js';

const log = createLogger('http');

/**
 * Routes for the structured ask-user-question system.
 *
 * - `POST /` — gezel posts a question (called by the MCP tool).
 * - `GET /` — list (filterable by `project=` and `pending=true`).
 * - `POST /:id/answer` — user submits a structured answer (or declines);
 *   the answer text is injected back into the originating session via
 *   `ChatManager.deliverQuestionAnswer`, which kicks off the gezel's
 *   next turn.
 */
export function questionRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/', async (c) => {
    const body = AskQuestionRequestSchema.parse(await c.req.json());

    // Turn-to-turn dedup: never stack a second unanswered question card
    // on a session. A gezel that re-asks a reworded version of the same
    // clarifying question every turn (wild-caught: a Meester on
    // gemma4-e4b re-asking the same problem-discovery questions, piling
    // up as "Question 7 of 7" in the Needs-your-input panel) would
    // otherwise mint a fresh Question record each time. The provider
    // per-turn dedup only collapses repeats within a single turn; this
    // is the across-turns guard. Only plain `ask_user_question` calls
    // reach this route — approval cards carry an `intent` and are written
    // via other paths — so `outstandingSessionQuestion`'s intent-less
    // filter never touches them.
    const outstanding = outstandingSessionQuestion(
      await ctx.store.listProjectQuestions(body.projectId),
      body.sessionId,
    );
    if (outstanding) {
      log.info(
        `[questions] dedup: session ${body.sessionId} already has unanswered question ${outstanding.id}; suppressing re-ask`,
      );
      return c.json({ questionId: outstanding.id, deduped: true }, 200);
    }

    const question: Question = {
      id: randomUUID(),
      projectId: body.projectId,
      gezelId: body.gezelId,
      sessionId: body.sessionId,
      prompt: body.prompt,
      ...(body.choices && body.choices.length > 0 ? { choices: body.choices } : {}),
      ...(body.allowWriteIn !== undefined ? { allowWriteIn: body.allowWriteIn } : {}),
      ...(body.multiSelect !== undefined ? { multiSelect: body.multiSelect } : {}),
      ...(body.taskRef ? { taskRef: body.taskRef } : {}),
      ...(body.documentPath ? { documentPath: body.documentPath } : {}),
      createdAt: nowIso(),
    };
    await ctx.store.writeQuestion(question);
    // Stamp pendingQuestionId onto the most recent assistant message so
    // the chat UI can attach the card to the bubble that asked. Best
    // effort — the panel + badge surfaces still work without the
    // in-chat correlation.
    await ctx.store
      .stampPendingQuestionOnLastAssistant(question.gezelId, question.sessionId, question.id)
      .catch((err) => {
        log.warn('[questions] stamp pendingQuestionId failed:', err);
      });
    ctx.chatEvents.publish(
      {
        sessionId: question.sessionId,
        gezelId: question.gezelId,
        projectId: question.projectId,
      },
      { type: 'question_asked', question },
    );
    await ctx.history
      .log({
        kind: 'user.question.asked',
        projectId: question.projectId,
        gezelId: question.gezelId,
        summary: `Question posted: ${truncate(question.prompt, 80)}`,
        details: { questionId: question.id, sessionId: question.sessionId },
      })
      .catch((err) => {
        log.warn('[questions] history log failed:', err);
      });
    return c.json({ questionId: question.id }, 201);
  });

  app.get('/', async (c) => {
    const projectId = c.req.query('project') || undefined;
    const pending = c.req.query('pending') === 'true';
    let questions: Question[];
    if (projectId) {
      questions = await ctx.store.listProjectQuestions(projectId);
      if (pending) questions = questions.filter((q) => !q.answer);
    } else if (pending) {
      questions = await ctx.store.listAllPendingQuestions();
    } else {
      // Without a project filter, default to pending — listing every
      // question across every project would be a lot, and the UI never
      // wants that today.
      questions = await ctx.store.listAllPendingQuestions();
    }
    return c.json({ questions });
  });

  app.post('/:id/answer', async (c) => {
    const id = c.req.param('id');
    const body = AnswerQuestionRequestSchema.parse(await c.req.json());

    // Find the question — it lives under one of the projects, but we
    // don't know which from the URL. Pull every pending question and
    // match by id; cheap because the file is small.
    const all = await ctx.store.listAllPendingQuestions();
    const q = all.find((x) => x.id === id);
    // Fall back to scanning all-and-answered too, so the API behaves
    // correctly when a stale UI submits twice.
    let question = q;
    if (!question) {
      // Walk every project explicitly.
      const projects = await ctx.store.listProjects();
      for (const p of projects) {
        const found = await ctx.store.getQuestion(p.id, id);
        if (found) {
          question = found;
          break;
        }
      }
    }
    if (!question) return c.json({ error: 'question not found' }, 404);
    if (question.answer) {
      // Already answered — return the existing record idempotently
      // rather than re-injecting into the session.
      return c.json(question);
    }

    question = {
      ...question,
      answer: {
        ...(body.selectedChoices && body.selectedChoices.length > 0
          ? { selectedChoices: body.selectedChoices }
          : {}),
        ...(body.writeIn ? { writeIn: body.writeIn } : {}),
        ...(body.declined ? { declined: true } : {}),
        ...(body.silentSkip ? { silentSkip: true } : {}),
        ...(body.npmInstallDecisions && body.npmInstallDecisions.length > 0
          ? { npmInstallDecisions: body.npmInstallDecisions }
          : {}),
        at: nowIso(),
      },
    };
    await ctx.store.writeQuestion(question);

    ctx.chatEvents.publish(
      {
        sessionId: question.sessionId,
        gezelId: question.gezelId,
        projectId: question.projectId,
      },
      { type: 'question_answered', question },
    );
    await ctx.history
      .log({
        kind: 'user.question.answered',
        projectId: question.projectId,
        gezelId: question.gezelId,
        summary: question.answer?.silentSkip
          ? `Question skipped: ${truncate(question.prompt, 80)}`
          : question.answer?.declined
            ? `Question dismissed (proceed with defaults): ${truncate(question.prompt, 80)}`
            : `Question answered: ${truncate(question.prompt, 80)}`,
        details: { questionId: question.id, sessionId: question.sessionId },
      })
      .catch((err) => {
        log.warn('[questions] history log failed:', err);
      });

    // Image-generation-approval questions are also answered
    // SYNCHRONOUSLY by the `POST /api/image-gen/generate` long-poll
    // — the route's await loop reads the persisted answer on its next
    // tick. No follow-up turn to seed; just persist the choice so the
    // polling endpoint can resume. The route applies the
    // `Always allow → config flip` itself so the answer flow stays
    // simple here.
    if (question.intent?.kind === 'image-generation-approval') {
      const declined = question.answer?.declined === true;
      const choice = question.answer?.selectedChoices?.[0];
      const label = declined
        ? 'declined image generation'
        : choice === 1
          ? 'approved image generation (always)'
          : choice === 0
            ? 'approved image generation'
            : 'declined image generation';
      ctx.chat.recordSessionIntent(
        {
          sessionId: question.sessionId,
          gezelId: question.gezelId,
          projectId: question.projectId,
        },
        label,
      );
      return c.json(question);
    }

    // Tool-permission questions are answered SYNCHRONOUSLY by the
    // long-polling `POST /api/permissions/request-and-wait` endpoint —
    // the Claude subprocess is alive and waiting on its return value,
    // so there's no follow-up turn to seed. Skip the deliver step
    // entirely; the polling loop reads the persisted answer on its
    // next tick.
    if (question.intent?.kind === 'tool-permission') {
      // Mirror the verdict into the chat stream as an `intent`
      // breadcrumb so the user sees "approved: <tool>" / "denied:
      // <tool>" inline alongside the upcoming tool row, completing
      // the loop they started by approving the question card.
      const intent = question.intent;
      const declined = question.answer?.declined === true;
      const approved = !declined && (question.answer?.selectedChoices ?? []).includes(0);
      const friendlyName = prettifyToolName(intent.toolName);
      const label = approved ? `approved: ${friendlyName}` : `denied: ${friendlyName}`;
      ctx.chat.recordSessionIntent(
        {
          sessionId: question.sessionId,
          gezelId: question.gezelId,
          projectId: question.projectId,
        },
        label,
      );
      return c.json(question);
    }

    // Night-shift-review questions are a synthesized morning summary —
    // no live session (sessionId is '') and nothing to arm. Answering
    // (Dismiss) just collapses the card everywhere.
    if (question.intent?.kind === 'night-shift-review') {
      return c.json(question);
    }

    // Task-paused cards are the same shape: service-synthesized, no live
    // session. Dismiss collapses the card; fixing/resuming the task
    // happens through the attached "Open task" link, not the answer.
    if (question.intent?.kind === 'task-paused') {
      return c.json(question);
    }

    // Schedule-approval questions come from project-type adoption —
    // there is no live session to seed (sessionId is ''). Approving
    // arms the paused host: the cron update re-derives `nextTickAt`
    // from NOW (otherwise the stale creation-time tick would fire
    // immediately on arm), then the status flips to active. Declining
    // leaves it paused; the Tasks view remains the manual enable path.
    if (question.intent?.kind === 'schedule-approval') {
      const intent = question.intent;
      const declined = question.answer?.declined === true || question.answer?.silentSkip === true;
      const approved = !declined && (question.answer?.selectedChoices ?? []).includes(0);
      if (approved && question.taskRef) {
        const ref = parseTaskRef(question.taskRef);
        if (ref) {
          try {
            await ctx.tasks.update(ref.projectId, ref.num, {
              cron: {
                expression: intent.cron,
                ...(intent.overlap ? { overlap: intent.overlap } : {}),
              },
            });
            await ctx.tasks.setStatus(ref.projectId, ref.num, 'active');
          } catch (err) {
            // Host deleted or otherwise unarmable — collapse the card
            // anyway; the Tasks view is the source of truth.
            log.warn(`[questions] schedule-approval arm failed for ${question.taskRef}:`, err);
          }
        }
      }
      return c.json(question);
    }

    // Silent skip: user dismissed the card but doesn't want the
    // gezel to do anything in response. Persist + emit the answered
    // event (so the card collapses everywhere) but skip seed
    // delivery — the gezel's session is left as-is. Its turn
    // already ended when it called `ask_user_question`; without the
    // synthetic user message, no new turn fires.
    if (question.answer?.silentSkip) {
      return c.json(question);
    }

    // Fire-and-forget: route the answer back into the asking gezel's
    // session. `deliverQuestionAnswer` is patient (busy-retry) and
    // tolerates a deleted session, so the HTTP response can return
    // promptly without waiting on the gezel's reply turn.
    //
    // Specialized-intent questions override the default seed: an
    // `npm-install-approval` answer maps its chosen button to an
    // actual install (or decline record), and the follow-up text is
    // about the install result rather than the raw answer.
    let seed: string;
    if (question.intent?.kind === 'npm-install-approval') {
      const decisions = resolveNpmInstallDecisions(question);
      seed = await applyNpmInstallApprovals(ctx.store, ctx.home, question.projectId, decisions);
    } else if (question.intent?.kind === 'command-approval') {
      seed = await applyCommandApprovalAnswer({
        home: ctx.home,
        projectId: question.projectId,
        intent: question.intent,
        answer: question.answer,
      });
    } else {
      seed = formatAnswerSeed(question);
    }
    // npm-install-approval follow-ups coalesce in the session queue.
    // When the user approves a multi-package install, each package
    // completion produces its own `[npm_install follow-up: …]` seed,
    // and those pile up as separate turns otherwise. Merging them
    // into one turn is more efficient AND reads more naturally: the
    // gezel sees "10 packages installed" in a single batch rather
    // than reacting 10 times. Regular answers stay uncoalesced —
    // they usually represent distinct user decisions.
    const coalescable = question.intent?.kind === 'npm-install-approval';
    void ctx.chat
      .deliverQuestionAnswer({
        sessionId: question.sessionId,
        seed,
        ...(coalescable ? { coalescable: true } : {}),
      })
      .catch((err) => {
        log.error('[questions] answer delivery failed:', err);
      });

    return c.json(question);
  });

  return app;
}

function truncate(s: string, n: number): string {
  const collapsed = s.replace(/\s+/g, ' ').trim();
  return collapsed.length > n ? `${collapsed.slice(0, n - 1)}…` : collapsed;
}

/**
 * Turn an answered `npm-install-approval` question into a flat list of
 * per-package decisions. Three shapes to handle:
 *   - Batch answers (new UI): `answer.npmInstallDecisions` is the source
 *     of truth.
 *   - Legacy single-package answers (old UI): a selectedChoices of [0]
 *     (Install), [1] (Install and always allow), or [2] (Decline); fall
 *     back to decline if the user dismissed the card.
 *   - Dismissed without a decision: every package → decline, safest
 *     default.
 */
function resolveNpmInstallDecisions(question: Question): Array<{
  package: string;
  version: string;
  decision: 'install' | 'always' | 'decline';
}> {
  const packages = intentPackages(question.intent);
  const batch = question.answer?.npmInstallDecisions;
  if (batch && batch.length > 0) {
    const packageSet = new Set(packages.map((p) => `${p.package}@${p.version}`));
    return batch.filter((d) => packageSet.has(`${d.package}@${d.version}`));
  }
  const legacyChoice = (() => {
    if (question.answer?.declined) return 'decline' as const;
    const first = question.answer?.selectedChoices?.[0];
    if (first === 0) return 'install' as const;
    if (first === 1) return 'always' as const;
    return 'decline' as const;
  })();
  return packages.map((p) => ({
    package: p.package,
    version: p.version,
    decision: legacyChoice,
  }));
}
