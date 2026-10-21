import { isLocalProvider } from '@bendyline/gezel';
import type { Context } from 'hono';
import { isOwnerCaller } from './auth.js';
import type { ServiceContext } from './context.js';

/**
 * Whether this caller may see where a photo was taken. A photo's coordinates
 * say where someone lives: the person's own app and a gezel session on an
 * on-device model see them; a session on a cloud model does not, and neither
 * does any narrower principal whose model Gezel cannot see.
 */
export async function callerMaySeeLocation(ctx: ServiceContext, c: Context): Promise<boolean> {
  const auth = c.get('auth');
  if (auth?.scopes.includes('session') && auth.appId.startsWith('session:')) {
    const session = await ctx.chat
      .getSessionRecord(auth.appId.slice('session:'.length))
      .catch(() => null);
    return session?.providerName ? isLocalProvider(session.providerName) : false;
  }
  return isOwnerCaller(c);
}
