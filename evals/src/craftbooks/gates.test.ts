import { describe, expect, it } from 'vitest';
import { minimalDocxFixture, minimalPptxFixture } from '../mock/mock-server.ts';
import { type CraftbookEvalWorkspace, evaluateCraftbookGateChecks } from './gates.ts';

function workspace(files: Record<string, string>): CraftbookEvalWorkspace {
  return {
    async read(file) {
      return files[file] ?? null;
    },
    async list() {
      return Object.keys(files);
    },
  };
}

function binaryWorkspace(
  files: Record<string, Uint8Array>,
  surface: 'workspace' | 'artifact' = 'workspace',
): CraftbookEvalWorkspace {
  const reader = async (file: string) => files[file] ?? null;
  return {
    async read() {
      return null;
    },
    async list() {
      return Object.keys(files);
    },
    ...(surface === 'workspace' ? { readBytes: reader } : { readArtifactBytes: reader }),
  };
}

describe('binaryDocument gate check', () => {
  const pptx = minimalPptxFixture();

  it('accepts a real converted container in the workspace', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'binaryDocument', file: 'deliverables/deck.pptx' }],
      binaryWorkspace({ 'deliverables/deck.pptx': pptx }),
    );
    expect(result).toEqual({ pass: true, failures: [] });
  });

  it('rejects the Markdown source written to the binary path', async () => {
    // The substitution a bare minBytes floor accepted: every DocBlocks tool
    // called, then `write_file` with the deck source at the .pptx path.
    const markdown = new TextEncoder().encode(
      `# Slide one\n\n---\n\n# Slide two\n${'x'.repeat(2000)}`,
    );
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'binaryDocument', file: 'deliverables/deck.pptx' }],
      binaryWorkspace({ 'deliverables/deck.pptx': markdown }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toMatch(/not a real ZIP container/);
  });

  it('reads the artifacts drawer without delegating to the runtime evaluator', async () => {
    // Eval-only kinds must not take the `artifact: true` delegation path —
    // the runtime evaluator has never heard of them.
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'binaryDocument', file: 'report.docx', artifact: true }],
      binaryWorkspace({ 'report.docx': minimalDocxFixture() }, 'artifact'),
    );
    expect(result).toEqual({ pass: true, failures: [] });
  });

  it('fails closed when the surface cannot serve bytes', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'binaryDocument', file: 'deck.pptx' }],
      workspace({ 'deck.pptx': 'text stand-in' }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toMatch(/cannot serve raw bytes/);
  });

  it('enforces a byte floor before the signature check', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'binaryDocument', file: 'deck.pptx', minBytes: 100_000 }],
      binaryWorkspace({ 'deck.pptx': pptx }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toMatch(/at least 100000/);
  });
});

