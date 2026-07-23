import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { promisify } from 'node:util';
import type { GateCheck, StepSniff } from '@bendyline/gezel';
import { evaluateGate } from '@bendyline/gezel-service';
import {
  type WorkspaceLike,
  containsPattern,
  cssMinBytes,
  csvShape,
  dataTableSniff,
  esmImports,
  extractInlineScripts,
  fileCountByExt,
  fileMinBytes,
  htmlCompleteSniff,
  htmlGameSniff,
  jsonPathEquals,
  jsonValid,
  notContainsPattern,
  totalMinBytes,
  unsupportedClaims,
  validateScriptSyntax,
} from '@bendyline/gezel/checks';
import { load as parseYaml } from 'js-yaml';
import ts from 'typescript';
import type { CraftbookEvalGateCheck, PrometheusAlertsGateCheck } from './types.ts';

const execFileAsync = promisify(execFile);

export type CraftbookEvalWorkspace = WorkspaceLike;

export interface CraftbookEvalGateResult {
  pass: boolean;
  failures: string[];
}

async function delegateToRuntimeEvaluator(
  check: GateCheck,
  ws: CraftbookEvalWorkspace,
): Promise<string | null> {
  const result = await evaluateGate([check], ws);
  if (result.pass) return null;
  return result.failures[0] ?? `gate check ${check.kind} failed`;
}

export async function evaluateCraftbookGateChecks(
  checks: readonly CraftbookEvalGateCheck[],
  ws: CraftbookEvalWorkspace,
): Promise<CraftbookEvalGateResult> {
  const failures: string[] = [];
  for (const check of checks) {
    const failure = await evaluateOne(check, ws);
    if (failure) failures.push(failure);
  }
  return { pass: failures.length === 0, failures };
}

