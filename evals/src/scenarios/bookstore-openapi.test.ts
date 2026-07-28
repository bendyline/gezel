import { describe, expect, it } from 'vitest';
import {
  bookstoreAssertionSnippet,
  bookstoreFeedbackPath,
  bookstoreMissingContractDirective,
  bookstoreRepairDirective,
  checkOpenApi,
  detectContractStaticIssue,
  formatContractFailure,
  shouldPostBookstoreFeedback,
  shouldPostBookstoreMissingContractFeedback,
} from './bookstore-openapi.ts';

describe('checkOpenApi', () => {
  it('reports when a required method is placed on a child path', () => {
    const result = checkOpenApi(`
openapi: 3.1.0
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    Book: {}
    Author: {}
    Error: {}
    Pagination: {}
paths:
  /books:
    get: {}
    post:
      security:
        - bearerAuth: []
  /books/{id}:
    get: {}
    patch:
      security:
        - bearerAuth: []
  /books/{id}/authors:
    delete:
      security:
        - bearerAuth: []
  /authors/{id}/books:
    get: {}
`);

    expect(result.pathsPresent).toBe(false);
    expect(result.missingPaths).toContain('/books/{id}#DELETE');
    expect(result.misplacedMethods).toContain(
      'DELETE belongs on /books/{id}, not /books/{id}/authors',
    );
  });

  it('accepts root-level bearer security as covering mutation operations', () => {
    const result = checkOpenApi(`
openapi: 3.1.0
security:
  - bearerAuth: []
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    Book: {}
    Author: {}
    Error: {}
    Pagination: {}
paths:
  /books:
    get: {}
    post: {}
  /books/{id}:
    get: {}
    patch: {}
    delete: {}
  /authors/{id}/books:
    get: {}
`);

    expect(result.authOnMutations).toBe(true);
    expect(result.missingAuthMethods).toEqual([]);
  });

  it('still reports missing bearer security when no root/path/operation coverage exists', () => {
    const result = checkOpenApi(`
openapi: 3.1.0
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    Book: {}
    Author: {}
    Error: {}
    Pagination: {}
paths:
  /books:
    get: {}
    post: {}
  /books/{id}:
    get: {}
    patch: {}
    delete: {}
  /authors/{id}/books:
    get: {}
`);

    expect(result.authOnMutations).toBe(false);
    expect(result.missingAuthMethods).toContain('POST /books');
    expect(result.missingAuthMethods).toContain('PATCH /books/{id}');
    expect(result.missingAuthMethods).toContain('DELETE /books/{id}');
  });

  it('turns missing undici into dependency-free fetch guidance', () => {
    const reason = formatContractFailure(
      1,
      '',
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'undici' imported from contract-test.mjs",
    );

    expect(reason).toContain('imports undici');
    expect(reason).toContain('without installed npm dependencies');
    expect(reason).toContain("Node's built-in global fetch");
  });

  it('turns missing node-fetch into dependency-free fetch guidance', () => {
    const reason = formatContractFailure(
      1,
      '',
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'node-fetch' imported from contract-test.mjs",
    );

    expect(reason).toContain('imports node-fetch');
    expect(reason).toContain('without installed npm dependencies');
    expect(reason).toContain("Node's built-in global fetch");
  });

  it('surfaces the real assertion failure on a completed run, not a port-race misdiagnosis', () => {
    // Regression for the e4b bookstore trial: the test ran to a
    // clean exit (1) but a `"cursor": null` in a response made the port-null
    // heuristic fire, hiding a Book-vs-Pagination schema bug for 25 minutes.
    const stdout = [
      '--- Running Test: List Books (GET /books) ---',
      '✅ PASSED: 200 response matches Pagination and Book schemas. cursor: null',
      '--- Running Test: Get Book by ID (GET /books/101) ---',
      '',
      'Shutting down server process...',
    ].join('\n');
    const stderr = '❌ FAILED: 200 response body shape does not match Pagination schema.';
    const reason = formatContractFailure(1, stdout, stderr);

    expect(reason).toContain('does not match Pagination schema');
    expect(reason).toContain('single-item GET');
    // Must NOT misdiagnose a working handshake as the bug.
    expect(reason).not.toContain('starts fetches before the server port');
  });

  it('still diagnoses a genuine port-handshake race when the test never completes', () => {
    const reason = formatContractFailure(null, 'GET http://localhost:null/books', '');
    expect(reason).toContain('starts fetches before the server port');
    expect(reason).toContain("stdout 'data' handler");
  });

  it('diagnoses undefined port failures as port-discovery bugs', () => {
    const reason = formatContractFailure(
      1,
      '',
      'Contract test failed: Failed to parse URL from http://localhost:undefined/books?page=1&limit=2',
    );

    expect(reason).toContain('undefined port');
    expect(reason).toContain("stdout 'data' handler");
    expect(reason).not.toContain('not the port handshake');
  });

  it('does not route failed port detection through the generic assertion branch', () => {
    const reason = formatContractFailure(1, '', 'Error: Failed to detect server port');

    expect(reason).toContain('server port is discovered');
    expect(reason).not.toContain('the test ran and reported a failing check');
  });

  it('detects contract tests that wait for server stdout to end before parsing the port', () => {
    const reason = detectContractStaticIssue(
      'server.listen(PORT, () => console.log(`listening on PORT=${PORT}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', chunk => { data += chunk.toString(); });
server.stdout.on('end', () => {
  const match = data.match(/PORT=(\\d+)/);
  resolve(Number(match[1]));
});
`,
    );

    expect(reason).toContain("waits for server.stdout 'end'");
    expect(reason).toContain("stdout 'data' handler");
    expect(reason).toContain('server.address().port');
  });

  it('detects contract tests that await server close before running fetches', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let port = null;
server.stdout.on('data', chunk => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) port = Number(match[1]);
});
await new Promise(resolve => {
  server.on('close', resolve);
});
await fetch(\`http://localhost:\${port}/books\`);
server.kill();
`,
    );

    expect(reason).toContain('awaits the spawned server close/exit event before killing it');
    expect(reason).toContain('deadlocks before fetch assertions');
    expect(reason).toContain('run fetches while the server is alive');
  });

  it('detects contract tests that import openapi.yaml as executable code', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const openapiSchema = require('./openapi.yaml');
`,
    );

    expect(reason).toContain('require/import openapi.yaml');
    expect(reason).toContain('Plain Node cannot load YAML');
    expect(reason).toContain('JS object literal');
  });

  it('gives exact ESM replacements for CommonJS built-in requires in .mjs files', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const { URL } = require("node:url");
const { setTimeout } = require("node:timers/promises");
const { spawn } = require("node:child_process");
`,
    );

    expect(reason).toContain('calls require(), but .mjs files are ES modules');
    expect(reason).toContain('Replace every require line');
    expect(reason).toContain('import { URL } from "node:url"');
    expect(reason).toContain('import { setTimeout } from "node:timers/promises"');
    expect(reason).toContain('import { spawn } from "node:child_process"');
  });

  it('detects process.exit cleanup immediately after killing the spawned server', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.kill();
if (allPassed) {
  process.exit(0);
}
`,
    );

    expect(reason).toContain('process.exit() soon after server.kill()');
    expect(reason).toContain('Await the child close/exit event');
    expect(reason).toContain('set process.exitCode');
    expect(reason).toContain('Remove every process.exit');
  });

  it('detects any process.exit call in a spawned-server contract test', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.on('error', () => process.exit(1));
await runAssertions();
process.exit(0);
`,
    );

    expect(reason).toContain('still calls process.exit');
    expect(reason).toContain('remove every process.exit');
    expect(reason).toContain('process.exitCode after cleanup');
  });

  it('does not flag a passed flag set via an aggregate boolean expression', () => {
    // Regression: `passed = t1 && t2 && t3` is a valid way to set the flag
    // true; the old heuristic only recognized a literal `passed = true` and
    // falsely looped the model on already-correct code.
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let passed = false;
try {
  passed = test1Passed && test2Passed && test3Passed;
} finally {
  process.exitCode = passed ? 0 : 1;
}
`,
    );
    expect(reason ?? '').not.toContain('never sets passed = true');
  });

  it('still flags a passed flag that is genuinely never set to a non-false value', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let passed = false;
await runAssertions();
process.exitCode = passed ? 0 : 1;
`,
    );
    expect(reason).toContain('never sets passed = true');
  });

  it('does not treat process.exit mentions in comments as live calls', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
// Do not call process.exit() here.
/* process.exit(1) would be wrong inside cleanup. */
process.exitCode = passed ? 0 : 1;
`,
    );

    expect(reason).toBeUndefined();
  });

  it('detects invalid node:fetch imports', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import fetch from 'node:fetch';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
`,
    );

    expect(reason).toContain('imports fetch');
    expect(reason).toContain('global function');
    expect(reason).toContain('Remove the fetch import');
  });

  it('detects npm HTTP client imports in dependency-free contract tests', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import fetch from 'node-fetch'; // stand-in for global fetch in old runtimes
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
`,
    );

    expect(reason).toContain('imports an npm HTTP client');
    expect(reason).toContain('only Node built-ins');
    expect(reason).toContain('Delete every undici/node-fetch/axios import line');
    expect(reason).toContain('do not replace it with another fetch import');
    expect(reason).toContain('call fetch(...) directly');
  });

  it('detects server handlers that treat req.url as a URL object', () => {
    const reason = detectContractStaticIssue(
      `
import http from 'node:http';
function listBooks(req, res) {
  const limit = Number(req.url.searchParams.get('limit') || 25);
  res.end(JSON.stringify({ data: [], pagination: { limit, cursor: null, total: 0, hasMore: false } }));
}
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) resolve(Number(match[1]));
}));
const port = await portPromise;
await fetch(\`http://127.0.0.1:\${port}/books\`);
`,
    );

    expect(reason).toContain('req.url.searchParams');
    expect(reason).toContain('req.url is a string');
    expect(reason).toContain('fetch failed for every endpoint');
    expect(reason).toContain('new URL(req.url');
  });

  it('detects server code that constructs URL from req.url without a base', () => {
    const reason = detectContractStaticIssue(
      `
const server = http.createServer((req, res) => {
  const url = new URL(req.url);
  res.end(url.pathname);
});
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) resolve(Number(match[1]));
}));
const port = await portPromise;
await fetch(\`http://127.0.0.1:\${port}/books\`);
`,
    );

    expect(reason).toContain('new URL(req.url) without a base URL');
    expect(reason).toContain('ERR_INVALID_URL');
    expect(reason).toContain('fetch failed');
    expect(reason).toContain('new URL(req.url ?? "/"');
  });

  it('detects missing limit defaults that turn GET /books into an empty crashed page', () => {
    const reason = detectContractStaticIssue(
      `
const server = http.createServer((req, res) => {
  const url = new URL(req.url, \`http://\${req.headers.host}\`);
  const limit = Math.min(Number(url.searchParams.get("limit")) ?? 10, 100);
  const slice = books.slice(0, limit);
  const hasMore = limit < books.length;
  const nextCursor = hasMore ? String(slice[slice.length - 1].id) : null;
  res.end(JSON.stringify({ data: slice, pagination: { limit, cursor: nextCursor, total: books.length, hasMore } }));
});
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) resolve(Number(match[1]));
}));
const port = await portPromise;
await fetch(\`http://127.0.0.1:\${port}/books\`);
`,
    );

    expect(reason).toContain('Number(url.searchParams.get("limit"))');
    expect(reason).toContain('Number(null)');
    expect(reason).toContain('empty slice');
    expect(reason).toContain('limitParam === null ? 10');
  });

  it('detects server auth guards that block public GET routes', () => {
    const reason = detectContractStaticIssue(
      `
const server = http.createServer((req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 401, message: 'Unauthorized' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/books') {
    res.end(JSON.stringify({ data: [], pagination: { limit: 10, cursor: null, total: 0, hasMore: false } }));
  }
});
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
await fetch(\`http://127.0.0.1:\${port}/books\`);
`,
    );

    expect(reason).toContain('applies a bearer Authorization guard before the GET routes');
    expect(reason).toContain('GET /books returns 401');
    expect(reason).toContain('bearerAuth is only an OpenAPI requirement');
  });

  it('detects author-books routes that use slash-split length 3 on an unfiltered pathname', () => {
    const reason = detectContractStaticIssue(
      `
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', \`http://\${req.headers.host}\`);
  const pathname = url.pathname;
  if (pathname.startsWith('/authors/') && pathname.split('/').length === 3 && req.method === 'GET') {
    handleGetBooksByAuthor(req, res);
  }
});
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) resolve(Number(match[1]));
}));
const port = await portPromise;
await fetch(\`http://127.0.0.1:\${port}/authors/101/books\`);
`,
    );

    expect(reason).toContain('pathname.split("/").length === 3');
    expect(reason).toContain('length 4');
    expect(reason).toContain('final segment "books"');
  });

  it('gives a focused repair directive for npm HTTP client imports', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: contract-test.mjs imports an npm HTTP client, but the eval runs with only Node built-ins.',
    );

    expect(directive).toContain('BOOKSTORE_CONTRACT_FETCH_PATCH');
    expect(directive).toContain('MUST write `contract-test.mjs`');
    expect(directive).toContain('smallest possible edit');
    expect(directive).toContain('Delete every line like `import fetch from "node-fetch"`');
    expect(directive).toContain('corrected file should simply start with the next existing import');
    expect(directive).toContain('Do not add a replacement fetch import');
    expect(directive).toContain('bare `await fetch(url, options)`');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('uses the full contract directive when npm imports are paired with lifecycle failures', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: contract-test.mjs never spawns server.mjs before making fetch requests. contract-test.mjs imports an npm HTTP client, but the eval runs with only Node built-ins.',
    );

    expect(directive).toContain('BOOKSTORE CONTRACT PATCH');
    expect(directive).toContain('import { spawn } from "node:child_process"');
    expect(directive).toContain('spawn("node", ["server.mjs"]');
    expect(directive).toContain('Use Node global fetch only');
    expect(directive).not.toContain('BOOKSTORE_CONTRACT_FETCH_PATCH');
  });

  it('gives a server-only directive for missing pagination.limit smoke failures', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: evaluator smoke failed: GET /books pagination.limit is not a number',
    );

    expect(directive).toContain('BOOKSTORE_SERVER_PAGINATION_PATCH');
    expect(directive).toContain('MUST write `server.mjs`');
    expect(directive).toContain('pagination: { limit: number');
    expect(directive).toContain(
      'Do not put `limit`, `cursor`, `total`, or `hasMore` beside `data`',
    );
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('gives a focused contract rewrite for empty-port cleanup failures', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: contract-test.mjs builds fetch URLs with an empty port, such as `http://127.0.0.1:/books`. contract-test.mjs calls serverProcess.kill() before registering the close/exit waiter.',
    );

    expect(directive).toContain('BOOKSTORE_CONTRACT_PORT_CLEANUP_REWRITE');
    expect(directive).toContain('MUST write `contract-test.mjs`');
    expect(directive).toContain('portPromise');
    expect(directive).toContain('baseUrl');
    expect(directive).toContain('once(server, "close")');
    expect(directive).toContain('Do not call `server.kill()` before registering');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('gives a server-only directive for wrong bookstore dataset size', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: evaluator smoke failed: GET /books expected 5 books, got 3',
    );

    expect(directive).toContain('BOOKSTORE_SERVER_DATASET_PATCH');
    expect(directive).toContain('MUST write `server.mjs`');
    expect(directive).toContain('exactly 5 Book objects across 3 numeric authorId values');
    expect(directive).toContain('Do not patch contract-test.mjs to expect fewer books');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('gives a server-only directive when GET /books ignores limit', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: evaluator smoke failed: GET /books?limit=2 expected 2 books, got 5',
    );

    expect(directive).toContain('BOOKSTORE_SERVER_LIMIT_PATCH');
    expect(directive).toContain('MUST write `server.mjs`');
    expect(directive).toContain('parses `limit`');
    expect(directive).toContain('books.slice(start, start + limit)');
    expect(directive).toContain('Do not patch the contract test');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('gives a server-only directive for response fall-through crashes', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: evaluator smoke failed: fetch failed; server stderr: Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client',
    );

    expect(directive).toContain('BOOKSTORE_SERVER_RESPONSE_FLOW_PATCH');
    expect(directive).toContain('MUST write `server.mjs`');
    expect(directive).toContain(
      'returns immediately after `res.end(...)`, `sendJson(...)`, or `sendError(...)`',
    );
    expect(directive).toContain('/books/999');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('gives a server-only directive for GET endpoints blocked by auth', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: contract-test exit 1: Failing check(s): Contract Test Failed: GET /books failed with status: 401',
    );

    expect(directive).toContain('BOOKSTORE_SERVER_GET_AUTH_PATCH');
    expect(directive).toContain('MUST write `server.mjs`');
    expect(directive).toContain('GET endpoints must work without an Authorization header');
    expect(directive).toContain('Bearer auth is required only as OpenAPI documentation');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('gives a server-only directive for missing limit defaults', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: server.mjs defaults the list limit with `Number(url.searchParams.get("limit")) ?? ...`, but `Number(null)` is 0, not nullish.',
    );

    expect(directive).toContain('BOOKSTORE_SERVER_LIMIT_PATCH');
    expect(directive).toContain('MUST write `server.mjs`');
    expect(directive).toContain('limitParam === null ? 10');
    expect(directive).toContain('GET /books with no query must return all 5 books');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('gives a server-only directive for non-boolean hasMore values', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: contract-test exit 1: hasMore is not boolean',
    );

    expect(directive).toContain('BOOKSTORE_SERVER_HASMORE_PATCH');
    expect(directive).toContain('MUST write `server.mjs`');
    expect(directive).toContain('hasMore: boolean');
    expect(directive).toContain('start + limit < filteredBooks.length');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('gives a focused rewrite directive for process.exit cleanup loops', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: contract-test.mjs still calls process.exit(...). For this eval, remove every process.exit(...) call from contract-test.mjs.',
    );

    expect(directive).toContain('BOOKSTORE_CONTRACT_EXIT_REWRITE');
    expect(directive).toContain('MUST write `contract-test.mjs`');
    expect(directive).toContain('contains zero `process.exit(...)` calls');
    expect(directive).toContain('process.exitCode = passed ? 0 : 1');
    expect(directive).toContain('let the async function return naturally');
    expect(directive).not.toContain('BOOKSTORE CONTRACT PATCH');
  });

  it('does not post transient missing-deliverable bookstore feedback immediately', () => {
    expect(shouldPostBookstoreFeedback('server.mjs not present yet')).toBe(false);
    expect(shouldPostBookstoreFeedback('contract-test.mjs not present yet')).toBe(false);
    expect(shouldPostBookstoreFeedback('README.md not present yet')).toBe(false);
  });

  it('posts final missing contract-test feedback only after the rest of the bookstore deliverables are ready', () => {
    const readySignals = [
      'yaml-parses',
      'openapi-3.1',
      'all-paths-present',
      'schemas-named',
      'auth-on-mutations',
      'readme-present',
    ];

    expect(
      shouldPostBookstoreMissingContractFeedback({
        failReason: 'contract-test.mjs not present yet',
        signals: readySignals,
        serverPresent: true,
        readmePresent: true,
      }),
    ).toBe(true);
    expect(
      shouldPostBookstoreMissingContractFeedback({
        failReason: 'contract-test.mjs not present yet',
        signals: readySignals.filter((signal) => signal !== 'all-paths-present'),
        serverPresent: true,
        readmePresent: true,
      }),
    ).toBe(false);
    expect(
      shouldPostBookstoreMissingContractFeedback({
        failReason: 'contract-test.mjs not present yet',
        signals: readySignals,
        serverPresent: false,
        readmePresent: true,
      }),
    ).toBe(false);
    expect(
      shouldPostBookstoreMissingContractFeedback({
        failReason: 'server.mjs not present yet',
        signals: readySignals,
        serverPresent: true,
        readmePresent: true,
      }),
    ).toBe(false);
  });

  it('gives a write-now directive for the missing contract-test file', () => {
    const directive = bookstoreMissingContractDirective();

    expect(directive).toContain('BOOKSTORE_CONTRACT_MISSING_FILE');
    expect(directive).toContain('MUST be `write_file({ path: "contract-test.mjs"');
    expect(directive).toContain('global fetch');
    expect(directive).toContain('server.stdout.on("data"');
    expect(directive).toContain('GET `/books`');
    expect(directive).toContain('process.exitCode');
    expect(directive).toContain('Do not call `process.exit()`');
  });

  it('gives a focused OpenAPI directive for duplicate path mappings', () => {
    const directive = bookstoreRepairDirective(
      'yaml-parses: duplicated mapping key (96:3)\n 96 |   /books/{id}:',
    );

    expect(directive).toContain('BOOKSTORE_OPENAPI_DUPLICATE_PATH_PATCH');
    expect(directive).toContain('MUST write `openapi.yaml`');
    expect(directive).toContain('/books/{id}` must be one mapping');
    expect(directive).toContain('get:`, `patch:`, and `delete:`');
    expect(directive).not.toContain('BOOKSTORE OPENAPI REWRITE');
  });

  it('gives a focused OpenAPI directive for mutation auth misses', () => {
    const directive = bookstoreRepairDirective(
      'auth-on-mutations: bearerAuth missing on POST /books, PATCH /books/{id}, DELETE /books/{id}',
    );

    expect(directive).toContain('BOOKSTORE_AUTH_PATCH');
    expect(directive).toContain('MUST write `openapi.yaml`');
    expect(directive).toContain('security:');
    expect(directive).toContain('  - bearerAuth: []');
    expect(directive).toContain('POST /books, PATCH /books/{id}, and DELETE /books/{id}');
    expect(directive).not.toContain('BOOKSTORE OPENAPI REWRITE');
  });

  it('still posts concrete bookstore repair feedback', () => {
    expect(shouldPostBookstoreFeedback('all-paths-present: missing /books/{id}#DELETE')).toBe(true);
    expect(
      shouldPostBookstoreFeedback(
        'contract-test-passes: contract-test.mjs calls require(), but .mjs files are ES modules',
      ),
    ).toBe(true);
  });

  it('detects promise timers used with callback-style setTimeout', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { setTimeout } from 'node:timers/promises';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve) => {
  const checkPort = () => {
    setTimeout(checkPort, 100);
  };
  checkPort();
});
`,
    );

    expect(reason).toContain('promise-based setTimeout');
    expect(reason).toContain('callback-style setTimeout(checkPort, 100)');
    expect(reason).toContain('ERR_INVALID_ARG_TYPE');
  });

  it('detects fetch helpers that omit the discovered port', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
async function testGetBooks() {
  const baseUrl = "http://127.0.0.1:";
  await fetch(\`\${baseUrl}/books\`);
}
`,
    );

    expect(reason).toContain('empty port');
    expect(reason).toContain('Thread the discovered port');
    expect(reason).toContain('http://127.0.0.1:${port}/books');
  });

  it('detects contract tests that fetch without spawning server.mjs', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const port = Number(process.env.PORT_TO_TEST);
await fetch(\`http://127.0.0.1:\${port}/books\`);
`,
    );

    expect(reason).toContain('never spawns server.mjs');
    expect(reason).toContain('no PORT_TO_TEST');
    expect(reason).toContain('Import `spawn`');
    expect(reason).toContain('parse /PORT=(\\d+)/');
  });

  it('detects contract tests that assume a fixed port without spawning server.mjs', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const ASSUMED_PORT = 3000;
const baseUrl = \`http://localhost:\${ASSUMED_PORT}\`;
await fetch(\`\${baseUrl}/books\`);
`,
    );

    expect(reason).toContain('never spawns server.mjs');
    expect(reason).toContain('no pre-started server');
    expect(reason).toContain('parse /PORT=(\\d+)/');
  });

  it('detects contract tests that use const PORT = 3000 without spawning server.mjs', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const PORT = 3000;
const API_URL = \`http://localhost:\${PORT}\`;
await fetch(\`\${API_URL}/books\`);
`,
    );

    expect(reason).toContain('never spawns server.mjs');
    expect(reason).toContain('no pre-started server');
    expect(reason).toContain('parse /PORT=(\\d+)/');
  });

  it('detects contract tests that mock server stdout instead of spawning server.mjs', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const stdoutData = 'listening on PORT=3000';
const portMatch = stdoutData.match(/PORT=(\\d+)/);
const port = Number(portMatch[1]);
const baseUrl = \`http://localhost:\${port}\`;
await fetch(\`\${baseUrl}/books\`);
`,
    );

    expect(reason).toContain('never spawns server.mjs');
    expect(reason).toContain('no pre-started server');
    expect(reason).toContain('parse /PORT=(\\d+)/');
  });

  it('detects contract tests that create a mock server instead of spawning server.mjs', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import http from 'http';
const serverInstance = http.createServer((req, res) => res.end('ok'));
server.listen(0, () => console.log('ready'));
await fetch('http://localhost:3000/books');
`,
    );

    expect(reason).toContain('creates a mock HTTP server');
    expect(reason).toContain('testing server.mjs');
    expect(reason).toContain('spawn `node server.mjs`');
    expect(reason).toContain('Do not copy server logic');
  });

  it('detects contract tests that use browser window globals in Node', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) window.resolvedPort = Number(match[1]);
});
await fetch(\`http://127.0.0.1:\${window.resolvedPort}/books\`);
`,
    );

    expect(reason).toContain('uses `window`');
    expect(reason).toContain('Node .mjs scripts');
    expect(reason).toContain('portPromise');
  });

  it('detects node:events once used as a callback wrapper', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { once } from 'node:events';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const listener = once((data) => {
  console.log(data);
});
if (!listener.hasBeenCalled()) listener.cancel();
`,
    );

    expect(reason).toContain('calls node:events once');
    expect(reason).toContain('once expects `(emitter, eventName)`');
    expect(reason).toContain('server.stdout.on("data"');
  });

  it('detects await inside non-async arrow helpers', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => {
  server.stdout.on('data', (chunk) => {
    const match = chunk.toString().match(/PORT=(\\d+)/);
    if (match) resolve(Number(match[1]));
  });
});
const base = (path) => \`http://localhost:\${await portPromise}\${path}\`;
await fetch(base('/books'));
`,
    );

    expect(reason).toContain('await inside a non-async arrow helper');
    expect(reason).toContain('Unexpected reserved word');
    expect(reason).toContain('const port = await portPromise');
  });

  it('detects contract tests that kill the server while discovering the port', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) {
    server.kill();
    resolve(Number(match[1]));
  }
});
await fetch('http://127.0.0.1:3000/books');
`,
    );

    expect(reason).toContain('kills the spawned server');
    expect(reason).toContain('leaves nothing alive for the fetch assertions');
    expect(reason).toContain('keep the child running');
  });

  it('detects base URLs built before awaiting the discovered port', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
let port = 0;
const BASE_URL = \`http://127.0.0.1:\${port}\`;
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
port = await waitForPort(server);
await fetch(\`\${BASE_URL}/books\`);
`,
    );

    expect(reason).toContain('builds BASE_URL from the initial mutable port value');
    expect(reason).toContain('requests still target port 0/null');
    expect(reason).toContain('const port = await portPromise');
  });

  it('accepts mutable port tests that build URLs after readiness is awaited', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { spawn } from 'node:child_process';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let port = null;
const onData = (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) port = Number(match[1]);
};
server.stdout.on('data', onData);
await new Promise((resolve) => {
  const tick = () => (port !== null ? resolve() : setTimeout(tick, 50));
  tick();
});
const baseUrl = \`http://127.0.0.1:\${port}\`;
await fetch(\`\${baseUrl}/books\`);
const closed = new Promise((resolve) => server.once('close', resolve));
server.kill();
await closed;
`,
    );

    expect(reason).toBeUndefined();
  });

  it('accepts named server readiness promises before baseUrl construction', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn("node", ["server.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
let port = null;
const buffer = [];
const serverReady = new Promise((resolve) => {
  server.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    buffer.push(text);
    const match = text.match(/PORT=(\\d+)/);
    if (match) {
      port = Number(match[1]);
      resolve();
    }
  });
});

try {
  await serverReady;
  const baseUrl = \`http://127.0.0.1:\${port}\`;
  await fetch(\`\${baseUrl}/books?limit=3\`);
} finally {
  const closed = new Promise((resolve) => server.once("close", resolve));
  server.kill();
  await closed;
}
`,
    );

    expect(reason).toBeUndefined();
  });

  it('detects ChildProcess.kill used with a callback', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve) => {
  server.kill(() => resolve());
});
`,
    );

    expect(reason).toContain('calls ChildProcess.kill(callback)');
    expect(reason).toContain('never invokes a callback');
    expect(reason).toContain('const closed = once(server, "close")');
  });

  it('detects contract tests that hard-code a localhost port', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
await fetch('http://127.0.0.1:3001/books');
`,
    );

    expect(reason).toContain('hard-codes a local port');
    expect(reason).toContain('ECONNREFUSED');
    expect(reason).toContain('PORT=(\\d+)');
    expect(reason).toContain('http://127.0.0.1:${port}/books');
  });

  it('detects fetch URLs that omit the discovered port before a path variable', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
async function request(url) {
  return fetch(\`http://localhost\${url}\`);
}
await request('/books');
`,
    );

    expect(reason).toContain('builds fetch URLs without it');
    expect(reason).toContain('http://localhost${url}');
    expect(reason).toContain('connects to port 80');
    expect(reason).toContain('const baseUrl');
  });

  it('detects contract tests that prepend /api/v1 to root-path endpoints', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
const baseUrl = \`http://127.0.0.1:\${port}/api/v1\`;
await fetch(\`\${baseUrl}/books\`);
`,
    );

    expect(reason).toContain('prepends /api/v1');
    expect(reason).toContain('root paths');
    expect(reason).toContain('/authors/{id}/books');
  });

  it('detects contract tests that expect list responses as a bare array', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const response = await fetch(\`http://127.0.0.1:\${port}/books\`);
const body = await response.json();
if (!Array.isArray(body)) throw new Error('Expected body to be an array');
`,
    );

    expect(reason).toContain('expects GET /books to return a bare array');
    expect(reason).toContain('Array.isArray(body.data)');
  });

  it('detects author-list bare-array checks as the author endpoint', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const { body: listBody } = await get('/books');
const authorId = listBody.data[0].authorId;
const { body } = await get(\`/authors/\${authorId}/books\`);
if (!Array.isArray(body)) throw new Error('author books should be an array');
`,
    );

    expect(reason).toContain('expects GET /authors/{id}/books to return a bare array');
    expect(reason).toContain('Array.isArray(body.data)');
    expect(reason).not.toContain('expects GET /books to return a bare array');
  });

  it('detects top-level return in a port-failure branch', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let port = null;
await waitForPort();
if (!port) {
  console.error('FAIL: could not detect server port');
  return;
}
`,
    );

    expect(reason).toContain('top-level port-failure branch');
    expect(reason).toContain('Illegal return statement');
    expect(reason).toContain('throw new Error("could not detect server port")');
  });

  it('detects contract tests that expect body.books instead of body.data', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const body = await fetchBooks();
if (!body.books || !body.pagination) throw new Error('Expected books and pagination');
`,
    );

    expect(reason).toContain('expects list responses to contain `body.books`');
    expect(reason).toContain('OpenAPI envelope key `data`');
  });

  it('detects impossible typeof integer assertions', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (typeof book.publishedYear !== "integer") {
  throw new Error('bad year');
}
`,
    );

    expect(reason).toContain('compares typeof to "integer"');
    expect(reason).toContain('typeof never returns "integer"');
    expect(reason).toContain('Number.isInteger');
  });

  it('detects contract tests that expect numeric Book ids as strings', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (typeof book.id !== "string") {
  throw new Error('bad id');
}
`,
    );

    expect(reason).toContain('expects Book.id to be a string');
    expect(reason).toContain('numeric Book ids');
    expect(reason).toContain('typeof book.id === "number"');
  });

  it('detects child cleanup that registers the exit waiter after kill', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { once } from 'node:events';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  passed = true;
} finally {
  server.kill();
  await once(server, 'exit');
  process.exitCode = passed ? 0 : 1;
}
`,
    );

    expect(reason).toContain('before registering the close/exit waiter');
    expect(reason).toContain('const closed = once(server, "close")');
  });

  it('detects contract tests that fetch before awaiting the port', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let port = null;
server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) port = Number(match[1]);
});
await runTests(port);
`,
    );

    expect(reason).toContain('uses port before waiting');
    expect(reason).toContain('portPromise');
  });

  it('formats fixed-port connection refusals as contract-test port discovery failures', () => {
    const reason = formatContractFailure(
      1,
      [
        '❌ Test 1 (GET /books): FAILED - connect ECONNREFUSED 127.0.0.1:3001',
        '❌ Test 2 (GET /books/{id}): FAILED - connect ECONNREFUSED 127.0.0.1:3001',
      ].join('\n'),
      '',
    );

    expect(reason).toContain('fetches a fixed local port');
    expect(reason).toContain('(3001)');
    expect(reason).toContain('parse /PORT=(\\d+)/');
    expect(reason).toContain('Do not hard-code 3000/3001');
    expect(reason).not.toContain('single-item GET');
  });

  it('formats harness-provided port waits as missing server-spawn flow', () => {
    const reason = formatContractFailure(
      1,
      'Starting contract test...\nFailed to determine server port within timeout.',
      '',
    );

    expect(reason).toContain('waits for a harness-provided port');
    expect(reason).toContain('no PORT_TO_TEST');
    expect(reason).toContain('spawn `node server.mjs`');
    expect(reason).toContain('parse /PORT=(\\d+)/');
    expect(reason).not.toContain('single-item GET');
  });

  it('formats assumed-port fetch failures as missing server-spawn flow', () => {
    const reason = formatContractFailure(
      1,
      [
        '--- Starting Bookstore API Contract Tests ---',
        'Note: Assuming server is running and accessible on a known port.',
        'Could not connect to server or run tests: fetch failed',
      ].join('\n'),
      '',
    );

    expect(reason).toContain('assumes server.mjs is already running');
    expect(reason).toContain('no pre-running server');
    expect(reason).toContain('spawn `node server.mjs`');
    expect(reason).toContain('http://127.0.0.1:${port}');
    expect(reason).not.toContain('single-item GET');
  });

  it('formats endpoint fetch failures as contract-test lifecycle failures', () => {
    const reason = formatContractFailure(
      1,
      [
        '❌ Test FAILED: GET /books (List all books) | Reason: fetch failed',
        '❌ Test FAILED: GET /books/{id} (Get specific book) | Reason: fetch failed',
      ].join('\n'),
      '',
    );

    expect(reason).toContain('contract-test.mjs could not connect');
    expect(reason).toContain('do not mock stdout');
    expect(reason).toContain('do not assume port 3000/3001');
    expect(reason).toContain('spawned child stderr');
    expect(reason).not.toContain('single-item GET');
  });

  it('formats author list bare-array assertions as contract-test shape failures', () => {
    const reason = formatContractFailure(
      1,
      ['--- GET /authors/{id}/books ---', 'FAIL response is array', 'FAIL author 3 has books'].join(
        '\n',
      ),
      '',
    );

    expect(reason).toContain('expects GET /authors/{id}/books to return a bare array');
    expect(reason).toContain('same Pagination envelope as GET /books');
    expect(reason).toContain('Patch contract-test.mjs');
    expect(reason).toContain('do not change server.mjs back to a bare array');
  });

  it('routes contract-test lifecycle failures back to contract-test.mjs', () => {
    const path = bookstoreFeedbackPath(
      'contract-test-passes: contract-test exit 1: contract-test.mjs could not connect before receiving an HTTP response. First fix the contract-test lifecycle: do not mock stdout, do not assume port 3000/3001, and do not fetch until it has spawned `node server.mjs`.',
      {
        yaml: 'openapi.yaml',
        server: 'server.mjs',
        contract: 'contract-test.mjs',
      },
    );

    expect(path).toBe('contract-test.mjs');
  });

  it('routes hasMore boolean failures back to server.mjs', () => {
    const path = bookstoreFeedbackPath(
      'contract-test-passes: contract-test exit 1: hasMore is not boolean',
      {
        yaml: 'openapi.yaml',
        server: 'server.mjs',
        contract: 'contract-test.mjs',
      },
    );

    expect(path).toBe('server.mjs');
  });

  it('routes contract-test assertion failures back to contract-test.mjs', () => {
    const path = bookstoreFeedbackPath(
      'contract-test-passes: contract-test exit 1: the test ran and reported a failing check — fix what it names. Failing check(s): Results: 17 passed, 5 failed | FAIL response is array | FAIL author 3 has books',
      {
        yaml: 'openapi.yaml',
        server: 'server.mjs',
        contract: 'contract-test.mjs',
      },
    );

    expect(path).toBe('contract-test.mjs');
  });

  it('routes illegal return syntax failures back to contract-test.mjs', () => {
    const path = bookstoreFeedbackPath(
      'contract-test-passes: contract-test exit 1: SyntaxError: Illegal return statement',
      {
        yaml: 'openapi.yaml',
        server: 'server.mjs',
        contract: 'contract-test.mjs',
      },
    );

    expect(path).toBe('contract-test.mjs');
  });

  it('routes static contract lifecycle failures back to contract-test.mjs', () => {
    const path = bookstoreFeedbackPath(
      'contract-test-passes: contract-test.mjs builds BASE_URL from the initial mutable port value before awaiting the server stdout PORT line, so requests still target port 0/null.',
      {
        yaml: 'openapi.yaml',
        server: 'server.mjs',
        contract: 'contract-test.mjs',
      },
    );

    expect(path).toBe('contract-test.mjs');
  });

  it('formats undefined listen crashes as mock-server contract-test failures', () => {
    const reason = formatContractFailure(
      1,
      '',
      "FATAL ERROR during test execution: TypeError: Cannot read properties of undefined (reading 'listen')",
    );

    expect(reason).toContain('create or control its own HTTP server');
    expect(reason).toContain('Do not build a mock server');
    expect(reason).toContain('spawn `node server.mjs`');
    expect(reason).toContain('parse /PORT=(\\d+)/');
  });

  it('formats window global crashes as Node contract-test failures', () => {
    const reason = formatContractFailure(
      1,
      '--- Starting Bookstore API Contract Test ---',
      'An unhandled error occurred during testing: window is not defined',
    );

    expect(reason).toContain('uses the browser global window');
    expect(reason).toContain('no window object');
    expect(reason).toContain('portPromise');
    expect(reason).toContain('const port = await portPromise');
  });

  it('detects server pagination cursors returned as numeric ids', () => {
    const reason = detectContractStaticIssue(
      `
const nextCursor = hasMore ? sliced[sliced.length - 1].id : null;
return { data: sliced, pagination: { limit, cursor: nextCursor, total, hasMore } };
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) resolve(Number(match[1]));
}));
const port = await portPromise;
`,
    );

    expect(reason).toContain('numeric pagination cursor');
    expect(reason).toContain('String(book.id)');
    expect(reason).toContain('script.js');
  });

  it('detects passed flags that are never set true', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
let passed = false;
async function runTests() {
  await fetch('http://localhost:1234/books');
  process.exitCode = passed ? 0 : 1;
}
`,
    );

    expect(reason).toContain('never sets passed = true');
  });

  it('allows passed flags set true after checks', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
let passed = false;
async function runTests() {
  await fetch('http://localhost:1234/books');
  passed = true;
  process.exitCode = passed ? 0 : 1;
}
`,
    );

    expect(reason).toBeUndefined();
  });

  it('allows server pagination cursors returned as strings', () => {
    const reason = detectContractStaticIssue(
      `
const nextCursor = hasMore ? String(sliced[sliced.length - 1].id) : null;
return { data: sliced, pagination: { limit, cursor: nextCursor, total, hasMore } };
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) resolve(Number(match[1]));
}));
const port = await portPromise;
`,
    );

    expect(reason).toBeUndefined();
  });

  it('detects cursor implementations that skip the next book', () => {
    const reason = detectContractStaticIssue(
      `
const cursorParam = url.searchParams.get("cursor");
let startIdx = 0;
if (cursorParam) {
  const cursorNum = parseInt(cursorParam, 10);
  const found = books.findIndex(b => b.id === cursorNum);
  if (found !== -1) {
    startIdx = found + 1;
  }
}
const hasMore = startIdx + limit < books.length;
const nextCursor = hasMore ? String(books[startIdx + limit].id) : null;
return { data: page, pagination: { limit, cursor: nextCursor, total, hasMore } };
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) resolve(Number(match[1]));
}));
const port = await portPromise;
`,
    );

    expect(reason).toContain('skips one book');
    expect(reason).toContain('Do not patch contract-test.mjs');
  });

  it('detects servers that compute a next cursor but return the incoming cursor', () => {
    const reason = detectContractStaticIssue(
      `
const cursorParam = searchParams.get("cursor");
const hasMore = startIndex + limit < total;
const nextCursorId = hasMore ? String(paginatedBooks[paginatedBooks.length - 1].id) : null;
return {
  data: paginatedBooks,
  pagination: {
    limit,
    cursor: cursorParam,
    total,
    hasMore,
  },
};
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) resolve(Number(match[1]));
}));
const port = await portPromise;
`,
    );

    expect(reason).toContain('computes a next cursor');
    expect(reason).toContain('cursor: cursorParam');
    expect(reason).toContain('Return the computed next cursor');
  });

  it('detects author-books routes that check the wrong path segment', () => {
    const reason = detectContractStaticIssue(
      `
const pathSegments = url.pathname.split('/').filter(Boolean);
if (pathSegments[0] === 'authors' && pathSegments.length >= 2 && pathSegments[1] === 'books') {
  const authorId = Number(pathSegments[1]);
  return listBooksForAuthor(authorId);
}
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
await fetch(\`http://localhost:\${port}/authors/1/books\`);
`,
    );

    expect(reason).toContain('misroutes /authors/{id}/books');
    expect(reason).toContain('pathSegments[1] is the numeric author id');
    expect(reason).toContain('pathSegments[2] is "books"');
  });

  it('detects broad GET /books routing that catches GET /books/{id}', () => {
    const reason = detectContractStaticIssue(
      `
if (pathSegments[0] === "books") {
  if (req.method === "GET") {
    return sendJson({ data: books, pagination: { limit: 10, cursor: null, total: 5, hasMore: false } });
  } else if (req.method === "GET" && pathSegments.length === 2) {
    return sendJson(books[0]);
  }
}
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
await fetch(\`http://localhost:\${port}/books/1\`);
`,
    );

    expect(reason).toContain('broad `if (req.method === "GET")` branch');
    expect(reason).toContain('GET /books/{id} is treated as the list endpoint');
    expect(reason).toContain('pathSegments.length === 2');
  });

  it('allows length-checked GET /books and GET /books/{id} routes', () => {
    const reason = detectContractStaticIssue(
      `
if (pathSegments.length === 1 && pathSegments[0] === "books" && req.method === "GET") {
  return sendJson({ data: books, pagination: { limit: 10, cursor: null, total: 5, hasMore: false } });
}
if (pathSegments.length === 2 && pathSegments[0] === "books" && req.method === "GET") {
  return sendJson(books[0]);
}
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
await fetch(\`http://localhost:\${port}/books/1\`);
`,
    );

    expect(reason).toBeUndefined();
  });

  it('allows nested length-checked GET /books and GET /books/{id} routes', () => {
    const reason = detectContractStaticIssue(
      `
if (pathSegments[0] === 'books') {
  if (pathSegments.length === 1) {
    if (req.method === 'GET') return listBooks(req, res);
  } else if (pathSegments.length === 2) {
    if (req.method === 'GET') return getBook(req, res, pathSegments);
  }
}
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
await fetch(\`http://localhost:\${port}/books/1\`);
`,
    );

    expect(reason).toBeUndefined();
  });

  it('detects contract tests that hard-code an author id absent from server data', () => {
    const reason = detectContractStaticIssue(
      `
const books = [{ id: 1, authorId: 101 }];
const authors = [{ id: 101, name: "Ada" }];
server.listen(process.env.PORT || 0, () => console.log(\`listening on PORT=\${server.address().port}\`));
`,
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const port = await waitForPort(server);
const authorId = 1;
await fetch(\`http://localhost:\${port}/authors/\${authorId}/books\`);
`,
    );

    expect(reason).toContain('hard-codes authorId = 1');
    expect(reason).toContain('does not appear to contain that author id');
    expect(reason).toContain('Derive authorId from an existing Book');
  });

  it('allows contract tests that await the port promise before fetching', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
const portPromise = new Promise((resolve) => {
  server.stdout.on('data', (chunk) => {
    const match = chunk.toString().match(/PORT=(\\d+)/);
    if (match) resolve(Number(match[1]));
  });
});
const port = await portPromise;
await runTests(port);
`,
    );

    expect(reason).toBeUndefined();
  });

  it('allows contract tests that poll until the stdout port has been discovered', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
let port = null;
server.stdout.on('data', (chunk) => {
  const match = chunk.toString().match(/PORT=(\\d+)/);
  if (match) port = Number(match[1]);
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout waiting for port')), 10000);
  const check = setInterval(() => {
    if (port) {
      clearTimeout(timer);
      clearInterval(check);
      resolve(port);
    }
  }, 50);
});
await fetch(\`http://localhost:\${port}/books\`);
`,
    );

    expect(reason).toBeUndefined();
  });

  it('detects child cleanup that registers a close listener after kill', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const serverProcess = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  passed = true;
} finally {
  serverProcess.kill();
  await new Promise((resolve) => serverProcess.on('close', resolve));
  process.exitCode = passed ? 0 : 1;
}
`,
    );

    expect(reason).toContain('before registering the close/exit waiter');
  });

  it('names the actual child variable in kill-before-wait cleanup feedback', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const child = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  passed = true;
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
  process.exitCode = passed ? 0 : 1;
}
`,
    );

    expect(reason).toContain('calls child.kill() before registering');
    expect(reason).toContain('once(child, "close")');
  });

  it('allows child cleanup with a non-server variable when the promise comes before kill', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const serverProcess = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  passed = true;
} finally {
  const closed = new Promise((resolve) => serverProcess.on('close', resolve));
  serverProcess.kill();
  await closed;
  process.exitCode = passed ? 0 : 1;
}
`,
    );

    expect(reason).toBeUndefined();
  });

  it('allows child cleanup that registers the close waiter before kill', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
import { once } from 'node:events';
const server = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
try {
  passed = true;
} finally {
  const closed = once(server, 'close');
  server.kill();
  await closed;
  process.exitCode = passed ? 0 : 1;
}
`,
    );

    expect(reason).toBeUndefined();
  });

  it('detects Error validators that reject string messages', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
function validateError(data) {
  if (typeof data.code !== 'number' || typeof data.message === 'string') return false;
  return true;
}
`,
    );

    expect(reason).toContain('rejects valid Error objects');
    expect(reason).toContain('typeof data.message !== "string"');
  });

  it('detects array validators that use typeof for array fields', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const SCHEMA = { PaginatedBooks: { typeChecks: { data: 'array' } } };
function validateShape(obj, schema) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
  for (const [key, expected] of Object.entries(schema.typeChecks)) {
    const val = obj[key];
    const actualType = val === null ? 'null' : typeof val;
    if (actualType !== expected) return false;
  }
  return true;
}
`,
    );

    expect(reason).toContain('typeof "object"');
    expect(reason).toContain('Array.isArray(value)');
  });

  it('allows array validators that use Array.isArray on the field value', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
const SCHEMA = { PaginatedBooks: { typeChecks: { data: 'array' } } };
function validateShape(obj, schema) {
  for (const [key, expected] of Object.entries(schema.typeChecks)) {
    const val = obj[key];
    if (expected === 'array') return Array.isArray(val);
    if (typeof val !== expected) return false;
  }
  return true;
}
`,
    );

    expect(reason).toBeUndefined();
  });

  it('does not misread pagination string checks as Error validator failures', () => {
    const reason = detectContractStaticIssue(
      'server.listen(process.env.PORT || 0, () => console.log(`listening on PORT=${server.address().port}`));',
      `
function validateError(data) {
  if (!data || typeof data !== 'object') return false;
  return typeof data.code === 'number' && typeof data.message === 'string';
}

function validateEnvelope(data) {
  if (!(data.pagination.cursor === null || typeof data.pagination.cursor === 'string')) {
    return false;
  }
  return true;
}
`,
    );

    expect(reason).toBeUndefined();
  });

  it('turns a contract-test timeout into port-handshake guidance', () => {
    const reason = formatContractFailure(null, '--- Starting Bookstore API Server ---\n', '');

    expect(reason).toContain('timed out before completing the server-port handshake');
    expect(reason).toContain("server.stdout 'end'");
    expect(reason).toContain('server.address().port');
  });

  it('turns a blank contract-test timeout into cleanup and port guidance', () => {
    const reason = formatContractFailure(null, '', '');

    expect(reason).toContain('timed out with no output');
    expect(reason).toContain('PORT');
    expect(reason).toContain('before calling server.kill()');
  });

  it('turns a YAML-as-JS SyntaxError into schema embedding guidance', () => {
    const reason = formatContractFailure(
      1,
      `C:\\Temp\\openapi.yaml:1
openapi: 3.1.0
            ^^

SyntaxError: Unexpected number`,
      '',
    );

    expect(reason).toContain('loading openapi.yaml as JavaScript');
    expect(reason).toContain('Plain Node cannot require/import YAML');
    expect(reason).toContain('JS object literal');
  });

  it('turns illegal top-level return syntax into a contract-test repair', () => {
    const reason = formatContractFailure(1, '', 'SyntaxError: Illegal return statement');

    expect(reason).toContain('top-level return statement');
    expect(reason).toContain('throw new Error("could not detect server port")');
    expect(reason).toContain('Do not rewrite server.mjs');
  });

  it('turns nonzero exit after pass output into cleanup guidance', () => {
    const reason = formatContractFailure(
      3221226505,
      'Testing: GET /authors/{id}/books\n\t[PASS] Schema validated successfully.\n*** All contract tests passed! ***',
      '',
    );

    expect(reason).toContain('printed that all contract tests passed');
    expect(reason).toContain('exited nonzero during cleanup');
    expect(reason).toContain('set process.exitCode');
  });

  it('explains brittle hasMore=false pagination assertions', () => {
    const reason = formatContractFailure(1, '✗ Expected hasMore=false', '');

    expect(reason).toContain('hard-codes hasMore=false');
    expect(reason).toContain('/books?limit=2&cursor=2');
    expect(reason).toContain('shape-focused');
  });

  it('routes non-boolean hasMore failures to the server response', () => {
    const reason = formatContractFailure(1, '', 'hasMore is not boolean');

    expect(reason).toContain('server.mjs returned pagination.hasMore');
    expect(reason).toContain('non-boolean value');
    expect(reason).not.toContain('the test ran and reported a failing check');
  });

  it('explains localhost:null port discovery failures', () => {
    const reason = formatContractFailure(
      1,
      'FAIL: GET /books failed: Failed to parse URL from http://localhost:null/books',
      '',
    );

    expect(reason).toContain('starts fetches before the server port is discovered');
    expect(reason).toContain('await that promise');
    expect(reason).toContain('building baseUrl');
  });

  it('explains typeof array validator failures', () => {
    const reason = formatContractFailure(
      1,
      'FAIL: GET /books: Key "data" expected array, got object',
      '',
    );

    expect(reason).toContain('validates arrays with typeof');
    expect(reason).toContain('Array.isArray(value)');
  });

  it('explains generic pagination envelope contract failures', () => {
    const reason = formatContractFailure(
      1,
      'GET /books?limit=2: response does not match Pagination envelope schema',
      '',
    );

    expect(reason).toContain('cursor as a string or null');
    expect(reason).toContain('never a numeric Book id');
  });

  it('explains when GET /books/{id} returns a list envelope instead of a Book', () => {
    const reason = formatContractFailure(
      1,
      '[FAIL] GET /books/1: Book object missing field id.\n[FAIL] GET /books/1: Book object missing field title.',
      '',
    );

    expect(reason).toContain('GET /books/{id} returned something that is not a Book object');
    expect(reason).toContain('list branch catch /books/1');
    expect(reason).toContain('pathSegments.length === 2');
  });

  it('explains author-books failures caused by a hard-coded absent author id', () => {
    const reason = formatContractFailure(
      1,
      '[FAIL] http://127.0.0.1:36531/authors/1/books?limit=2: Expected status 200, got 404',
      '',
    );

    expect(reason).toContain('GET /authors/{id}/books returned 404');
    expect(reason).toContain('derive authorId from an existing Book');
    expect(reason).toContain('pathSegments[2] === "books"');
  });

  it('explains blank FAIL output from an unset passed flag', () => {
    const reason = formatContractFailure(1, 'FAIL: ', '');

    expect(reason).toContain('printed FAIL with no reason');
    expect(reason).toContain('passed = true');
  });

  it('prioritizes stderr failure lines over generic cleanup stdout', () => {
    const reason = formatContractFailure(
      1,
      '[TEST] Running: Get books by non-existent author (404) (GET /authors/99/books)\nShutting down server...\nServer process successfully closed.',
      '[FAIL] Get books by non-existent author (404): Response shape validation failed for data: {"code":404,"message":"Author not found."}',
    );

    expect(reason).toContain('Response shape validation failed');
    expect(reason).toContain('Author not found');
    expect(reason).not.toContain('Server process successfully closed');
  });

  it('explains the exact author-books pagination envelope on response-shape failures', () => {
    const reason = formatContractFailure(1, '', 'GET /authors/{id}/books response shape invalid');

    expect(reason).toContain('GET /authors/{id}/books response shape invalid');
    expect(reason).toContain('same Pagination envelope as GET /books');
    expect(reason).toContain('cursor: string | null');
    expect(reason).toContain('Do not return { data, author }');
    expect(reason).toContain('do not use nextCursor');
  });

  it('explains the exact books pagination envelope on response-shape failures', () => {
    const reason = formatContractFailure(1, 'FAIL: GET /books response shape invalid', '');

    expect(reason).toContain('GET /books response shape invalid');
    expect(reason).toContain('exact Pagination envelope');
    expect(reason).toContain('hasMore: boolean');
    expect(reason).toContain('Do not use nextCursor');
  });

  it('explains Book field drift when server returns year instead of publishedYear', () => {
    const reason = formatContractFailure(
      1,
      'Invalid pagination envelope for http://localhost:54481/books: {"data":[{"id":1,"title":"The Great Gatsby","authorId":1,"year":1925,"isbn":"978-0743273565"}],"pagination":{"limit":10,"cursor":null,"total":5,"hasMore":false}}',
      '',
    );

    expect(reason).toContain('expects `publishedYear`');
    expect(reason).toContain('Do not mix `year` and `publishedYear`');
  });

  it('uses a focused DELETE patch directive when only /books/{id}#DELETE is missing', () => {
    const directive = bookstoreRepairDirective(
      'all-paths-present: missing /books/{id}#DELETE; DELETE belongs on /books/{id}, not /books/{id}/delete',
    );

    expect(directive).toContain('BOOKSTORE_DELETE_PATCH');
    expect(directive).toContain('next tool call MUST write `openapi.yaml`');
    expect(directive).toContain('doc.paths["/books/{id}"].delete');
    expect(directive).toContain('same indentation as `get:` and `patch:`');
    expect(directive).toContain('operationId: deleteBook');
    expect(directive).toContain("        '204':");
    expect(directive).not.toContain('Rewrite the entire openapi.yaml');
  });

  it('uses a whole-file OpenAPI rewrite directive for other structural path failures', () => {
    const directive = bookstoreRepairDirective('all-paths-present: missing /authors/{id}/books');

    expect(directive).toContain('Rewrite the entire openapi.yaml');
    expect(directive).toContain('do not patch YAML fragments');
    expect(directive).toContain('`/books/{id}` with `get`, `patch`, and `delete`');
    expect(directive).toContain('Do not create `/books/{id}/delete`');
    expect(directive).toContain('comment saying DELETE is required does not count');
    expect(directive).toContain('literal `delete:` operation nested under `/books/{id}`');
    expect(directive).toContain('operationId: deleteBook');
    expect(directive).toContain('Either root-level `security: [{ bearerAuth: [] }]`');
    expect(directive).toContain('Bearer auth must cover POST /books');
    expect(directive).toContain('PATCH /books/{id}');
    expect(directive).toContain('DELETE /books/{id}');
    expect(directive).toContain('`security: [{ bearerAuth: [] }]`');
  });

  it('uses a no-duplicate YAML directive for parse failures', () => {
    const directive = bookstoreRepairDirective('yaml-parses: duplicated mapping key (214:7)');

    expect(directive).toContain('BOOKSTORE_OPENAPI_DUPLICATE_PATH_PATCH');
    expect(directive).toContain('same path key more than once');
    expect(directive).toContain('/books/{id}` must be one mapping');
  });

  it('uses a runtime patch directive for contract failures', () => {
    const directive = bookstoreRepairDirective(
      'contract-test-passes: server.mjs did not print PORT',
    );

    expect(directive).toContain('Patch only server.mjs and/or contract-test.mjs');
    expect(directive).toContain("server.stdout.on('data'");
    expect(directive).toContain('already ran `node contract-test.mjs`');
    expect(directive).toContain('Do not reply that you are waiting for the checker');
    expect(directive).toContain('use top-level imports');
    expect(directive).toContain('Do not await server close/exit before running assertions');
    expect(directive).toContain('Do not prepend `/api/v1`');
    expect(directive).toContain('Thread the discovered `port`');
    expect(directive).toContain('Do not import `setTimeout` from `node:timers/promises`');
    expect(directive).toContain('pathSegments[2] === "books"');
    expect(directive).toContain('GET `/books/{id}` only when `pathSegments.length === 2`');
    expect(directive).toContain('avoid hard-coded author ids');
    expect(directive).toContain('Do not `require("./openapi.yaml")`');
    expect(directive).toContain('Remove every `process.exit(...)` call');
    expect(directive).toContain('let passed = false');
    expect(directive).toContain('process.exitCode = passed ? 0 : 1');
    expect(directive).toContain('do not call process.exit in success');
    expect(directive).toContain('do not import `node:fetch`');
    expect(directive).toContain('Error schema checks must accept');
    expect(directive).toContain('Pagination checks must use one exact envelope');
    expect(directive).toContain('independent smoke test fetches `/books`');
    expect(directive).toContain('Do not call `run_nodejs_script` for contract-test.mjs');
  });

  it('uses a whole-file contract-test rewrite directive for duplicate import syntax failures', () => {
    const directive = bookstoreRepairDirective(
      "contract-test-passes: contract-test exit 1: SyntaxError: Identifier 'assert' has already been declared",
    );

    expect(directive).toContain('BOOKSTORE_CONTRACT_IMPORT_REWRITE');
    expect(directive).toContain('write `contract-test.mjs`');
    expect(directive).toContain('Rewrite the whole contract-test.mjs once');
    expect(directive).toContain('single import block');
    expect(directive).toContain('Each imported binding may appear exactly once');
    expect(directive).toContain('Do not import `{ json }` from `node:util`');
    expect(directive).toContain('Set `process.exitCode = passed ? 0 : 1`');
  });
});

