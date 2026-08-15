import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Craftbook } from '@bendyline/gezel';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * A launch that fails its own preconditions must answer with the sentence
 * naming the fix. The catch-all error handler scrubs any untyped throw to
 * `{ error: 'internal_error' }`, so a connector-reading craftbook under a
 * blocking posture used to reach the launcher as a bare 500 — the user saw
 * nothing but a failed dialog, and the one actionable sentence only ever
 * appeared in the daemon log.
 *
 * The posture that blocks is `super-lockdown` alone. A launch is
 * user-initiated, so it rides `allowConnectorData`; `lockdown` clears it
 * and fails further along, on the binding.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let projectId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

const CONNECTOR_BOOK: Craftbook = {
  id: 'corpus-review',
  name: 'Corpus Review',
  version: '1.0.0',
  steps: [
    {
      id: 'review',
      name: 'Review the corpus',
      prompt: 'Read every record under `{{corpusScope}}/`.',
    },
  ],
  entryStepId: 'review',
  connectors: [{ typeId: 'github-pulls', reason: 'mirror the pull request corpus' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-task-launch-errors-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  projectId = (await svc.context.store.createProject({ name: 'Launch errors' })).id;
  await svc.context.store.writeProjectCraftbook(projectId, CONNECTOR_BOOK);
}, 30_000);

async function setLevel(level: 'super-lockdown' | 'lockdown'): Promise<void> {
  await svc.context.store.writeConfig({ securityPolicy: securityPolicyForLevel(level) });
}

function launch() {
  return httpFetch(`${baseUrl}/api/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Review the corpus',
      description: 'Review every record the pull-request corpus mirrored for this project.',
      craftbookId: 'corpus-review',
      assignee: { kind: 'user' },
    }),
  });
}

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

interface LaunchRefusal {
  error?: string;
  code?: string;
  craftbookId?: string;
  connectorTypeId?: string;
  reason?: string;
}

describe('craftbook launch preconditions over HTTP', () => {
  it('answers a super-lockdown connector launch with the fix, not a scrubbed 500', async () => {
    await setLevel('super-lockdown');
    const res = await launch();
    const body = (await res.json()) as LaunchRefusal;

    expect(res.status).toBe(409);
    expect(body.code).toBe('CONNECTOR_PREP_FAILED');
    expect(body.reason).toBe('policy');
    expect(body.craftbookId).toBe('corpus-review');
    expect(body.connectorTypeId).toBe('github-pulls');
    expect(body.error).toMatch(/Settings → Security/);
    // A refused launch leaves nothing half-built behind.
    expect(await svc.context.tasks.list({ projectId })).toEqual([]);
  });

  it('clears the posture gate under lockdown and refuses on the binding instead', async () => {
    // The point of the posture split: lockdown lets a user-initiated launch
    // move corpus data, so the refusal that remains is about setup, not
    // about the security level.
    await setLevel('lockdown');
    const res = await launch();
    const body = (await res.json()) as LaunchRefusal;

    expect(res.status).toBe(409);
    expect(body.reason).toBe('unbound');
    expect(body.error).not.toMatch(/Settings → Security/);
    expect(await svc.context.tasks.list({ projectId })).toEqual([]);
  });
});
