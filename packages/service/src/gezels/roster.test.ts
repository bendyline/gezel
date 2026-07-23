import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Task, nowIso } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { deriveGezelRoster, filterRoster, rankProjectsForGezel } from './roster.js';

let seq = 1;

function makeTask(args: {
  projectId: string;
  num: number;
  title: string;
  assigneeGezelId: string;
  phaseAssignee?: string;
}): Task {
  const now = nowIso();
  return {
    projectId: args.projectId,
    num: args.num,
    ref: `${args.projectId}/${args.num}`,
    title: args.title,
    status: 'active',
    assignee: { kind: 'gezel', gezelId: args.assigneeGezelId },
    craftbook: {
      id: 'cb-1',
      name: 'cb',
      steps: [
        {
          id: 'p1',
          name: 'start',
          createdAt: now,
          ...(args.phaseAssignee
            ? { assignee: { kind: 'gezel' as const, gezelId: args.phaseAssignee } }
            : {}),
        },
      ],
      entryStepId: 'p1',
      createdAt: now,
      updatedAt: now,
    },
    activeStepId: 'p1',
    createdAt: now,
    updatedAt: now,
    createdBy: { kind: 'user' },
  };
}

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-roster-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.ensureDefaultProject();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('deriveGezelRoster', () => {
  it('returns every gezel under "team" when no project is passed', async () => {
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    await store.createGezel({ name: 'Bea', role: 'Designer' });
    const roster = await deriveGezelRoster(store);
    expect(roster.map((r) => r.id).sort()).toEqual(['ada', 'bea']);
    expect(roster.every((r) => r.group === 'team')).toBe(true);
  });

  it('puts the voorman first, assignees next, everyone else last', async () => {
    await store.createGezel({ name: 'Leo', role: 'Voorman' });
    await store.createGezel({ name: 'Maya', role: 'Designer' });
    await store.createGezel({ name: 'Tess', role: 'Reviewer' });
    await store.createGezel({ name: 'Other', role: 'Developer' });

    const project = await store.createProject({
      name: 'Shop',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    await store.updateProject(project.id, { voormanGezelId: 'leo' });
    await store.writeTask(
      makeTask({
        projectId: project.id,
        num: seq++,
        title: 'Design',
        assigneeGezelId: 'maya',
        phaseAssignee: 'tess',
      }),
    );

    const roster = await deriveGezelRoster(store, project.id);
    expect(roster.map((r) => r.id)).toEqual(['leo', 'maya', 'tess', 'other']);
    expect(roster[0]?.group).toBe('voorman');
    expect(roster[1]?.group).toBe('assignees');
    expect(roster[2]?.group).toBe('assignees');
    expect(roster[3]?.group).toBe('team');
  });

  it('does not double-count the voorman when they are also an assignee', async () => {
    await store.createGezel({ name: 'Leo', role: 'Voorman' });
    const project = await store.createProject({
      name: 'Shop',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    await store.updateProject(project.id, { voormanGezelId: 'leo' });
    await store.writeTask(
      makeTask({
        projectId: project.id,
        num: seq++,
        title: 'Do it',
        assigneeGezelId: 'leo',
      }),
    );

    const roster = await deriveGezelRoster(store, project.id);
    const leoEntries = roster.filter((r) => r.id === 'leo');
    expect(leoEntries).toHaveLength(1);
    expect(leoEntries[0]?.group).toBe('voorman');
  });

  it('degrades to team-only when projectId is unknown', async () => {
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    const roster = await deriveGezelRoster(store, 'does-not-exist');
    expect(roster.every((r) => r.group === 'team')).toBe(true);
  });

  it('expands Meester-chat candidates into one per (gezel, project) pair', async () => {
    // Mira is on two real projects (Shop as voorman, Ops via task
    // assignment). The Meester picker should let the user route to
    // either explicitly — "@Mira re: Shop" vs "@Mira re: Ops" — by
    // emitting two candidates with `?project=…`-tagged ids.
    await store.createGezel({ name: 'Mira', role: 'Designer' });
    const shop = await store.createProject({
      name: 'Shop',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    const ops = await store.createProject({
      name: 'Ops',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    await store.updateProject(shop.id, { voormanGezelId: 'mira' });
    await store.writeTask(
      makeTask({
        projectId: ops.id,
        num: seq++,
        title: 'Triage',
        assigneeGezelId: 'mira',
      }),
    );

    const roster = await deriveGezelRoster(store);
    const miras = roster.filter((c) => c.label.startsWith('Mira'));
    expect(miras).toHaveLength(2);
    const ids = miras.map((c) => c.id).sort();
    expect(ids).toEqual([
      `mira?project=${encodeURIComponent(ops.id)}`,
      `mira?project=${encodeURIComponent(shop.id)}`,
    ]);
    // Label carries the project so the inserted chip + the chat bubble
    // both read "@Mira re: Shop" instead of a bare "@Mira" that would
    // lose the disambiguation the moment the user hits Send.
    const labels = miras.map((c) => c.label).sort();
    expect(labels).toEqual(['Mira re: Ops', 'Mira re: Shop']);
    // Role moves to description so the popover row pairs the project-
    // scoped label with a muted "Designer" line below.
    expect(miras.every((c) => c.description === 'Designer')).toBe(true);
  });

  it('falls back to a bare Meester candidate when a gezel has no project presence', async () => {
    // Fresh gezel, no projects yet. The picker should still surface
    // them as a plain `@Mira` so the Meester can pull them in — the
    // fan-out path will auto-pick a project at send time (today's
    // behavior, preserved for back-compat).
    await store.createGezel({ name: 'Mira', role: 'Designer' });
    const roster = await deriveGezelRoster(store);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.id).toBe('mira');
    expect(roster[0]?.label).toBe('Mira');
  });
});

describe('filterRoster', () => {
  const roster = [
    { id: 'ada', label: 'Ada', description: 'Developer', group: 'voorman' as const },
    { id: 'bea', label: 'Bea', description: 'Designer', group: 'team' as const },
    { id: 'cid', label: 'Cid', description: 'Reviewer', group: 'team' as const },
  ];

  it('returns everything when query is empty', () => {
    expect(filterRoster(roster, '')).toHaveLength(3);
    expect(filterRoster(roster, '   ')).toHaveLength(3);
  });

  it('matches on label (case-insensitive)', () => {
    expect(filterRoster(roster, 'be').map((r) => r.id)).toEqual(['bea']);
    expect(filterRoster(roster, 'BE').map((r) => r.id)).toEqual(['bea']);
  });

  it('matches on description', () => {
    expect(filterRoster(roster, 'design').map((r) => r.id)).toEqual(['bea']);
  });

  it('returns empty when nothing matches', () => {
    expect(filterRoster(roster, 'zzz')).toEqual([]);
  });
});

describe('rankProjectsForGezel', () => {
  it('always includes `default` last, as a fallback', async () => {
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    const ranked = await rankProjectsForGezel(store, 'ada');
    expect(ranked.map((p) => p.projectId)).toEqual(['default']);
    expect(ranked[0]?.precedence).toBe('fallback');
  });

  it('ranks voorman > assignment > session > fallback', async () => {
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    const voormanP = await store.createProject({
      name: 'Runs It',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    await store.updateProject(voormanP.id, { voormanGezelId: 'ada' });

    const assignedP = await store.createProject({
      name: 'Has Task',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    await store.writeTask(
      makeTask({
        projectId: assignedP.id,
        num: seq++,
        title: 'thing',
        assigneeGezelId: 'ada',
      }),
    );

    const sessionP = await store.createProject({
      name: 'Just Chatted',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    // Create a session in sessionP so ada has non-archived presence there.
    const now = nowIso();
    const { randomUUID } = await import('node:crypto');
    await store.writeSession({
      version: 1,
      id: randomUUID(),
      gezelId: 'ada',
      projectId: sessionP.id,
      providerName: 'copilot',
      title: 'hi',
      createdAt: now,
      lastActivityAt: now,
      messages: [],
      providerState: {},
    });

    const ranked = await rankProjectsForGezel(store, 'ada');
    expect(ranked.map((p) => p.precedence)).toEqual([
      'voorman',
      'assignment',
      'session',
      'fallback',
    ]);
    expect(ranked.map((p) => p.projectId)).toEqual([
      voormanP.id,
      assignedP.id,
      sessionP.id,
      'default',
    ]);
  });

  it('within a band, orders by most recent session activity', async () => {
    await store.createGezel({ name: 'Ada', role: 'Developer' });
    const a = await store.createProject({
      name: 'A',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    const b = await store.createProject({
      name: 'B',
      about: 'x'.repeat(80),
      missionObjectives: 'y'.repeat(60),
    });
    await store.updateProject(a.id, { voormanGezelId: 'ada' });
    await store.updateProject(b.id, { voormanGezelId: 'ada' });

    const { randomUUID } = await import('node:crypto');
    await store.writeSession({
      version: 1,
      id: randomUUID(),
      gezelId: 'ada',
      projectId: a.id,
      providerName: 'copilot',
      title: 'a',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
      messages: [],
      providerState: {},
    });
    await store.writeSession({
      version: 1,
      id: randomUUID(),
      gezelId: 'ada',
      projectId: b.id,
      providerName: 'copilot',
      title: 'b',
      createdAt: nowIso(),
      lastActivityAt: nowIso(),
      messages: [],
      providerState: {},
    });

    const ranked = await rankProjectsForGezel(store, 'ada');
    const voormen = ranked.filter((p) => p.precedence === 'voorman');
    expect(voormen.map((p) => p.projectId)).toEqual([b.id, a.id]); // b more recent
  });
});