describe('craftbook eval gate checks', () => {
  it('evaluates shared file checks', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        { kind: 'minBytes', file: 'report.md', bytes: 10 },
        { kind: 'contains', file: 'report.md', pattern: '^#\\s+Report', flags: 'm' },
      ],
      workspace({ 'report.md': '# Report\n\nUseful content.\n' }),
    );
    expect(result).toEqual({ pass: true, failures: [] });
  });

  it('reports concrete failures', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'minBytes', file: 'report.md', bytes: 100 }],
      workspace({ 'report.md': 'short' }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('report.md');
  });

  it('evaluates negative content checks', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'notContains', file: 'report.md', pattern: 'internal-only|CI', flags: 'i' }],
      workspace({ 'report.md': '# Report\n\nInternal-only CI refactor.\n' }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('forbidden content');
  });

  it('surfaces labeled content checks as repair guidance', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'contains',
          file: 'report.md',
          pattern: 'Summary',
          label: 'add a Summary section',
        },
      ],
      workspace({ 'report.md': '# Report\n' }),
    );
    expect(result.pass).toBe(false);
    // The verdict quotes the requirement (label) AND what was observed
    // (byte count + pattern) — the A3 name-the-mistake upgrade.
    expect(result.failures[0]).toBe(
      'report.md is missing required content: add a Summary section — nothing in its 9 bytes matches /Summary/. Add that content.',
    );
  });

  it('evaluates exact JSON path checks', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'jsonPathEquals',
          file: 'data/audit.json',
          path: 'summary.total_records',
          value: 6,
          label: 'use the seeded CSV row count',
        },
      ],
      workspace({ 'data/audit.json': '{"summary":{"total_records":7}}' }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toBe(
      'data/audit.json summary.total_records should equal 6 but was 7: use the seeded CSV row count',
    );
  });

  it('surfaces matched text for labeled forbidden content', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'notContains',
          file: 'report.md',
          pattern: 'significant(?:ly)?',
          flags: 'i',
          label: 'remove promotional wording',
        },
      ],
      workspace({ 'report.md': '# Report\n\nThis is a significant improvement.\n' }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toBe(
      'report.md contains forbidden content: remove promotional wording (matched "significant")',
    );
  });

  it('evaluates unsupported claim checks against seeded source files', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'unsupportedClaims',
          file: 'press-release.md',
          sourceFiles: ['source/news-brief.md'],
          patterns: [
            { pattern: 'fundamentally(?: changes?)?', label: 'avoid sweeping overclaims' },
          ],
        },
      ],
      workspace({
        'source/news-brief.md': 'Boreal Desk is launching guided returns intake.',
        'press-release.md': 'Boreal Desk fundamentally changes support operations.',
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('matched "fundamentally changes"');
  });

  it('evaluates CSV shape checks', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'csvShape',
          file: 'updates.csv',
          exactColumns: ['object_type', 'email', 'status'],
          minRows: 2,
          allowedValues: { status: ['Active', 'Renewal Risk', 'Expansion', 'UNMATCHED'] },
        },
      ],
      workspace({
        'updates.csv':
          'object_type,email,status\nContact,a@example.com,Expansion\nContact,b@example.com,Renewal Risk\n',
      }),
    );
    expect(result).toEqual({ pass: true, failures: [] });

    const bad = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'csvShape',
          file: 'updates.csv',
          exactColumns: ['object_type', 'email', 'status'],
          minRows: 2,
        },
      ],
      workspace({
        'updates.csv':
          'object_type,email,status\nContact,a@example.com\nContact,b@example.com,Active\n',
      }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toContain('column(s), expected');
    expect(bad.failures[0]).toContain('Keep empty placeholders as adjacent commas');
  });

  it('evaluates Prometheus alert rule shape checks', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'prometheusAlerts',
          file: 'alerts.yaml',
          minRules: 3,
          maxPageAlerts: 2,
          requiredServices: ['checkout-api', 'webhook-worker'],
          requiredRunbookUrls: [
            'https://runbooks.example/payments/checkout-latency',
            'https://runbooks.example/payments/checkout-errors',
            'https://runbooks.example/payments/webhook-backlog',
          ],
        },
      ],
      workspace({
        'alerts.yaml': `groups:
  - name: payments.checkout
    rules:
      - alert: CheckoutLatencyP99High
        expr: histogram_quantile(0.99, rate(checkout_request_duration_seconds_bucket[10m])) > 0.8
        for: 10m
        labels:
          severity: page
          team: payments
          service: checkout-api
        annotations:
          summary: Checkout p99 latency is above 800ms
          description: Checkout p99 latency is above 800ms for 10 minutes.
          runbook_url: https://runbooks.example/payments/checkout-latency
      - alert: CheckoutErrorRateHigh
        expr: sum(rate(checkout_http_requests_total{status=~"5.."}[5m])) / sum(rate(checkout_http_requests_total[5m])) > 0.02
        for: 5m
        labels:
          severity: page
          team: payments
          service: checkout-api
        annotations:
          summary: Checkout 5xx error rate is above 2%
          description: Checkout 5xx error rate is above 2% for 5 minutes.
          runbook_url: https://runbooks.example/payments/checkout-errors
      - alert: WebhookRetryBacklogHigh
        expr: webhook_retry_backlog_jobs > 5000
        for: 10m
        labels:
          severity: ticket
          team: payments
          service: webhook-worker
        annotations:
          summary: Webhook retry backlog is above 5000 jobs
          description: Webhook retry backlog is above 5000 jobs for more than 10 minutes.
          runbook_url: https://runbooks.example/payments/webhook-backlog
`,
      }),
    );
    expect(result).toEqual({ pass: true, failures: [] });
  });

  it('rejects invalid Prometheus alert rule shape with repairable detail', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'prometheusAlerts',
          file: 'alerts.yaml',
          maxPageAlerts: 1,
        },
      ],
      workspace({
        'alerts.yaml': `groups:
  - name: broken
    rules:
      - alert: MissingExpr
        for: 5m
        labels:
          severity: page
          team: payments
          service: checkout-api
        annotations:
          summary: Missing expr
          description: Missing expr
          runbook_url: https://runbooks.example/payments/checkout-errors
`,
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('groups.[0].rules.[0].expr');
  });

  it('matches runtime jsParses semantics for pages with no inline JS', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'jsParses', file: 'index.html' }],
      workspace({ 'index.html': '<!doctype html><html><body>No script needed</body></html>' }),
    );
    expect(result.pass).toBe(true);
  });

  it('evaluates core esmImports checks for code deliverables', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'esmImports', file: 'src/cli.mjs' }],
      workspace({ 'src/cli.mjs': "const fs = require('node:fs');\n" }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('require');
  });

  it('evaluates core sourceParses checks for standalone source deliverables', async () => {
    const ok = await evaluateCraftbookGateChecks(
      [{ kind: 'sourceParses', file: 'server.mjs' }],
      workspace({
        'server.mjs':
          "import { createServer } from 'node:http';\nexport function createBookstoreServer() {\n  return createServer();\n}\n",
      }),
    );
    expect(ok.pass).toBe(true);

    const bad = await evaluateCraftbookGateChecks(
      [{ kind: 'sourceParses', file: 'server.mjs' }],
      workspace({
        'server.mjs':
          "import { createServer } from 'node:http';\nexport function createBookstoreServer() {\n  return createServer(\n",
      }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toContain('server.mjs does not parse');
    expect(bad.failures[0]).toMatch(/line \d+:\d+/);
  });

  it('delegates sourceParses checks for HTML deliverables to inline JavaScript parsing', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'sourceParses', file: 'index.html' }],
      workspace({ 'index.html': '<html><body><script>function broken( {</script></body></html>' }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('inline JavaScript does not parse');
  });

  it('evaluates core data-table sniff checks for data deliverables', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'sniff', file: 'data/output.csv', sniff: 'data-table' }],
      workspace({ 'data/output.csv': 'id,total\nA,10\nB,20\n' }),
    );

    expect(result).toEqual({ pass: true, failures: [] });
  });

  it('runs node scripts against a materialized workspace copy', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'tests/check.mjs', timeoutMs: 2000 }],
      workspace({
        'src/value.mjs': 'export const value = 42;\n',
        'tests/check.mjs':
          "import assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\nassert.equal(value, 42);\n",
      }),
    );

    expect(result).toEqual({ pass: true, failures: [] });
  });

  it('reports node script runtime failures as repair guidance', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'check.mjs', timeoutMs: 2000 }],
      workspace({
        'check.mjs':
          "import assert from 'node:assert/strict';\nassert.equal('actual', 'expected');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('check.mjs did not pass when run with node');
    expect(result.failures[0]).toContain('actual');
    expect(result.failures[0]).toContain('expected');
  });

  // INCIDENT: the oracle copies the workspace into a fresh `mkdtemp` root on
  // every poll, and node stamps that root into every stack frame. The repair
  // ladders in sniff-feedback.ts key their "did the model try again?"
  // counters off the failure text, so a frozen failure looked like a brand
  // new revision five seconds later: the score-plateau ladder booked one
  // "completed repair" per poll and terminated qwen3.8-27b x codemod-sweep
  // as `repair-exhausted (score plateau): 6 completed repairs` while the
  // target gezel had been mid-turn the entire time. Booked as a MODEL
  // failure for a counter the model never touched.
  it('renders the same node failure identically across runs', async () => {
    const ws = workspace({
      'check.mjs':
        "import assert from 'node:assert/strict';\nassert.equal('actual', 'expected');\n",
    });
    const check = { kind: 'nodeScriptPasses' as const, script: 'check.mjs', timeoutMs: 5000 };

    const first = await evaluateCraftbookGateChecks([check], ws);
    const second = await evaluateCraftbookGateChecks([check], ws);

    expect(first.failures[0]).toBe(second.failures[0]);
    expect(first.failures[0]).not.toMatch(/gezel-craftbook-node-/);
    expect(first.failures[0]).toContain('<sandbox>');
  });

  // INCIDENT: `execFile`'s rejection message already ends with the captured
  // stderr, and the detail appended it a second time. formatNudge then
  // renders the detail once as a missing signal and once as the specific
  // failure, so one 1.3 KB assertion trace reached the model FOUR times in a
  // 5.4 KB repair message, and the 2000-char cap sliced the last copy
  // mid-token (`operator: 'deepS`). On a 27B local model that message is the
  // entire repair signal.
  it('does not repeat the captured stderr the failure message already carries', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'check.mjs', timeoutMs: 5000 }],
      workspace({
        'check.mjs':
          "import assert from 'node:assert/strict';\nassert.ok(false, 'UNIQUE_MARKER_FOR_DEDUP');\n",
      }),
    );

    expect(result.pass).toBe(false);
    const occurrences = result.failures[0]!.split('UNIQUE_MARKER_FOR_DEDUP').length - 1;
    expect(occurrences).toBe(1);
  });

  it('reports a hung (unclosed) script as a timeout, not an assertion failure (E3)', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'hang.mjs', timeoutMs: 500 }],
      workspace({
        // Keeps the event loop alive forever → never exits → timeout kills
        // it. Stands in for "the server never closed."
        'hang.mjs': "console.log('Pagination test passed');\nsetInterval(() => {}, 100000);\n",
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('was killed after 500ms without exiting');
    expect(result.failures[0]).toContain('timeout, not an assertion failure');
    expect(result.failures[0]).toContain('server.close()');
    expect(result.failures[0]).not.toContain('did not pass when run with node');
  });

  it('fails node scripts that print assertion failures but exit cleanly', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'check.mjs', timeoutMs: 2000 }],
      workspace({
        'check.mjs': "console.error('Test C Failed: AssertionError [ERR_ASSERTION]');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('reported failure output despite exit 0');
    expect(result.failures[0]).toContain('Do not catch assertion errors');
  });

  it('requires configured node script output patterns', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'nodeScriptPasses',
          script: 'contract-test.mjs',
          timeoutMs: 2000,
          requiredOutput: [
            { pattern: 'pagination', flags: 'i', label: 'pagination test ran' },
            { pattern: 'auth', flags: 'i', label: 'auth test ran' },
          ],
        },
      ],
      workspace({
        'contract-test.mjs': "console.log('Pagination test passed');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('auth test ran');
    expect(result.failures[0]).toContain('console.log("Pagination test passed")');
  });

  it('accepts route-specific contract output markers when runtime assertions pass', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'nodeScriptPasses',
          script: 'contract-test.mjs',
          timeoutMs: 2000,
          requiredOutput: [
            {
              pattern: 'GET\\s+/books/\\{id\\}|Not Found|BOOK_NOT_FOUND|404',
              flags: 'i',
              label: 'not-found test ran',
            },
          ],
        },
      ],
      workspace({
        'contract-test.mjs': "console.log('--- Running GET /books/{id} Tests ---');\n",
      }),
    );

    expect(result.pass).toBe(true);
  });

  it('hints when a node test listens on port 0 but requests port 80', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "console.log('Server listening on http://127.0.0.1:0');\nthrow new Error('connect ECONNREFUSED 127.0.0.1:80');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('server.address().port');
  });

  it('hints when a server module imports itself and redeclares the exported factory', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'server.mjs':
          "import { createBookstoreServer } from './server.mjs';\nexport function createBookstoreServer() {}\n",
        'contract-test.mjs':
          "import { createBookstoreServer } from './server.mjs';\ncreateBookstoreServer();\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('Remove the self-import from `server.mjs`');
  });

  it('hints when a contract test imports ./server without the .mjs extension', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': "import { createBookstoreServer } from './server';\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('importing `./server` without the `.mjs` extension');
  });

  it('hints when a contract test calls the server factory without importing it', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': 'createBookstoreServer();\n',
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('without importing that binding');
    expect(result.failures[0]).toContain('import { createBookstoreServer }');
  });

  it('hints when generated code references a missing module-scope variable', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': "throw new ReferenceError('books is not defined');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('references `books` outside its scope');
    expect(result.failures[0]).toContain('Define it once in module scope');
  });

  it('hints with a whole-file contract-test rewrite when port scope is lost', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': "throw new ReferenceError('port is not defined');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('Rewrite `contract-test.mjs` once');
    expect(result.failures[0]).toContain('start it exactly once');
    expect(result.failures[0]).toContain('one `baseUrl`');
    expect(result.failures[0]).toContain('server.close()');
  });

  it('hints when a contract test imports node-fetch instead of using global fetch', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': "import fetch from 'node-fetch';\nconsole.log(fetch);\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('Do not import `node-fetch`');
    expect(result.failures[0]).toContain('global `fetch`');
  });

  it('hints when a node http server parses a relative req.url without a base', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw Object.assign(new TypeError(\"Invalid URL\\ninput: '/books/non-existent-id'\"), { code: 'ERR_INVALID_URL' });\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('Parse it with a base URL');
  });

  it('hints when generated REST tests call an /api/v1-prefixed route', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw new Error('API Error 404: Code=NOT_FOUND, Message=Endpoint /api/v1/books not found.');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('Remove every `/api/v1` prefix');
  });

  it('hints when a node HTTP test opens a request incorrectly', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': "throw new Error('socket hang up ECONNRESET');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('global `fetch()`');
  });

  it('hints when a contract test builds localhost URLs with an undefined port', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw new TypeError('Failed to parse URL from http://localhost:undefined/books');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('assigned port');
    expect(result.failures[0]).toContain('server.address().port');
  });

  it('hints when a contract test builds a URL for an unreachable server', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': "await fetch('http://127.0.0.1:1/books');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('not reachable');
    expect(result.failures[0]).toContain('baseUrl');
  });

  it('hints when a contract helper drops the listen(0) port from request URLs', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw new Error('Test 1 Failed: GET /books failed. TypeError: fetch failed\\n--- Running Contract Tests on http://localhost:43065 ---');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('assigned listen(0) port');
    expect(result.failures[0]).toContain('new URL(path, baseUrl)');
    expect(result.failures[0]).toContain('server.address().port');
  });

  it('hints when pagination tests assert hasMore without a paginated request', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw new Error('AssertionError: Pagination should indicate more items are available (if total > limit).');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('/books?limit=2');
  });

  it('hints when the bookstore server uses non-matching keys for seeded book ids', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          'throw new Error("Test Failed: GET /books/bk-1 should return the correct book ID.\\n+ actual - expected\\n\\n+ undefined\\n- \'bk-1\'");\n',
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('seeded book lookup is mismatched');
    expect(result.failures[0]).toContain('bk-1');
    expect(result.failures[0]).toContain('book.id === bookId');
  });

  it('hints when a create-book contract request drops body or auth options', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw new Error('Test Failed: POST /books should return 201 on success.\\n400 !== 201');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('JSON body and bearer auth');
    expect(result.failures[0]).toContain('method');
    expect(result.failures[0]).toContain('headers');
    expect(result.failures[0]).toContain('body');
  });

  it('hints when an unauthorized POST test is accidentally sent as a GET', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw new Error('T4 Status Check: Should be 401 Unauthorized\\n\\n200 !== 401');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('probably being sent as a GET');
    expect(result.failures[0]).toContain('globalThis.fetch(url, options)');
    expect(result.failures[0]).toContain('method: "POST"');
  });

  it('hints when expected REST error statuses throw before assertions inspect them', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw new Error('Fetch Error: Error: API call failed: 404 - Code: BOOK_NOT_FOUND\\nFetch Error: Error: API call failed: 401 - Code: VALIDATION_ERROR\\nFetch Error: Error: API call failed: 400 - Code: VALIDATION_ERROR\\n\\nContract Test FAILED.');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('throwing for expected non-2xx responses');
    expect(result.failures[0]).toContain('response.status');
    expect(result.failures[0]).toContain('404/BOOK_NOT_FOUND');
    expect(result.failures[0]).toContain('400/VALIDATION_ERROR');
  });

  it('hints when a REST server writes more than one response for a request', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': [
          "const err = new Error('Cannot write headers after they are sent to the client');",
          "err.code = 'ERR_HTTP_HEADERS_SENT';",
          'throw err;',
        ].join('\n'),
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('sends more than one response');
    expect(result.failures[0]).toContain('immediately `return`');
    expect(result.failures[0]).toContain('auth/validation/not-found error');
  });

  it('hints when a contract helper awaits fetch inside a non-async function', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "function makeRequest() {\n  const response = await fetch('http://localhost');\n  return response;\n}\nmakeRequest();\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('inside a non-async function');
  });

  it('hints when a contract helper awaits a global fetch expression inside a non-async function', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "function authCheck(fetchUrl) {\n  const authRes = await (globalThis.fetch || fetch)(fetchUrl);\n  return authRes;\n}\nauthCheck('http://localhost');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('using `await` inside a non-async function');
  });

  it('hints when server.mjs dynamically imports node:http inside a synchronous factory', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'server.mjs':
          "export function createBookstoreServer() {\n  const http = await import('node:http');\n  return http.createServer();\n}\n",
        'contract-test.mjs': "import { createBookstoreServer } from './server.mjs';\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('HTTP import ban applies to `contract-test.mjs` only');
    expect(result.failures[0]).toContain('top-level `import http from "node:http";`');
    expect(result.failures[0]).toContain('keep `createBookstoreServer()` synchronous');
  });

  it('hints when a node script redeclares a variable in the same scope', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          'let postMutationListResponse = 1;\nlet postMutationListResponse = 2;\n',
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('declares `postMutationListResponse` more than once');
    expect(result.failures[0]).toContain('remove every duplicated declaration');
    expect(result.failures[0]).toContain('replace the file once with one clean complete version');
  });

  it('hints with a whole-file contract-test rewrite when duplicate URL blocks are appended', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': 'const url = "/books";\nconst url = "/books?limit=2";\n',
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('declares `url` more than once');
    expect(result.failures[0]).toContain('Earlier patches likely inserted duplicate');
    expect(result.failures[0]).toContain('one async request helper');
    expect(result.failures[0]).toContain('Do not keep duplicated imports');
  });

  it('hints with a whole-file contract-test rewrite when the server is listened twice', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs': [
          "const err = new Error('Listen method has been called more than once without closing.');",
          "err.code = 'ERR_SERVER_ALREADY_LISTEN';",
          'throw err;',
        ].join('\n'),
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('starts the same HTTP server more than once');
    expect(result.failures[0]).toContain('create exactly one server');
    expect(result.failures[0]).toContain('multiple `listen()` calls');
  });

  it('hints when a node contract test times out waiting on server lifecycle', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 50 }],
      workspace({
        'contract-test.mjs': 'setInterval(() => {}, 1000);\n',
      }),
    );

    expect(result.pass).toBe(false);
    // A timeout is surfaced as a timeout (not an assertion failure), and
    // carries both hang-cause hints (Theme E / E3).
    expect(result.failures[0]).toContain('was killed after 50ms without exiting');
    expect(result.failures[0]).toContain('server.address().port');
    expect(result.failures[0]).not.toContain('did not pass when run with node');
  });

  it('hints when stateful REST tests assert seeded pagination totals after create', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "throw new Error('FAILED: List Books with Pagination\\nExpected values to be strictly equal:\\n\\n4 !== 3');\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('mutated the in-memory store');
  });

  it('hints when node test runners swallow assertion details', async () => {
    const result = await evaluateCraftbookGateChecks(
      [{ kind: 'nodeScriptPasses', script: 'contract-test.mjs', timeoutMs: 2000 }],
      workspace({
        'contract-test.mjs':
          "console.error('--- Test FAILED ---');\nconsole.error('!!! CONTRACT TEST SUITE ABORTED !!!');\nprocess.exit(1);\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('not printing the caught error');
  });

  it('rejects server modules that replace the native close method', async () => {
    const result = await evaluateCraftbookGateChecks(
      [
        {
          kind: 'notContains',
          file: 'server.mjs',
          pattern: 'server\\.close\\s*=',
          label: 'do not replace the native HTTP server close method',
        },
      ],
      workspace({
        'server.mjs':
          "import http from 'node:http';\nexport function createBookstoreServer() { const server = http.createServer(); server.close = () => {}; return server; }\n",
      }),
    );

    expect(result.pass).toBe(false);
    expect(result.failures[0]).toContain('native HTTP server close method');
  });

  it('allows node:http references in contract-test type comments while forbidding real imports', async () => {
    const pattern =
      '\\bfunction\\s+fetch\\s*\\(|\\b(?:const|let|var)\\s+fetch\\s*=|http\\.request|http\\.get|from\\s+[\'"]node:http[\'"]|import\\s+[^;]*[\'"]node:http[\'"]|require\\([\'"]node:http[\'"]\\)|from\\s+[\'"]node-fetch[\'"]|import\\s*\\([\'"]node-fetch[\'"]\\)|require\\([\'"]node-fetch[\'"]\\)';
    const typed = await evaluateCraftbookGateChecks(
      [{ kind: 'notContains', file: 'contract-test.mjs', pattern }],
      workspace({
        'contract-test.mjs':
          "/** @type {import('node:http').Server | null} */\nlet server = null;\n",
      }),
    );
    expect(typed.pass).toBe(true);

    const imported = await evaluateCraftbookGateChecks(
      [{ kind: 'notContains', file: 'contract-test.mjs', pattern }],
      workspace({
        'contract-test.mjs': "import http from 'node:http';\n",
      }),
    );
    expect(imported.pass).toBe(false);
  });

  it('allows global fetch helper names while rejecting replacement fetch functions', async () => {
    const pattern =
      '\\bfunction\\s+fetch\\s*\\(|\\b(?:const|let|var)\\s+fetch\\s*=|http\\.request|http\\.get|from\\s+[\'"]node:http[\'"]|import\\s+[^;]*[\'"]node:http[\'"]|require\\([\'"]node:http[\'"]\\)|from\\s+[\'"]node-fetch[\'"]|import\\s*\\([\'"]node-fetch[\'"]\\)|require\\([\'"]node-fetch[\'"]\\)';
    const helper = await evaluateCraftbookGateChecks(
      [{ kind: 'notContains', file: 'contract-test.mjs', pattern }],
      workspace({
        'contract-test.mjs':
          'async function fetchRequest(url, options = {}) {\n  return globalThis.fetch(url, options);\n}\n',
      }),
    );
    expect(helper.pass).toBe(true);

    const replacement = await evaluateCraftbookGateChecks(
      [{ kind: 'notContains', file: 'contract-test.mjs', pattern }],
      workspace({
        'contract-test.mjs': 'async function fetch(url) {\n  return globalThis.fetch(url);\n}\n',
      }),
    );
    expect(replacement.pass).toBe(false);
  });

  it('allows prose mentions of node-fetch while rejecting node-fetch imports', async () => {
    const pattern =
      'from\\s+[\'"]node-fetch[\'"]|import\\s*\\([\'"]node-fetch[\'"]\\)|require\\([\'"]node-fetch[\'"]\\)';
    const comment = await evaluateCraftbookGateChecks(
      [{ kind: 'notContains', file: 'contract-test.mjs', pattern }],
      workspace({
        'contract-test.mjs':
          'async function fetchRequest(url) {\n  // no node-fetch/require; use the runtime global.\n  return globalThis.fetch(url);\n}\n',
      }),
    );
    expect(comment.pass).toBe(true);

    const imported = await evaluateCraftbookGateChecks(
      [{ kind: 'notContains', file: 'contract-test.mjs', pattern }],
      workspace({
        'contract-test.mjs':
          "import fetch from 'node-fetch';\nconst fallback = await import('node-fetch');\nconst legacy = require('node-fetch');\n",
      }),
    );
    expect(imported.pass).toBe(false);
  });
});