async function evaluateOne(
  check: CraftbookEvalGateCheck,
  ws: CraftbookEvalWorkspace,
): Promise<string | null> {
  switch (check.kind) {
    case 'minBytes': {
      const result = await fileMinBytes(ws, check.file, check.bytes);
      return result.ok ? null : result.detail;
    }
    case 'totalMinBytes': {
      const result = await totalMinBytes(ws, check.files, check.bytes);
      return result.ok ? null : result.detail;
    }
    case 'fileCount': {
      const result = await fileCountByExt(ws, check.ext, check.min, check.dir);
      return result.ok ? null : result.detail;
    }
    case 'cssMinBytes': {
      const result = await cssMinBytes(ws, check.bytes, check.file);
      return result.ok ? null : result.detail;
    }
    case 'sniff': {
      const content = await ws.read(check.file);
      if (content === null) return `${check.file} not found`;
      const result = runCoreSniff(check.sniff, content);
      return result.ok ? null : result.detail;
    }
    case 'jsonPathEquals': {
      const result = await jsonPathEquals(ws, check.file, check.path, check.value, check.label);
      return result.ok ? null : result.detail;
    }
    case 'csvShape': {
      const content = await ws.read(check.file);
      const result = csvShape(content, {
        ...(check.requiredColumns ? { requiredColumns: check.requiredColumns } : {}),
        ...(check.exactColumns ? { exactColumns: check.exactColumns } : {}),
        ...(check.minRows !== undefined ? { minRows: check.minRows } : {}),
        ...(check.consistentColumns !== undefined
          ? { consistentColumns: check.consistentColumns }
          : {}),
        ...(check.allowedValues ? { allowedValues: check.allowedValues } : {}),
      });
      return result.ok ? null : `${check.file}: ${result.detail}`;
    }
    case 'contains': {
      const result = await containsPattern(ws, check.file, check.pattern, check.flags, check.label);
      return result.ok ? null : result.detail;
    }
    case 'notContains': {
      const result = await notContainsPattern(
        ws,
        check.file,
        check.pattern,
        check.flags,
        check.label,
      );
      return result.ok ? null : result.detail;
    }
    case 'unsupportedClaims': {
      const result = await unsupportedClaims(
        ws,
        check.file,
        check.sourceFiles,
        check.patterns,
        check.flags !== undefined ? { flags: check.flags } : {},
      );
      return result.ok ? null : result.detail;
    }
    case 'prometheusAlerts':
      return evaluatePrometheusAlerts(check, ws);
    case 'nodeScriptPasses':
      return evaluateNodeScriptPasses(check, ws);
    case 'jsParses': {
      const file = check.file ?? 'index.html';
      const content = await ws.read(file);
      if (content === null) return `${file} not found`;
      const parsed = validateScriptSyntax(extractInlineScripts(content));
      if (parsed.totalBytes === 0) return null;
      return parsed.allParse
        ? null
        : `${file}: inline JavaScript does not parse (${parsed.firstError ?? 'syntax error'})`;
    }
    case 'esmImports': {
      const content = await ws.read(check.file);
      if (content === null) return `${check.file} not found`;
      const result = esmImports(content, check.file);
      return result.ok ? null : result.detail;
    }
    case 'sourceParses': {
      const content = await ws.read(check.file);
      if (content === null) return `${check.file} not found (needed for the source-parse check)`;
      if (/\.html?$/i.test(check.file)) {
        const parsed = validateScriptSyntax(extractInlineScripts(content));
        if (parsed.totalBytes === 0 || parsed.allParse) return null;
        return `${check.file}: inline JavaScript does not parse (${parsed.firstError ?? 'syntax error'}).`;
      }
      const output = ts.transpileModule(content, {
        reportDiagnostics: true,
        fileName: check.file,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      const firstError = (output.diagnostics ?? []).find(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
      if (!firstError) return null;
      let position = '';
      if (firstError.file && firstError.start !== undefined) {
        const line = firstError.file.getLineAndCharacterOfPosition(firstError.start);
        position = ` at line ${line.line + 1}:${line.character + 1}`;
      }
      const message = ts.flattenDiagnosticMessageText(firstError.messageText, ' ');
      return `${check.file} does not parse: ${message}${position} - the file will not load until this is fixed (commonly a truncated file or an unbalanced brace).`;
    }
    default:
      // Every remaining core gate-check kind (recordSchema, tableShape,
      // valuesSubsetOf, valueGrounding, citationsResolve, judge, …)
      // delegates to the RUNTIME evaluator — one implementation, one
      // verdict prose, zero drift between what a craftbook gate enforces
      // in production and what its eval sidecar grades. No deps injected:
      // `judge` fail-opens (advisory, matching eval policy) and `nodeRuns`
      // fail-closes with an explanatory rejection. Wild-caught
      // (craftbook-receipt-intake trial: "unsupported gate check kind:
      // recordSchema" burned four repair rounds on a schema-valid check
      // this switch simply never learned).
      return delegateToRuntimeEvaluator(check as GateCheck, ws);
  }
}

async function evaluateNodeScriptPasses(
  check: Extract<CraftbookEvalGateCheck, { kind: 'nodeScriptPasses' }>,
  ws: CraftbookEvalWorkspace,
): Promise<string | null> {
  const script = normalizeWorkspacePath(check.script);
  if (!script) return `nodeScriptPasses script path is unsafe: ${check.script}`;
  const scriptContent = await ws.read(script);
  if (scriptContent === null) return `${script} not found`;

  const root = await mkdtemp(join(tmpdir(), 'gezel-craftbook-node-'));
  try {
    for (const filePath of await ws.list()) {
      const normalized = normalizeWorkspacePath(filePath);
      if (!normalized || normalized.startsWith('.gezel/')) continue;
      const content = await ws.read(normalized);
      if (content === null) continue;
      const outPath = join(root, normalized);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, content);
    }

    try {
      const output = await execFileAsync(process.execPath, [script], {
        cwd: root,
        timeout: check.timeoutMs ?? 10_000,
        maxBuffer: 1024 * 1024,
      });
      const failureOutput = nodeExecSuccessFailureDetail(output.stdout, output.stderr);
      if (failureOutput) {
        return `${script} reported failure output despite exit 0: ${failureOutput}\nRepair hint: Let assertion failures throw out of the test process, or set process.exitCode = 1 when a test case fails. Do not catch assertion errors only to print them and continue.`;
      }
      const missingOutput = missingRequiredNodeOutput(check, output.stdout, output.stderr);
      if (missingOutput) {
        return `${script} ${missingOutput}\nRepair hint: Make sure \`${script}\` executes the tests when run with \`node ${script}\`; do not only define or export test functions. Add explicit console output after each required assertion group passes, for example \`console.log("Pagination test passed")\`, \`console.log("Auth failure test passed")\`, and similar labels. Do not only leave these names in comments or assertion messages that print only on failure.`;
      }
      return null;
    } catch (err) {
      const timeoutMs = check.timeoutMs ?? 10_000;
      // A timeout kill (SIGTERM from execFileAsync's `timeout`) is NOT a
      // logic/assertion failure — surfacing it as one false-fails a
      // correct-but-slow server (Theme E / E3 calibration). The dominant
      // real cause is a server that never closed, so the process hangs
      // until killed; name that specifically (Law 3) instead of a generic
      // "did not pass".
      if (isNodeExecTimeout(err)) {
        return `${script} was killed after ${timeoutMs}ms without exiting. This is a timeout, not an assertion failure — do NOT rewrite your test logic. Two usual causes, both fixable: (1) a server that never closes — after the tests finish (in a \`finally\`), call \`server.close()\` so the process exits; (2) hanging on server lifecycle — resolve the assigned port inside \`server.listen(0, () => ...)\` with \`server.address().port\` and do not wait for a \`listening\` event after \`listen()\` already fired. If your logic is already correct and the host is simply slow, this passes on retry.`;
      }
      const detail = nodeExecErrorDetail(err);
      const hint = nodeExecRepairHint(detail);
      return `${script} did not pass when run with node: ${detail}${hint ? `\nRepair hint: ${hint}` : ''}`;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function normalizeWorkspacePath(path: string): string | null {
  const normalized = normalize(path).replace(/\\/g, '/');
  if (isAbsolute(path) || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized === '.' ? null : normalized;
}

/**
 * True when a node-script execution error is a timeout kill (the
 * `timeout` option fires SIGTERM). `killed` is the reliable signal;
 * `signal === 'SIGTERM'` is the fallback for wrappers that drop `killed`.
 */
function isNodeExecTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { killed?: boolean; signal?: string };
  return record.killed === true || record.signal === 'SIGTERM';
}

function nodeExecErrorDetail(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const record = err as {
    message?: string;
    code?: string | number;
    signal?: string;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  };
  const parts = [
    record.code !== undefined ? `exit=${record.code}` : null,
    record.signal ? `signal=${record.signal}` : null,
    record.message,
    bufferishToString(record.stderr),
    bufferishToString(record.stdout),
  ]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .map((part) => part.trim());
  const joined = parts.join('\n').slice(0, 2000);
  return joined || 'unknown node execution failure';
}

function nodeExecSuccessFailureDetail(
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined,
): string | null {
  const output = [bufferishToString(stderr), bufferishToString(stdout)]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join('\n')
    .trim();
  if (!output) return null;
  if (!/\b(AssertionError|ERR_ASSERTION|Failed:|FAILED|FAIL)\b/i.test(output)) return null;
  return output.slice(0, 2000);
}

function missingRequiredNodeOutput(
  check: Extract<CraftbookEvalGateCheck, { kind: 'nodeScriptPasses' }>,
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined,
): string | null {
  if (!check.requiredOutput || check.requiredOutput.length === 0) return null;
  const output = [bufferishToString(stdout), bufferishToString(stderr)]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join('\n');
  for (const requirement of check.requiredOutput) {
    const pattern = new RegExp(requirement.pattern, requirement.flags);
    if (!pattern.test(output)) {
      return `output is missing required content${requirement.label ? `: ${requirement.label}` : ` /${requirement.pattern}/`}`;
    }
  }
  return null;
}

function bufferishToString(value: string | Buffer | undefined): string | null {
  if (value === undefined) return null;
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

function nodeExecRepairHint(detail: string): string | null {
  if (/ECONNREFUSED\s+127\.0\.0\.1:80/.test(detail) && /listening.*:0/i.test(detail)) {
    return 'When a server listens on port 0, read the assigned port with `server.address().port` after `listen()` resolves and build test request URLs with that actual port, not port 0 or an empty/default port.';
  }
  if (/ERR_MODULE_NOT_FOUND/.test(detail) && /node-fetch/.test(detail)) {
    return 'Do not import `node-fetch` in generated contract tests. Node 18+ provides global `fetch`; remove the dependency import and call `fetch()` directly so the offline eval can run without package installs.';
  }
  if (/ERR_MODULE_NOT_FOUND/.test(detail) && /server\.mjs/.test(detail)) {
    return 'Ensure the generated server file exists at `server.mjs` and import it from tests with `import { createBookstoreServer } from "./server.mjs"` after writing both files.';
  }
  if (/ERR_MODULE_NOT_FOUND/.test(detail) && /\/server['"\s]/.test(detail)) {
    return 'The contract test is importing `./server` without the `.mjs` extension. Change it to `import { createBookstoreServer } from "./server.mjs"` and make sure `server.mjs` exists.';
  }
  if (/ReferenceError:\s+createBookstoreServer is not defined/.test(detail)) {
    return 'The contract test calls `createBookstoreServer` without importing that binding. Add a top-level named ESM import: `import { createBookstoreServer } from "./server.mjs";` and remove any dynamic/string-only references that do not create the binding.';
  }
  const missingReference = detail.match(/ReferenceError:\s+([A-Za-z_$][\w$]*) is not defined/);
  if (missingReference) {
    if (/^(?:port|baseUrl|url)$/.test(missingReference[1] ?? '')) {
      return contractTestWholeFileRewriteHint(
        `The contract test references \`${missingReference[1]}\` outside the scope where it was created`,
      );
    }
    return `The generated code references \`${missingReference[1]}\` outside its scope. Define it once in module scope before the functions that use it, or pass it explicitly into those functions; do not patch with placeholder comments or delete the state/token declaration.`;
  }
  if (/ERR_SERVER_ALREADY_LISTEN|Listen method has been called more than once/i.test(detail)) {
    return contractTestWholeFileRewriteHint(
      'The contract test starts the same HTTP server more than once',
    );
  }
  if (/Identifier 'createBookstoreServer' has already been declared/.test(detail)) {
    return '`server.mjs` appears to import itself and then export the same `createBookstoreServer` name. Remove the self-import from `server.mjs`; define and export `createBookstoreServer` exactly once.';
  }
  const duplicateIdentifier = detail.match(
    /SyntaxError:\s+Identifier ['"]([^'"]+)['"] has already been declared/,
  );
  if (duplicateIdentifier) {
    const identifier = duplicateIdentifier[1] ?? '';
    if (
      /contract-test\.mjs/i.test(detail) ||
      /^(?:assert|createBookstoreServer|server|port|baseUrl|url|response|postMutationListResponse)$/i.test(
        identifier,
      )
    ) {
      return [
        `The script declares \`${identifier}\` more than once in the same scope.`,
        contractTestWholeFileRewriteHint(
          'Earlier patches likely inserted duplicate contract-test sections',
        ),
      ].join(' ');
    }
    return `The script declares \`${duplicateIdentifier[1]}\` more than once in the same scope. Re-read the file and remove every duplicated declaration or repeated surrounding block. If earlier patches inserted duplicate test sections, replace the file once with one clean complete version instead of adding another block.`;
  }
  if (/ERR_INVALID_URL/.test(detail) && /input:\s*['"]\/books/.test(detail)) {
    return 'In a Node `http.createServer` request handler, `req.url` is relative. Parse it with a base URL such as `new URL(req.url, `http://${req.headers.host ?? "localhost"}`)` instead of `new URL(req.url)`.';
  }
  if (/\/api\/v1\/books|Endpoint \/api\/v1/i.test(detail)) {
    return 'The eval API uses exact bare paths only: `/books`, `/books/{id}`, and `POST /books`. Remove every `/api/v1` prefix from OpenAPI, server routes, and contract-test request URLs.';
  }
  if (
    /Failed to parse URL from http:\/\/localhost:undefined\/books|localhost:undefined/i.test(detail)
  ) {
    return 'The contract test is building request URLs before it has the assigned port. Start the server with `await new Promise(resolve => server.listen(0, () => resolve(server.address().port)))`, then build `baseUrl` from that resolved port before any fetch calls.';
  }
  if (/\bECONNRESET\b|socket hang up/i.test(detail)) {
    return 'The test opened an HTTP connection that the server closed before a response. In Node 18+, use the built-in global `fetch()` directly in contract tests; do not define a custom fetch wrapper around `node:http`. If you use `http.request`, write the request body and call `req.end()`.';
  }
  if (/TypeError:\s+fetch failed|fetch failed/i.test(detail)) {
    if (/Running Contract Tests on http:\/\/localhost:\d+/i.test(detail)) {
      return 'The server has an assigned listen(0) port, but the request helper is still probably building URLs without that port. Pass the resolved `baseUrl` into the helper and call `new URL(path, baseUrl)` or `${baseUrl}${path}`; do not use `new URL(path, "http://localhost")` or any plain localhost URL that drops `server.address().port`.';
    }
    return 'The contract test built a request URL for a server that is not reachable. Start one `createBookstoreServer()` instance, resolve `baseUrl` inside `server.listen(0, () => ...)` from `server.address().port`, pass that `baseUrl` into request helpers, and only close the server in `finally` after all fetch calls finish.';
  }
  if (/Pagination should indicate more items are available|hasMore/i.test(detail)) {
    return 'Do not assert `hasMore: true` on an unpaginated `GET /books` response. In `contract-test.mjs`, request `/books?limit=2` before asserting the response includes two items and `pagination.hasMore === true`.';
  }
  if (
    /GET \/books\/bk-1 should return the correct book ID|undefined\s*- ['"]bk-1['"]/i.test(detail)
  ) {
    return 'The seeded book lookup is mismatched. Store seeded books under the same hyphenated IDs exposed by the API (`bk-1`, `bk-2`, `bk-3`) or look them up with `book.id === bookId`; `GET /books/{id}` must return the book object itself, not an error envelope.';
  }
  if (
    /POST \/books should return 201 on success|Created book title mismatch|(?:400|401|403) !== 201/i.test(
      detail,
    )
  ) {
    return 'The create-book request is not reaching the server with both JSON body and bearer auth. If `contract-test.mjs` wraps `fetch`, merge all request options into the fetch call, including `method`, `headers`, and `body`; do not pass headers or body to a helper signature that ignores them.';
  }
  if (/Should be 401 Unauthorized|expected 401|200 !== 401|200 !== 403/i.test(detail)) {
    return 'The unauthorized POST test is probably being sent as a GET because the request helper ignores fetch options. Update the helper to accept `options = {}` and call `globalThis.fetch(url, options)` so `method: "POST"`, headers, and body reach the server; then assert missing or wrong bearer tokens return 401.';
  }
  if (/signal=SIGTERM/.test(detail)) {
    return 'The node script timed out. Ensure all server/timer promises can resolve and close servers in `finally`. For `server.listen(0)`, resolve the assigned port inside the listen callback with `server.address().port`; do not wait for a `listening` event after `listen()` has already fired.';
  }
  if (
    /SyntaxError:\s+Unexpected reserved word/.test(detail) &&
    /await import\(['"]node:http['"]\)/i.test(detail)
  ) {
    return 'In `server.mjs`, do not use `await import("node:http")` inside `createBookstoreServer()` or another synchronous function. The HTTP import ban applies to `contract-test.mjs` only; use a normal top-level `import http from "node:http";` or `import { createServer } from "node:http";` in `server.mjs`, and keep `createBookstoreServer()` synchronous.';
  }
  if (/SyntaxError:\s+Unexpected reserved word/.test(detail) && /\bawait\b/.test(detail)) {
    return 'The contract test is using `await` inside a non-async function or callback. Mark the containing helper `async` (for example `async function makeRequest(...)`) or move the await into an async test function, then await calls to that helper.';
  }
  if (
    /API call failed:\s*(?:400|401|403|404)/i.test(detail) &&
    /BOOK_NOT_FOUND|VALIDATION_ERROR|Unauthorized|Contract Test FAILED/i.test(detail)
  ) {
    return 'The contract helper is throwing for expected non-2xx responses before the negative tests can assert them. Change the helper to return both `response.status` and the parsed JSON body for every HTTP status; only throw for network errors or invalid JSON. Then assert 404/BOOK_NOT_FOUND, 401 auth failure, and 400/VALIDATION_ERROR explicitly in the test body.';
  }
  if (/ERR_HTTP_HEADERS_SENT|Cannot write headers after they are sent/i.test(detail)) {
    return 'The server sends more than one response for a single request. In `server.mjs`, every branch that calls `sendResponse`, `sendJson`, `res.writeHead`, or `res.end` for an error or success must immediately `return`; do not fall through from an auth/validation/not-found error into the create-success handler. Prefer an `if/else if/else` route chain with one final response per request.';
  }
  if (
    /Test FAILED|CONTRACT TEST SUITE ABORTED/.test(detail) &&
    !/AssertionError|ReferenceError|TypeError|SyntaxError|not defined|Expected values/i.test(detail)
  ) {
    return 'The test runner is catching a failure but not printing the caught error. In every catch block, log `error.stack ?? error` and then rethrow or set `process.exitCode = 1`; do not replace assertion details with only a generic failure banner.';
  }
  if (/List Books with Pagination/i.test(detail) && /4 !== 3|3 !== 4/.test(detail)) {
    return 'The contract test is asserting the seeded book total after a POST create has already mutated the in-memory store. Run pagination/list assertions before create-success, reset server state between tests, or assert the new dynamic total after creation.';
  }
  return null;
}

function contractTestWholeFileRewriteHint(reason: string): string {
  return [
    `${reason}.`,
    'Rewrite `contract-test.mjs` once with one clean complete file instead of appending another patch block; replace the file once with one clean complete version.',
    'Use one top-level async flow: import `createBookstoreServer` from `./server.mjs`, create exactly one server, start it exactly once with `server.listen(0, () => resolve(server.address().port))`, then define one `baseUrl` from that resolved port.',
    'Use one async request helper that calls `globalThis.fetch(url, options)` and returns `{ status, body }` for every HTTP status.',
    'Run pagination, not-found, auth failure, validation failure, and create-success assertions in that single flow, then close the server in `finally` with the native `server.close()` method.',
    'Also remove every duplicated declaration. Do not keep duplicated imports, duplicate `url`/`baseUrl` declarations, multiple `listen()` calls, or old test blocks below the rewritten version.',
  ].join(' ');
}

interface PrometheusRule {
  alert?: unknown;
  expr?: unknown;
  for?: unknown;
  labels?: unknown;
  annotations?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function yamlPath(path: Array<string | number>): string {
  return path
    .map((part) =>
      typeof part === 'number' ? `[${part}]` : part.includes('.') ? `["${part}"]` : part,
    )
    .join('.');
}

async function evaluatePrometheusAlerts(
  check: PrometheusAlertsGateCheck,
  ws: CraftbookEvalWorkspace,
): Promise<string | null> {
  const content = await ws.read(check.file);
  if (content === null) return `${check.file} not found`;

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    return `${check.file} is not valid YAML: ${(err as Error).message}`;
  }
  if (!isRecord(parsed)) return `${check.file} YAML root must be an object`;
  if (!Array.isArray(parsed.groups) || parsed.groups.length === 0) {
    return `${check.file} must define a non-empty groups array`;
  }

  const rules: Array<{ rule: PrometheusRule; groupIndex: number; ruleIndex: number }> = [];
  const alertNames = new Set<string>();
  const duplicateNames = new Set<string>();

  parsed.groups.forEach((group, groupIndex) => {
    if (!isRecord(group)) {
      rules.push({ rule: {}, groupIndex, ruleIndex: -1 });
      return;
    }
    const groupRules = group.rules;
    if (!Array.isArray(groupRules)) {
      rules.push({ rule: {}, groupIndex, ruleIndex: -1 });
      return;
    }
    groupRules.forEach((rule, ruleIndex) => {
      if (isRecord(rule)) {
        const alertName = asNonEmptyString(rule.alert);
        if (alertName) {
          if (alertNames.has(alertName)) duplicateNames.add(alertName);
          alertNames.add(alertName);
        }
        rules.push({ rule, groupIndex, ruleIndex });
      } else {
        rules.push({ rule: {}, groupIndex, ruleIndex });
      }
    });
  });

  if (rules.some(({ ruleIndex }) => ruleIndex < 0)) {
    return `${check.file} every group must be an object with a rules array`;
  }
  if (rules.length === 0) return `${check.file} must contain at least one alert rule`;
  if (check.minRules !== undefined && rules.length < check.minRules) {
    return `${check.file} has ${rules.length} alert rule(s), need at least ${check.minRules}`;
  }
  if (duplicateNames.size > 0) {
    return `${check.file} has duplicate alert name(s): ${Array.from(duplicateNames).join(', ')}`;
  }

  const allowedSeverities = check.allowedSeverities ?? ['page', 'ticket', 'info'];
  const services = new Set<string>();
  const runbookUrls = new Set<string>();
  let pageAlerts = 0;

  for (const { rule, groupIndex, ruleIndex } of rules) {
    const path = yamlPath(['groups', groupIndex, 'rules', ruleIndex]);
    const alertName = asNonEmptyString(rule.alert);
    if (!alertName) return `${check.file} ${path}.alert must be a non-empty string`;
    if (!asNonEmptyString(rule.expr))
      return `${check.file} ${path}.expr must be a non-empty string`;
    const forDuration = asNonEmptyString(rule.for);
    if (!forDuration || /^0+[smhdwy]?$/.test(forDuration)) {
      return `${check.file} ${path}.for must be a non-zero duration`;
    }
    if (!isRecord(rule.labels)) return `${check.file} ${path}.labels must be an object`;
    if (!isRecord(rule.annotations)) return `${check.file} ${path}.annotations must be an object`;

    const severity = asNonEmptyString(rule.labels.severity);
    if (!severity) return `${check.file} ${path}.labels.severity must be present`;
    if (!allowedSeverities.includes(severity)) {
      return `${check.file} ${path}.labels.severity "${severity}" is not one of ${allowedSeverities.join(', ')}`;
    }
    if (severity === 'page') pageAlerts += 1;

    const team = asNonEmptyString(rule.labels.team);
    if (!team) return `${check.file} ${path}.labels.team must be present`;
    const service = asNonEmptyString(rule.labels.service);
    if (!service) return `${check.file} ${path}.labels.service must be present`;
    services.add(service);

    if (!asNonEmptyString(rule.annotations.summary)) {
      return `${check.file} ${path}.annotations.summary must be present`;
    }
    if (!asNonEmptyString(rule.annotations.description)) {
      return `${check.file} ${path}.annotations.description must be present`;
    }

    const runbookUrl = asNonEmptyString(rule.annotations.runbook_url);
    if (severity === 'page' && !runbookUrl) {
      return `${check.file} ${path}.annotations.runbook_url is required for page alerts`;
    }
    if (runbookUrl) runbookUrls.add(runbookUrl);
  }

  if (check.maxPageAlerts !== undefined && pageAlerts > check.maxPageAlerts) {
    return `${check.file} has ${pageAlerts} page alert(s), max allowed is ${check.maxPageAlerts}`;
  }

  for (const required of check.requiredServices ?? []) {
    if (!services.has(required)) {
      return `${check.file} is missing service label "${required}"`;
    }
  }
  for (const required of check.requiredRunbookUrls ?? []) {
    if (!runbookUrls.has(required)) {
      return `${check.file} is missing runbook_url "${required}"`;
    }
  }

  return null;
}

function runCoreSniff(sniff: StepSniff, content: string): { ok: boolean; detail: string } {
  switch (sniff) {
    case 'html-complete': {
      const result = htmlCompleteSniff(content);
      return result
        ? { ok: true, detail: '' }
        : { ok: false, detail: 'HTML is incomplete or truncated' };
    }
    case 'html-game': {
      const result = htmlGameSniff(content);
      return result
        ? { ok: true, detail: '' }
        : { ok: false, detail: 'HTML does not look like a complete interactive game' };
    }
    case 'nonempty':
      return content.trim().length > 0
        ? { ok: true, detail: '' }
        : { ok: false, detail: 'file is empty' };
    case 'json-valid': {
      const result = jsonValid(content);
      return result.ok
        ? { ok: true, detail: '' }
        : { ok: false, detail: result.error ?? 'invalid JSON' };
    }
    case 'data-table':
      return dataTableSniff(content)
        ? { ok: true, detail: '' }
        : { ok: false, detail: 'file is not a non-empty data table' };
    default:
      return { ok: false, detail: `unsupported sniff: ${String(sniff)}` };
  }
}
