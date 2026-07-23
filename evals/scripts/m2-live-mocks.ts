/**
 * M2 rollout — upgrade the genuinely service-facing `external` craftbooks
 * from documentation-only dry-run fixtures to LIVE mock services, following
 * the pattern the `ship` pilot proved (fake endpoints served per trial,
 * credentialed `http.authed` access, a provenance-trusted probe shim, and
 * request-log `success.mocks` assertions). Also fixes tag hygiene: books
 * the old regex classifier mis-tagged `external` but that are really prose
 * artifacts get retagged instead of mocked.
 *
 * One-shot; retired after landing (catalog CI guards the results).
 *
 * Run: pnpm --filter @bendyline/gezel-evals exec tsx scripts/m2-live-mocks.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// This script MUTATES craftbook test specs, so it targets the sibling
// gilde working tree (where edits become PRs), not the installed package.
const gildeRoot = process.env.GILDE_DIR?.trim() || join(here, '..', '..', '..', 'gilde');
const templatesRoot = join(gildeRoot, 'data', 'craftbook-templates');

/** Books whose task genuinely drives an external service → live mocks. */
const LIVE_MOCK_BOOKS = new Set([
  'booking-automation',
  'ci-pipeline',
  'data-pipeline-etl',
  'deploy-checklist',
  'digest-from-feeds',
  'feature-flag-release',
  'feature-flag-rollout',
  'form-fill-batch',
  'live-browser-qa',
  'monitor-and-alert',
  'notification-router',
  'perf-audit',
  'pull-request-review',
  'release-pipeline-ci',
  'rollback-plan',
  'scrape-to-structured',
  'script-automation',
  'webhook-handler',
]);

/**
 * Mis-tagged prose books: the artifact is a document about internal
 * material; no service is involved. Retag to the honest class (they keep
 * their current fixtures/deliverables — the tag drives harness planning).
 */
const RETAG: Record<string, string[]> = {
  'ab-test-readout': ['corpus'],
  'blog-post': ['corpus'],
  'case-study': ['corpus'],
  'changelog-writeup': ['corpus'],
  'design-system-consultation': ['corpus'],
  'doc-rewrite': ['corpus'],
  'engineering-retrospective': ['corpus'],
  'executive-level-review': ['corpus'],
  'idea-office-hours': ['corpus'],
  'incident-postmortem': ['corpus'],
  'office-hours': ['corpus'],
  'release-notes': ['corpus'],
  'spec-authoring': ['corpus'],
  'technical-documentation': ['corpus'],
  'security-architecture-review': ['corpus'],
  'seasonal-maintenance-sweep': ['corpus'],
  'careful-mode': ['corpus'],
};

function probeShim(bookId: string): string {
  return `import { defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: '${bookId}-mock-probe',
  description:
    'Probe the live fake ops service for this eval: lists the open work items and records a dry-run submission. Outputs the raw JSON responses as evidence for the write-up.',
  inputs: {},
  outputs: {
    open: { type: 'string', description: 'Raw JSON body from the open-items listing.' },
    dryRun: { type: 'string', description: 'Raw JSON body from the dry-run submission.' },
  },
  requires: ['workspace.read', 'network', 'credential:mock.ops'],
});

const services = JSON.parse(await gezel.fs.read('mocks/services.json'));
const base = (id) => {
  const service = services.find((entry) => entry.id === id);
  if (!service) throw new Error(\`mock service "\${id}" is not listed in mocks/services.json\`);
  return service.baseUrl;
};

const open = await gezel.http.authed(\`\${base('ops')}/api/bookings/open\`, {
  credential: 'mock.ops',
});
if (!open.ok) throw new Error(\`open-items listing failed: \${open.status} \${open.body}\`);

const dryRun = await gezel.http.authed(\`\${base('ops')}/api/bookings/dry-run\`, {
  credential: 'mock.ops',
  method: 'POST',
  body: JSON.stringify({ items: JSON.parse(open.body).items, mode: 'dry-run' }),
});
if (!dryRun.ok) throw new Error(\`dry-run submission failed: \${dryRun.status} \${dryRun.body}\`);

gezel.output({ open: open.body, dryRun: dryRun.body });
`;
}

function liveMocks(bookId: string): unknown[] {
  return [
    {
      kind: 'http',
      id: 'ops',
      description:
        'Fake operations service for this eval. GET /api/bookings/open lists the open work items; POST /api/bookings/dry-run records a simulated submission and returns DRY_RUN_OK.',
      credential: { name: 'mock.ops' },
      routes: [
        {
          method: 'GET',
          path: '/api/bookings/open',
          body: { items: ['BKG-1001', 'BKG-1002', 'BKG-1003'] },
        },
        {
          method: 'POST',
          path: '/api/bookings/dry-run',
          status: 201,
          body: { status: 'DRY_RUN_OK', recorded: 3 },
        },
      ],
    },
    {
      kind: 'webhook',
      id: 'notify',
      description:
        'Notification receiver. POST a JSON completion notice here when the run finishes.',
      path: '/hooks/notify',
    },
    {
      kind: 'cli',
      id: 'probe',
      description: `Provenance-trusted project script \`${bookId}-mock-probe\` that exercises the fake ops service through http.authed and returns the raw responses.`,
      shim: { path: `scripts/${bookId}-mock-probe.ts`, content: probeShim(bookId) },
    },
  ];
}

const LIVE_PROMPT =
  'Theres a fake ops service wired up for this so nothing real gets touched — the endpoints are in mocks/services.md, and the probe script talks to them for you (our notes are in fixtures/fake-service.md if you want background). Can you run the automation against it and write up how it went in automation.md?';

let upgraded = 0;
let retagged = 0;
for (const file of globSync(join(templatesRoot, '*', '*', 'versions', '*', 'test.json'))) {
  const spec = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const bookId = file.replace(/\\/g, '/').split('/').slice(-4)[0]!;
  const tags = (spec.tags as string[] | undefined) ?? [];

  if (RETAG[bookId] && tags.includes('external')) {
    spec.tags = RETAG[bookId];
    writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    retagged++;
    continue;
  }
  if (!LIVE_MOCK_BOOKS.has(bookId) || !tags.includes('external')) continue;
  if (Array.isArray(spec.mocks) && (spec.mocks as unknown[]).length > 0) continue;

  spec.mocks = liveMocks(bookId);
  spec.prompt = LIVE_PROMPT;
  const success = spec.success as Record<string, unknown>;
  success.mocks = [
    {
      service: 'ops',
      minRequests: 2,
      requiredPaths: ['^/api/bookings/open$', '^/api/bookings/dry-run$'],
    },
  ];
  success.summary =
    'automation.md is grounded in live fake-service responses: the open items were actually listed and a dry-run actually recorded (request-log assertions), with safety guards and signals described.';
  writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  upgraded++;
}
console.log(`M2: ${upgraded} books upgraded to live mocks, ${retagged} mis-tagged books retagged`);
