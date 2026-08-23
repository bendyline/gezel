import { randomUUID } from 'node:crypto';
import {
  type ClaudeUserQuestionOption,
  type Question,
  type RequestPermissionRequest,
  RequestPermissionRequestSchema,
  type RequestPermissionResponse,
  nowIso,
  prettifyToolName,
} from '@bendyline/gezel';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ServiceContext } from '../context.js';

/**
 * Routes that broker tool-permission requests from the Claude CLI provider.
 *
 * The CLI's `--permission-prompt-tool` flag points at our gezel-mcp
 * `request_tool_permission` tool, which in turn POSTs to this route. We
 * create a `tool-permission` question, block the HTTP response until the
 * user answers via the regular question-answer surface, then translate
 * the answer into the shape Claude CLI expects (`{behavior: "allow",
 * updatedInput}` or `{behavior: "deny", message}`).
 *
 * Why a synchronous block: Claude CLI is alive on the user's machine
 * inside `claude -p`, with the model paused on the permission tool's
 * return value. There is no async "resume the gezel session" path here
 * — the gezel session IS the still-running `claude` subprocess. The
 * cleanest way to keep the contract simple is to just hold the HTTP
 * connection open until the user clicks; gezel-mcp's HTTP client is
 * patient and the CLI itself imposes no per-tool-call timeout.
 *
 * One built-in gets special treatment: `AskUserQuestion`. Its arguments
 * ARE the question, and in headless mode the permission component is the
 * only thing that can answer it — the CLI expects the verdict to carry
 * `updatedInput.answers` (keyed by each question's full text, values are
 * the chosen option labels). Rendering it as a generic Allow/Deny card
 * shows the user a JSON blob, and "Allow" without answers hands the model
 * a dead tool call. So we intercept it: each entry in `questions[]`
 * becomes a real gezel question card (`claude-user-question` intent),
 * and the collected answers ride back on the allow verdict.
 */

/** Total time we'll keep the connection open before auto-denying. */
const WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/** Poll cadence for the question file. */
const POLL_INTERVAL_MS = 500;

/**
 * The subset of Claude CLI's `AskUserQuestion` input we render. Lenient
 * on purpose — unknown fields are stripped for parsing but preserved on
 * the wire, because the allow verdict spreads the original `toolInput`.
 * A payload that doesn't even match this shape falls back to the generic
 * permission card rather than failing the request.
 */
const AskUserQuestionInputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string().optional(),
        options: z
          .array(z.object({ label: z.string().min(1), description: z.string().optional() }))
          .optional(),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1),
});
type AskUserQuestionInput = z.infer<typeof AskUserQuestionInputSchema>;

type AwaitOutcome =
  | { kind: 'answered'; question: Question }
  | { kind: 'timeout' }
  | { kind: 'disconnected' };

