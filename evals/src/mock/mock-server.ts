import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:https';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { CraftbookTestSpec, MockService } from '@bendyline/gezel';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import selfsigned from 'selfsigned';
import { z } from 'zod';

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
  /** Request media type as received by the fixture (webhook requests only). */
  contentType?: string;
  /** Bounded request bytes decoded as UTF-8 (webhook requests only). */
  requestBody?: string;
  requestBodyTruncated?: boolean;
  /** Validated arguments from an MCP tools/call request. */
  toolArgs?: Record<string, unknown>;
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
export function mockMcpToolsetId(serviceId: string, explicitId?: string): string {
  return explicitId ?? `mock-mcp-${serviceId}`;
}

/**
 * System toolset ids (for example `@playwright/mcp`) are valid installed
 * runtime ids but intentionally invalid local-catalog identity ids. The eval
 * runner seeds those records directly into the fresh trial home's system
 * roster; ordinary mock ids still install through LocalCatalogSource.
 */
const LOCAL_CATALOG_TOOLSET_ID = /^[a-z0-9][a-z0-9.\-:]{1,63}$/;

export function mockMcpUsesSystemSeed(serviceId: string, explicitId?: string): boolean {
  return !LOCAL_CATALOG_TOOLSET_ID.test(mockMcpToolsetId(serviceId, explicitId));
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
   * Toolset seed files for `kind:'mcp'` services, relative to the trial's
   * GEZEL_HOME. Catalog-valid ids get ordinary local-catalog manifests;
   * scoped system ids are written into `installed-toolsets-system.json`.
   */
  mcpToolsetFiles(): Array<{ path: string; content: string }>;
  /** Bind deterministic MCP file effects to the scenario's project. */
  bindProject(projectId: string): void;
  close(): Promise<void>;
}

/**
 * Small eval-only argument vocabulary for fake MCP tools.
 *
 * `MockService` intentionally stays a catalog-owned, dependency-light wire
 * schema. Tool-routing evals may layer these required/optional string fields
 * over it so the simulator advertises realistic affordances without adding
 * test-only Zod shapes to the product catalog contract.
 */
export type MockMcpToolArgumentSchemas = Record<
  string,
  Record<
    string,
    Record<
      string,
      {
        description?: string;
        /** Defaults to true. */
        required?: boolean;
      }
    >
  >
>;

