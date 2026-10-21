/**
 * A route-table `fetch` for connector tests and the provider simulator.
 *
 * Every native adapter takes its HTTP transport through `AdapterDeps.fetch`
 * (or a provider constructor's `fetchImpl`), so a test hands it
 * `fakeHttp.fetch` and the adapter talks to an in-process fake of Gmail,
 * Graph, Google Calendar, … instead of the network. The fakes in this folder
 * are stateful (a mailbox that gains messages, a delta token that expires), so
 * a test can drive the same adapter through several sync passes and watch
 * the cursor do its job.
 *
 * Two properties matter more than convenience:
 *
 * - **Unrouted requests fail loudly.** A request no route matches throws a
 *   plain error (deliberately not one `retryTransient` would retry) and is
 *   kept on `unrouted`, so an adapter calling an endpoint its fake does not
 *   model shows up as a test failure, never as a quiet empty sync.
 * - **Faults are first-class.** `failNext` queues a canned response (429
 *   with `Retry-After`, 503, 401, 410 Gone) ahead of the real handler, which
 *   is how the conformance suite proves backoff, auth, and cursor-expiry
 *   behavior without a real provider ever misbehaving on cue.
 */

type HeadersLike = ConstructorParameters<typeof Headers>[0];

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** Raw request body ('' when none). */
  bodyText: string;
  /** Body parsed as JSON (throws on invalid JSON). */
  json<T = unknown>(): T;
  /** Body parsed as `application/x-www-form-urlencoded`. */
  form(): URLSearchParams;
  /** The `Authorization: Bearer` token, when one was sent. */
  bearer?: string;
}

export type FakeHandler = (
  req: FakeRequest,
  params: Record<string, string>,
) => Response | Promise<Response>;

interface Route {
  method: string;
  origin: string;
  /** Path segments: literals, `:name` params, or a final `*`. */
  segments: string[];
  handler: FakeHandler;
}

interface Fault {
  method?: string;
  match: (url: URL) => boolean;
  remaining: number;
  respond: (req: FakeRequest) => Response;
  /** A canned response, copied fresh for every serve. */
  template?: Response;
}

/** JSON response helper. */
export function json(
  body: unknown,
  init: { status?: number; headers?: HeadersLike } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...headersObject(init.headers) },
  });
}

/** Plain status response helper, optionally with a JSON error body. */
export function status(code: number, body?: unknown, headers?: HeadersLike): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: code,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headersObject(headers),
    },
  });
}

/** Byte/text response helper. */
export function bytes(
  body: string | Uint8Array,
  contentType = 'application/octet-stream',
  headers?: HeadersLike,
): Response {
  return new Response(typeof body === 'string' ? body : Buffer.from(body), {
    status: 200,
    headers: { 'content-type': contentType, ...headersObject(headers) },
  });
}

function headersObject(h: HeadersLike | undefined): Record<string, string> {
  if (!h) return {};
  return Object.fromEntries(new Headers(h).entries());
}

/**
 * Match a request pathname against route segments. Each request segment is
 * decoded on its own, so an id carrying `%2F` or `%40` arrives intact as one
 * param instead of splitting the path.
 */
