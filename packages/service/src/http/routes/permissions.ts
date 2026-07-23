import { randomUUID } from 'node:crypto';
import {
  type Question,
  RequestPermissionRequestSchema,
  type RequestPermissionResponse,
  nowIso,
  prettifyToolName,
} from '@bendyline/gezel';
import { Hono } from 'hono';
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
 */

/** Total time we'll keep the connection open before auto-denying. */
const WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
/** Poll cadence for the question file. */
const POLL_INTERVAL_MS = 500;

export function permissionRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/request-and-wait', async (c) => {
    const body = RequestPermissionRequestSchema.parse(await c.req.json());

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

    // Long-poll the question file. The answer endpoint
    // (`POST /api/questions/:id/answer`) writes the answer back; we
    // see it on the next poll tick.
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let resolved: Question | null = null;
    while (Date.now() < deadline) {
      const current = await ctx.store.getQuestion(body.projectId, question.id);
      if (current?.answer) {
        resolved = current;
        break;
      }
      // Honor client disconnect — Hono / @hono/node-server exposes the
      // raw IncomingMessage via `c.req.raw`. Without this the loop runs
      // for the full timeout even after the gezel-mcp client gives up.
      const raw = (c.req as unknown as { raw?: { aborted?: boolean } }).raw;
      if (raw?.aborted) {
        return c.json<RequestPermissionResponse>({
          behavior: 'deny',
          message: 'permission request canceled',
        });
      }
      await sleep(POLL_INTERVAL_MS);
    }

    if (!resolved) {
      return c.json<RequestPermissionResponse>({
        behavior: 'deny',
        message: `Permission request timed out after ${Math.round(WAIT_TIMEOUT_MS / 60_000)}m without a user response.`,
      });
    }

    return c.json<RequestPermissionResponse>(verdictFor(resolved, body.toolInput));
  });

  return app;
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