export function permissionRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/request-and-wait', async (c) => {
    const body = RequestPermissionRequestSchema.parse(await c.req.json());

    // `AskUserQuestion` is intercepted BEFORE the auto-allow fast-track:
    // an answer requires a user by definition, and auto-allowing it would
    // return the input unchanged — a tool call with no answers.
    if (body.toolName === 'AskUserQuestion') {
      const parsed = AskUserQuestionInputSchema.safeParse(body.toolInput);
      if (parsed.success) {
        return c.json<RequestPermissionResponse>(
          await runAskUserQuestions(ctx, c, body, parsed.data),
        );
      }
    }

    // Fast-track: if the session's active craftbook pre-authorizes this
    // tool (an `autoAllow` toolset), approve immediately without asking.
    // Uses the same derivation as the in-process auto-allow hook so a
    // CLI-backed gezel and an in-process one behave identically — the
    // point of `autoAllow` is unattended runs that don't stop to prompt.
    const autoAllowed = await ctx.chat
      .autoAllowedToolsForSession(body.sessionId)
      .catch(() => new Set<string>());
    if (autoAllowed.has(body.toolName)) {
      return c.json<RequestPermissionResponse>({
        behavior: 'allow',
        updatedInput: body.toolInput,
      });
    }

    // Build and persist the question so the UI's question surface picks it
    // up via the question_asked SSE event. We don't stamp pendingQuestionId
    // synchronously here — there's no committed assistant message yet
    // (we're mid-turn, the bubble commits at end-of-turn). Two surfaces
    // pick up the slack: while the turn is still streaming, the
    // `StreamingBubble` resolves any unanswered question for this session
    // and renders the inline card directly; once the turn finishes,
    // `ChatManager` stamps `pendingQuestionId` onto the just-committed
    // assistant bubble so the persisted bubble keeps the card visible
    // across reloads.
    const question: Question = {
      id: randomUUID(),
      projectId: body.projectId,
      gezelId: body.gezelId,
      sessionId: body.sessionId,
      prompt: buildPrompt(body.toolName, body.toolInput),
      choices: ['Allow', 'Deny'],
      allowWriteIn: false,
      multiSelect: false,
      intent: {
        kind: 'tool-permission',
        toolName: body.toolName,
        toolInput: body.toolInput,
      },
      createdAt: nowIso(),
    };
    await ctx.store.writeQuestion(question);
    const scope = {
      sessionId: question.sessionId,
      gezelId: question.gezelId,
      projectId: question.projectId,
    };
    ctx.chatEvents.publish(scope, { type: 'question_asked', question });
    // Surface the wait state in the streaming chat itself so the user sees
    // a breadcrumb above the tool row instead of just the question card
    // floating elsewhere — same channel as "STARTING" / "USING <tool>".
    // Going through ChatManager (not chatEvents directly) makes the
    // breadcrumb persist on the final assistant message too, so a
    // reload still shows the approval pause.
    ctx.chat.recordSessionIntent(
      scope,
      `awaiting your approval to use ${prettifyToolName(body.toolName)}`,
    );

    const outcome = await awaitAnswer(ctx, c, body.projectId, question.id, deadlineFromNow());
    if (outcome.kind === 'disconnected') {
      return c.json<RequestPermissionResponse>({
        behavior: 'deny',
        message: 'permission request canceled',
      });
    }
    if (outcome.kind === 'timeout') {
      return c.json<RequestPermissionResponse>({
        behavior: 'deny',
        message: timeoutMessage(),
      });
    }

    return c.json<RequestPermissionResponse>(verdictFor(outcome.question, body.toolInput));
  });

  return app;
}

/**
 * The `AskUserQuestion` interception: one gezel question card per entry
 * in `questions[]` (sequential — the CLI sends up to 4, almost always 1),
 * answered back to the CLI through the permission contract. The allow
 * verdict carries `updatedInput.answers` keyed by each question's full
 * text; values are the selected option labels joined with `", "` (the
 * multiSelect encoding the Agent SDK documents), with any write-in text
 * passed through verbatim — Claude expects the user's own words, never
 * the literal string "Other".
 */