describe('bookstoreAssertionSnippet', () => {
  const server = {
    path: 'server.mjs',
    text: [
      "import { createServer } from 'node:http';",
      'const books = loadBooks();',
      'function handleBooks(res, query) {',
      '  // GET /books returns the paginated envelope',
      '  const page = paginate(books, query);',
      '  res.end(JSON.stringify({ data: page.items, pagination: { cursor: page.cursor, hasMore: String(page.hasMore) } }));',
      '}',
      'function handleAuthors(res) {',
      '  res.end(JSON.stringify(authors));',
      '}',
    ].join('\n'),
  };
  const contract = {
    path: 'contract-test.mjs',
    text: [
      "import assert from 'node:assert';",
      'const body = await getJson(`/books`);',
      "assert.ok(Array.isArray(body.data), 'GET /books returns data array');",
      "assert.strictEqual(typeof body.pagination.hasMore, 'boolean', 'hasMore is boolean');",
    ].join('\n'),
  };

  it('pairs a smoke assertion with the offending server snippet window', () => {
    const snippet = bookstoreAssertionSnippet(
      'contract-test-passes: evaluator smoke failed: GET /books pagination.hasMore is not boolean; server stderr: (none)',
      { server, contract },
    );
    expect(snippet).toContain('Failing assertion: GET /books pagination.hasMore is not boolean');
    expect(snippet).toContain('Offending code (`server.mjs`');
    expect(snippet).toContain('hasMore: String(page.hasMore)');
    expect(snippet).toContain('Fix exactly this code path');
  });

  it('collapsed Failing check(s) lines pair only the FIRST failing assertion', () => {
    const snippet = bookstoreAssertionSnippet(
      "contract-test exit 1: the test ran and reported a failing check — fix what it names (the assertion in contract-test.mjs, or the server response it validates), not the port handshake. Remember a single-item GET like /books/{id} must match that item's own schema (Book), while only list endpoints (GET /books, GET /authors/{id}/books) return the Pagination envelope. Failing check(s): GET /books expected 5 books, got 3 | GET /authors/1/books expected 2, got 0",
      { server, contract },
    );
    expect(snippet).toContain('Failing assertion: GET /books expected 5 books, got 3');
    expect(snippet).not.toContain('expected 2, got 0');
  });

  it('falls back to assertion-only guidance when the token has no code hit', () => {
    const snippet = bookstoreAssertionSnippet(
      'contract-test-passes: evaluator smoke failed: publishedYear must be an integer',
      { server: { path: 'server.mjs', text: 'const nothing = true;' }, contract },
    );
    expect(snippet).toContain('Failing assertion: publishedYear must be an integer');
    expect(snippet).toContain('Search `');
    expect(snippet).not.toContain('```');
  });

  it('returns undefined for structural spec failures and unmatchable reasons', () => {
    expect(
      bookstoreAssertionSnippet('all-paths-present: missing /books/{id}#DELETE', {
        server,
        contract,
      }),
    ).toBeUndefined();
    expect(
      bookstoreAssertionSnippet('something entirely unshaped', { server, contract }),
    ).toBeUndefined();
  });

  it('never throws on empty sources', () => {
    expect(() =>
      bookstoreAssertionSnippet('contract-test exit 1: boom /books', {
        server: { path: 'server.mjs', text: '' },
      }),
    ).not.toThrow();
  });
});
