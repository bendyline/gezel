/**
 * Recognize Codex CLI's reports of an HTTP 429 from the model service.
 *
 * Codex retries a refused sampling request itself (five attempts, waiting
 * out the service's retry-after, ~60 s each) and reports each retry on the
 * `--json` stream as an `error` event, e.g.
 *
 *   {"type":"error","message":"Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)"}
 *
 * then, when the retries run out, a final `error` / `turn.failed` carrying
 * the same status. Nothing else on the stream moves while it waits, so a
 * throttled turn looked like a hung model and was killed by the turn budget
 * (2026-11-10). The invoker uses this to tell "Codex is waiting out a 429"
 * from "Codex failed": the wait stops the turn budget, the provider narrows
 * its queue (RateLimitGovernor), and a turn that still fails rejects with
 * ProviderRateLimitError.
 *
 * A usage-limit message (the plan's allowance is spent) is deliberately not
 * a rate-limit signal: waiting a minute will not fix it, and the quota path
 * reports it.
 *
 * Related: invoker.ts, provider.ts, core runtime/provider-rate-limit.ts.
 */

export interface CodexRateLimitSignal {
  /** Codex is retrying (`Reconnecting... n/m`) rather than reporting a final refusal. */
  retrying: boolean;
  attempt?: number;
  maxAttempts?: number;
}

const RATE_LIMITED = /\b429\b|too many requests|rate[ _-]?limit(?:ed)?\b/i;
const USAGE_LIMIT = /usage limit|quota|insufficient[_ ]quota|credits?\b/i;
const RECONNECTING = /\breconnecting\.{0,3}\s*(\d+)\s*\/\s*(\d+)/i;

/** A Codex stream message that reports a 429, or null. */
export function codexRateLimitSignal(message: string): CodexRateLimitSignal | null {
  if (!RATE_LIMITED.test(message) || USAGE_LIMIT.test(message)) return null;
  const retry = RECONNECTING.exec(message);
  if (!retry) return { retrying: false };
  return { retrying: true, attempt: Number(retry[1]), maxAttempts: Number(retry[2]) };
}
