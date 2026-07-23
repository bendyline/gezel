import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:https';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { CraftbookTestSpec, MockService } from '@bendyline/gezel';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import selfsigned from 'selfsigned';

/**
 * Live per-trial mock services for the craftbook eval rail.
 *
 * The declarative `mocks[]` from a book's `test.json` is the SOURCE this
 * server serves: each `http`/`webhook`/`mcp` service gets its own HTTPS
 * listener on `127.0.0.1:0` with a per-trial self-signed cert. The trial
 * daemon is spawned with `NODE_EXTRA_CA_CERTS=<that cert>` so its
 * daemon-side `http.authed` fetches AND its MCP bridge connections trust
 * it, and with `GEZEL_SEED_SECRETS_FILE` provisioning the `mock.<id>`
 * credentials — so gezels reach the mock through the REAL credential/
 * origin-grant rail, not a test backdoor. `cli` shims are seeded as
 * workspace files; `mcp` services host a real Streamable-HTTP MCP
 * endpoint (official SDK server) that the trial installs as a
 * local-catalog `mock-mcp-<id>` toolset, so the tools ride the REAL
 * catalog-install → per-session bridge rail.
 *
 * Auth is enforced for http services: they 401 unless the request
 * carries the seeded token (Bearer/Basic per spec) — a passing trial
 * therefore proves the credential rail end to end. MCP mocks are
 * unauthenticated in v1: the boundary under test there is the toolset
 * install rail (only the trial that wrote + installed the local-catalog
 * manifest can reach the loopback endpoint), not credential auth. Every
 * request lands in an in-process log the graders read for
 * `success.mocks` assertions.
 */

export interface MockRequestLogEntry {
  at: string;
  method: string;
  path: string;
  matchedRoute: string | null;
  status: number;
  authorized: boolean;
}

export interface StartedMockService {
  id: string;
  kind: 'http' | 'webhook' | 'mcp';
  baseUrl: string;
  /** Credential short name (`mock.<id>`) for http services; null otherwise. */
  credentialName: string | null;
  token: string | null;
  requests: MockRequestLogEntry[];
}

/** Catalog id of the local toolset that fronts a `kind:'mcp'` mock service. */
export function mockMcpToolsetId(serviceId: string): string {
  return `mock-mcp-${serviceId}`;
}

export interface MockServicesRuntime {
  services: Map<string, StartedMockService>;
  /** PEM of the per-trial self-signed cert — write it to disk and point NODE_EXTRA_CA_CERTS at it. */
  caPem: string;
  /** Entries for the daemon's GEZEL_SEED_SECRETS_FILE seam. */
  seedEntries(): Array<{ toolsetId: string; fieldId: string; value: string }>;
  /** grantedCredentials + credentialAllowedOrigins patches for the trial project. */
  projectGrants(): {
    grantedCredentials: string[];
    credentialAllowedOrigins: Record<string, string[]>;
  };
  /** Replace `{{mock:<id>.baseUrl}}` / `{{mock:<id>.credential}}` placeholders. */
  substitute(text: string): string;
  /** Human + machine discovery docs seeded into the trial workspace. */
  servicesMarkdown(): string;
  servicesJson(): string;
  /**
   * Local-catalog toolset manifest files for the `kind:'mcp'` services,
   * as paths relative to the trial's GEZEL_HOME. The runner writes them
   * before spawning the daemon so `installToolset('mock-mcp-<id>', …)`
   * resolves through the daemon's LocalCatalogSource like any other
   * catalog toolset. Empty when the book declares no mcp mocks.
   */
  mcpToolsetFiles(): Array<{ path: string; content: string }>;
  close(): Promise<void>;
}

