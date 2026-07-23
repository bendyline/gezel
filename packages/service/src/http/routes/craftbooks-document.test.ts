import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serializeCraftbookDoc } from '@bendyline/gezel';
import type { CraftbookDoc } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * End-to-end coverage for the whole-document craftbook surface: one
 * document (either encoding) carries steps + gates + inline scripts;
 * writes validate-or-422 with repair-grade errors; a task created from
 * the book executes its inline gate script from the snapshot.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-cbdoc-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function api(method: string, path: string, body?: unknown) {
  return httpFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const GATE_SCRIPT = `import { gezel, defineScript } from '@bendyline/gezel-sdk';
export const meta = defineScript({
  name: 'checkMarker',
  description: 'approves when the marker deliverable exists in the workspace.',
  kind: 'gate',
  outputs: {
    decision: { type: 'string', description: 'the decision' },
    message: { type: 'string', description: 'guidance' },
  },
  requires: ['workspace.read'],
});
let present = false;
try {
  await gezel.fs.read('marker.txt');
  present = true;
} catch {
  present = false;
}
gezel.output(
  present
    ? { decision: 'approve', message: 'marker found' }
    : { decision: 'reject', message: 'write marker.txt before completing this step' },
);`;

const DOC: CraftbookDoc = {
  id: 'doc-e2e',
  name: 'Doc E2E',
  description: 'End-to-end whole-document craftbook.',
  entryStepId: 'build',
  steps: [
    {
      id: 'build',
      name: 'Build',
      prompt: 'Produce the marker.',
      gate: {
        at: 'completion',
        scripts: [{ name: 'checkMarker', scope: 'craftbook' }],
        onReject: 'build',
      },
      next: 'done',
    },
    { id: 'done', name: 'Done', terminal: true },
  ],
  scripts: { checkMarker: GATE_SCRIPT },
};

describe('craftbook document routes — end to end', () => {
  it('creates a book from a MARKDOWN document, reads it back as JSON, and round-trips', async () => {
    const content = serializeCraftbookDoc(DOC, 'markdown');
    const res = await api('POST', '/api/craftbooks/document', { content, format: 'markdown' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { craftbook: { id: string }; gatedSteps: number };
    expect(body.craftbook.id).toBe('doc-e2e');
    expect(body.gatedSteps).toBe(1);

    const get = await api('GET', '/api/craftbooks/doc-e2e/document?format=json&source=local');
    expect(get.status).toBe(200);
    const doc = JSON.parse(((await get.json()) as { content: string }).content) as CraftbookDoc;
    expect(doc.scripts?.checkMarker).toContain('checkMarker');
    expect(doc.steps).toHaveLength(2);
  });

  it('rejects a broken document with 422 + repair-grade errors, writing nothing', async () => {
    const res = await api('POST', '/api/craftbooks/document', {
      content: JSON.stringify({
        name: 'Broken',
        steps: [
          { name: 'Build', next: 'reviw' },
          { id: 'review', name: 'Review', terminal: true },
        ],
      }),
      format: 'json',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { formatted: string };
    expect(body.formatted).toContain('did you mean "review"');
    const gone = await api('GET', '/api/craftbooks/broken/document?source=local');
    expect(gone.status).toBe(404);
  });

  it('executes the inline gate where enforceable and otherwise fails closed', async () => {
    const create = await api('POST', '/api/projects/default/tasks', {
      title: 'Doc E2E run',
      description: 'runs the doc-authored craftbook end to end through its inline gate.',
      assignee: { kind: 'user' },
      craftbookId: 'doc-e2e',
    });
    expect(create.status).toBe(201);
    const task = (await create.json()) as {
      num: number;
      craftbook: { scripts?: Record<string, string> };
    };
    expect(task.craftbook.scripts?.checkMarker).toBeDefined();

    const held = await api('POST', `/api/projects/default/tasks/${task.num}/steps/build/complete`);
    const heldBody = (await held.json()) as {
      gate?: { decision: string; message?: string };
      task: { activeStepId?: string };
    };
    expect(heldBody.gate?.decision).toBe('reject');
    if (process.platform !== 'darwin') {
      // denyNet craftbook gates require an OS network sandbox. Windows and
      // Linux fail closed instead of treating the JS preload as a malicious-
      // code boundary; the runner surfaces its actionable refusal text rather
      // than the underlying exit code 126. macOS executes under Seatbelt.
      expect(heldBody.gate?.message).toContain(
        'denyNet requires an enforceable OS network boundary',
      );
      expect(heldBody.task.activeStepId).toBe('build');
      return;
    }
    expect(heldBody.gate?.message).toContain('marker.txt');

    const marker = join(home, 'projects', 'default', 'workspace', 'marker.txt');
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, 'present', 'utf8');

    const done = await api('POST', `/api/projects/default/tasks/${task.num}/steps/build/complete`);
    const doneBody = (await done.json()) as { gate?: unknown; task: { activeStepId?: string } };
    expect(doneBody.gate).toBeUndefined();
    expect(doneBody.task.activeStepId).toBe('done');
  }, 120_000);

  it('replaces a task craftbook via the document route, preserving step progress by id', async () => {
    const create = await api('POST', '/api/projects/default/tasks', {
      title: 'Doc replace run',
      description: 'whole-document replace of a running task keeps surviving step lifecycle.',
      assignee: { kind: 'user' },
      steps: [
        { name: 'Draft', id: 'draft' },
        { name: 'Done', id: 'done', terminal: true },
      ],
    });
    const task = (await create.json()) as { num: number };

    const replacement: CraftbookDoc = {
      name: 'Edited mid-task',
      entryStepId: 'draft',
      steps: [
        { id: 'draft', name: 'Draft', prompt: 'Rewritten prompt.', next: 'verify' },
        { id: 'verify', name: 'Verify', deliverable: { path: 'out/report.md' }, next: 'done' },
        { id: 'done', name: 'Done', terminal: true },
      ],
    };
    const put = await api('PUT', `/api/projects/default/tasks/${task.num}/craftbook/document`, {
      content: serializeCraftbookDoc(replacement, 'json'),
      format: 'json',
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as {
      stepCount: number;
      gatedSteps: number;
      task: { craftbook: { steps: { id: string; prompt?: string; gate?: unknown }[] } };
    };
    expect(body.stepCount).toBe(3);
    expect(body.gatedSteps).toBe(1);
    const draft = body.task.craftbook.steps.find((s) => s.id === 'draft');
    expect(draft?.prompt).toBe('Rewritten prompt.');
    const verify = body.task.craftbook.steps.find((s) => s.id === 'verify');
    expect(verify?.gate).toBeDefined();
  });

  it('rejects a task-document replace whose inline script has a TS error', async () => {
    const create = await api('POST', '/api/projects/default/tasks', {
      title: 'Bad script replace',
      description: 'inline script diagnostics reject the write with line info.',
      assignee: { kind: 'user' },
      steps: [{ name: 'Only', id: 'only', terminal: true }],
    });
    const task = (await create.json()) as { num: number };
    const res = await api('PUT', `/api/projects/default/tasks/${task.num}/craftbook/document`, {
      content: JSON.stringify({
        name: 'Bad',
        steps: [
          {
            id: 'only',
            name: 'Only',
            gate: { at: 'completion', scripts: [{ name: 'bad', scope: 'craftbook' }] },
            terminal: true,
          },
        ],
        scripts: {
          bad: 'export const meta = { name: "bad", description: "broken here" };\nfunction oops( {',
        },
      }),
      format: 'json',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { formatted: string };
    expect(body.formatted).toContain('scripts');
  });
});
