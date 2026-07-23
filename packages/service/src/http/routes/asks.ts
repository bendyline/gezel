import { RequestAskRequestSchema, type RequestAskResponse } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';

/**
 * Routes that broker synchronous gezel-to-gezel consultations.
 *
 * Each `POST /api/asks/request-and-wait` call corresponds to one
 * `ask_gezel` MCP tool invocation. The service spins up a fresh
 * consultation session for the target gezel, delivers the asker's
 * question, and blocks the HTTP response until either:
 *   - the target's session emits a `complete` event (success), OR
 *   - the target's session emits an `error` event (target turn failed), OR
 *   - the per-call timeout elapses, OR
 *   - the target's session is deleted mid-ask, OR
 *   - the call is rejected up front for cycle / depth / engagement reasons.
 *
 * Deadlock protection lives in `ChatManager.askGezelAndWait`:
 *   - the in-flight ask graph is walked BEFORE the new edge is added,
 *     and any path that would close a cycle through the asker is
 *     rejected with `outcome: 'error', reason: 'cycle'`.
 *   - depth-exceeding chains are rejected with `reason: 'depth'`.
 *   - per-call timeout (configurable, default 5 min, clamped to 10s..30min)
 *     bounds how long any one ask can hold a slot.
 *
 * Status code semantics: every outcome (success or structured failure)
 * returns 200 with a discriminated union body. The MCP tool branches on
 * `outcome` and surfaces the failure reason to the model verbatim.
 */
export function askRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post('/request-and-wait', async (c) => {
    const body = RequestAskRequestSchema.parse(await c.req.json());

    const result = await ctx.chat.askGezelAndWait({
      fromGezelId: body.fromGezelId,
      fromSessionId: body.fromSessionId,
      toGezelIdOrName: body.toGezelIdOrName,
      ...(body.projectId ? { projectId: body.projectId } : {}),
      text: body.question,
      ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {}),
      ...(body.taskRef ? { taskRef: body.taskRef } : {}),
      ...(body.stepId ? { stepId: body.stepId } : {}),
      ...(body.expectedDeliverable ? { expectedDeliverable: body.expectedDeliverable } : {}),
    });

    if (result.outcome === 'reply') {
      const response: RequestAskResponse = {
        outcome: 'reply',
        text: result.text,
        toGezelId: result.toGezelId,
        toGezelName: result.toGezelName,
        sessionId: result.sessionId,
      };
      return c.json(response);
    }

    const response: RequestAskResponse = {
      outcome: 'error',
      reason: result.reason,
      message: result.message,
    };
    return c.json(response);
  });

  return app;
}