export async function startMockServices(
  mocks: CraftbookTestSpec['mocks'],
): Promise<MockServicesRuntime | null> {
  const live = mocks.filter(
    (mock): mock is Extract<MockService, { kind: 'http' | 'webhook' | 'mcp' }> =>
      mock.kind === 'http' || mock.kind === 'webhook' || mock.kind === 'mcp',
  );
  if (live.length === 0) return null;

  const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: '127.0.0.1' },
          { type: 2, value: 'localhost' },
        ],
      },
    ],
  });

  const services = new Map<string, StartedMockService>();
  const servers: Server[] = [];
  const specById = new Map(live.map((mock) => [mock.id, mock]));

  for (const mock of live) {
    const token = mock.kind === 'http' ? randomBytes(24).toString('hex') : null;
    const started: StartedMockService = {
      id: mock.id,
      kind: mock.kind,
      baseUrl: '',
      credentialName: mock.kind === 'http' ? mock.credential.name : null,
      token,
      requests: [],
    };
    if (mock.kind === 'mcp') {
      const server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
        void handleMcpMockRequest(mock, started, req, res);
      });
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(0, '127.0.0.1', () => resolvePromise());
      });
      const port = (server.address() as AddressInfo).port;
      started.baseUrl = `https://127.0.0.1:${port}`;
      services.set(mock.id, started);
      servers.push(server);
      continue;
    }
    const server = createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
      const url = new URL(req.url ?? '/', 'https://127.0.0.1');
      const entry: MockRequestLogEntry = {
        at: new Date().toISOString(),
        method: req.method ?? 'GET',
        path: url.pathname,
        matchedRoute: null,
        status: 0,
        authorized: true,
      };
      const finish = (status: number, headers: Record<string, string>, body: string) => {
        entry.status = status;
        started.requests.push(entry);
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(body);
      };

      if (mock.kind === 'http') {
        const scheme = mock.credential.authScheme ?? 'bearer';
        const expected =
          scheme === 'basic'
            ? `Basic ${Buffer.from(`mock:${token}`).toString('base64')}`
            : `Bearer ${token}`;
        if ((req.headers.authorization ?? '') !== expected) {
          entry.authorized = false;
          finish(401, {}, JSON.stringify({ error: 'missing or invalid mock credential' }));
          return;
        }
        const route = mock.routes.find(
          (candidate) =>
            (candidate.method ?? 'GET') === (req.method ?? 'GET') &&
            pathMatches(candidate.path, url.pathname),
        );
        if (!route) {
          finish(
            404,
            {},
            JSON.stringify({ error: `no mock route for ${req.method} ${url.pathname}` }),
          );
          return;
        }
        entry.matchedRoute = `${route.method ?? 'GET'} ${route.path}`;
        const body =
          typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? null);
        const respond = () => finish(route.status ?? 200, route.headers ?? {}, body);
        if (route.latencyMs && route.latencyMs > 0) setTimeout(respond, route.latencyMs);
        else respond();
        return;
      }

      // webhook: accept POSTs on the receiver path, reject the rest.
      const receiverPath = mock.path ?? '/webhook';
      if ((req.method ?? 'GET') === 'POST' && pathMatches(receiverPath, url.pathname)) {
        entry.matchedRoute = `POST ${receiverPath}`;
        // Drain the body so keep-alive clients aren't stalled.
        req.resume();
        req.on('end', () => finish(200, {}, JSON.stringify({ ok: true })));
        return;
      }
      finish(405, {}, JSON.stringify({ error: `webhook receiver accepts POST ${receiverPath}` }));
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(0, '127.0.0.1', () => resolvePromise());
    });
    const port = (server.address() as AddressInfo).port;
    started.baseUrl = `https://127.0.0.1:${port}`;
    services.set(mock.id, started);
    servers.push(server);
  }

  return {
    services,
    caPem: pems.cert,
    seedEntries() {
      return [...services.values()]
        .filter((service) => service.token !== null && service.credentialName)
        .map((service) => {
          const dot = service.credentialName!.indexOf('.');
          return {
            toolsetId: service.credentialName!.slice(0, dot),
            fieldId: service.credentialName!.slice(dot + 1),
            value: service.token!,
          };
        });
    },
    projectGrants() {
      const grantedCredentials: string[] = [];
      const credentialAllowedOrigins: Record<string, string[]> = {};
      for (const service of services.values()) {
        if (!service.credentialName) continue;
        grantedCredentials.push(service.credentialName);
        credentialAllowedOrigins[service.credentialName] = [service.baseUrl];
      }
      return { grantedCredentials, credentialAllowedOrigins };
    },
    substitute(text: string) {
      return text.replace(
        /\{\{mock:([a-z0-9][a-z0-9-]*)\.(baseUrl|credential)\}\}/g,
        (whole, id: string, field: string) => {
          const service = services.get(id);
          if (!service) return whole;
          return field === 'baseUrl' ? service.baseUrl : (service.credentialName ?? whole);
        },
      );
    },
    mcpToolsetFiles() {
      const files: Array<{ path: string; content: string }> = [];
      for (const mock of live) {
        if (mock.kind !== 'mcp') continue;
        const service = services.get(mock.id);
        if (!service) continue;
        const toolsetId = mockMcpToolsetId(mock.id);
        const shard = toolsetId.slice(0, 2).toLowerCase();
        const base = `toolsets/${shard}/${toolsetId}`;
        files.push({
          path: `${base}/manifest.json`,
          content: `${JSON.stringify(
            {
              schemaVersion: 1,
              kind: 'toolset',
              id: toolsetId,
              name: `Mock MCP: ${mock.id}`,
              description: mock.description,
              tags: ['eval-mock'],
              maintainer: { name: 'gezel eval harness' },
            },
            null,
            2,
          )}\n`,
        });
        files.push({
          path: `${base}/versions/1.0.0/manifest.json`,
          content: `${JSON.stringify(
            {
              schemaVersion: 1,
              version: '1.0.0',
              releasedAt: new Date().toISOString(),
              runtime: {
                kind: 'http-mcp',
                url: `${service.baseUrl}/mcp`,
                transport: 'streamable-http',
              },
              tools: mock.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
              })),
            },
            null,
            2,
          )}\n`,
        });
      }
      return files;
    },
    servicesMarkdown() {
      const lines = [
        '# Live mock services for this eval',
        '',
        'These fake services are REAL listening endpoints for this trial only —',
        'they log every request, and the work is graded on those logs. Reach the',
        'http services through the `http.authed` script capability using the',
        'named credential; never use real external services in this project.',
        '',
      ];
      const shims = mocks.filter(
        (mock): mock is Extract<MockService, { kind: 'cli' }> => mock.kind === 'cli',
      );
      if (shims.length > 0) {
        lines.push('## Ready-made probe scripts', '');
        for (const shim of shims) {
          const name = shim.shim.path.replace(/^scripts\//, '').replace(/\.(ts|mjs|js)$/, '');
          lines.push(`- \`${name}\` — ${shim.description}`);
          lines.push(`  Run it with \`run_script({ name: "${name}" })\`.`);
        }
        lines.push('');
      }
      for (const mock of live) {
        const service = services.get(mock.id)!;
        lines.push(`## ${mock.id} (${mock.kind})`, '', mock.description, '');
        lines.push(`- Base URL: ${service.baseUrl}`);
        if (service.credentialName) lines.push(`- Credential: \`${service.credentialName}\``);
        if (mock.kind === 'http') {
          lines.push('- Routes:');
          for (const route of mock.routes) {
            lines.push(`  - ${route.method ?? 'GET'} ${route.path} → ${route.status ?? 200}`);
          }
        } else if (mock.kind === 'mcp') {
          lines.push(`- Tools: ${mock.tools.map((tool) => `\`${tool.name}\``).join(', ')}`);
          for (const tool of mock.tools) {
            lines.push(`  - \`${tool.name}\` — ${tool.description}`);
          }
          lines.push(
            '- These surface as normal tools on your tool roster — just call them by name',
            '  like any other tool. No HTTP request or credential is needed.',
          );
        } else {
          lines.push(`- Receiver: POST ${mock.path ?? '/webhook'}`);
        }
        lines.push('');
      }
      return lines.join('\n');
    },
    servicesJson() {
      return `${JSON.stringify(
        [...services.values()].map((service) => {
          const spec = specById.get(service.id);
          return {
            id: service.id,
            kind: service.kind,
            baseUrl: service.baseUrl,
            credential: service.credentialName,
            ...(spec?.kind === 'http'
              ? {
                  routes: spec.routes.map((route) => ({
                    method: route.method ?? 'GET',
                    path: route.path,
                  })),
                }
              : {}),
            ...(spec?.kind === 'mcp'
              ? {
                  tools: spec.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                  })),
                  note: 'MCP tools — available directly on the tool roster; call them by name.',
                }
              : {}),
          };
        }),
        null,
        2,
      )}\n`;
    },
    async close() {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolvePromise) => {
              server.close(() => resolvePromise());
              server.closeAllConnections?.();
            }),
        ),
      );
    },
  };
}

