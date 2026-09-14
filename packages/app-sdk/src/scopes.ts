/**
 * Which scopes need the user to read a code out of this app.
 *
 * This predicate lived in two places — `connect.ts`, deciding whether to wire
 * the code handshake, and `connect-or-host.ts`, deciding whether an app that
 * cannot show a code should host its own daemon instead. Two copies of a
 * security predicate that must agree is a latent bug: adding a scope to one
 * and not the other silently changes who is asked for proof of presence.
 */

/** Scopes that grant inference only, and so need no code handshake. */
const INFERENCE_ONLY_SCOPES: ReadonlySet<string> = new Set(['openai', 'remote-inference']);

/**
 * True when the grant carries authority beyond inference, or when the caller
 * asked for the stronger handshake anyway.
 *
 * A first-party client may set `requireVerificationCode` to demand the code
 * even for an inference-only grant — stronger proof of intent without asking
 * for broader authority.
 */
export function scopeNeedsVerificationCode(
  scopes: readonly string[],
  requireVerificationCode?: boolean,
): boolean {
  if (requireVerificationCode === true) return true;
  return scopes.some((scope) => !INFERENCE_ONLY_SCOPES.has(scope));
}