export async function startMockServices(
  mocks: CraftbookTestSpec['mocks'],
  opts: {
    trialHome?: string;
    mcpToolArgumentSchemas?: MockMcpToolArgumentSchemas;
  } = {},
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
  let boundProjectId: string | null = null;

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
        void handleMcpMockRequest(mock, started, req, res, {
          trialHome: opts.trialHome,
          projectId: boundProjectId,
          toolArgumentSchemas: opts.mcpToolArgumentSchemas?.[mock.id],
        });
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
        // Retain bounded request evidence so an eval cannot pass merely by
        // reaching the right path with an empty or wrongly-typed POST. This
        // is a per-trial fake endpoint; the capture is written only into the
        // trial run directory. Keep the cap defensive in case a broken model
        // sends an unexpectedly large payload.
        const maxLoggedBytes = 64 * 1024;
        const chunks: Buffer[] = [];
        let keptBytes = 0;
        req.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = maxLoggedBytes - keptBytes;
          if (remaining > 0) {
            const kept = bytes.subarray(0, remaining);
            chunks.push(kept);
            keptBytes += kept.length;
          }
          if (bytes.length > remaining) entry.requestBodyTruncated = true;
        });
        req.on('end', () => {
          const rawContentType = req.headers['content-type'];
          const contentType = Array.isArray(rawContentType)
            ? rawContentType.join(', ')
            : rawContentType;
          if (contentType !== undefined) entry.contentType = contentType;
          entry.requestBody = Buffer.concat(chunks).toString('utf8');
          finish(200, {}, JSON.stringify({ ok: true }));
        });
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
      const systemInstalled: Array<Record<string, unknown>> = [];
      for (const mock of live) {
        if (mock.kind !== 'mcp') continue;
        const service = services.get(mock.id);
        if (!service) continue;
        const toolsetId = mockMcpToolsetId(mock.id, mock.toolsetId);
        if (mockMcpUsesSystemSeed(mock.id, mock.toolsetId)) {
          systemInstalled.push({
            toolsetId,
            sourceId: 'eval-mock',
            version: '1.0.0',
            installedAt: new Date().toISOString(),
            runtime: {
              kind: 'http-mcp',
              url: `${service.baseUrl}/mcp`,
              transport: 'streamable-http',
              authHint: 'none',
              envHints: [],
            },
          });
          continue;
        }
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
      if (systemInstalled.length > 0) {
        files.push({
          path: 'installed-toolsets-system.json',
          content: `${JSON.stringify(systemInstalled, null, 2)}\n`,
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
          lines.push(`  Run it with \`run_installed_script({ name: "${name}" })\`.`);
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
    bindProject(projectId: string) {
      boundProjectId = projectId;
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
    toolCalls?: Record<string, { minCalls: number; maxCalls?: number }>;
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
      'writing about it does not count — actually call the service (run the probe script listed in mocks/services.md via run_installed_script, or use http.authed), then update the report from the response';
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
    for (const [name, budget] of Object.entries(expectation.toolCalls ?? {})) {
      const wanted = `tools/call:${name}`;
      const calls = authorized.filter((entry) => entry.path === wanted).length;
      if (calls < budget.minCalls) {
        failures.push(
          `mock ${expectation.service}: MCP tool "${name}" was called ${calls}/${budget.minCalls} required time(s); perform the missing journey or retry with the real tool`,
        );
      }
      if (budget.maxCalls !== undefined && calls > budget.maxCalls) {
        failures.push(
          `mock ${expectation.service}: MCP tool "${name}" was called ${calls} time(s); expected at most ${budget.maxCalls}`,
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
  fixtureContext: {
    trialHome?: string;
    projectId: string | null;
    toolArgumentSchemas?: MockMcpToolArgumentSchemas[string];
  },
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
      // Tools WITHOUT a file effect or an explicit eval argument declaration
      // stay schema-less on purpose: the SDK then skips argument validation,
      // so a model may pass anything (e.g. `ack_alert({id})`) without a
      // rejection and the mock serves the template regardless.
      //
      // A tool that MATERIALIZES A FILE cannot afford that. Wild-caught on
      // the first two live runs of research-to-document: with no schema the
      // model first guessed `destinationPath` against a spec expecting
      // `destination.path`, then called `save_artifact` with NO arguments
      // at all. Both times the call logged (satisfying `requiredTools`),
      // the write found no path, and the trial failed on a missing document
      // while every provenance check passed. The model was not being
      // careless — nothing told it the argument existed.
      //
      // File-effect schema is DERIVED from the same `pathArgument` the
      // fixture reads. Explicit declarations are a separate eval-only layer
      // for external-tool affordances such as browser_navigate({url}).
      const declaredInputSchema = declaredMockToolInputSchema(
        fixtureContext.toolArgumentSchemas?.[tool.name],
      );
      const wellKnownSchema =
        WELL_KNOWN_TOOLSET_TOOL_SCHEMAS[mockMcpToolsetId(mock.id, mock.toolsetId)]?.[tool.name] ??
        {};
      const inputSchema = {
        ...declaredInputSchema,
        ...wellKnownSchema,
        ...(tool.writeFixture ? fixturePathSchema(tool.writeFixture.pathArgument) : {}),
      };
      const config = {
        description: tool.description,
        ...(Object.keys(inputSchema).length > 0 ? { inputSchema } : {}),
      };
      server.registerTool(tool.name, config, async (args) => {
        const callPath = `tools/call:${tool.name}`;
        const callIndex = started.requests.filter((entry) => entry.path === callPath).length;
        started.requests.push({
          at: new Date().toISOString(),
          method: 'POST',
          path: callPath,
          matchedRoute: `tools/call ${tool.name}`,
          status: 200,
          authorized: true,
          toolArgs: { ...args },
        });
        if (tool.writeFixture) {
          await materializeMockToolFixture(tool.writeFixture, args, fixtureContext);
        }
        const sequenced =
          tool.resultSequence?.[Math.min(callIndex, Math.max(0, tool.resultSequence.length - 1))];
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sequenced ?? tool.resultTemplate ?? { ok: true }),
            },
          ],
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

function declaredMockToolInputSchema(
  fields: MockMcpToolArgumentSchemas[string][string] | undefined,
): Record<string, z.ZodTypeAny> {
  if (!fields) return {};
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => {
      let schema = z.string().min(1);
      if (field.description) schema = schema.describe(field.description);
      return [name, field.required === false ? schema.optional() : schema];
    }),
  );
}

/**
 * Argument schemas for mock tools that impersonate a REAL first-party
 * toolset, keyed by toolset id then tool name.
 *
 * A mock without a schema is deliberately permissive — but when the tool
 * being faked is a product tool with required structured arguments, that
 * permissiveness rewards precisely the calls the product would reject.
 * Wild-caught on the 2026-08-22 scorecard sweep and its follow-up e2e
 * (craftbook-powerpoint-deck, every model 0/3): models called
 * `convert_document` with NO arguments (bridge log: `call_tool
 * convert_document keys=`), the schema-less mock answered the canned
 * success template, and the trial "converted" nothing while every
 * DocBlocks provenance check lit up green. The model was not careless —
 * nothing advertised that `source`/`targets` existed, and nothing
 * rejected their absence.
 *
 * Shapes mirror ../docblocks/packages/core/src/mcp/zod.ts (the runtime
 * truth), including the lenient convenience forms the product accepts
 * (a plain string `source` path; a bare-string or string-array
 * `targets`). Registering them makes the MCP SDK both ADVERTISE the
 * arguments and VALIDATE calls, so an empty call becomes a learnable
 * error instead of a fake success. Keep in sync with DocBlocks — an
 * over-strict drift here fails honest calls, an over-loose one hides
 * broken ones.
 */
const docblocksDocumentSource = z
  .union([
    z
      .string()
      .min(1)
      .describe(
        'Path to the source document, workspace-root-relative (e.g. "powerpoint/eval/deck.md").',
      ),
    z
      .object({
        kind: z.literal('file'),
        rootId: z.string().min(1).optional(),
        path: z.string().min(1),
        format: z.string().nullable().optional(),
      })
      .passthrough(),
    z
      .object({
        kind: z.literal('markdown'),
        markdown: z.string().min(1),
        name: z.string().nullable().optional(),
      })
      .passthrough(),
    z.object({ kind: z.literal('artifact'), uri: z.string().min(1) }).passthrough(),
  ])
  .describe(
    'The document to operate on: a workspace-relative path string, or a structured source ({kind:"file",path}, {kind:"markdown",markdown}, {kind:"artifact",uri}).',
  );

const docblocksTargets = z
  .union([
    z.string().min(1),
    z
      .array(z.union([z.string().min(1), z.object({ format: z.string().min(1) }).passthrough()]))
      .min(1),
  ])
  .describe('Output format(s), e.g. "pptx" or [{"format":"pptx"}].');

const WELL_KNOWN_TOOLSET_TOOL_SCHEMAS: Record<
  string,
  Record<string, Record<string, z.ZodTypeAny>>
> = {
  docblocks: {
    convert_document: {
      source: docblocksDocumentSource,
      targets: docblocksTargets,
      themeId: z.string().min(1).optional().describe('Optional exact theme id.'),
      title: z.string().optional(),
    },
    preview_document: {
      source: docblocksDocumentSource,
      startIndex: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().min(1).max(20).optional(),
    },
    save_artifact: {
      // artifactUri stays optional here although the product requires it:
      // the fixture write keys off destination.path alone, and existing
      // scenarios pass with destination-only calls. Advertising it teaches
      // the convert -> save handoff without failing those calls.
      artifactUri: z
        .string()
        .min(1)
        .optional()
        .describe('URI of the converted artifact returned by convert_document.'),
    },
  },
};

function valueAtPath(value: unknown, dottedPath: string): unknown {
  let current = value;
  for (const part of dottedPath.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Build the input schema a file-materializing tool advertises, from the
 * dotted `pathArgument` its fixture reads.
 *
 * `destination.path` → `{ destination: { path: string } }`
 * `destinationPath`  → `{ destinationPath: string }`
 *
 * The description matters as much as the shape: it is what a model reads
 * when deciding what to put there.
 */
function fixturePathSchema(pathArgument: string): Record<string, z.ZodTypeAny> {
  const parts = pathArgument.split('.').filter(Boolean);
  const leaf = z
    .string()
    .min(1)
    .describe('Destination path for the saved file, relative to the target root.');
  if (parts.length <= 1) return { [parts[0] ?? 'path']: leaf };
  let current: z.ZodTypeAny = leaf;
  for (let index = parts.length - 1; index >= 1; index--) {
    current = z.object({ [parts[index]!]: current });
  }
  return { [parts[0]!]: current };
}

/**
 * Resolve the destination path from a tool call whose argument SHAPE was
 * never declared.
 *
 * Mock MCP tools register without an `inputSchema` (see the note in
 * `handleMcpMockRequest`), so a model has nothing telling it whether the
 * argument is `destination.path`, `destinationPath`, or plain `path`. It
 * guesses — and a spec that pins exactly one spelling turns that guess into
 * a silent failure: the tool call is logged (satisfying `requiredTools`),
 * the fixture write throws, and no file appears. Wild-caught on the first
 * live run of research-to-document: the model sent `destinationPath`, the
 * spec declared `destination.path`, and the trial failed on a missing DOCX
 * while every provenance check passed.
 *
 * The declared `pathArgument` stays authoritative; these are fallbacks so a
 * reasonable guess still lands the file. `powerpoint-deck` carries the same
 * unvalidated `destination.path` and is fixed by the same tolerance.
 */
function resolveFixturePath(args: unknown, declared: string): string | null {
  const camel = declared.replace(/\.([a-z])/gi, (_, c: string) => c.toUpperCase());
  const last = declared.split('.').pop() ?? declared;
  const candidates = [declared, camel, last, 'destinationPath', 'destination.path', 'path'];
  for (const candidate of candidates) {
    const value = valueAtPath(args, candidate);
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/** Fixture id → the bytes it materializes. */
const MOCK_FIXTURE_BYTES: Readonly<Record<MockToolFixture, () => Uint8Array>> = {
  'minimal-pptx': () => minimalPptxFixture(),
  'minimal-docx': () => minimalDocxFixture(),
  'minimal-pdf': () => minimalPdfFixture(),
  'minimal-png': () => minimalPngFixture(),
};

export type MockToolFixture = 'minimal-pptx' | 'minimal-docx' | 'minimal-pdf' | 'minimal-png';

/**
 * Materialize a deterministic fixture through the trial project's real file
 * surfaces.
 *
 * `effect.fixture` used to be read from the spec and then ignored — every
 * effect wrote a PPTX regardless. That was invisible while `minimal-pptx`
 * was the only value, and would have silently written a presentation to a
 * `.docx` path the moment a second fixture existed. Dispatch on it.
 */
export async function materializeMockToolFixture(
  effect: {
    surface: 'workspace' | 'artifact';
    pathArgument: string;
    fixture: MockToolFixture;
  },
  args: unknown,
  context: { trialHome?: string; projectId: string | null },
): Promise<void> {
  if (!context.trialHome || !context.projectId) {
    throw new Error('mock MCP file effect has no bound trial project');
  }
  const rawPath = resolveFixturePath(args, effect.pathArgument);
  if (rawPath === null) {
    throw new Error(
      `mock MCP file effect could not resolve a destination path from ${JSON.stringify(args)} ` +
        `(declared ${effect.pathArgument})`,
    );
  }
  const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.split('/').includes('..')) {
    throw new Error('mock MCP file effect path must stay inside the project');
  }
  const bytes = MOCK_FIXTURE_BYTES[effect.fixture];
  if (!bytes) throw new Error(`unknown mock MCP fixture "${effect.fixture}"`);
  const drawer = effect.surface === 'artifact' ? 'artifacts' : 'workspace';
  const target = join(context.trialHome, 'projects', context.projectId, drawer, normalized);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes());
}

/** Deterministic valid 1×1 PNG padded beyond the image-gate byte floor. */
export function minimalPngFixture(): Uint8Array {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  return Buffer.concat([png, Buffer.alloc(2_048)]);
}

/** Small deterministic ZIP-shaped Open XML presentation used only by eval mocks. */
export function minimalPptxFixture(): Uint8Array {
  const files: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    ],
    [
      'ppt/presentation.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    ],
    [
      'ppt/_rels/presentation.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ],
    [
      'ppt/slides/slide1.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Deterministic DocBlocks eval deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
    ],
  ];
  return zipStored(files);
}

/** Small deterministic ZIP-shaped Open XML word document used only by eval mocks. */
export function minimalDocxFixture(): Uint8Array {
  const files: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Deterministic DocBlocks eval document</w:t></w:r></w:p><w:p><w:r><w:t>Converted from the approved Markdown source.</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
    ],
    [
      'word/_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    ],
  ];
  return zipStored(files);
}

/**
 * Smallest structurally valid PDF used only by eval mocks: header, four
 * objects, xref table, trailer. Byte offsets in the xref are computed rather
 * than hardcoded so edits to the object bodies can't silently desync it.
 */
export function minimalPdfFixture(): Uint8Array {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 60 >>\nstream\nBT /F1 12 Tf 72 720 Td (DocBlocks eval report) Tj ET\nendstream\nendobj\n',
  ];
  const header = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = [];
  let body = '';
  for (const object of objects) {
    offsets.push(header.length + body.length);
    body += object;
  }
  const xrefStart = header.length + body.length;
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefStart),
    '%%EOF\n',
  ].join('\n');
  // latin1 so the binary comment bytes in the header stay single-byte.
  return Uint8Array.from(`${header}${body}${xref}`, (char) => char.charCodeAt(0) & 0xff);
}

function zipStored(files: Array<[string, string]>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, entry) => sum + entry.length, 0);
  const out = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const entry of locals) {
    out.set(entry, cursor);
    cursor += entry.length;
  }
  for (const entry of centrals) {
    out.set(entry, cursor);
    cursor += entry.length;
  }
  const end = new DataView(out.buffer, cursor, 22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return out;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
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