async function runAskUserQuestions(
  ctx: ServiceContext,
  c: Context,
  body: RequestPermissionRequest,
  input: AskUserQuestionInput,
): Promise<RequestPermissionResponse> {
  const scope = {
    sessionId: body.sessionId,
    gezelId: body.gezelId,
    projectId: body.projectId,
  };
  const deadline = deadlineFromNow();
  const answers: Record<string, string> = {};
  ctx.chat.recordSessionIntent(scope, 'has a question for you');

  for (const [index, entry] of input.questions.entries()) {
    const options: ClaudeUserQuestionOption[] = entry.options ?? [];
    const question: Question = {
      id: randomUUID(),
      projectId: body.projectId,
      gezelId: body.gezelId,
      sessionId: body.sessionId,
      prompt: entry.question,
      ...(options.length > 0 ? { choices: options.map((o) => o.label) } : {}),
      allowWriteIn: true,
      multiSelect: entry.multiSelect ?? false,
      intent: {
        kind: 'claude-user-question',
        ...(entry.header ? { header: entry.header } : {}),
        options,
        questionIndex: index,
        questionCount: input.questions.length,
      },
      createdAt: nowIso(),
    };
    await ctx.store.writeQuestion(question);
    ctx.chatEvents.publish(scope, { type: 'question_asked', question });

    const outcome = await awaitAnswer(ctx, c, body.projectId, question.id, deadline);
    if (outcome.kind === 'disconnected') {
      return { behavior: 'deny', message: 'permission request canceled' };
    }
    if (outcome.kind === 'timeout') {
      return { behavior: 'deny', message: timeoutMessage(partialNote(answers)) };
    }

    const answer = outcome.question.answer;
    const labels = (answer?.selectedChoices ?? [])
      .map((i) => options[i]?.label)
      .filter((label): label is string => typeof label === 'string');
    const writeIn = answer?.writeIn?.trim();
    if (answer?.silentSkip || answer?.declined || (labels.length === 0 && !writeIn)) {
      const message = answer?.declined
        ? 'The user chose not to answer and wants you to proceed using your best judgment.'
        : 'The user dismissed the question without answering.';
      return { behavior: 'deny', message: `${message}${partialNote(answers)}` };
    }
    answers[entry.question] = [...labels, ...(writeIn ? [writeIn] : [])].join(', ');
  }

  return { behavior: 'allow', updatedInput: { ...body.toolInput, answers } };
}

/**
 * Long-poll one question until it's answered, the shared deadline lapses,
 * or the requesting client hangs up. The answer endpoint
 * (`POST /api/questions/:id/answer`) writes the answer back; we see it on
 * the next poll tick.
 */
async function awaitAnswer(
  ctx: ServiceContext,
  c: Context,
  projectId: string,
  questionId: string,
  deadline: number,
): Promise<AwaitOutcome> {
  while (Date.now() < deadline) {
    const current = await ctx.store.getQuestion(projectId, questionId);
    if (current?.answer) {
      return { kind: 'answered', question: current };
    }
    // Honor client disconnect — Hono / @hono/node-server exposes the
    // raw IncomingMessage via `c.req.raw`. Without this the loop runs
    // for the full timeout even after the gezel-mcp client gives up.
    const raw = (c.req as unknown as { raw?: { aborted?: boolean } }).raw;
    if (raw?.aborted) {
      return { kind: 'disconnected' };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { kind: 'timeout' };
}

function deadlineFromNow(): number {
  return Date.now() + WAIT_TIMEOUT_MS;
}

function timeoutMessage(suffix = ''): string {
  return `Permission request timed out after ${Math.round(WAIT_TIMEOUT_MS / 60_000)}m without a user response.${suffix}`;
}

/**
 * When a multi-question call dies partway (skip, decline, timeout), the
 * deny message still carries what the user DID answer — the model can act
 * on it instead of re-asking everything.
 */
function partialNote(answers: Record<string, string>): string {
  const entries = Object.entries(answers);
  if (entries.length === 0) return '';
  const lines = entries.map(([q, a]) => `- ${q} → ${a}`);
  return `\nAnswers given before that:\n${lines.join('\n')}`;
}

function buildPrompt(toolName: string, toolInput: Record<string, unknown>): string {
  const args =
    Object.keys(toolInput).length > 0
      ? `\n\n**Arguments:**\n\n\`\`\`json\n${safeStringify(toolInput)}\n\`\`\``
      : '';
  return `Claude wants to use the **${toolName}** tool.${args}`;
}

function verdictFor(
  question: Question,
  originalInput: Record<string, unknown>,
): RequestPermissionResponse {
  const answer = question.answer;
  if (!answer || answer.declined) {
    return { behavior: 'deny', message: 'User declined the permission request.' };
  }
  // Allow == selectedChoices[0] === 0; anything else (including [1]) → deny.
  const allowed = (answer.selectedChoices ?? []).includes(0);
  if (allowed) {
    return { behavior: 'allow', updatedInput: originalInput };
  }
  return { behavior: 'deny', message: 'User denied the permission request.' };
}

function safeStringify(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '<<unserializable>>';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
