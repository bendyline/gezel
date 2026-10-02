import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { JournalContext } from '../workspace/journal.js';

/** Session credentials decide the writer; request attribution is only trusted for user clients. */
export function mutationActor(c: Context, claimed?: JournalContext): JournalContext {
  const auth = c.get('auth');
  if (auth?.scopes.includes('session')) {
    if (!auth.gezelId || !auth.appId.startsWith('session:')) {
      throw new HTTPException(403, { message: 'session token has no mutation actor' });
    }
    return { gezelId: auth.gezelId, sessionId: auth.appId.slice('session:'.length) };
  }
  const gezelId = claimed?.gezelId || c.req.query('gezelId');
  const sessionId = claimed?.sessionId || c.req.query('sessionId');
  return { ...(gezelId ? { gezelId } : {}), ...(sessionId ? { sessionId } : {}) };
}
