import {
  egressIndicatorRefusal,
  findEgressIndicators,
  resolveSecurityPolicy,
  toolCallBlockedHistoryEntry,
} from '@bendyline/gezel';
import type { Context } from 'hono';
import { collectProviderSecretValues } from '../secrets/registry.js';
import { isOwnerCaller } from './auth.js';
import type { ServiceContext } from './context.js';

/**
 * Secret shapes that are nearly never anything else. A gezel has no reason
 * to post one to GitHub; an injected one does.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
];

/**
 * A gezel reaching a git remote or GitHub when model git is off. The tools
 * were hidden at that level, but their routes asked nothing, so a session
 * token could still push, pull or post. The person's own clients and the
 * grants they approved act with their authority and are not asked.
 */
export async function modelGitRefusal(c: Context, ctx: ServiceContext): Promise<Response | null> {
  if (isOwnerCaller(c)) return null;
  const policy = resolveSecurityPolicy(await ctx.store.readConfig());
  if (policy.allowModelGit) return null;
  return c.json(
    {
      error:
        'request denied: git and GitHub are turned off for gezels at the current security level.',
    },
    403,
  );
}

/**
 * Text a gezel is about to publish on GitHub. An injected reviewer posted the
 * workspace's `.env` as a comment on the attacker's own pull request, and an
 * image in a comment is fetched by GitHub's proxy wherever it points. Refuse
 * a stored credential, a secret-shaped string, or an address the egress
 * tripwire names.
 */
export async function modelGitHubTextRefusal(
  c: Context,
  ctx: ServiceContext,
  tool: string,
  texts: ReadonlyArray<string | undefined>,
): Promise<Response | null> {
  if (isOwnerCaller(c)) return null;
  const present = texts.filter((text): text is string => Boolean(text));
  if (present.length === 0) return null;
  const stored = await collectProviderSecretValues(ctx.secrets);
  const secret =
    present.some((text) => stored.some((value) => value && text.includes(value))) ||
    present.some((text) => SECRET_SHAPES.some((shape) => shape.test(text)));
  if (secret) {
    return c.json(
      {
        error:
          'Blocked by Gezel: this text contains what looks like a credential or private key. Gezel does not post secrets to GitHub. Remove it, and tell the person what you meant to post.',
      },
      403,
    );
  }
  const indicators = present.flatMap((text) => findEgressIndicators(text));
  if (indicators.length > 0) {
    const auth = c.get('auth') as { gezelId?: string } | undefined;
    const entry = toolCallBlockedHistoryEntry({
      tool,
      surface: 'gezel-tool',
      indicators,
      ...(c.req.param('id') ? { projectId: c.req.param('id') } : {}),
      ...(auth?.gezelId ? { gezelId: auth.gezelId } : {}),
    });
    void ctx.history?.log(entry).catch(() => undefined);
    return c.json({ error: egressIndicatorRefusal(indicators) }, 403);
  }
  return null;
}
