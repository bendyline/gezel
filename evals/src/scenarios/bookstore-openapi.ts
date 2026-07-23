import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile as fsWriteFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { load as parseYaml } from 'js-yaml';
import { postMissingDeliverableFeedback, postSniffFeedback } from '../sniff-feedback.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { spawnAndAwait } from './helpers.ts';

/**
 * Bookstore OpenAPI — structured-output validation under three runtime gates.
 *
 * The model writes:
 *   1. openapi.yaml          — OpenAPI 3.1 spec, 6 endpoints, bearer auth on mutations
 *   2. server.mjs            — Node http stub implementing 3 read endpoints
 *   3. contract-test.mjs     — Node script that starts the server and checks the spec
 *   4. README.md             — usage notes
 *
 * Pass gates (all must fire):
 *   - YAML parses
 *   - OpenAPI 3.1 shape (top-level `openapi: 3.1.x`)
 *   - All 6 paths present with the right verbs
 *   - Required component schemas present (Book, Author, Error, Pagination)
 *   - Bearer auth referenced on POST / PATCH / DELETE
 *   - `node server.mjs` boots and binds a port within 5 s
 *   - `node contract-test.mjs` exits 0
 *
 * Deliberately skips a hosted spec linter (`@redocly/cli`) to keep the
 * eval offline. The structural checks above + the live contract test
 * cover the same ground for the eval purposes: a model can't talk its
 * way out of a 6-endpoint object structure, and the contract test
 * verifies the schemas it wrote actually match the responses it
 * implements.
 */

const PROJECT_NAME = 'Bookstore API';
const DEVELOPER_NAME = 'Sam';

