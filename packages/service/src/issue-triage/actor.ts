import { type IssueVerdictActor, parseHarnessAppId } from '@bendyline/gezel';
import type { Context } from 'hono';
import { isOwnerCaller } from '../http/auth.js';

/**
 * Who a verdict is from, decided by the caller's credential alone. A gezel's
 * session token names its gezel; an outside app's harness token names the
 * app; the person's own clients are the person. Anything else may not judge
 * issues at all, so the caller gets `null` and a refusal.
 */
export function issueVerdictActorFor(c: Context): IssueVerdictActor | null {
  const auth = c.get('auth');
  if (!auth) return null;
  if (auth.scopes.includes('session')) {
    return auth.gezelId ? { kind: 'gezel', gezelId: auth.gezelId } : null;
  }
  const harness = parseHarnessAppId(auth.appId ?? '');
  if (harness && auth.scopes.includes('harness')) return { kind: 'app', client: harness.client };
  return isOwnerCaller(c) ? { kind: 'person' } : null;
}