/**
 * Grade a book's `success.mocks` request-log assertions. Only AUTHORIZED
 * requests count — a 401 probe is not "the model reached the service."
 * Returns human-actionable failure strings in the same voice as the file
 * gate checks so they merge into the scenario's failure list directly.
 */
export function evaluateMockExpectations(
  expectations: ReadonlyArray<{
    service: string;
    minRequests?: number;
    requiredPaths?: string[];
    forbiddenPaths?: string[];
    requiredTools?: string[];
  }>,
  runtime: Pick<MockServicesRuntime, 'services'>,
): string[] {
  const failures: string[] = [];
  for (const expectation of expectations) {
    const service = runtime.services.get(expectation.service);
    if (!service) {
      failures.push(`mock service "${expectation.service}" is not running`);
      continue;
    }
    const authorized = service.requests.filter((entry) => entry.authorized);
    // Failure text must steer toward the ACTION, not the report: a model
    // that only sees "signal missing" keeps editing prose (wild-caught,
    // ship pilot: 4 repair rounds of report rewrites, 0 requests). Name
    // the recovery path explicitly.
    const actionHint =
      'writing about it does not count — actually call the service (run the probe script listed in mocks/services.md via run_script, or use http.authed), then update the report from the response';
    if (expectation.minRequests !== undefined && authorized.length < expectation.minRequests) {
      failures.push(
        `mock ${expectation.service}: ${authorized.length}/${expectation.minRequests} authorized request(s) seen; ${actionHint}`,
      );
    }
    for (const pattern of expectation.requiredPaths ?? []) {
      const regex = new RegExp(pattern);
      if (!authorized.some((entry) => regex.test(entry.path))) {
        failures.push(
          `mock ${expectation.service}: no authorized request matched ${pattern}; ${actionHint}`,
        );
      }
    }
    for (const pattern of expectation.forbiddenPaths ?? []) {
      const regex = new RegExp(pattern);
      if (authorized.some((entry) => regex.test(entry.path))) {
        failures.push(`mock ${expectation.service}: forbidden path ${pattern} was requested`);
      }
    }
    // MCP tool assertions: exact-name match against the `tools/call:<name>`
    // entries the fake MCP host logs. Same steer-toward-the-action voice as
    // the http hints — the recovery is a tool call, not more prose.
    for (const name of expectation.requiredTools ?? []) {
      const wanted = `tools/call:${name}`;
      if (!authorized.some((entry) => entry.path === wanted)) {
        failures.push(
          `mock ${expectation.service}: MCP tool "${name}" was never called; writing about it does not count — "${name}" is on your tool roster, call it like any other tool and use its response in the deliverable`,
        );
      }
    }
  }
  return failures;
}

