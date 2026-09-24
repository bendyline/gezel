/**
 * The canonical form of a craftbook invocation, shared by every launcher
 * that derives an idempotency key from one (the MCP tool's per-root-turn
 * cache and the chat composer's launch route). Hashing lives with each
 * caller — this module has to load in the browser build.
 */

export function canonicalizeInvocation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeInvocation);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalizeInvocation(entry)]),
    );
  }
  return value;
}

/**
 * The task's display labels, not the work. A model re-emitting its call
 * rarely reproduces them: a qwen3.8-27b Meester's two `invoke_craftbook`
 * calls for one "Create a PowerPoint about pizza" differed only in `title`,
 * and that alone launched a second deck crew (2026-09-23). Craftbook,
 * project, version, assignee and params still separate genuinely different
 * work — "a deck on pizza and one on pasta" differs in `params.topic`.
 */
const COSMETIC_INVOCATION_FIELDS = new Set(['title', 'description']);

export function invocationSignature(invocation: Readonly<Record<string, unknown>>): string {
  const work = Object.fromEntries(
    Object.entries(invocation).filter(([key]) => !COSMETIC_INVOCATION_FIELDS.has(key)),
  );
  return JSON.stringify(canonicalizeInvocation(work));
}

/** Every durable invocation key carries this prefix; `CreateTaskRequest` checks it. */
export const CRAFTBOOK_INVOCATION_KEY_PREFIX = 'craftbook-root-v1:';
