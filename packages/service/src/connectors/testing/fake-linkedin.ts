/**
 * A fake of the LinkedIn surface the `linkedin-posts` adapter uses, served
 * through `FakeHttp`: OpenID `GET /v2/userinfo` and the versioned
 * `POST /rest/posts`. The posts endpoint enforces what the live one does: a
 * `LinkedIn-Version` header naming an active version (a retired one answers
 * 426 NONEXISTENT_VERSION, a missing one 400 VERSION_MISSING), the Rest.li 2.0
 * protocol header, a 201 whose `x-restli-id` header carries the new post URN,
 * and `little`-format commentary — unescaped reserved characters are rejected
 * here rather than silently mangled, so a test sees the defect.
 */

import { FakeHttp, type FakeRequest, json, status } from './fake-http.js';

export const LINKEDIN_API = 'https://api.linkedin.com';

/** Versions LinkedIn serves as of October 2026 (each lives about a year). */
const ACTIVE_VERSIONS = new Set([
  '202511',
  '202601',
  '202602',
  '202603',
  '202604',
  '202605',
  '202606',
  '202607',
  '202608',
  '202609',
  '202610',
]);

export interface FakeLinkedInPost {
  urn: string;
  author: string;
  commentary: string;
  version: string;
}

export class FakeLinkedIn {
  readonly http = new FakeHttp();
  readonly sub = 'AbC123xYz';
  readonly posts: FakeLinkedInPost[] = [];
  private readonly tokens = new Set<string>(['li-seed']);
  private n = 0;

  constructor() {
    this.install();
  }

  /** The blob `completeOAuth` stores for LinkedIn (no refresh token for ordinary apps). */
  credential(expiresAt = '2999-01-01T00:00:00.000Z'): Record<string, string> {
    return { accessToken: 'li-seed', expiresAt, refreshMode: 'none' };
  }

  revoke(): void {
    this.tokens.clear();
  }

  private authorized(req: FakeRequest): Response | null {
    if (req.bearer && this.tokens.has(req.bearer)) return null;
    return status(401, {
      status: 401,
      serviceErrorCode: 65601,
      code: 'REVOKED_ACCESS_TOKEN',
      message: 'The token used in the request has been revoked by the user',
    });
  }

  private install(): void {
    this.http.on('GET', `${LINKEDIN_API}/v2/userinfo`, (req) => {
      const denied = this.authorized(req);
      if (denied) return denied;
      return json({
        sub: this.sub,
        name: 'Gezel Fake',
        given_name: 'Gezel',
        family_name: 'Fake',
        email_verified: true,
        locale: { country: 'US', language: 'en' },
      });
    });
    this.http.on('POST', `${LINKEDIN_API}/rest/posts`, (req) => {
      const denied = this.authorized(req);
      if (denied) return denied;
      const version = req.headers.get('linkedin-version');
      if (!version) {
        return status(400, {
          status: 400,
          code: 'VERSION_MISSING',
          message:
            'A version must be present. Please specify a version by adding the LinkedIn-Version header.',
        });
      }
      if (!ACTIVE_VERSIONS.has(version)) {
        return status(426, {
          status: 426,
          code: 'NONEXISTENT_VERSION',
          message: `Requested version ${version} is not active`,
        });
      }
      if (req.headers.get('x-restli-protocol-version') !== '2.0.0') {
        return status(400, { status: 400, message: 'Rest.li protocol 2.0.0 is required' });
      }
      const body = req.json<{
        author?: string;
        commentary?: string;
        visibility?: string;
        distribution?: unknown;
        lifecycleState?: string;
      }>();
      if (!body.author || !body.visibility || !body.distribution || !body.lifecycleState) {
        return status(400, {
          status: 400,
          code: 'MISSING_FIELD',
          message: 'A required field is missing',
        });
      }
      if (body.author !== `urn:li:person:${this.sub}`) {
        return status(403, {
          status: 403,
          code: 'ACCESS_DENIED',
          message: 'Not allowed to post as this author',
        });
      }
      const commentary = body.commentary ?? '';
      if (hasUnescapedReserved(commentary)) {
        return status(422, {
          status: 422,
          code: 'UNPROCESSABLE_ENTITY',
          message: 'commentary is not valid little text: escape reserved characters',
        });
      }
      const urn = `urn:li:share:71000000000000${String(++this.n).padStart(5, '0')}`;
      this.posts.push({ urn, author: body.author, commentary, version });
      return new Response(null, { status: 201, headers: { 'x-restli-id': urn } });
    });
  }
}

/**
 * True when `little` text holds a reserved character that is neither escaped
 * nor part of a hashtag. (LinkedIn's parser drops the rest of the text in
 * that case; the fake rejects it so the defect is visible.)
 */
function hasUnescapedReserved(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    const startsWord = i === 0 || /\s/.test(text[i - 1]!);
    if (ch === '#' && startsWord && /[\p{L}\p{N}]/u.test(text[i + 1] ?? '')) continue;
    if ('|{}@[]()<>#*_~'.includes(ch)) return true;
  }
  return false;
}