/**
 * Serve one request on a fake MCP service. Stateless Streamable-HTTP per
 * the SDK's documented pattern: every POST gets a fresh McpServer +
 * transport (`sessionIdGenerator: undefined`), so repeated `initialize`
 * round-trips from rebuilt chat-session bridges never trip the
 * "Server already initialized" guard a shared transport would raise.
 * GET/DELETE (SSE stream / session teardown) get the stateless 405.
 *
 * Only `tools/call` invocations land in the request log — initialize and
 * tools/list are transport chatter, and logging them would let a trial
 * satisfy `minRequests` without the model ever calling a tool.
 * Unauthenticated by design in v1 (`authorized: true` on every entry);
 * see the module doc for why the install rail is the boundary here.
 */
async function handleMcpMockRequest(
  mock: Extract<MockService, { kind: 'mcp' }>,
  started: StartedMockService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'stateless mock MCP accepts POST only' },
          id: null,
        }),
      );
      return;
    }
    const server = new McpServer({ name: `mock-mcp-${mock.id}`, version: '1.0.0' });
    for (const tool of mock.tools) {
      // No inputSchema: the SDK skips argument validation entirely, so a
      // model may pass any args (e.g. `ack_alert({id})`) without a
      // rejection — the mock ignores them and serves the template.
      server.registerTool(tool.name, { description: tool.description }, async () => {
        started.requests.push({
          at: new Date().toISOString(),
          method: 'POST',
          path: `tools/call:${tool.name}`,
          matchedRoute: `tools/call ${tool.name}`,
          status: 200,
          authorized: true,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(tool.resultTemplate ?? { ok: true }) }],
        };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          id: null,
        }),
      );
    } else {
      res.end();
    }
  }
}

/** Exact, `:param`-segment, or trailing-`*` path matching. */
export function pathMatches(pattern: string, actual: string): boolean {
  if (pattern === actual) return true;
  const patternParts = pattern.split('/').filter((part) => part.length > 0);
  const actualParts = actual.split('/').filter((part) => part.length > 0);
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i]!;
    if (part === '*') return true;
    const actualPart = actualParts[i];
    if (actualPart === undefined) return false;
    if (part.startsWith(':')) continue;
    if (part !== actualPart) return false;
  }
  return patternParts.length === actualParts.length;
}
