import { isLocalProvider } from '@bendyline/gezel';
import type { ProjectConnectorBinding } from '@bendyline/gezel';
import type { Context } from 'hono';
import {
  cameraAllowsCloud,
  cameraBindingForArtifact,
} from '../connectors/live/camera/frame-access.js';
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

/**
 * Whether this caller may read the pixels of an artifact image. Everything
 * outside a camera's corpus is unaffected. A camera's keyframes reach the
 * person's own app and on-device sessions; a cloud-model session only when
 * the camera allows it.
 */
export async function callerMaySeeArtifactPixels(
  ctx: ServiceContext,
  c: Context,
  project: { connectors?: ProjectConnectorBinding[] },
  artifactPath: string,
): Promise<boolean> {
  const binding = cameraBindingForArtifact(project, artifactPath);
  if (!binding || cameraAllowsCloud(binding)) return true;
  return callerMaySeeLocation(ctx, c);
}
