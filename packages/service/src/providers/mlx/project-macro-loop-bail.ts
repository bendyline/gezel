/**
 * Loop-cap helper for the `start_project` / `start_job` per-turn
 * intercept. When the model emits the macro, the bridge runs it
 * successfully on the first call and the per-turn guard
 * (`startedProjectOrJobThisTurn`) arms. Subsequent calls in the same
 * turn hit an intercept that returns a "STOP, you already kicked off
 * the project" message — but small/medium local models (wild-caught
 * on gemma4-26b/MLX) misread that as "your call was
 * malformed, retry it" and keep emitting envelopes until
 * `MAX_TOOL_LOOP_TURNS` (96) bails the session. The user stares at a
 * blank bubble for minutes; the real project + voorman exist but the
 * Meester never wraps the turn with a user-visible reply.
 *
 * This module owns:
 *   1. `deriveProjectMacroClosing` — parse the first successful
 *      result text into a one-line user-facing summary the synthetic
 *      end-of-turn message can carry. Pure function; tested directly.
 *   2. `PROJECT_MACRO_INTERCEPT_CAP` — how many redundant macro
 *      attempts past the first success we tolerate before force-
 *      ending the turn. 2 means: 1 successful + 2 redundant = 3
 *      total attempts before the runtime steps in.
 */

/** Hard cap on per-turn redundant macro intercepts before we force end-of-turn. */
export const PROJECT_MACRO_INTERCEPT_CAP = 2;

/**
 * Derive a one-line closing summary from the verbatim `start_project`
 * / `start_job` tool result. Used when the loop-cap force-ends the
 * turn so the user sees "Project X is on it — Vivian is leading" in
 * the assistant bubble instead of the model's malformed retry prose.
 *
 * Input shapes (from `packages/mcp/src/server.ts`):
 *   `Started project "NAME" (id). Recruited NAME as voorman. Created task ...`
 *   `Started job "NAME" (id). Recruited NAME as ambachtsman (template: ...). ...`
 *
 * Falls back to a generic "kickoff is on it" line if the result text
 * doesn't match either shape — should never happen with the current
 * MCP server, but we never want to surface the literal stuck-loop
 * prose to the user.
 */
export function deriveProjectMacroClosing(firstResult: string): string {
  const projectMatch = firstResult.match(/Started (?:project|job) "([^"]+)"/);
  const leadMatch = firstResult.match(/Recruited (\S+) as (voorman|ambachtsman)/);
  const projectName = projectMatch?.[1];
  const leadName = leadMatch?.[1];
  const leadRole = leadMatch?.[2];
  if (projectName && leadName) {
    const trailer = leadRole === 'voorman' ? ' is leading the crew' : ' is on it';
    return `Project "${projectName}" is kicked off — ${leadName}${trailer}. You can watch their work surface in this thread.`;
  }
  if (projectName) {
    return `Project "${projectName}" is kicked off — the lead is taking it from here.`;
  }
  return 'Project kickoff is on it — the lead is taking it from here.';
}