function matchSegments(segments: string[], pathname: string): Record<string, string> | null {
  const actual = pathname.split('/');
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === '*' && i === segments.length - 1) {
      params['*'] = actual.slice(i).map(safeDecode).join('/');
      return params;
    }
    if (i >= actual.length) return null;
    const got = safeDecode(actual[i]!);
    if (seg.startsWith(':')) {
      if (!got) return null;
      params[seg.slice(1)] = got;
    } else if (got !== seg) {
      return null;
    }
  }
  return actual.length === segments.length ? params : null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export class FakeHttp {
  /** Every request, in order (routed or not). */
  readonly calls: FakeRequest[] = [];
  /** Requests no route matched — a test should normally assert this is empty. */
  readonly unrouted: string[] = [];
  private readonly routes: Route[] = [];
  private readonly faults: Fault[] = [];

  /**
   * Register a route. `url` is an absolute URL whose path may use `:name`
   * segments and a trailing `*`; the query string is never matched (handlers
   * read `req.url.searchParams`). Later routes win over earlier ones, so a
   * test can override one endpoint of a stateful fake.
   */
  on(method: string, url: string, handler: FakeHandler): this {
    const u = new URL(url);
    this.routes.unshift({
      method: method.toUpperCase(),
      origin: u.origin,
      segments: u.pathname.split('/').map(safeDecode),
      handler,
    });
    return this;
  }

  /**
   * Answer the next `times` requests matching `url` (a URL prefix or regex)
   * with a canned response instead of the route. Faults are consumed in the
   * order they were queued.
   */
  failNext(
    match: { method?: string; url: string | RegExp },
    response: Response | ((req: FakeRequest) => Response),
    times = 1,
  ): this {
    const test =
      typeof match.url === 'string'
        ? (u: URL) => u.href.startsWith(match.url as string)
        : (u: URL) => (match.url as RegExp).test(u.href);
    this.faults.push({
      ...(match.method ? { method: match.method.toUpperCase() } : {}),
      match: test,
      remaining: times,
      respond: typeof response === 'function' ? response : () => response,
      // A served clone shares a tee'd stream with the template, and cancelling
      // one branch of a tee never settles while the other is unread — so an
      // adapter that cancels a 401 body before retrying would hang. Each serve
      // gets an independent copy of the bytes instead.
      ...(typeof response === 'function' ? {} : { template: response }),
    });
    return this;
  }

  /** True when a route (not a fault) would answer this request. */
  handles(method: string, url: string): boolean {
    const u = new URL(url);
    const m = method.toUpperCase();
    return this.routes.some(
      (r) =>
        r.method === m && r.origin === u.origin && matchSegments(r.segments, u.pathname) !== null,
    );
  }

  /** Requests whose method matches and whose URL starts with `prefix`. */
  requests(method: string, prefix: string): FakeRequest[] {
    const m = method.toUpperCase();
    return this.calls.filter((c) => c.method === m && c.url.href.startsWith(prefix));
  }

  /** Bound fetch implementation to hand to an adapter. */
  readonly fetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    const bodyText = await readBody(init?.body ?? null, request);
    const auth = headers.get('authorization') ?? '';
    const req: FakeRequest = {
      method,
      url,
      headers,
      bodyText,
      json: <T>() => JSON.parse(bodyText) as T,
      form: () => new URLSearchParams(bodyText),
      ...(auth.toLowerCase().startsWith('bearer ') ? { bearer: auth.slice(7).trim() } : {}),
    };
    this.calls.push(req);

    const fault = this.faults.find(
      (f) => f.remaining > 0 && (!f.method || f.method === method) && f.match(url),
    );
    if (fault) {
      fault.remaining--;
      if (fault.template) {
        const body = await fault.template.clone().arrayBuffer();
        return new Response(body.byteLength > 0 ? body : null, {
          status: fault.template.status,
          headers: fault.template.headers,
        });
      }
      return fault.respond(req);
    }

    for (const route of this.routes) {
      if (route.method !== method || route.origin !== url.origin) continue;
      const params = matchSegments(route.segments, url.pathname);
      if (params) return route.handler(req, params);
    }
    this.unrouted.push(`${method} ${url.href}`);
    throw new Error(
      `FakeHttp has no route for ${method} ${url.origin}${url.pathname} — add one to the fake, or the adapter is calling an endpoint the test does not expect`,
    );
  };
}

async function readBody(body: RequestInit['body'], request: Request | null): Promise<string> {
  if (body === null || body === undefined) return request ? await request.text() : '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('utf8');
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  }
  return await new Response(body).text();
}

/**
 * OAuth token endpoint fake: accepts `authorization_code` and `refresh_token`
 * grants, mints opaque tokens, optionally rotates refresh tokens, and records
 * every grant. `rejectRefresh` simulates a revoked grant (`invalid_grant`).
 */
export class FakeTokenEndpoint {
  readonly grants: URLSearchParams[] = [];
  private n = 0;
  rejectRefresh = false;
  /** Refresh tokens issued so far; only the newest is valid when rotating. */
  private validRefresh = new Set<string>();

  constructor(
    readonly url: string,
    private readonly opts: {
      rotateRefreshToken?: boolean;
      expiresIn?: number;
      /** More token URLs sharing this grant state (Microsoft's per-tenant endpoints). */
      alsoAt?: string[];
    } = {},
  ) {}

  /** Mint a refresh token the fake will accept (for seeding a credential). */
  issueRefreshToken(): string {
    const token = `refresh-${++this.n}`;
    this.validRefresh.add(token);
    return token;
  }

  install(http: FakeHttp): this {
    for (const url of [this.url, ...(this.opts.alsoAt ?? [])]) {
      http.on('POST', url, (req) => this.grant(req));
    }
    return this;
  }

  private grant(req: FakeRequest): Response {
    const form = req.form();
    this.grants.push(form);
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      if (!form.get('code') || !form.get('code_verifier')) {
        return status(400, { error: 'invalid_request' });
      }
      return json({
        access_token: `access-${++this.n}`,
        refresh_token: this.issueRefreshToken(),
        expires_in: this.opts.expiresIn ?? 3600,
        token_type: 'Bearer',
      });
    }
    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      if (this.rejectRefresh || !this.validRefresh.has(presented)) {
        return status(400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        });
      }
      const rotated = this.opts.rotateRefreshToken ? this.issueRefreshToken() : undefined;
      if (rotated) this.validRefresh.delete(presented);
      return json({
        access_token: `access-${++this.n}`,
        ...(rotated ? { refresh_token: rotated } : {}),
        expires_in: this.opts.expiresIn ?? 3600,
        token_type: 'Bearer',
      });
    }
    return status(400, { error: 'unsupported_grant_type' });
  }
}