const REQUIRED_PATHS: ReadonlyArray<{ path: string; methods: readonly string[] }> = [
  { path: '/books', methods: ['get', 'post'] },
  { path: '/books/{id}', methods: ['get', 'patch', 'delete'] },
  { path: '/authors/{id}/books', methods: ['get'] },
];
const REQUIRED_SCHEMAS = ['Book', 'Author', 'Error', 'Pagination'] as const;
const MUTATION_METHODS = new Set(['post', 'patch', 'delete']);

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function readWorkspaceText(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

/**
 * Find a file by basename anywhere in the project workspace tree.
 * Wild-caught qwen3.6 bookstore trial: the model wrote
 * `workspace/Bookstore API/openapi.yaml` (treating "workspace/" as a
 * literal subdir of the project workspace), and our path-anchored
 * sniff scanning at the project root saw nothing. Walk the tree to
 * accept the deliverable wherever the model decided to put it.
 *
 * Same trap surfaced on super-120b's petshop run. Both
 * scenarios need this path-tolerant lookup — the anchored-scenario
 * rule is about content gates, NOT about where the model files end
 * up on disk.
 */
async function findFileText(
  client: GezelClient,
  projectId: string,
  basename: string,
): Promise<{ text: string; path: string } | null> {
  try {
    const list = await client.listProjectWorkspace(projectId, undefined, true);
    const target = basename.toLowerCase();
    const hit = list.files.find(
      (f) =>
        !f.isDirectory &&
        (f.path.toLowerCase() === target || f.path.toLowerCase().endsWith(`/${target}`)),
    );
    if (!hit) return null;
    const blob = await client.fetchProjectWorkspaceBlob(projectId, hit.path);
    return { text: await blob.text(), path: hit.path };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Single-source spec facts. These exact strings appear in BOTH the
// project missionObjectives and the developer kickoff message — they
// used to be hand-duplicated prose and drifted (the `year` vs
// `publishedYear` class of bug). Change them here, never inline.

export const SPEC_PAGINATION_ENVELOPE =
  '`{ data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }`';
export const SPEC_BOOK_FIELDS = 'id, title, authorId, publishedYear, isbn';
export const SPEC_PORT_CONTRACT =
  'server.mjs reads PORT from process.env.PORT (default 0 to bind any free port) and logs the ' +
  'bound port to stdout as `listening on PORT=NNNN` (the actual assigned port from ' +
  '`server.address().port` inside the listen callback)';

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Design a tiny REST API for an online bookstore. Deliverables: openapi.yaml ' +
        '(OpenAPI 3.1, 6 endpoints), server.mjs (Node http stub for the 3 GET endpoints), ' +
        'contract-test.mjs (dependency-free Node script that validates the server against the spec), README.md.',
      missionObjectives: [
        '1. Write openapi.yaml — OpenAPI 3.1 with paths GET/POST /books, GET/PATCH/DELETE /books/{id}, GET /authors/{id}/books.',
        '2. Define components.schemas Book, Author, Error, Pagination, and securitySchemes.bearerAuth.',
        '3. Reference bearerAuth on POST/PATCH/DELETE (write-side endpoints).',
        `   Pagination is exactly ${SPEC_PAGINATION_ENVELOPE}.`,
        '   Both GET /books and GET /authors/{id}/books must return that same Pagination envelope.',
        `   Book objects use exactly these fields everywhere: ${SPEC_BOOK_FIELDS}. Do not use \`year\`.`,
        '4. Write server.mjs — plain `node:http` server (no Express, no deps) implementing the 3 GET endpoints against a hardcoded dataset of 5 books across 3 authors.',
        '5. Write contract-test.mjs — start server.mjs, hit each GET endpoint, validate responses against the spec.',
        '   contract-test.mjs must only call GET endpoints at runtime; POST/PATCH/DELETE are OpenAPI auth-reference checks, not server runtime checks.',
        '   Keep pagination assertions shape-focused: validate data[], pagination.limit, cursor, total, and hasMore types. Do not hard-code exact hasMore/cursor values for a specific page unless the server logic makes that page final.',
        '6. Write README.md — usage notes for running the server + the contract test.',
        '   contract-test.mjs must use built-in global fetch; do NOT import undici, node-fetch, axios, or any npm package.',
        `7. \`node server.mjs\` must bind a port (${SPEC_PORT_CONTRACT}); \`node contract-test.mjs\` must exit 0.`,
        'No task ref is needed for this work. The deliverables are fully specified here and in this project brief.',
      ].join(' '),
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('bookstore-openapi setup: failed to resolve project id');

  let sam: { id: string };
  try {
    // No hand-written about: the service resolves the shipped Developer
    // template (product-shaped prompt). The API spec lives in the
    // project's missionObjectives and the kickoff message below. The old
    // about had accumulated ~4 KB of trap-avoidance coaching (spawn stdio
    // arrays, YAML-import warnings) from past failures — that coaching
    // was harness overfitting and is deliberately dropped; the runtime
    // contract feedback is the product-shaped way those mistakes surface.
    const created = await client.createGezel({
      name: DEVELOPER_NAME,
      role: 'Developer',
    });
    sam = { id: created.id };
    log(`[scenario:setup] created developer "${DEVELOPER_NAME}" id=${sam.id}`);
  } catch (err) {
    const { gezels } = await client.listGezels();
    const existing = gezels.find((g) => g.name === DEVELOPER_NAME);
    if (!existing) throw err;
    sam = { id: existing.id };
    log(`[scenario:setup] reusing developer "${DEVELOPER_NAME}" id=${sam.id}`);
  }
  await client.addGezelToProject(projectId, sam.id);
  log(`[scenario:setup] joined ${DEVELOPER_NAME} to project ${projectId}`);

  await client.sendChatMessage(sam.id, {
    message: [
      "Please design the Bookstore API. Read the project's missionObjectives for the",
      'full deliverable list if needed, but do not ask for a task ref or wait for one:',
      'this kickoff message contains the complete deliverable list. Start with openapi.yaml (path it at the workspace root,',
      'just `openapi.yaml`), then server.mjs, then contract-test.mjs, then README.md.',
      'Your first assistant action MUST be a `writeFile` tool call for `openapi.yaml`; do not draft YAML, JavaScript, or README content in chat.',
      'For each deliverable, write the file with `writeFile` or `replaceInFile` first, then use chat only for a short status note.',
      'openapi.yaml must document ALL SIX paths — GET and POST /books, GET/PATCH/DELETE',
      '/books/{id}, and GET /authors/{id}/books — even though server.mjs implements only',
      'the three GET endpoints; the write-side paths exist in the spec with bearerAuth',
      'references. Do not drop POST/PATCH/DELETE from the spec. components.schemas must',
      'define ALL FOUR schemas — Book, Author, Error, AND Pagination — plus',
      'securitySchemes.bearerAuth; do not stop after Book.',
      'Only those four workspace files count; do not create script.js, temp.js,',
      'Node.js, or other scratch files.',
      'Keep contract-test.mjs dependency-free: use Node global fetch; do not import undici.',
      'In server.mjs, log `server.address().port` after listen; in contract-test.mjs,',
      'parse the port from stdout data immediately, not from the stdout end event.',
      'Validate as you go — once contract-test.mjs exits 0 against your server.mjs',
      "you're done.",
      'The contract test should call only GET /books, GET /books/{id}, and',
      'GET /authors/{id}/books plus GET-based 404 checks. Do not call',
      'POST/PATCH/DELETE in contract-test.mjs.',
      'Keep pagination tests shape-focused: check `hasMore` is boolean and `cursor`',
      'is string or null. Do not fail solely because a non-final page has',
      '`hasMore: true`.',
      `Book objects use exactly these fields everywhere: ${SPEC_BOOK_FIELDS} — in openapi.yaml, server.mjs, and contract-test.mjs; do not mix \`publishedYear\` with \`year\`.`,
      'Do not run contract-test.mjs through `run_nodejs_script`; it spawns server.mjs and that MCP tool is sandboxed against child processes. The scenario checker will run `node contract-test.mjs` directly.',
      'Do not call process.exit() anywhere in contract-test.mjs; use process.exitCode',
      'after cleanup instead.',
      'For runtime behavior, unknown `/books/{id}` and unknown `/authors/{id}/books`',
      'requests should return 404 JSON errors shaped as `{ code: 404, message: "..." }`.',
      'Author ids are numeric: Book references Author by `authorId` (number), and',
      '`/authors/{id}/books` takes the numeric author id as its path parameter.',
      `Port contract: ${SPEC_PORT_CONTRACT} so the contract test can discover it.`,
    ].join(' '),
    projectId,
  });
  log(`[scenario:setup] sent kickoff message to ${DEVELOPER_NAME} in project ${projectId}`);
}

interface OpenApiCheck {
  yamlParses: boolean;
  is31: boolean;
  pathsPresent: boolean;
  schemasPresent: boolean;
  authOnMutations: boolean;
  missingPaths: string[];
  misplacedMethods: string[];
  missingSchemas: string[];
  missingAuthMethods: string[];
  parseError?: string;
}

export function checkOpenApi(yaml: string): OpenApiCheck {
  const out: OpenApiCheck = {
    yamlParses: false,
    is31: false,
    pathsPresent: false,
    schemasPresent: false,
    authOnMutations: false,
    missingPaths: [],
    misplacedMethods: [],
    missingSchemas: [],
    missingAuthMethods: [],
  };
  let doc: Record<string, unknown> | null = null;
  try {
    doc = parseYaml(yaml) as Record<string, unknown> | null;
    out.yamlParses = doc !== null && typeof doc === 'object';
  } catch (err) {
    out.parseError = err instanceof Error ? err.message.slice(0, 200) : String(err);
    return out;
  }
  if (!out.yamlParses || !doc) return out;

  const openapi = String(doc.openapi ?? '');
  out.is31 = /^3\.1(\.|$)/.test(openapi);

  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const required of REQUIRED_PATHS) {
    const node = paths[required.path];
    if (!node || typeof node !== 'object') {
      out.missingPaths.push(required.path);
      continue;
    }
    for (const method of required.methods) {
      if (!(method in node)) {
        out.missingPaths.push(`${required.path}#${method.toUpperCase()}`);
        const misplacedPath = Object.entries(paths).find(([candidatePath, candidateNode]) => {
          if (candidatePath === required.path) return false;
          if (!candidatePath.startsWith(`${required.path}/`)) return false;
          return !!candidateNode && typeof candidateNode === 'object' && method in candidateNode;
        })?.[0];
        if (misplacedPath) {
          out.misplacedMethods.push(
            `${method.toUpperCase()} belongs on ${required.path}, not ${misplacedPath}`,
          );
        }
      }
    }
  }
  out.pathsPresent = out.missingPaths.length === 0;

  const components = (doc.components ?? {}) as Record<string, unknown>;
  const schemas = (components.schemas ?? {}) as Record<string, unknown>;
  for (const schema of REQUIRED_SCHEMAS) {
    if (!(schema in schemas)) out.missingSchemas.push(schema);
  }
  out.schemasPresent = out.missingSchemas.length === 0;

  // securitySchemes.bearerAuth (top-level component) — and *some*
  // reference that covers each mutation method. We accept OpenAPI's
  // root-level global security, path-level security, or method-level
  // security; tolerant on the exact key (`bearerAuth` is conventional).
  const securitySchemes = (components.securitySchemes ?? {}) as Record<string, unknown>;
  const hasBearerScheme = 'bearerAuth' in securitySchemes;
  const rootSecurity = doc.security as Array<Record<string, unknown>> | undefined;
  if (hasBearerScheme) {
    for (const required of REQUIRED_PATHS) {
      const node = paths[required.path];
      if (!node) continue;
      for (const method of required.methods) {
        if (!MUTATION_METHODS.has(method)) continue;
        const op = node[method] as Record<string, unknown> | undefined;
        if (!op) continue;
        const opSecurity = op.security as Array<Record<string, unknown>> | undefined;
        const pathSecurity = (node as Record<string, unknown>).security as
          | Array<Record<string, unknown>>
          | undefined;
        const referencesBearer = [
          ...(opSecurity ?? []),
          ...(pathSecurity ?? []),
          ...(rootSecurity ?? []),
        ].some((s) => s && typeof s === 'object' && 'bearerAuth' in s);
        if (!referencesBearer) {
          out.missingAuthMethods.push(`${method.toUpperCase()} ${required.path}`);
        }
      }
    }
    out.authOnMutations = out.missingAuthMethods.length === 0;
  } else {
    out.missingAuthMethods.push('securitySchemes.bearerAuth missing');
  }
  return out;
}

// Materialize the model's deliverables into a temp dir + run the
// contract-test (which owns its own server lifecycle). Cached by
// content-hash to avoid re-spawning on every 5 s poll when nothing
// changed.
//
// Earlier design pre-spawned server.mjs from the sniff and passed PORT
// into contract-test.mjs — but contract-test.mjs internally spawns
// server.mjs itself with the same env, so the two server processes
// raced for the same port. Wild-caught qwen3.6 trial:
// EADDRINUSE :::39263 in contract-test stdout because both servers
// inherited PORT=39263 from the sniff. Letting contract-test own the
// whole server lifecycle is simpler and avoids the collision.
const runCache = new WeakMap<EvalContext, { hash: string; contractOk: boolean; reason?: string }>();

export function formatContractFailure(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string {
  const combined = `${stdout}\n${stderr}`;
  if (
    exitCode === null &&
    /Starting Bookstore API Server|bookstore api server|server/i.test(stdout) &&
    !/Server started successfully|tests? passed|contract.*passed/i.test(stdout)
  ) {
    return `contract-test exit ${exitCode}: timed out before completing the server-port handshake. If contract-test.mjs waits for server.stdout 'end', change it to parse /PORT=(\\d+)/ inside the stdout 'data' handler and resolve immediately; server stdout stays open while the server runs. Also make server.mjs log the actual assigned port from server.address().port, not the literal PORT variable when PORT=0.`;
  }
  if (
    /ERR_MODULE_NOT_FOUND|Cannot find package|from ['"](?:undici|node-fetch|axios)['"]|from "(?:undici|node-fetch|axios)"/is.test(
      combined,
    )
  ) {
    const dep =
      /(?:package ['"]|from ['"])(undici|node-fetch|axios)/i.exec(combined)?.[1] ?? 'fetch package';
    return `contract-test exit ${exitCode}: contract-test.mjs imports ${dep}, but the eval runs it without installed npm dependencies. Remove that import and use Node's built-in global fetch.`;
  }
  if (
    /openapi\.ya?ml:\d+|openapi:\s*3\.1\.0|SyntaxError:\s*Unexpected number/is.test(combined) &&
    /SyntaxError|Unexpected number/is.test(combined)
  ) {
    return `contract-test exit ${exitCode}: contract-test.mjs is loading openapi.yaml as JavaScript. Plain Node cannot require/import YAML without a loader or npm dependency. Remove the YAML import/require and embed the needed OpenAPI schemas as a JS object literal inside contract-test.mjs, or only read the YAML as text with built-in fs.`;
  }
  if (/SyntaxError:\s*Illegal return statement/i.test(combined)) {
    return `contract-test exit ${exitCode}: contract-test.mjs contains a top-level return statement, which is illegal in an ES module. Patch contract-test.mjs directly: replace any top-level \`return;\` failure branch with \`throw new Error("could not detect server port")\` or set process.exitCode and let control reach the final cleanup block. Do not rewrite server.mjs for this syntax error.`;
  }
  if (exitCode !== 0 && /\ball contract tests passed\b/i.test(stdout)) {
    return `contract-test exit ${exitCode}: contract-test.mjs printed that all contract tests passed, but the process exited nonzero during cleanup. Do not call process.exit() immediately after server.kill(); await the spawned server close/exit event, set process.exitCode to 0 on pass or 1 on failure, and let the async function return.`;
  }
  if (exitCode === null && combined.trim() === '') {
    return `contract-test exit ${exitCode}: timed out with no output. This usually means contract-test.mjs either never resolved the PORT stdout data handler or passed its assertions then hung during cleanup. Parse /PORT=(\\d+)/ inside the stdout 'data' handler, and create the child close/exit promise before calling server.kill(): const closed = once(server, "close"); server.kill(); await closed.`;
  }
  if (
    /Failed to determine server port within timeout|PORT_TO_TEST|harness provides the port/i.test(
      combined,
    )
  ) {
    return `contract-test exit ${exitCode}: contract-test.mjs waits for a harness-provided port instead of spawning server.mjs. This eval runs \`node contract-test.mjs\` directly with no PORT_TO_TEST. Restore the required flow: import spawn from node:child_process, spawn \`node server.mjs\`, parse /PORT=(\\d+)/ from server.stdout data, await that port, run fetches, then kill and await the child in cleanup.`;
  }
  if (
    /Assuming server is running|ASSUMED_PORT|TEST_PORT|known port|Could not connect to server or run tests:\s*fetch failed/i.test(
      combined,
    )
  ) {
    return `contract-test exit ${exitCode}: contract-test.mjs assumes server.mjs is already running on a fixed or environment-provided port. This eval runs \`node contract-test.mjs\` directly with no pre-running server. Restore the required flow: import spawn from node:child_process, spawn \`node server.mjs\`, parse /PORT=(\\d+)/ from server.stdout data, await that port, run fetches against \`http://127.0.0.1:\${port}\`, then kill and await the child in cleanup.`;
  }
  if (/Reason:\s*fetch failed|\bfetch failed\b/i.test(combined)) {
    return `contract-test exit ${exitCode}: contract-test.mjs could not connect before receiving an HTTP response. First fix the contract-test lifecycle: do not mock stdout, do not assume port 3000/3001, and do not fetch until it has spawned \`node server.mjs\`, parsed /PORT=(\\d+)/ from server.stdout data, and built URLs with \`http://127.0.0.1:\${port}\`. If the file already does that, print and inspect the spawned child stderr before changing server responses.`;
  }
  if (
    /Cannot read properties of undefined \(reading ['"]listen['"]\)|undefined.*\.listen/i.test(
      combined,
    )
  ) {
    return `contract-test exit ${exitCode}: contract-test.mjs is trying to create or control its own HTTP server and calls .listen on the wrong object. Do not build a mock server in contract-test.mjs. Restore the required flow: import spawn from node:child_process, spawn \`node server.mjs\`, parse /PORT=(\\d+)/ from server.stdout data, await that port, run fetches against the real server, then kill and await the child in cleanup.`;
  }
  if (/\bwindow is not defined\b|ReferenceError:\s*window\b/i.test(combined)) {
    return `contract-test exit ${exitCode}: contract-test.mjs uses the browser global window, but Node contract tests have no window object. Store the discovered port in a local variable or resolve it from a Promise; do not write window.resolvedPort. Required flow: spawn \`node server.mjs\`, resolve portPromise inside server.stdout.on("data", ...), then \`const port = await portPromise\`.`;
  }
  // A genuine port-handshake race shows up as a URL with a NULL port
  // (`http://localhost:null/...`), which makes fetch throw "Failed to parse
  // URL". Match THAT specific symptom — not a bare `port ... null` or a stray
  // `"cursor": null` in a response body, which the old `/port.*null/i` caught
  // and which masked a real assertion failure for 25 min on an e4b
  // bookstore run (it kept re-fixing a port handshake that already worked).
  if (
    /localhost:(?:null|undefined)|:\/\/[^\s/]*:(?:null|undefined)\b|Failed to (?:parse|construct) URL[^\n]*(?:null|undefined)|Failed to detect server port|could not detect server port/i.test(
      combined,
    )
  ) {
    return `contract-test exit ${exitCode}: contract-test.mjs starts fetches before the server port is discovered or threads an undefined port into URLs. Replace mutable port polling with a promise that resolves inside the stdout 'data' handler when /PORT=(\\d+)/ matches, then await that promise before building baseUrl or calling runTests(port).`;
  }
  if (/Expected hasMore=false/i.test(combined)) {
    return `contract-test exit ${exitCode}: contract-test.mjs hard-codes hasMore=false for a page that may not be final. With 5 books, /books?limit=2&cursor=2 can still have another page. Keep pagination checks shape-focused, or use a genuinely final page before expecting hasMore=false.`;
  }
  if (/Expected hasMore=true/i.test(combined)) {
    return `contract-test exit ${exitCode}: contract-test.mjs hard-codes hasMore=true for a page that may be final depending on cursor semantics. Keep pagination checks shape-focused: validate hasMore is a boolean and cursor is string or null.`;
  }
  if (
    /hasMore is not boolean|pagination\.hasMore[^\n]*(?:not boolean|expected boolean)|hasMore[^\n]*expected[^\n]*boolean/i.test(
      combined,
    )
  ) {
    return `contract-test exit ${exitCode}: server.mjs returned pagination.hasMore with a non-boolean value. Patch server.mjs so every list endpoint returns the Pagination envelope with hasMore as true or false, never a string, number, null, or omitted field.`;
  }
  if (/ECONNREFUSED\s+(?:127\.0\.0\.1|localhost):(\d{2,5})/i.test(combined)) {
    const port = /ECONNREFUSED\s+(?:127\.0\.0\.1|localhost):(\d{2,5})/i.exec(combined)?.[1];
    return `contract-test exit ${exitCode}: contract-test.mjs fetches a fixed local port${port ? ` (${port})` : ''} instead of the port printed by the spawned server. Spawn server.mjs, parse /PORT=(\\d+)/ from server.stdout data, await that port, then build URLs with \`http://127.0.0.1:\${port}\`. Do not hard-code 3000/3001 or change server.mjs to match the test.`;
  }
  if (/response does not match Pagination envelope schema/i.test(combined)) {
    return `contract-test exit ${exitCode}: a list endpoint response does not match the Pagination envelope. Check the exact shape { data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }. Common trap: server.mjs must return cursor as a string or null, never a numeric Book id.`;
  }
  if (
    /GET\s+\/books\/(?:\{id\}|\d+)|\/books\/\d+/i.test(combined) &&
    /Book object missing field (?:id|title|authorId|publishedYear|isbn)/i.test(combined)
  ) {
    return `contract-test exit ${exitCode}: GET /books/{id} returned something that is not a Book object. Common trap: server.mjs lets the GET /books list branch catch /books/1 before the single-book route. Patch server.mjs so GET /books requires pathSegments.length === 1, and GET /books/{id} requires pathSegments.length === 2 and returns one Book with id, title, authorId, publishedYear, isbn.`;
  }
  if (
    /\/authors\/\d+\/books[^\n]*Expected status 200, got 404|GET\s+\/authors\/\{id\}\/books[^\n]*Expected status 200, got 404/i.test(
      combined,
    )
  ) {
    return `contract-test exit ${exitCode}: GET /authors/{id}/books returned 404 for the id the contract test chose. Align the test and server data: either derive authorId from an existing Book returned by GET /books, or make the server dataset include the hard-coded author id. The endpoint route itself must be /authors/:id/books with pathSegments[2] === "books".`;
  }
  if (
    /Key ['"]data['"] expected array, got object|data.*expected array.*got object/i.test(combined)
  ) {
    return `contract-test exit ${exitCode}: contract-test.mjs validates arrays with typeof, so JSON arrays are reported as object. Patch contract-test.mjs so array fields use Array.isArray(value); the list endpoints should return { data: Book[], pagination: ... }.`;
  }
  if (/\bFAIL:\s*$/i.test(combined.trim())) {
    return `contract-test exit ${exitCode}: contract-test.mjs printed FAIL with no reason. This usually means it initializes \`passed = false\` and never sets \`passed = true\` after all assertions pass. Set passed true only after the final successful check, before cleanup and process.exitCode assignment.`;
  }
  if (/GET\s+\/authors\/\{id\}\/books response shape invalid/i.test(combined)) {
    return `contract-test exit ${exitCode}: GET /authors/{id}/books response shape invalid. Patch server.mjs so GET /authors/{id}/books returns the same Pagination envelope as GET /books: { data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }. Do not return { data, author }, and do not use nextCursor. Patch contract-test.mjs to validate that same envelope.`;
  }
  if (
    /GET\s+\/authors\/\{id\}\/books|\/authors\/\d+\/books/i.test(combined) &&
    /\bFAIL\b[^\n]*response is array|response is array[^\n]*\bFAIL\b/i.test(combined)
  ) {
    return `contract-test exit ${exitCode}: contract-test.mjs still expects GET /authors/{id}/books to return a bare array. The spec requires the same Pagination envelope as GET /books: { data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }. Patch contract-test.mjs to assert Array.isArray(body.data) and validate body.pagination; do not change server.mjs back to a bare array.`;
  }
  if (/GET\s+\/books response shape invalid/i.test(combined)) {
    return `contract-test exit ${exitCode}: GET /books response shape invalid. Patch server.mjs and contract-test.mjs to use the exact Pagination envelope: { data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }. Do not use nextCursor or a bare array response.`;
  }
  if (
    /Invalid (?:pagination )?envelope|response shape invalid/i.test(combined) &&
    /"year"\s*:/i.test(combined) &&
    !/"publishedYear"\s*:/i.test(combined)
  ) {
    return `contract-test exit ${exitCode}: Book objects use \`year\` but the Book schema/contract expects \`publishedYear\`. Patch server.mjs data and responses, openapi.yaml Book schema, and contract-test.mjs validation so every Book uses exactly: id, title, authorId, publishedYear, isbn. Do not mix \`year\` and \`publishedYear\`.`;
  }
  // The test ran but reported a failing check. Surface the model's OWN failure
  // line — plus the endpoint/test-name line just above it for context — so it
  // fixes the real assertion. Broad on purpose: catches "❌ FAILED", "FAIL",
  // "does not match", "response body shape", etc., not just the few canned
  // phrasings above, which is how the Book-vs-Pagination bug slipped through.
  // Surface the test's OWN failing check(s) — stdout and stderr are separate
  // streams so we can't reliably pair an assertion with its endpoint header,
  // but the assertion text itself ("... does not match Pagination schema") is
  // the honest signal. Broad on purpose: catches "❌ FAILED", "FAIL", "does
  // not match", "response body shape", etc., which is how the Book-vs-
  // Pagination bug slipped past the few canned phrasings above.
  const failLines = combined
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      /❌|✗|\bFAIL(?:ED)?\b|\[FAIL\]|does not match|response (?:body )?shape|schema (?:validation|mismatch)|expected status|unexpected http status|invalid (?:envelope|shape|schema)/i.test(
        line,
      ),
    );
  if (failLines.length > 0) {
    return `contract-test exit ${exitCode}: the test ran and reported a failing check — fix what it names (the assertion in contract-test.mjs, or the server response it validates), not the port handshake. Remember a single-item GET like /books/{id} must match that item's own schema (Book), while only list endpoints (GET /books, GET /authors/{id}/books) return the Pagination envelope. Failing check(s): ${failLines.slice(0, 3).join(' | ')}`;
  }
  // Prefer the actionable error line: Node's ReferenceError/TypeError
  // messages carry their own remediation hint ("you can use import
  // instead"), and the old 200-char cap cut it off right before the
  // hint (wild-caught: gemma4-e4b-q8 received the truncated half,
  // claimed it had fixed the file, and idled to a watchdog kill).
  const errorLine = stderr
    .split('\n')
    .find((l) => /(?:Reference|Type|Syntax)Error[:\s]/.test(l))
    ?.trim();
  const head =
    stdout
      .split('\n')
      .filter((l) => l.trim())
      .slice(-3)
      .join(' | ') ||
    errorLine ||
    stderr.slice(0, 500);
  return `contract-test exit ${exitCode}: ${head}`;
}

export function detectContractStaticIssue(
  server: string,
  contractTest: string,
): string | undefined {
  const issues: string[] = [];
  const codeOnly = stripJsComments(contractTest);
  if (
    /\bfetch\s*\(/s.test(codeOnly) &&
    /\/books\b/s.test(codeOnly) &&
    !/\bspawn\s*\(/s.test(codeOnly) &&
    /PORT_TO_TEST|TEST_PORT|ASSUMED_PORT|stdoutData|listening on PORT=\d+|\b(?:const|let|var)\s+(?:PORT|port)\s*=\s*(?:3000|3001|8080)\b|process\.env\.PORT\b|Failed to determine server port|harness|pre-started server|server is running|known port|common ports/i.test(
      codeOnly,
    )
  ) {
    issues.push(
      'contract-test.mjs never spawns server.mjs before making fetch requests. This eval runs `node contract-test.mjs` directly with no pre-started server and no PORT_TO_TEST. Import `spawn` from `node:child_process`, spawn `node server.mjs`, parse /PORT=(\\d+)/ from server.stdout data, await that port, then fetch the root endpoints.',
    );
  }
  if (
    /\b(?:http|node:http)\b[\s\S]{0,200}\.createServer\s*\(/s.test(codeOnly) &&
    !/\bspawn\s*\(/s.test(codeOnly)
  ) {
    issues.push(
      'contract-test.mjs creates a mock HTTP server with http.createServer instead of testing server.mjs. The contract test must exercise the real deliverable: import `spawn` from `node:child_process`, spawn `node server.mjs`, parse /PORT=(\\d+)/ from server.stdout data, await that port, run fetches against the spawned server, then kill and await the child in cleanup. Do not copy server logic into contract-test.mjs.',
    );
  }
  if (/\bwindow\./s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs uses `window`, but Node .mjs scripts do not have a browser window global. Keep the discovered port in local Promise state instead: create `const portPromise = new Promise(...)`, resolve it inside server.stdout.on("data", ...) when /PORT=(\\d+)/ matches, then `const port = await portPromise` before fetches.',
    );
  }
  if (/\bif\s*\(\s*!\s*port\s*\)\s*\{[\s\S]{0,240}\breturn\s*;/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs uses `return;` in a top-level port-failure branch, which throws "SyntaxError: Illegal return statement" in an ES module. Replace that branch with `throw new Error("could not detect server port")`, or set process.exitCode and let control reach the final cleanup block. Do not use top-level return in .mjs.',
    );
  }
  if (nonAsyncArrowHelperContainsAwait(codeOnly)) {
    issues.push(
      'contract-test.mjs uses await inside a non-async arrow helper, which throws "SyntaxError: Unexpected reserved word". Resolve the port once at top level with `const port = await portPromise`, then build `const baseUrl = `http://127.0.0.1:${port}``; or mark the helper async and await every call to it.',
    );
  }
  if (/\bonce\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs calls node:events once(...) with a callback, but once expects `(emitter, eventName)` and returns a Promise. Do not build hasBeenCalled/cancel wrappers around once. Use server.stdout.on("data", ...) to resolve the port promise, and use once(server, "close") only during cleanup.',
    );
  }
  if (inlineStdoutDataHandlerContainsKill(codeOnly)) {
    issues.push(
      'contract-test.mjs kills the spawned server inside the stdout data handler after discovering PORT. That leaves nothing alive for the fetch assertions. Resolve the port promise from stdout, keep the child running while requests execute, then kill and await it in finally after all tests finish.',
    );
  }
  if (buildsBaseUrlBeforePortReady(codeOnly)) {
    issues.push(
      'contract-test.mjs builds BASE_URL from the initial mutable port value before awaiting the server stdout PORT line, so requests still target port 0/null. Build the base URL only after `const port = await portPromise`, or pass `baseUrl` into every request helper.',
    );
  }
  if (/\.[ \t]*kill\s*\(\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs calls ChildProcess.kill(callback), but child.kill() returns a boolean and never invokes a callback. For cleanup, create the close promise before killing: `const closed = once(server, "close"); server.kill(); await closed;`.',
    );
  }
  // CommonJS-in-ESM is the single most frequent blocker in the run
  // history (every gemma/nemotron bookstore failure walled at
  // 6/7 on it): a `require()` call in a .mjs file throws
  // "ReferenceError: require is not defined in ES module scope" at
  // runtime, burning a full contract cycle per attempt. Catch it
  // statically and name the exact fix.
  const serverCodeOnly = stripJsComments(server);
  for (const [file, code] of [
    ['contract-test.mjs', codeOnly],
    ['server.mjs', serverCodeOnly],
  ] as const) {
    if (/(^|[^.\w])require\s*\(/.test(code) && !/createRequire/.test(code)) {
      issues.push(
        `${file} calls require(), but .mjs files are ES modules — require is not defined there and the script dies with "ReferenceError: require is not defined in ES module scope". Replace every require line with an import statement at the top of the file, not only child_process. Exact replacements: \`const { spawn } = require("node:child_process")\` -> \`import { spawn } from "node:child_process";\`; \`const { URL } = require("node:url")\` -> \`import { URL } from "node:url";\`; \`const { setTimeout } = require("node:timers/promises")\` -> \`import { setTimeout } from "node:timers/promises";\`. If URL or setTimeout is unused, delete that require line instead.`,
      );
    }
  }
  if (/\b(?:req|request)\.url\.searchParams\b/s.test(serverCodeOnly)) {
    issues.push(
      'server.mjs reads req.url.searchParams, but in Node http IncomingMessage req.url is a string. That throws on the first request and makes contract-test.mjs report fetch failed for every endpoint. In each handler, create `const url = new URL(req.url ?? "/", `http://${req.headers.host}`);` and read `url.searchParams`.',
    );
  }
  if (/\bnew\s+URL\s*\(\s*(?:req|request)\.url\s*\)/s.test(serverCodeOnly)) {
    issues.push(
      'server.mjs calls new URL(req.url) without a base URL. In Node http, req.url is usually a relative path like /books, so this throws ERR_INVALID_URL on the first request and contract-test.mjs reports fetch failed. Create the URL with a base: `const url = new URL(req.url ?? "/", `http://${req.headers.host}`);`.',
    );
  }
  if (
    /Number\s*\(\s*[^)]*searchParams\.get\s*\(\s*['"]limit['"]\s*\)\s*\)\s*\?\?/s.test(
      serverCodeOnly,
    )
  ) {
    issues.push(
      'server.mjs defaults the list limit with `Number(url.searchParams.get("limit")) ?? ...`, but `Number(null)` is 0, not nullish. GET /books with no limit then returns an empty page or crashes when pagination reads the last item from an empty slice, making contract-test.mjs report fetch failed. Patch server.mjs so the default is chosen before Number conversion, e.g. `const limitParam = url.searchParams.get("limit"); const limit = limitParam === null ? 10 : Number(limitParam);`.',
    );
  }
  const authGuardIndex = firstMatchIndex(
    serverCodeOnly,
    /(?:req\.headers\s*\[\s*['"]authorization['"]\s*\]|authorization)[\s\S]{0,360}(?:writeHead\s*\(\s*401|statusCode\s*=\s*401|code\s*:\s*401)/is,
  );
  const firstGetBooksRouteIndex = firstMatchIndex(
    serverCodeOnly,
    /(?:GET \/books|pathSegments[\s\S]{0,180}books[\s\S]{0,180}(?:method|req\.method)[\s\S]{0,80}GET|(?:method|req\.method)[\s\S]{0,80}GET[\s\S]{0,180}books)/is,
  );
  if (
    authGuardIndex >= 0 &&
    (firstGetBooksRouteIndex < 0 || authGuardIndex < firstGetBooksRouteIndex)
  ) {
    issues.push(
      'server.mjs applies a bearer Authorization guard before the GET routes, so GET /books returns 401. In this scenario server.mjs implements only public GET endpoints; bearerAuth is only an OpenAPI requirement for POST/PATCH/DELETE. Remove the top-level auth guard, or guard only non-GET mutation methods that the stub does not implement.',
    );
  }
  if (/stdout\.on\(\s*['"]end['"]/s.test(codeOnly) && /PORT\s*=/.test(codeOnly)) {
    issues.push(
      "contract-test.mjs waits for server.stdout 'end' before parsing PORT. That hangs because server stdout does not end until the server exits. Parse /PORT=(\\d+)/ inside the stdout 'data' handler and resolve immediately.",
    );
  }
  const awaitedCloseIndex = firstMatchIndex(
    codeOnly,
    /await\s+(?:once\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*['"](?:close|exit)['"]\s*\)|new\s+Promise\s*\([^)]*=>[\s\S]{0,360}\.(?:on|once)\s*\(\s*['"](?:close|exit)['"])/s,
  );
  const firstKillIndex = firstMatchIndex(codeOnly, /\.[ \t]*kill\s*\(/s);
  if (awaitedCloseIndex >= 0 && (firstKillIndex < 0 || awaitedCloseIndex < firstKillIndex)) {
    issues.push(
      'contract-test.mjs awaits the spawned server close/exit event before killing it. The server stays alive while tests run, so this deadlocks before fetch assertions. Discover PORT with a promise, run fetches while the server is alive, then in finally create the close promise before server.kill() and await it.',
    );
  }
  if (/listening on PORT=.*(?:\$\{\s*PORT\s*\}|\+\s*PORT\b)/s.test(server)) {
    issues.push(
      'server.mjs logs the requested PORT variable. With PORT=0 that prints 0, not the assigned ephemeral port. Inside the listen callback, call server.address().port and log that value.',
    );
  }
  const cursorInitializer =
    /const\s+\w*cursor\w*\s*=\s*[^?\n;]+\?\s*[^:\n;]*\.id\s*:\s*null/is.exec(server)?.[0];
  const cursorProperty = /cursor\s*:\s*[^,\n;]*\.id\b/is.exec(server)?.[0];
  if (
    (cursorInitializer && !/String\s*\(/.test(cursorInitializer)) ||
    (cursorProperty && !/String\s*\(/.test(cursorProperty))
  ) {
    issues.push(
      'server.mjs returns a numeric pagination cursor from a Book id, but the Pagination schema requires cursor to be string or null. Patch server.mjs so nextCursor is `hasMore ? String(book.id) : null` (or String(index) for index cursors). Do not write unrelated files such as script.js; the checker only reads openapi.yaml, server.mjs, contract-test.mjs, and README.md.',
    );
  }
  if (
    /const\s+\w*cursor\w*\s*=\s*hasMore\s*\?\s*String\s*\(\s*\w+\s*\[\s*\w+\s*\+\s*limit\s*\]\.id\s*\)\s*:\s*null/is.test(
      server,
    ) &&
    /findIndex\s*\([^)]*\.id\s*={2,3}[\s\S]{0,260}\w+\s*\+\s*1/is.test(server)
  ) {
    issues.push(
      'server.mjs returns the next book id as pagination.cursor, but later treats cursor as the last-seen book id and starts after it. That skips one book on the next page. Either return the last returned book id as the cursor, or when cursor points at the next book id, start the next page at that book. Do not patch contract-test.mjs to expect the skipped page.',
    );
  }
  if (
    /\b(?:const|let)\s+\w*next\w*cursor\w*\s*=\s*hasMore\s*\?/is.test(server) &&
    /pagination\s*:\s*{[\s\S]{0,240}cursor\s*:\s*cursorParam\b/is.test(server)
  ) {
    issues.push(
      'server.mjs computes a next cursor but returns `cursor: cursorParam`, so the first page `/books?limit=2` returns null instead of a next-page cursor. Return the computed next cursor in the pagination envelope.',
    );
  }
  if (
    /\b(?:require|import)\s*\(\s*['"][^'"]*openapi\.ya?ml['"]\s*\)/s.test(codeOnly) ||
    /\bfrom\s+['"][^'"]*openapi\.ya?ml['"]/s.test(codeOnly)
  ) {
    issues.push(
      'contract-test.mjs tries to require/import openapi.yaml. Plain Node cannot load YAML without a loader or npm package. Remove that import and embed the needed schemas as a JS object literal, or read YAML only as plain text with built-in fs.',
    );
  }
  if (/\bfrom\s+['"]node:fetch['"]|\bfrom\s+['"]fetch['"]/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs imports fetch, but Node fetch is a global function, not a `node:fetch` module. Remove the fetch import and call global `fetch(...)` directly.',
    );
  }
  if (
    /\bfrom\s+['"](?:undici|node-fetch|axios)['"]|\brequire\s*\(\s*['"](?:undici|node-fetch|axios)['"]\s*\)/s.test(
      codeOnly,
    )
  ) {
    issues.push(
      'contract-test.mjs imports an npm HTTP client, but the eval runs with only Node built-ins. Delete every undici/node-fetch/axios import line; do not replace it with another fetch import or compatibility shim. Node provides fetch as a global, so call fetch(...) directly.',
    );
  }
  if (
    /\bArray\.isArray\s*\(\s*body\s*\)/s.test(codeOnly) &&
    /\/authors\/(?:\$\{[^}]+}|[^/\s"'`]+|\{id\})\/books|\/authors\/\{id\}\/books|author books/is.test(
      codeOnly,
    )
  ) {
    issues.push(
      'contract-test.mjs still expects GET /authors/{id}/books to return a bare array. The spec requires the same Pagination envelope as GET /books: { data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }. Patch contract-test.mjs to assert Array.isArray(body.data) and validate body.pagination; do not change server.mjs back to a bare array.',
    );
  } else if (/\bArray\.isArray\s*\(\s*body\s*\)/s.test(codeOnly) && /\/books\b/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs expects GET /books to return a bare array, but the required list response is an envelope: `{ data: Book[], pagination: { limit, cursor, total, hasMore } }`. Validate `Array.isArray(body.data)`, not `Array.isArray(body)`.',
    );
  }
  if (/\bbody\.books\b/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs expects list responses to contain `body.books`, but this scenario uses the OpenAPI envelope key `data`. Patch GET /books and GET /authors/{id}/books checks to read `body.data` plus `body.pagination`.',
    );
  }
  if (/typeof\s+[^;\n]+['"]integer['"]/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs compares typeof to "integer", but JavaScript typeof never returns "integer". Validate integer fields with `typeof value === "number"` and, only if necessary, `Number.isInteger(value)`.',
    );
  }
  if (/typeof\s+[^;\n]*\.id\s*!==\s*['"]string['"]/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs expects Book.id to be a string, but this scenario and the independent smoke gate use numeric Book ids. Validate Book.id with `typeof book.id === "number"` and keep server.mjs/openapi.yaml/contract-test.mjs consistent.',
    );
  }
  if (
    /\bimport\s*{\s*setTimeout\s*}\s*from\s*['"]node:timers\/promises['"]/s.test(codeOnly) &&
    /setTimeout\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*\d+/s.test(codeOnly)
  ) {
    issues.push(
      'contract-test.mjs imports promise-based setTimeout from node:timers/promises but uses callback-style setTimeout(checkPort, 100). That throws ERR_INVALID_ARG_TYPE because the promises API expects a numeric delay first. Remove that import and use the global callback setTimeout, or await `setTimeout(100)` from node:timers/promises without passing a callback.',
    );
  }
  if (/http:\/\/(?:127\.0\.0\.1|localhost):(?:[/"'`]|$)/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs builds fetch URLs with an empty port, such as `http://127.0.0.1:/books`. Thread the discovered port into every helper or pass a baseUrl argument; fetch URLs must be `http://127.0.0.1:${port}/books`, `/books/{id}`, and `/authors/{id}/books`.',
    );
  }
  if (
    /http:\/\/(?:127\.0\.0\.1|localhost):(?:3000|3001|8080)\b/s.test(codeOnly) &&
    !/http:\/\/(?:127\.0\.0\.1|localhost):\$\{[^}]*port[^}]*\}/is.test(codeOnly)
  ) {
    issues.push(
      'contract-test.mjs hard-codes a local port such as `http://127.0.0.1:3001`. The eval spawns server.mjs on an ephemeral port, so fixed-port fetches fail with ECONNREFUSED. Parse /PORT=(\\d+)/ from server.stdout data, await that port, and build URLs as `http://127.0.0.1:${port}/books`, `/books/{id}`, and `/authors/{id}/books`.',
    );
  }
  if (
    /http:\/\/(?:127\.0\.0\.1|localhost)\$\{[^}]+\}/s.test(codeOnly) ||
    /http:\/\/(?:127\.0\.0\.1|localhost)['"]\s*\+\s*(?:path|url|endpoint|route)\b/s.test(codeOnly)
  ) {
    issues.push(
      'contract-test.mjs discovers the server port but builds fetch URLs without it, such as `http://localhost${url}`. That connects to port 80 and makes every fetch fail. Build one base URL after port discovery: `const baseUrl = `http://127.0.0.1:${port}`;`, then fetch `${baseUrl}/books`, `${baseUrl}/books/{id}`, and `${baseUrl}/authors/{id}/books`.',
    );
  }
  if (/\/api\/v1\/?(?:books|authors)?/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs prepends /api/v1 to endpoint URLs, but this scenario uses root paths from openapi.yaml and server.mjs: /books, /books/{id}, and /authors/{id}/books. Build baseUrl as `http://127.0.0.1:${port}` and fetch those root paths directly.',
    );
  }
  if (
    /let\s+port\s*=\s*null/s.test(codeOnly) &&
    /stdout\.on\s*\(\s*['"]data['"][\s\S]{0,500}PORT=\(\\d\+\)/s.test(codeOnly) &&
    /\b(?!(?:resolve|reject|Number|String|parseInt|if|while|for|switch)\b)[A-Za-z_$][\w$]*\s*\(\s*port\s*\)/s.test(
      codeOnly,
    ) &&
    !/(await\s+\w*port\w*Promise|port\s*=\s*await|while\s*\([^)]*port)/s.test(codeOnly)
  ) {
    issues.push(
      'contract-test.mjs uses port before waiting for the stdout PORT=NNNN line. Create a portPromise that resolves inside server.stdout.on("data", ...), then `const port = await portPromise` before calling runTests(port) or fetch().',
    );
  }
  // Flag a never-set-true `passed` flag ONLY when it is genuinely never
  // reassigned to a non-false value. Capture each `passed = <rhs>` and check
  // the rhs token: recognize aggregate assignments like `passed = a && b && c`
  // (a valid, common pattern), not just a literal `passed = true`. A lookahead
  // here backtracks past the whitespace and mis-reads `passed = false` as
  // non-false, so capture-and-check instead. Otherwise this masks the real
  // failing assertion and loops the model on already-correct code (same
  // false-positive class as the port-race heuristic; e4b bookstore).
  const passedSetNonFalse = [...codeOnly.matchAll(/\bpassed\s*=\s*([^;\n]+)/g)].some(
    (m) => !/^false\b/i.test((m[1] ?? '').trim()),
  );
  if (/\blet\s+passed\s*=\s*false\b/s.test(codeOnly) && !passedSetNonFalse) {
    issues.push(
      'contract-test.mjs initializes passed = false but never sets passed = true after successful assertions. Set passed = true (or passed = <all checks passed>) only after all GET endpoint checks pass, before cleanup and process.exitCode assignment.',
    );
  }
  if (
    /pathSegments\s*\[\s*0\s*\]\s*={2,3}\s*['"]authors['"][\s\S]{0,220}pathSegments\s*\[\s*1\s*\]\s*={2,3}\s*['"]books['"]/s.test(
      serverCodeOnly,
    )
  ) {
    issues.push(
      'server.mjs misroutes /authors/{id}/books by checking pathSegments[1] === "books". For /authors/1/books, pathSegments[1] is the numeric author id and pathSegments[2] is "books". Route it as pathSegments[0] === "authors", pathSegments[2] === "books", and authorId = Number(pathSegments[1]).',
    );
  }
  if (
    /pathname\.startsWith\s*\(\s*['"]\/authors\/['"]\s*\)[\s\S]{0,260}pathname\.split\s*\(\s*['"]\/['"]\s*\)\.length\s*={2,3}\s*3[\s\S]{0,260}handle[A-Za-z0-9_$]*Books[A-Za-z0-9_$]*Author/s.test(
      serverCodeOnly,
    )
  ) {
    issues.push(
      'server.mjs routes /authors/{id}/books with pathname.split("/").length === 3, but "/authors/101/books".split("/") has length 4. Route author books with pathSegments.length === 3 after filtering empty segments, or with pathname.split("/").length === 4 and the final segment "books".',
    );
  }
  const booksRootIndex = firstMatchIndex(
    serverCodeOnly,
    /pathSegments\s*\[\s*0\s*\]\s*={2,3}\s*['"]books['"]/s,
  );
  if (booksRootIndex >= 0) {
    const booksRouteSlice = serverCodeOnly.slice(booksRootIndex, booksRootIndex + 1800);
    const hasSafeNestedListRoute =
      /pathSegments\.length\s*={2,3}\s*1[\s\S]{0,220}req\.method\s*={2,3}\s*['"]GET['"]/s.test(
        booksRouteSlice,
      );
    const hasSafeNestedItemRoute =
      /pathSegments\.length\s*={2,3}\s*2[\s\S]{0,220}req\.method\s*={2,3}\s*['"]GET['"]/s.test(
        booksRouteSlice,
      );
    const broadGetMatch = /if\s*\(([^)]*req\.method\s*={2,3}\s*['"]GET['"][^)]*)\)/s.exec(
      booksRouteSlice,
    );
    const broadGetCondition = broadGetMatch?.[1] ?? '';
    if (
      broadGetMatch &&
      !(hasSafeNestedListRoute && hasSafeNestedItemRoute) &&
      !/pathSegments\.length\s*={2,3}\s*(?:1|2)|pathSegments\.length\s*!={2,3}\s*2/.test(
        broadGetCondition,
      ) &&
      !/pathSegments\s*\[\s*1\s*\]/.test(broadGetCondition)
    ) {
      issues.push(
        'server.mjs has a broad `if (req.method === "GET")` branch under pathSegments[0] === "books", so GET /books/{id} is treated as the list endpoint and returns a Pagination envelope instead of one Book. Patch route order/conditions: GET /books requires pathSegments.length === 1; GET /books/{id} requires pathSegments.length === 2 and returns one Book object or a 404 Error.',
      );
    }
  }
  const hardCodedAuthorId = /(?:const|let)\s+authorId\s*=\s*(\d+)\b/.exec(codeOnly)?.[1];
  if (hardCodedAuthorId) {
    const serverHasAuthorId = new RegExp(`\\bauthorId\\s*:\\s*${hardCodedAuthorId}\\b`).test(
      serverCodeOnly,
    );
    if (!serverHasAuthorId) {
      issues.push(
        `contract-test.mjs hard-codes authorId = ${hardCodedAuthorId}, but server.mjs does not appear to contain that author id in its dataset. Derive authorId from an existing Book returned by GET /books, or make the server dataset use that id consistently before calling /authors/${hardCodedAuthorId}/books.`,
      );
    }
  }
  const killThenAwaitOnce =
    /\b([A-Za-z_$][\w$]*)\.kill\s*\([^)]*\)[\s\S]{0,260}await\s+once\s*\(\s*\1\s*,\s*['"](?:exit|close)['"]\s*\)/s.exec(
      codeOnly,
    );
  const killThenAwaitListener =
    /\b([A-Za-z_$][\w$]*)\.kill\s*\([^)]*\)[\s\S]{0,360}await[\s\S]{0,220}\1\.(?:on|once)\s*\(\s*['"](?:exit|close)['"]/s.exec(
      codeOnly,
    );
  if (killThenAwaitOnce || killThenAwaitListener) {
    const childName = killThenAwaitOnce?.[1] ?? killThenAwaitListener?.[1] ?? 'server';
    issues.push(
      `contract-test.mjs calls ${childName}.kill() before registering the close/exit waiter. If the child exits quickly, awaiting ${childName}.on/once("exit"|"close") afterward can miss the event and hang forever after assertions pass. Patch contract-test.mjs directly; do not create script.js or any helper file. Create the promise before killing: \`const closed = once(${childName}, "close"); ${childName}.kill(); await closed;\`.`,
    );
  }
  if (/server\.kill\s*\([^)]*\)[\s\S]{0,500}process\.exit\s*\(/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs calls process.exit() soon after server.kill(). On Windows this can abort with a nonzero native exit code even after assertions pass. Remove every process.exit(...) call from contract-test.mjs. Await the child close/exit event after kill, set process.exitCode, and let the async function return.',
    );
  } else if (/\bprocess\.exit\s*\(/s.test(codeOnly) && /\bspawn\s*\(/s.test(codeOnly)) {
    issues.push(
      'contract-test.mjs still calls process.exit(...). For this eval, remove every process.exit(...) call from contract-test.mjs. A spawned-server test must set process.exitCode after cleanup instead of exiting directly.',
    );
  }
  const validateErrorBody = extractFunctionBody(codeOnly, 'validateError');
  if (validateErrorBody) {
    const messageStringCheck = validateErrorBody.search(
      /typeof\s+[^;\n]*\.message\s*={2,3}\s*['"]string['"]/s,
    );
    const rejectsAfterMessageString =
      messageStringCheck >= 0 &&
      /return\s+false\b/.test(
        validateErrorBody.slice(messageStringCheck, messageStringCheck + 180),
      );
    if (rejectsAfterMessageString) {
      issues.push(
        'contract-test.mjs rejects valid Error objects: validateError returns false when `typeof data.message === "string"`. Error.message is supposed to be a string. Change the check to reject non-strings, e.g. `typeof data.message !== "string"`.',
      );
    }
  }
  const validateShapeBody = extractFunctionBody(codeOnly, 'validateShape');
  if (
    validateShapeBody &&
    /['"]array['"]/.test(codeOnly) &&
    /typeof\s+/.test(validateShapeBody) &&
    !/Array\.isArray\s*\(\s*(?:val|value|obj\s*\[\s*key\s*\]|obj\s*\[[^\]]+\])/.test(
      validateShapeBody,
    )
  ) {
    issues.push(
      'contract-test.mjs validates expected array fields using typeof, but JavaScript arrays have typeof "object". Use Array.isArray(value) for array fields such as response.data.',
    );
  }
  return issues.length > 0 ? issues.join(' ') : undefined;
}

function inlineStdoutDataHandlerContainsKill(code: string): boolean {
  const handlerPatterns = [
    /stdout\.on\s*\(\s*['"]data['"]\s*,\s*(?:async\s*)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\([^)]*\)\s*\{/g,
    /stdout\.on\s*\(\s*['"]data['"]\s*,\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g,
  ];

  for (const pattern of handlerPatterns) {
    let match: RegExpExecArray | null = pattern.exec(code);
    while (match !== null) {
      const openIndex = match.index + match[0].lastIndexOf('{');
      const bodyEnd = matchingBraceIndex(code, openIndex);
      const body = code.slice(openIndex + 1, bodyEnd === -1 ? openIndex + 1201 : bodyEnd);
      if (/\.[ \t]*kill\s*\(/.test(body)) return true;
      match = pattern.exec(code);
    }
  }

  return false;
}

function matchingBraceIndex(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function buildsBaseUrlBeforePortReady(code: string): boolean {
  if (!/\b(?:let|var)\s+port\s*=\s*(?:0|null|undefined)\b/is.test(code)) return false;

  const baseMatch =
    /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*`http:\/\/(?:127\.0\.0\.1|localhost):\$\{\s*port\s*\}/is.exec(
      code,
    );
  if (!baseMatch) return false;

  return !awaitsPortReadinessBefore(code, baseMatch.index);
}

function awaitsPortReadinessBefore(code: string, beforeIndex: number): boolean {
  const beforeBase = code.slice(0, beforeIndex);
  if (/\bawait\s+(?:portPromise|new\s+Promise\s*\(|waitForPort\s*\()/i.test(beforeBase)) {
    return true;
  }

  const awaitedIdentifiers = beforeBase.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\b/g);
  for (const match of awaitedIdentifiers) {
    const name = match[1];
    if (!name) continue;
    const declaration = new RegExp(
      `\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*new\\s+Promise\\b`,
    ).exec(beforeBase);
    if (!declaration || declaration.index > match.index) continue;

    const promiseRegion = beforeBase.slice(declaration.index, match.index);
    if (
      /\bPORT\s*=|\/PORT=|stdout\.on\s*\(\s*['"]data['"]/is.test(promiseRegion) &&
      /\bport\s*=/.test(promiseRegion)
    ) {
      return true;
    }
  }

  return false;
}

function nonAsyncArrowHelperContainsAwait(code: string): boolean {
  return /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?!async\b)(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:`[^`]*\bawait\b|\{[^}]*\bawait\b)/s.test(
    code,
  );
}

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function firstMatchIndex(source: string, pattern: RegExp): number {
  const match = pattern.exec(source);
  return match?.index ?? -1;
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFunctionBody(source: string, functionName: string): string | undefined {
  const match = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*{`).exec(source);
  if (!match) return undefined;
  let depth = 1;
  const start = match.index + match[0].length;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return source.slice(start);
}

function simpleHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function bookstoreRepairDirective(failReason: string | undefined): string {
  const reasonLine = failReason ? `Current runtime failure: ${failReason}` : '';
  const reason = failReason ?? '';
  const schemaInContractRule =
    'Do not `require("./openapi.yaml")`, import `./openapi.yaml`, or import js-yaml. The eval runs with only Node built-ins. If contract-test.mjs needs the OpenAPI schemas, define `const openapiSchema = { components: { schemas: ... } }` directly in contract-test.mjs and keep it consistent with openapi.yaml.';

  if (/yaml-parses:[\s\S]*duplicated mapping key/i.test(reason)) {
    return [
      'BOOKSTORE_OPENAPI_DUPLICATE_PATH_PATCH: openapi.yaml has the same path key more than once, so YAML parsing fails before any structural checks can run. Your next tool call MUST write `openapi.yaml`; do not edit README.md, server.mjs, or contract-test.mjs before this is fixed.',
      reasonLine,
      'Rewrite the `paths:` section so each path key appears exactly once. In particular, `/books/{id}` must be one mapping containing sibling operations `get:`, `patch:`, and `delete:` under that single key.',
      'Do not write one `/books/{id}` block for GET and a second `/books/{id}` block for PATCH/DELETE. Do not create child paths like `/books/{id}/delete` or `/books/{id}/reviews` for required mutations.',
      'Required path keys: `/books`, `/books/{id}`, and `/authors/{id}/books`. `/books` has `get` and `post`; `/books/{id}` has `get`, `patch`, and `delete`; `/authors/{id}/books` has `get`.',
      'Keep components.schemas Book, Author, Error, Pagination and components.securitySchemes.bearerAuth in the same file.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (/all-paths-present:[^\n]*\/books\/\{id\}#DELETE/i.test(reason)) {
    return [
      'BOOKSTORE_DELETE_PATCH: this is one mechanical YAML miss. Your next tool call MUST write `openapi.yaml`; do not edit README.md, server.mjs, or contract-test.mjs before this is fixed.',
      reasonLine,
      'The checker looks for `doc.paths["/books/{id}"].delete`. A comment about DELETE or a child path like `/books/{id}/delete` does not count.',
      'Under the existing `/books/{id}` path, add this literal sibling operation at the same indentation as `get:` and `patch:`:',
      [
        '    delete:',
        '      tags:',
        '        - Books',
        '      summary: Delete a book',
        '      operationId: deleteBook',
        '      security:',
        '        - bearerAuth: []',
        '      parameters:',
        '        - name: id',
        '          in: path',
        '          required: true',
        '          schema:',
        '            type: integer',
        '      responses:',
        "        '204':",
        '          description: Book deleted',
        "        '401':",
        '          description: Unauthorized',
        '          content:',
        '            application/json:',
        '              schema:',
        "                $ref: '#/components/schemas/Error'",
        "        '404':",
        '          description: Book not found',
        '          content:',
        '            application/json:',
        '              schema:',
        "                $ref: '#/components/schemas/Error'",
      ].join('\n'),
      'After that write, keep openapi.yaml stable unless the checker names another OpenAPI signal.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (/auth-on-mutations/i.test(reason)) {
    return [
      'BOOKSTORE_AUTH_PATCH: this is one mechanical OpenAPI auth miss. Your next tool call MUST write `openapi.yaml`; do not edit README.md, server.mjs, or contract-test.mjs before this is fixed.',
      reasonLine,
      'The checker already sees `components.securitySchemes.bearerAuth`; what is missing is a security reference that covers POST /books, PATCH /books/{id}, and DELETE /books/{id}.',
      'Fastest valid fix: add this root-level block once near the top of openapi.yaml, as a sibling of `openapi:`, `info:`, `paths:`, and `components:`:',
      ['security:', '  - bearerAuth: []'].join('\n'),
      'Do not create a new scheme name. Do not put `security` under only GET operations. If you prefer operation-level auth instead, add `security: [{ bearerAuth: [] }]` directly under each of `post:`, `patch:`, and `delete:`.',
      'After this write, keep openapi.yaml stable unless the checker names another OpenAPI signal.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (/schemas-named:[^\n]*components\.schemas missing[^\n]*Pagination/i.test(reason)) {
    return [
      'BOOKSTORE_PAGINATION_SCHEMA_PATCH: this is one mechanical OpenAPI schema miss. Your next tool call MUST write `openapi.yaml`; do not edit README.md, server.mjs, or contract-test.mjs before this is fixed.',
      reasonLine,
      'Add a literal `Pagination` schema under `components.schemas` as a sibling of Book, Author, and Error. Keep the existing paths and mutation auth stable.',
      'The checker looks for `doc.components.schemas.Pagination`; a response description or inline pagination object does not count.',
      'Required shape:',
      [
        '    Pagination:',
        '      type: object',
        '      required:',
        '        - limit',
        '        - cursor',
        '        - total',
        '        - hasMore',
        '      properties:',
        '        limit:',
        '          type: integer',
        '        cursor:',
        '          type:',
        '            - string',
        '            - "null"',
        '        total:',
        '          type: integer',
        '        hasMore:',
        '          type: boolean',
      ].join('\n'),
      'After this write, keep openapi.yaml stable unless the checker names another OpenAPI signal.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (/yaml-parses|openapi-3\.1|all-paths-present|schemas-named|auth-on-mutations/i.test(reason)) {
    return [
      'BOOKSTORE OPENAPI REWRITE: fix openapi.yaml first. Rewrite the entire openapi.yaml with one writeFile call; do not patch YAML fragments with replaceInFile.',
      reasonLine,
      'Exact required path keys: `/books` with `get` and `post`; `/books/{id}` with `get`, `patch`, and `delete`; `/authors/{id}/books` with `get`. Do not create `/books/{id}/delete` or any child path for DELETE.',
      'A comment saying DELETE is required does not count. The YAML must contain a literal `delete:` operation nested under `/books/{id}` at the same indentation level as `get:` and `patch:`.',
      'If DELETE is missing, copy this operation shape under `/books/{id}` now: `delete: { tags: [Books], summary: Delete a book, operationId: deleteBook, security: [{ bearerAuth: [] }], parameters: [{ name: id, in: path, required: true, schema: { type: integer } }], responses: { "204": { description: Book deleted }, "401": { description: Unauthorized, content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } }, "404": { description: Book not found, content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } } } }`.',
      'Use two-space YAML indentation and only one mapping key per object. Do not duplicate operation keys such as `summary`, `responses`, `parameters`, or status codes under the same method.',
      'Keep components.schemas Book, Author, Error, Pagination and components.securitySchemes.bearerAuth. Bearer auth must cover POST /books, PATCH /books/{id}, and DELETE /books/{id}. Either root-level `security: [{ bearerAuth: [] }]` or direct operation-level security is acceptable; if the auth signal is still missing, add `security: [{ bearerAuth: [] }]` directly under each mutation operation.',
      'After openapi.yaml parses and the structural signals pass, keep it stable and patch only server.mjs/contract-test.mjs.',
      schemaInContractRule,
    ]
      .filter(Boolean)
      .join(' ');
  }

  const contractLifecycleProblem =
    /never spawns|assumes server\.mjs|pre-started server|PORT_TO_TEST|fixed or environment-provided port|could not connect before receiving an HTTP response|starts fetches before the server port|hard-codes a local port|builds BASE_URL|kills the spawned server|calls node:events once|ChildProcess\.kill|mock HTTP server/i.test(
      reason,
    );

  if (
    /npm HTTP client|undici|node-fetch|axios|built-in global fetch/i.test(reason) &&
    !contractLifecycleProblem
  ) {
    return [
      'BOOKSTORE_CONTRACT_FETCH_PATCH: this is one mechanical contract-test.mjs dependency issue. Your next tool call MUST write `contract-test.mjs`; do not edit openapi.yaml, server.mjs, or README.md before this is fixed.',
      reasonLine,
      'Do not rewrite the whole test from scratch for this fix. Keep the existing contract-test.mjs content and make the smallest possible edit.',
      'Delete every line like `import fetch from "node-fetch"`, `import { fetch } from "node-fetch"`, `import { fetch } from "undici"`, `import axios from "axios"`, or `require("node-fetch")`.',
      'If the current file starts with `import fetch from "node-fetch";` or `import fetch from \'node-fetch\';`, the corrected file should simply start with the next existing import or statement. Do not replace that first line with anything.',
      'Do not add a replacement fetch import. Do not add a compatibility shim. Do not write comments saying node-fetch is a stand-in. The evaluator treats any undici/node-fetch/axios import as a hard failure.',
      'Node already provides fetch as a global function in this eval. Leave calls as bare `await fetch(url, options)`.',
      'Allowed imports for contract-test.mjs are Node built-ins only, for example `import { spawn } from "node:child_process";` and `import { once } from "node:events";`.',
      'After deleting the npm HTTP-client import, keep the real server-spawn flow: spawn `node server.mjs`, parse PORT from stdout data, await that port before fetches, then kill and await the child in cleanup.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (/evaluator smoke failed:[^\n]*GET \/books pagination\.limit is not a number/i.test(reason)) {
    return [
      'BOOKSTORE_SERVER_PAGINATION_PATCH: the independent smoke test reached server.mjs and GET /books returned a malformed pagination envelope. Your next tool call MUST write `server.mjs`; do not edit openapi.yaml or contract-test.mjs for this failure.',
      reasonLine,
      'Patch server.mjs so every list endpoint returns exactly `{ data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }`.',
      'Do not put `limit`, `cursor`, `total`, or `hasMore` beside `data` at the top level. They must be nested under `pagination`.',
      'GET /books with no query should return all 5 books and `pagination.limit` as a number. GET /authors/{id}/books must use the same envelope shape.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (
    /contract-test\.mjs builds fetch URLs with an empty port|contract-test\.mjs calls [A-Za-z_$][\w$]*\.kill\(\) before registering the close\/exit waiter/i.test(
      reason,
    )
  ) {
    return [
      'BOOKSTORE_CONTRACT_PORT_CLEANUP_REWRITE: contract-test.mjs has a port threading and cleanup bug. Your next tool call MUST write `contract-test.mjs`; do not edit openapi.yaml, server.mjs, or README.md for this failure.',
      reasonLine,
      'Use this lifecycle shape: create `const server = spawn("node", ["server.mjs"], { stdio: ["ignore", "pipe", "pipe"] });`, create a `portPromise` that resolves inside `server.stdout.on("data", ...)` when `/PORT=(\\d+)/` matches, then `const port = await portPromise` before making any fetch.',
      'After `const port = await portPromise`, build `const baseUrl = `http://127.0.0.1:${port}`;` and pass `baseUrl` into every request helper. No URL may look like `http://127.0.0.1:/books`, `localhost:null`, or a fixed port.',
      'Cleanup must create the close promise before killing: `const closed = once(server, "close"); server.kill(); await closed;`. Do not call `server.kill()` before registering `once(server, "close")`.',
      'Set `process.exitCode = passed ? 0 : 1` after cleanup and let the async function return. Do not call `process.exit(...)`.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (
    /hasMore is not boolean|pagination\.hasMore[^\n]*(?:not boolean|expected boolean)|hasMore[^\n]*expected[^\n]*boolean/i.test(
      reason,
    )
  ) {
    return [
      'BOOKSTORE_SERVER_HASMORE_PATCH: server.mjs is returning a malformed pagination.hasMore value. Your next tool call MUST write `server.mjs`; do not edit openapi.yaml or contract-test.mjs for this failure.',
      reasonLine,
      'Patch both GET /books and GET /authors/{id}/books so their list responses are exactly `{ data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }`.',
      'Compute `hasMore` as a boolean expression such as `start + limit < filteredBooks.length`. Do not return `"true"`, `"false"`, `1`, `0`, null, or omit the field.',
      'Keep contract-test.mjs shape-focused; the server response is the failing artifact.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (/evaluator smoke failed:[^\n]*GET \/books expected 5 books, got \d+/i.test(reason)) {
    return [
      'BOOKSTORE_SERVER_DATASET_PATCH: the independent smoke test reached server.mjs and GET /books did not return the required dataset. Your next tool call MUST write `server.mjs`; do not edit openapi.yaml or contract-test.mjs for this failure.',
      reasonLine,
      'Patch the hardcoded server dataset to contain exactly 5 Book objects across 3 numeric authorId values. Each Book must have id, title, authorId, publishedYear, and isbn.',
      'GET /books with no query must return all 5 books in `data`. Keep the pagination envelope as `{ data, pagination: { limit, cursor, total, hasMore } }` with `total: 5`.',
      'Do not patch contract-test.mjs to expect fewer books; the evaluator smoke test independently fetches server.mjs.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (/evaluator smoke failed:[^\n]*GET \/books\?limit=2 expected 2 books, got \d+/i.test(reason)) {
    return [
      'BOOKSTORE_SERVER_LIMIT_PATCH: the independent smoke test reached server.mjs, but GET /books ignores the `limit` query parameter. Your next tool call MUST write `server.mjs`; do not edit openapi.yaml or contract-test.mjs for this failure.',
      reasonLine,
      'Patch the GET /books list route so it parses `limit` from `new URL(req.url, ...).searchParams`, defaults to the full dataset size when absent, clamps it to a positive integer, and returns only `books.slice(start, start + limit)` in `data`.',
      'Concrete shape: `const rawLimit = url.searchParams.get("limit"); const limit = rawLimit == null ? filtered.length : Math.max(1, Math.min(filtered.length, Number.parseInt(rawLimit, 10) || filtered.length)); const page = filtered.slice(start, start + limit);` then return `data: page`.',
      'Keep `pagination.limit` as the numeric effective limit, `pagination.total` as 5, `pagination.cursor` as a string next offset or null, and `pagination.hasMore` as a boolean.',
      'Apply the same envelope helper to GET /authors/{id}/books if that route also lists books. Do not patch the contract test to expect 5 for `?limit=2`; the evaluator independently fetches server.mjs.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (
    /evaluator smoke failed:[^\n]*(ERR_HTTP_HEADERS_SENT|Cannot write headers after they are sent)/i.test(
      reason,
    )
  ) {
    return [
      'BOOKSTORE_SERVER_RESPONSE_FLOW_PATCH: server.mjs crashes after writing a response and then falling through to write another one. Your next tool call MUST write `server.mjs`; do not edit openapi.yaml or contract-test.mjs for this failure.',
      reasonLine,
      'Patch every route branch so it returns immediately after `res.end(...)`, `sendJson(...)`, or `sendError(...)`. Use `return sendError(...)` for 404 branches such as unknown `/books/{id}` and unknown `/authors/{id}/books`.',
      'Do not let a request continue into the catch-all after sending a route-specific 404. The independent smoke test calls `/books/999` and `/authors/999/books`; both must return one JSON error response without crashing.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (/GET \/books[^\n]*(?:status:?\s*401|got 401|failed with status:?\s*401)/i.test(reason)) {
    return [
      'BOOKSTORE_SERVER_GET_AUTH_PATCH: server.mjs is returning 401 for a public read endpoint. Your next tool call MUST write `server.mjs`; do not edit openapi.yaml or contract-test.mjs for this failure.',
      reasonLine,
      'Remove the top-level Authorization/Bearer guard that runs before GET routes. The service stub implements only GET /books, GET /books/{id}, and GET /authors/{id}/books, and those GET endpoints must work without an Authorization header.',
      'Bearer auth is required only as OpenAPI documentation on POST /books, PATCH /books/{id}, and DELETE /books/{id}. Do not enforce bearer auth in server.mjs for GET requests.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (/Number\(url\.searchParams\.get\("limit"\)\)|Number\(null\)|empty slice/i.test(reason)) {
    return [
      'BOOKSTORE_SERVER_LIMIT_PATCH: server.mjs is computing the default page limit incorrectly. Your next tool call MUST write `server.mjs`; do not edit openapi.yaml or contract-test.mjs for this failure.',
      reasonLine,
      '`Number(url.searchParams.get("limit")) ?? 10` does not default missing limits to 10 because `Number(null)` is 0. Choose the default before converting to Number: `const limitParam = url.searchParams.get("limit"); const limit = limitParam === null ? 10 : Number(limitParam);`.',
      'GET /books with no query must return all 5 books in the Pagination envelope, not an empty page. If you compute `nextCursor` from the page slice, guard empty slices before reading `slice[slice.length - 1].id`.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (/Illegal return statement|top-level return statement|top-level `return`/i.test(reason)) {
    return [
      'BOOKSTORE_CONTRACT_SYNTAX_PATCH: contract-test.mjs has one ES-module syntax bug. Your next tool call MUST edit `contract-test.mjs`; do not edit server.mjs, openapi.yaml, or README.md for this failure.',
      reasonLine,
      'Find the top-level branch that says `return;`, usually after `if (!port) { ... }`, and remove that return.',
      'Use this small replacement: `if (!port) { throw new Error("could not detect server port"); }`.',
      'Keep the existing `try/catch/finally` and cleanup block. Do not rewrite the whole contract test.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (
    /contract-test-passes:[\s\S]*SyntaxError:[\s\S]*(?:has already been declared|does not provide an export named|Unexpected token|Unexpected identifier)/i.test(
      reason,
    )
  ) {
    return [
      'BOOKSTORE_CONTRACT_IMPORT_REWRITE: contract-test.mjs has an ES-module syntax/import cascade. Your next tool call MUST write `contract-test.mjs`; do not edit openapi.yaml, server.mjs, or README.md before this is fixed.',
      reasonLine,
      'Do not patch another import line onto the file. Rewrite the whole contract-test.mjs once with a single import block at the top.',
      'Allowed import block: `import assert from "node:assert/strict"; import { spawn } from "node:child_process"; import { once } from "node:events";`.',
      'Each imported binding may appear exactly once. Do not import `assert`, `spawn`, `once`, or `setTimeout` again later in the file. Do not import `{ json }` from `node:util`; that export does not exist.',
      'Use Node global fetch directly; do not import node-fetch, undici, axios, node:fetch, or any npm package.',
      'Keep the real server-spawn flow: spawn `node server.mjs`, parse PORT from stdout, await that port, run GET endpoint checks, then kill and await the child in cleanup. Set `process.exitCode = passed ? 0 : 1`; do not call `process.exit(...)`.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (
    /contract-test-passes:[\s\S]*(?:process\.exit\(|process\.exit\(\.\.\.\)|printed that all contract tests passed, but the process exited nonzero during cleanup)/i.test(
      reason,
    )
  ) {
    return [
      'BOOKSTORE_CONTRACT_EXIT_REWRITE: contract-test.mjs still has process.exit-based cleanup. Your next tool call MUST write `contract-test.mjs`; do not edit openapi.yaml, server.mjs, or README.md for this failure.',
      reasonLine,
      'Do not patch one branch at a time. Rewrite contract-test.mjs once so the final file contains zero `process.exit(...)` calls.',
      'The final file may contain `process.exitCode = passed ? 0 : 1` exactly in cleanup; it must not call `process.exit` in success, failure, startup-error, catch, timeout, or finally branches.',
      'Use this cleanup shape: `let passed = false; const server = spawn("node", ["server.mjs"], { stdio: ["ignore", "pipe", "pipe"] }); try { const port = await portPromise; await runAssertions(port); passed = true; } catch (err) { console.error(err instanceof Error ? err.message : String(err)); } finally { if (!server.killed) { const closed = new Promise(resolve => server.once("close", resolve)); server.kill(); await closed; } process.exitCode = passed ? 0 : 1; }`.',
      'Keep the real server-spawn flow and global fetch. Parse PORT inside `server.stdout.on("data", ...)`, await the port before fetches, then let the async function return naturally.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    'BOOKSTORE CONTRACT PATCH: keep openapi.yaml as-is if the structural signals are passing. Patch only server.mjs and/or contract-test.mjs until `node contract-test.mjs` exits 0.',
    reasonLine,
    'The scenario checker already ran `node contract-test.mjs`, and this message means it failed. Do not reply that you are waiting for the checker; make another writeFile/replaceInFile edit to server.mjs or contract-test.mjs now.',
    'Because `.mjs` files are ES modules, use top-level imports such as `import { spawn } from "node:child_process";` and `import { once } from "node:events";`. Do not call `require(...)` in server.mjs or contract-test.mjs.',
    'Required server.mjs pattern: `server.listen(process.env.PORT || 0, () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : Number(process.env.PORT); console.log(`listening on PORT=${port}`); });`.',
    "Required contract-test.mjs pattern: attach `server.stdout.on('data', chunk => { buffer += chunk; const match = buffer.match(/PORT=(\\d+)/); if (match) resolve(Number(match[1])); })`. Do not wait for `server.stdout.on('end')` to discover the port.",
    'Do not await server close/exit before running assertions. The spawned server stays alive while tests run. Await the PORT promise, run fetches while the child is alive, then clean up in finally by creating the close promise before `server.kill()` and awaiting it.',
    'Use root endpoint URLs in contract-test.mjs: `http://127.0.0.1:${port}/books`, `/books/{id}`, and `/authors/{id}/books`. Do not prepend `/api/v1`; the OpenAPI paths and evaluator smoke test use root paths.',
    'Thread the discovered `port` or `baseUrl` into every test helper. Do not leave helper-local constants like `const baseUrl = "http://127.0.0.1:"`; that creates invalid empty-port URLs.',
    'Do not import `setTimeout` from `node:timers/promises` and then call `setTimeout(checkPort, 100)`. Use the global callback timer for polling, or use the promise timer as `await setTimeout(100)` with the delay first.',
    'In server.mjs, route `/authors/:id/books` as `pathSegments[0] === "authors"` and `pathSegments[2] === "books"`; `pathSegments[1]` is the numeric author id, not the word "books".',
    'In server.mjs, do not let a broad `if (req.method === "GET")` inside the `/books` branch catch `/books/1`. Route by path length: GET `/books` only when `pathSegments.length === 1`; GET `/books/{id}` only when `pathSegments.length === 2` and must return a single Book object, not `{ data, pagination }`.',
    'In contract-test.mjs, avoid hard-coded author ids unless server.mjs actually has that id. Prefer: fetch `/books`, take `const authorId = books.data[0].authorId`, then call `/authors/${authorId}/books`.',
    schemaInContractRule,
    'Error schema checks must accept `{ code: number, message: string }`; do not reject `typeof error.message === "string"`.',
    'Book schema checks must match the server response exactly: every Book object uses `id`, `title`, `authorId`, `publishedYear`, and `isbn`. Do not use `year` in server.mjs or contract-test.mjs.',
    'Pagination checks must use one exact envelope for both GET /books and GET /authors/{id}/books: `{ data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }`. Do not use `nextCursor`, and do not return `{ data, author }` from the author-books endpoint.',
    'In server.mjs, `pagination.cursor` must be `String(nextBookIdOrIndex)` or null. Do not return a numeric cursor.',
    'If the evaluator says the cursor page skipped or duplicated books, patch server.mjs. Do not patch contract-test.mjs to expect the bad page. The independent smoke test fetches `/books`, then `/books?limit=2`, then `/books?limit=2&cursor=<returned cursor>` and requires the second page to continue the full-list order.',
    'Keep pagination tests shape-focused. Do not hard-code `hasMore=false` for a cursor page unless that exact page is final for your own server logic.',
    'When validating array fields in contract-test.mjs, use Array.isArray(value). Do not compare `typeof value` to `"array"` because JavaScript arrays have typeof `"object"`.',
    'Do not start fetches until the port promise has resolved to a number from the server stdout PORT=NNNN line.',
    'contract-test.mjs should call only the GET endpoints and GET-based 404 checks. Do not runtime-test POST, PATCH, or DELETE; those mutation endpoints only need bearerAuth references in openapi.yaml for this eval.',
    'Remove every `process.exit(...)` call from contract-test.mjs. Use this cleanup shape exactly: `let passed = false; const server = spawn("node", ["server.mjs"], { stdio: ["ignore", "pipe", "pipe"] }); try { /* discover port and run assertions; set passed = true only after all checks pass */ } catch (err) { console.error(err instanceof Error ? err.message : String(err)); } finally { if (!server.killed) { const closed = new Promise(resolve => server.once("close", resolve)); server.kill(); await closed; } process.exitCode = passed ? 0 : 1; }`. Let the async function return; do not call process.exit in success, failure, startup-error, catch, or finally branches.',
    'If contract-test.mjs uses a `passed` flag, initialize it false and set `passed = true` only after all endpoint checks pass. Do not leave it false on the success path.',
    'Do not create or edit extra files such as script.js or Node.js. They are ignored by the checker; patch the actual deliverable file that is failing.',
    'Use Node global fetch only; do not import `node:fetch`, undici, node-fetch, axios, or any npm package.',
    'Do not call `run_nodejs_script` for contract-test.mjs; that MCP tool is sandboxed and cannot run scripts that spawn server.mjs. Finish the files and let the scenario checker run `node contract-test.mjs` directly.',
  ]
    .filter(Boolean)
    .join(' ');
}

export function bookstoreFeedbackPath(
  failReason: string,
  paths: { yaml?: string; server?: string; contract?: string },
): string {
  if (
    /yaml-parses|openapi-3\.1|all-paths-present|schemas-named|auth-on-mutations/i.test(failReason)
  ) {
    return paths.yaml ?? 'openapi.yaml';
  }
  if (
    /contract-test\.mjs (?:never spawns|assumes server\.mjs|waits for a harness-provided port|could not connect before receiving an HTTP response|fetches a fixed local port|hard-codes a local port|builds fetch URLs with an empty port|discovers the server port but builds fetch URLs without it|starts fetches before the server port|creates a mock HTTP server|uses the browser global window|calls node:events once|kills the spawned server|builds BASE_URL|calls ChildProcess\.kill|expects GET \/books|expects list responses|compares typeof to "integer"|expects Book\.id|contains a top-level return statement|uses `return;` in a top-level port-failure branch)/i.test(
      failReason,
    ) ||
    /SyntaxError:\s*Illegal return statement/i.test(failReason) ||
    /contract-test exit \d+: the test ran and reported a failing check/i.test(failReason) ||
    /contract-test\.mjs still expects GET \/authors\/\{id\}\/books to return a bare array/i.test(
      failReason,
    )
  ) {
    return paths.contract ?? 'contract-test.mjs';
  }
  if (
    /server\.mjs|evaluator smoke|GET\s+\/authors|GET\s+\/books|pagination\.cursor|pagination\.hasMore|hasMore is not boolean|cursor page skipped|authorId/i.test(
      failReason,
    )
  ) {
    if (/\/authors\/\d+\/books[^\n]*Expected status 200, got 404/i.test(failReason)) {
      return paths.contract ?? paths.server ?? 'contract-test.mjs';
    }
    return paths.server ?? 'server.mjs';
  }
  return paths.contract ?? 'contract-test.mjs';
}

/**
 * B4: pair the FIRST failing contract assertion with the offending code
 * snippet so the model never has to re-derive WHERE the defect lives —
 * the July matrix's bookstore fails were all "correct feedback, wrong
 * edit site" loops (server envelope fixed, contract assertion stale; or
 * vice versa). Heuristic and fail-open at every step: structural yaml
 * reasons and reasons with nothing assertion-shaped return undefined and
 * the existing directives stand alone.
 */
export function bookstoreAssertionSnippet(
  failReason: string,
  files: { server?: { path: string; text: string }; contract?: { path: string; text: string } },
): string | undefined {
  // Structural spec failures already get surgical directives; snippets
  // only make sense for runtime contract failures.
  if (
    /yaml-parses|openapi-3\.1|all-paths-present|schemas-named|auth-on-mutations/i.test(failReason)
  ) {
    return undefined;
  }

  const assertionLine =
    /evaluator smoke failed:\s*(.+?)(?:;\s*server stderr|$)/i.exec(failReason)?.[1]?.trim() ??
    /Failing check\(s\):\s*([^|]+)/i.exec(failReason)?.[1]?.trim() ??
    /contract-test exit \d+:\s*(.+)$/i.exec(failReason)?.[1]?.trim();
  if (!assertionLine) return undefined;
  const assertion = assertionLine.slice(0, 200);

  // Search token: the route path when the assertion names one, else the
  // first contract-vocabulary keyword it mentions.
  const routeMatch = /\/(?:books|authors)[\w/{}-]*/i.exec(assertion)?.[0];
  const routeToken = routeMatch?.replace(/\{[^}]*\}/g, '').replace(/\/+$/, '');
  const keyword = [
    'hasMore',
    'cursor',
    'pagination',
    'publishedYear',
    'isbn',
    'authorId',
    'total',
  ].find((k) => assertion.toLowerCase().includes(k.toLowerCase()));
  const token = routeToken && routeToken.length > 1 ? routeToken : keyword;
  const targetPath = bookstoreFeedbackPath(failReason, {
    server: files.server?.path,
    contract: files.contract?.path,
  });
  const target =
    files.server && targetPath === files.server.path
      ? files.server
      : files.contract && targetPath === files.contract.path
        ? files.contract
        : (files.server ?? files.contract);

  if (!target || !token) {
    return `Failing assertion: ${assertion}\nSearch \`${targetPath}\` for the code handling this route/field and fix exactly that; do not change unrelated routes or tests.`;
  }

  const lines = target.text.split(/\r?\n/);
  const hitIndex = lines.findIndex((line) => line.includes(token));
  if (hitIndex < 0) {
    return `Failing assertion: ${assertion}\nSearch \`${target.path}\` for the code handling \`${token}\` and fix exactly that; do not change unrelated routes or tests.`;
  }
  const start = Math.max(0, hitIndex - 3);
  const end = Math.min(lines.length, hitIndex + 4, start + 12);
  const snippet = lines.slice(start, end).join('\n').slice(0, 600);
  return [
    `Failing assertion: ${assertion}`,
    `Offending code (\`${target.path}\` lines ${start + 1}-${end}):`,
    '```',
    snippet,
    '```',
    'Fix exactly this code path; do not change unrelated routes or tests.',
  ].join('\n');
}

export function shouldPostBookstoreFeedback(failReason: string): boolean {
  return !/\b(?:server\.mjs|contract-test\.mjs|README\.md) not present yet\b/i.test(failReason);
}

export function shouldPostBookstoreMissingServerFeedback(opts: {
  failReason: string | undefined;
  signals: readonly string[];
}): boolean {
  if (!opts.failReason || !/\bserver\.mjs not present yet\b/i.test(opts.failReason)) {
    return false;
  }
  const have = new Set(opts.signals);
  return [
    'yaml-parses',
    'openapi-3.1',
    'all-paths-present',
    'schemas-named',
    'auth-on-mutations',
  ].every((signal) => have.has(signal));
}

export function bookstoreMissingServerDirective(): string {
  return [
    'BOOKSTORE_SERVER_MISSING_FILE: the OpenAPI structural checks are passing. The next required deliverable is `server.mjs`.',
    'Your next assistant action MUST be `writeFile({ path: "server.mjs", content: ... })`; do not reply with a plan, do not rewrite openapi.yaml, and do not write contract-test.mjs first.',
    'Write a complete dependency-free `.mjs` server using only Node built-ins. Use `node:http`, a hardcoded dataset of 5 books across 3 numeric authors, and public GET routes only.',
    'Required GET routes: `/books`, `/books/{id}`, and `/authors/{id}/books`. Mutation endpoints only need bearerAuth documentation in openapi.yaml; do not enforce bearer auth in server.mjs for GET requests.',
    'Every Book object must use exactly `id`, `title`, `authorId`, `publishedYear`, and `isbn`. List endpoints must return `{ data: Book[], pagination: { limit: number, cursor: string | null, total: number, hasMore: boolean } }`.',
    'Bind with `server.listen(process.env.PORT || 0, ...)` and log the actual assigned port as `PORT=<number>` from `server.address().port` so contract-test.mjs can discover it.',
  ].join(' ');
}

export function shouldPostBookstoreMissingContractFeedback(opts: {
  failReason: string | undefined;
  signals: readonly string[];
  serverPresent: boolean;
  readmePresent: boolean;
}): boolean {
  if (!opts.failReason || !/\bcontract-test\.mjs not present yet\b/i.test(opts.failReason)) {
    return false;
  }
  if (!opts.serverPresent) return false;
  const have = new Set(opts.signals);
  return [
    'yaml-parses',
    'openapi-3.1',
    'all-paths-present',
    'schemas-named',
    'auth-on-mutations',
  ].every((signal) => have.has(signal));
}

export function bookstoreMissingContractDirective(): string {
  return [
    'BOOKSTORE_CONTRACT_MISSING_FILE: all OpenAPI structural checks are passing and server.mjs/README.md exist. The only missing deliverable is `contract-test.mjs`.',
    'Your next assistant action MUST be `writeFile({ path: "contract-test.mjs", content: ... })`; do not reply with a plan, do not rewrite openapi.yaml, and do not edit server.mjs first.',
    'Write a complete dependency-free `.mjs` script using only Node built-ins plus global fetch: import `spawn` from `node:child_process` and optionally `once` from `node:events`; do not import undici, node-fetch, axios, `node:fetch`, js-yaml, or openapi.yaml.',
    'The script must spawn `node server.mjs`, resolve the port inside `server.stdout.on("data", ...)` when `/PORT=(\\d+)/` matches, await that port before fetches, then GET `/books`, `/books/{id}`, `/authors/{id}/books`, and GET-based 404 checks only.',
    'Use root URLs like `http://127.0.0.1:${port}/books`; do not prepend `/api/v1`. Derive an existing author id from the GET /books response before testing `/authors/${authorId}/books`.',
    'Validate Book fields `id`, `title`, `authorId`, `publishedYear`, `isbn`, and the list envelope `{ data: Book[], pagination: { limit, cursor, total, hasMore } }`; use `Array.isArray` for arrays and accept `cursor` as string or null.',
    'Cleanup must create the child close/exit waiter before `server.kill()`, await it, set `process.exitCode = passed ? 0 : 1`, and let the async function return. Do not call `process.exit()`.',
  ].join(' ');
}

async function runContractGate(
  ctx: EvalContext,
  client: GezelClient,
  projectId: string,
  hash: string,
  contractTestRelPath: string,
  serverRelPath: string,
  log: (line: string) => void,
): Promise<{ contractOk: boolean; reason?: string }> {
  const cached = runCache.get(ctx);
  if (cached && cached.hash === hash) {
    return { contractOk: cached.contractOk, reason: cached.reason };
  }

  const tmp = await mkdtemp(`${tmpdir()}/gezel-eval-bookstore-`);
  try {
    // Materialize every text file under the project workspace into the
    // tmp tree, preserving the model's chosen subdirectory layout (the
    // sniff already accepted whatever structure the model picked).
    const files = await client.listProjectWorkspace(projectId, undefined, true);
    for (const f of files.files) {
      if (f.isDirectory) continue;
      if (!/\.(mjs|js|yaml|yml|json|md)$/.test(f.path)) continue;
      const blob = await client.fetchProjectWorkspaceBlob(projectId, f.path);
      const content = await blob.text();
      const target = join(tmp, f.path);
      await mkdir(dirname(target), { recursive: true });
      await fsWriteFile(target, content, 'utf8');
    }
    // Spawn from the directory containing contract-test.mjs — relative
    // refs to `./server.mjs` etc. work whatever subdir the model chose.
    const spawnCwd = join(tmp, dirname(contractTestRelPath));
    const env = { ...process.env };
    delete env.PORT;
    const result = await spawnAndAwait(process.execPath, ['contract-test.mjs'], {
      cwd: spawnCwd,
      env,
      timeoutMs: 45_000,
    });
    const contractOk = result.exitCode === 0;
    if (contractOk) {
      log(`[scenario] contract-test.mjs passed (${result.durationMs} ms)`);
      const smoke = await runServerSmokeGate(tmp, serverRelPath);
      if (!smoke.contractOk) {
        log(`[scenario] evaluator smoke failed: ${smoke.reason}`);
        runCache.set(ctx, { hash, contractOk: false, reason: smoke.reason });
        return smoke;
      }
      log('[scenario] evaluator server smoke passed');
      runCache.set(ctx, { hash, contractOk });
      return { contractOk };
    }
    const reason = formatContractFailure(result.exitCode, result.stdout, result.stderr);
    log(`[scenario] contract-test.mjs failed: ${reason}`);
    runCache.set(ctx, { hash, contractOk: false, reason });
    return { contractOk: false, reason };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function runServerSmokeGate(
  tmp: string,
  serverRelPath: string,
): Promise<{ contractOk: boolean; reason?: string }> {
  const serverCwd = join(tmp, dirname(serverRelPath));
  const serverFile = basename(serverRelPath);
  const env = { ...process.env, PORT: '0' };
  const child = spawn(process.execPath, [serverFile], {
    cwd: serverCwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let portResolved = false;

  const portPromise = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('server.mjs did not print listening on PORT=NNNN within 5s'));
    }, 5_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const match = stdout.match(/PORT=(\d+)/);
      if (match && !portResolved) {
        portResolved = true;
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => {
      if (!portResolved) {
        clearTimeout(timer);
        reject(err);
      }
    });
    child.once('exit', (code) => {
      if (!portResolved) {
        clearTimeout(timer);
        reject(
          new Error(
            `server.mjs exited before printing PORT (code ${String(code)}): ${stderr.slice(0, 240)}`,
          ),
        );
      }
    });
  });

  try {
    const port = await portPromise;
    await runBookstoreSmoke(port);
    return { contractOk: true };
  } catch (err) {
    let reason = err instanceof Error ? err.message : String(err);
    const stderrSummary = stderr
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(' | ');
    if (stderrSummary) {
      reason = `${reason}; server stderr: ${stderrSummary.slice(0, 800)}`;
    }
    return {
      contractOk: false,
      reason: `evaluator smoke failed: ${reason}`,
    };
  } finally {
    const closed = once(child, 'close');
    child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]).catch(
      () => {},
    );
  }
}

async function runBookstoreSmoke(port: number): Promise<void> {
  const full = await fetchJson(port, '/books');
  assertEnvelope(full.body, 'GET /books');
  if (full.status !== 200) throw new Error(`GET /books expected 200, got ${full.status}`);
  if (full.body.data.length !== 5) {
    throw new Error(`GET /books expected 5 books, got ${full.body.data.length}`);
  }

  const firstPage = await fetchJson(port, '/books?limit=2');
  assertEnvelope(firstPage.body, 'GET /books?limit=2');
  if (firstPage.status !== 200) {
    throw new Error(`GET /books?limit=2 expected 200, got ${firstPage.status}`);
  }
  if (firstPage.body.data.length !== 2) {
    throw new Error(`GET /books?limit=2 expected 2 books, got ${firstPage.body.data.length}`);
  }
  if (firstPage.body.pagination.cursor === null) {
    throw new Error('GET /books?limit=2 should return a cursor for the next page');
  }

  const cursor = firstPage.body.pagination.cursor;
  const secondPage = await fetchJson(port, `/books?limit=2&cursor=${encodeURIComponent(cursor)}`);
  assertEnvelope(secondPage.body, 'GET /books?limit=2&cursor=<cursor>');
  if (secondPage.status !== 200) {
    throw new Error(`GET /books?limit=2&cursor expected 200, got ${secondPage.status}`);
  }
  const expectedNextIds = full.body.data.slice(2, 4).map((book) => book.id);
  const actualNextIds = secondPage.body.data.map((book) => book.id);
  if (JSON.stringify(actualNextIds) !== JSON.stringify(expectedNextIds)) {
    throw new Error(
      `GET /books cursor page skipped or duplicated books: expected ids [${expectedNextIds.join(
        ', ',
      )}], got [${actualNextIds.join(', ')}]. Keep cursor semantics consistent with /books order; do not patch contract-test.mjs to expect the bad page.`,
    );
  }

  const missingBook = await fetchJson(port, '/books/999');
  if (missingBook.status !== 404) {
    throw new Error(`GET /books/999 expected 404, got ${missingBook.status}`);
  }
  assertError(missingBook.body, 'GET /books/999');

  const authorId = full.body.data[0]?.authorId;
  if (typeof authorId !== 'number') {
    throw new Error('GET /books did not return any Book with a numeric authorId');
  }
  const authorBooks = await fetchJson(port, `/authors/${authorId}/books`);
  if (authorBooks.status !== 200) {
    throw new Error(`GET /authors/${authorId}/books expected 200, got ${authorBooks.status}`);
  }
  assertEnvelope(authorBooks.body, `GET /authors/${authorId}/books`);
  if (!authorBooks.body.data.every((book) => book.authorId === authorId)) {
    throw new Error(`GET /authors/${authorId}/books returned a book with a different authorId`);
  }

  const missingAuthor = await fetchJson(port, '/authors/999/books');
  if (missingAuthor.status !== 404) {
    throw new Error(`GET /authors/999/books expected 404, got ${missingAuthor.status}`);
  }
  assertError(missingAuthor.body, 'GET /authors/999/books');
}

async function fetchJson(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} did not return JSON: ${text.slice(0, 160)}`);
  }
  if (!isRecord(body)) throw new Error(`${path} returned a non-object JSON value`);
  return { status: response.status, body };
}

function assertEnvelope(
  body: Record<string, unknown>,
  label: string,
): asserts body is {
  data: Array<{ id: number; title: string; authorId: number; publishedYear: number; isbn: string }>;
  pagination: { limit: number; cursor: string | null; total: number; hasMore: boolean };
} {
  if (!Array.isArray(body.data)) throw new Error(`${label} response data is not an array`);
  for (const book of body.data) assertBook(book, label);
  if (!isRecord(body.pagination)) throw new Error(`${label} pagination is not an object`);
  if (typeof body.pagination.limit !== 'number')
    throw new Error(`${label} pagination.limit is not a number`);
  if (body.pagination.cursor !== null && typeof body.pagination.cursor !== 'string') {
    throw new Error(`${label} pagination.cursor must be string or null`);
  }
  if (typeof body.pagination.total !== 'number')
    throw new Error(`${label} pagination.total is not a number`);
  if (typeof body.pagination.hasMore !== 'boolean') {
    throw new Error(`${label} pagination.hasMore is not a boolean`);
  }
}

function assertBook(
  book: unknown,
  label: string,
): asserts book is {
  id: number;
  title: string;
  authorId: number;
  publishedYear: number;
  isbn: string;
} {
  if (!isRecord(book)) throw new Error(`${label} contains a non-object Book`);
  if (typeof book.id !== 'number') throw new Error(`${label} Book.id is not a number`);
  if (typeof book.title !== 'string') throw new Error(`${label} Book.title is not a string`);
  if (typeof book.authorId !== 'number') {
    throw new Error(`${label} Book.authorId is not a number`);
  }
  if (typeof book.publishedYear !== 'number') {
    throw new Error(`${label} Book.publishedYear is not a number`);
  }
  if (typeof book.isbn !== 'string') throw new Error(`${label} Book.isbn is not a string`);
}

function assertError(body: Record<string, unknown>, label: string): void {
  if (typeof body.code !== 'number') throw new Error(`${label} Error.code is not a number`);
  if (typeof body.message !== 'string') throw new Error(`${label} Error.message is not a string`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const bookstoreOpenapiScenario: EvalScenario = {
  id: 'bookstore-openapi',
  description:
    'Design a small bookstore REST API: openapi.yaml (6 endpoints, bearer auth on mutations), server.mjs (Node http stub), contract-test.mjs, README.md. Gated by YAML parse + structural OpenAPI check + live server boot + contract-test exit 0.',
  prompt: [
    `Heads up: ${DEVELOPER_NAME} is designing a bookstore REST API on the`,
    `"${PROJECT_NAME}" project. The brief and missionObjectives are there.`,
    "You don't need to do anything — just confirm you've seen this note.",
  ].join(' '),
  timeoutMs: 45 * 60_000,
  // 15 min between progress events to absorb super-120b warm-up; smaller
  // models deliver turns well under this. See schema-migration.ts for
  // the broader rationale.
  progressTimeoutMs: 15 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, log, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] bookstore-api project not present yet');
      return { done: false };
    }
    const [yamlHit, serverHit, contractHit, readmeHit] = await Promise.all([
      findFileText(client, projectId, 'openapi.yaml'),
      findFileText(client, projectId, 'server.mjs'),
      findFileText(client, projectId, 'contract-test.mjs'),
      findFileText(client, projectId, 'README.md'),
    ]);
    const yaml = yamlHit?.text ?? null;
    const server = serverHit?.text ?? null;
    const contractTest = contractHit?.text ?? null;
    const readme = readmeHit?.text ?? null;

    const signals: string[] = [];
    const failures: string[] = [];

    if (yaml === null) {
      logChanged('sniff', '[scenario] openapi.yaml not present yet');
      recordSniff?.({ key: 'bookstore', score: 0, bytes: 0 });
      return { done: false };
    }

    const oa = checkOpenApi(yaml);
    if (oa.yamlParses) signals.push('yaml-parses');
    else failures.push(`yaml-parses: ${oa.parseError ?? 'not a valid YAML object'}`);
    if (oa.is31) signals.push('openapi-3.1');
    else if (oa.yamlParses) failures.push('openapi-3.1: top-level `openapi: 3.1.x` missing');
    if (oa.pathsPresent) signals.push('all-paths-present');
    else if (oa.yamlParses)
      failures.push(
        `all-paths-present: missing ${oa.missingPaths.slice(0, 3).join(', ')}${
          oa.misplacedMethods.length ? `; ${oa.misplacedMethods.slice(0, 2).join('; ')}` : ''
        }`,
      );
    if (oa.schemasPresent) signals.push('schemas-named');
    else if (oa.yamlParses)
      failures.push(`schemas-named: components.schemas missing ${oa.missingSchemas.join(', ')}`);
    if (oa.authOnMutations) signals.push('auth-on-mutations');
    else if (oa.yamlParses)
      failures.push(
        `auth-on-mutations: bearerAuth missing on ${oa.missingAuthMethods.slice(0, 3).join(', ')}`,
      );

    // Need contract-test + server present to even attempt the runtime gate.
    const structuralOk =
      signals.includes('yaml-parses') &&
      signals.includes('openapi-3.1') &&
      signals.includes('all-paths-present') &&
      signals.includes('schemas-named') &&
      signals.includes('auth-on-mutations');
    if (server === null) failures.push('server.mjs not present yet');
    if (contractTest === null) failures.push('contract-test.mjs not present yet');

    let runtimeReason: string | undefined;
    if (structuralOk && server !== null && contractTest !== null && contractHit && serverHit) {
      const staticIssue = detectContractStaticIssue(server, contractTest);
      if (staticIssue) {
        failures.push(`contract-test-passes: ${staticIssue}`);
        runtimeReason = staticIssue;
      } else {
        const hash = [yaml, server, contractTest]
          .map((text) => `${text.length.toString(36)}.${simpleHash(text)}`)
          .join('/');
        const gates = await runContractGate(
          ctx,
          client,
          projectId,
          hash,
          contractHit.path,
          serverHit.path,
          log,
        );
        if (gates.contractOk) signals.push('contract-test-passes');
        else failures.push(`contract-test-passes: ${gates.reason ?? 'exit nonzero'}`);
        runtimeReason = gates.reason;
      }
    }

    const readmePresent = readme !== null && readme.length >= 256;
    if (readmePresent) signals.push('readme-present');

    const totalBytes =
      (yaml?.length ?? 0) +
      (server?.length ?? 0) +
      (contractTest?.length ?? 0) +
      (readme?.length ?? 0);
    const score = signals.length;
    const failReason = failures.length > 0 ? failures[0] : runtimeReason;

    logChanged(
      'sniff',
      `[scenario] bookstore bytes=${totalBytes} score=${score}/7 signals=${signals.join(',') || 'none'}${failReason ? ` failReason="${failReason}"` : ''}`,
    );
    recordSniff?.({ key: 'bookstore', score, bytes: totalBytes, failReason });

    if (
      signals.includes('contract-test-passes') &&
      signals.includes('yaml-parses') &&
      signals.includes('openapi-3.1') &&
      signals.includes('all-paths-present') &&
      signals.includes('schemas-named') &&
      signals.includes('auth-on-mutations')
    ) {
      return {
        done: true,
        success: true,
        reason: `all hard signals firing (signals: ${signals.join(', ')})`,
      };
    }

    // Forward concrete failures into team chat so the model has
    // something to act on (e.g. "openapi-3.1: top-level openapi missing"
    // or "contract-test exit 1: book.title is missing"). Dedupes by
    // (filePath, missing-signals, failReason).
    if (shouldPostBookstoreMissingServerFeedback({ failReason, signals })) {
      await postMissingDeliverableFeedback(ctx, 'server.mjs', {
        minPolls: 1,
        repeatEvery: 8,
        maxNudges: 2,
        projectId,
        repairDirective: bookstoreMissingServerDirective(),
      });
    }

    if (
      shouldPostBookstoreMissingContractFeedback({
        failReason,
        signals,
        serverPresent: server !== null,
        readmePresent,
      })
    ) {
      await postMissingDeliverableFeedback(ctx, 'contract-test.mjs', {
        minPolls: 1,
        repeatEvery: 8,
        maxNudges: 2,
        projectId,
        repairDirective: bookstoreMissingContractDirective(),
      });
    }

    if (failReason && shouldPostBookstoreFeedback(failReason)) {
      const allHardSignals = [
        'yaml-parses',
        'openapi-3.1',
        'all-paths-present',
        'schemas-named',
        'auth-on-mutations',
        'contract-test-passes',
      ];
      const missing = allHardSignals.filter((s) => !signals.includes(s));
      const feedbackPath = bookstoreFeedbackPath(failReason, {
        yaml: yamlHit?.path,
        server: serverHit?.path,
        contract: contractHit?.path,
      });
      const sourceText = [
        `# openapi.yaml\n${yaml ?? ''}`,
        `# server.mjs\n${server ?? ''}`,
        `# contract-test.mjs\n${contractTest ?? ''}`,
        `# README.md\n${readme ?? ''}`,
      ].join('\n\n---\n\n');
      const assertionSnippet = bookstoreAssertionSnippet(failReason, {
        ...(serverHit && server ? { server: { path: serverHit.path, text: server } } : {}),
        ...(contractHit && contractTest
          ? { contract: { path: contractHit.path, text: contractTest } }
          : {}),
      });
      const baseDirective = bookstoreRepairDirective(failReason);
      await postSniffFeedback(
        ctx,
        feedbackPath,
        {
          ok: false,
          signals,
          score,
          failReason,
          missingRequiredSignals: missing,
        },
        {
          repairDirective: assertionSnippet
            ? `${baseDirective}\n\n${assertionSnippet}`
            : baseDirective,
          dedupeToken: simpleHash(sourceText),
          projectId,
          sourceText,
        },
      );
    }
    return { done: false };
  },
};
