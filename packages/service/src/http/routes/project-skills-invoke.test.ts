import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * Invoking a repo's own SKILL.md has to land on somebody. A SKILL.md
 * carries a procedure and no crew, so the old path created a task owned
 * by the user and dispatched nothing — active, inert, no chat. The route
 * builds the triage → run → verify scaffold instead and hands step 1 to
 * the project's voorman, who picks the craftsman for step 2.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let projectId: string;
let voormanId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

const SKILL_SOURCE = '.claude/skills/summarize/SKILL.md';
const SKILL_MD = `---
name: summarize
description: Summarize a long document into a brief.
---

# Summarize

Read the document and produce a one-page brief.
`;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-skill-invoke-route-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;

  projectId = (await svc.context.store.createProject({ name: 'Skill invoke' })).id;
  const ws = await svc.context.store.projectWorkspaceDir(projectId);
  await mkdir(join(ws, '.claude', 'skills', 'summarize'), { recursive: true });
  await writeFile(join(ws, SKILL_SOURCE), SKILL_MD);
  await svc.context.workspaceIndex.refreshAndWait(projectId);

  // Pin the foreman so the assertion is about the scaffold, not about
  // whichever gezel the role resolver would have recruited.
  const voorman = await svc.context.store.createGezel({ name: 'Lieke', role: 'Voorman' });
  voormanId = voorman.id;
  await svc.context.store.updateProject(projectId, { voormanGezelId: voormanId });
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true });
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
});

function invoke(skillSource: string) {
  return httpFetch(`${baseUrl}/api/projects/${projectId}/skills/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ skillSource }),
  });
}

describe('POST /api/projects/:id/skills/invoke', () => {
  it('builds the triage → run → verify task and starts it on the voorman', async () => {
    const res = await invoke(SKILL_SOURCE);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { task: Task; started: boolean; assigneeName?: string };

    expect(body.task.craftbook.steps.map((s) => s.id)).toEqual(['triage', 'run', 'verify']);
    expect(body.task.activeStepId).toBe('triage');
    expect(body.task.assignee).toEqual({ kind: 'gezel', gezelId: voormanId });
    expect(body.started).toBe(true);
    expect(body.assigneeName).toBe('Lieke');

    const run = body.task.craftbook.steps.find((s) => s.id === 'run');
    // Left open on purpose — the voorman's read of the skill decides this.
    expect(run?.suggestedRole).toBeUndefined();
    expect(run?.suggestedGezelId).toBeUndefined();
    expect(run?.prompt).toContain('Read the document and produce a one-page brief.');
  });

  it('404s on a source that is not a discovered skill', async () => {
    const res = await invoke('.claude/skills/nope/SKILL.md');
    expect(res.status).toBe(404);
  });
});
