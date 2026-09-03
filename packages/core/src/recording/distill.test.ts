import { describe, expect, it } from 'vitest';
import type { HistoryEvent } from '../schemas/history.js';
import { parseRunRecording } from '../schemas/run-recording.js';
import type { ChatSession } from '../schemas/session.js';
import { distillRunRecording } from './distill.js';

const T = (seconds: number) => new Date(Date.UTC(2026, 8, 1, 10, 0, seconds)).toISOString();

function session(partial: Partial<ChatSession> & Pick<ChatSession, 'id' | 'gezelId'>): ChatSession {
  return {
    projectId: 'default',
    messages: [],
    createdAt: T(0),
    lastActivityAt: T(0),
    ...partial,
  } as ChatSession;
}

function fixtureSessions(): ChatSession[] {
  const ada = session({
    id: 'sess-ada',
    gezelId: 'ada',
    messages: [
      { role: 'user', content: 'Review the payment code.', at: T(0) },
      {
        role: 'assistant',
        content: 'I looked things over and delegated the deep review.',
        at: T(30),
        reasoning: 'The payment module is the risky area; Rex should review it.',
        reasoningDurationMs: 4000,
        toolCalls: [
          { name: 'read_file', at: T(5), durationMs: 100, success: true, path: 'src/payment.js' },
          { name: 'read_file', at: T(6), durationMs: 90, success: true, path: 'src/export.js' },
          { name: 'read_file', at: T(7), durationMs: 80, success: true, path: 'src/util.js' },
          {
            name: 'message_gezel',
            at: T(20),
            durationMs: 500,
            success: true,
            argsSummary: '→ Rex: review src/',
          },
        ],
      },
    ],
  });
  const rex = session({
    id: 'sess-rex',
    gezelId: 'rex',
    messages: [
      {
        role: 'user',
        content: '[Message from Ada]: Please review src/ carefully.',
        at: T(21),
        from: { gezelId: 'ada', gezelName: 'Ada', sessionId: 'sess-ada', kind: 'delegation' },
      },
      { role: 'assistant', content: 'Report written to reviews/report.md.', at: T(90) },
    ],
  });
  return [ada, rex];
}

function fixtureHistory(): HistoryEvent[] {
  return [
    {
      id: 'h1',
      at: T(22),
      kind: 'task.step.activated',
      gezelId: 'rex',
      summary: 'Step "Deep review" activated',
      details: { ref: 'default/1', stepId: 'review', stepName: 'Deep review' },
    },
    {
      id: 'h2',
      at: T(80),
      kind: 'workspace.write',
      gezelId: 'rex',
      summary: 'Wrote reviews/report.md',
      details: { path: 'reviews/report.md', bytes: 2048 },
    },
    {
      id: 'h3',
      at: T(85),
      kind: 'task.step.gated',
      gezelId: 'rex',
      summary: 'Gate rejected attempt 1',
      details: { ref: 'default/1', stepId: 'review', attempt: 1 },
    },
    {
      id: 'h4',
      at: T(95),
      kind: 'task.step.completed',
      gezelId: 'rex',
      summary: 'Step "Deep review" completed',
      details: { ref: 'default/1', stepId: 'review', stepName: 'Deep review' },
    },
  ] as HistoryEvent[];
}

describe('distillRunRecording', () => {
  it('builds a chronological, schema-valid scene timeline from a run', () => {
    const recording = distillRunRecording({
      sessions: fixtureSessions(),
      historyEvents: fixtureHistory(),
      taskNotes: [
        {
          ref: 'default/1',
          projectId: 'default',
          num: 1,
          notes: [{ at: T(88), author: 'rex', stepId: 'review', text: 'Found 4 issues.' }],
        },
      ],
      actors: [
        { id: 'ada', name: 'Ada', role: 'Meester', kind: 'gezel', meester: true },
        { id: 'rex', name: 'Rex', role: 'Reviewer', kind: 'gezel' },
      ],
      screenshots: [{ sourcePath: 'reviews/report.md', png: 'report.png' }],
      trial: { trialId: 't1', scenarioId: 'code-review', modelId: 'mock', startedAt: T(0) },
    });

    const parsed = parseRunRecording(recording);
    expect(parsed.ok).toBe(true);

    // Chronological with intra-message ordering preserved.
    const ats = recording.scenes.map((scene) => Date.parse(scene.at));
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);

    const kinds = recording.scenes.map((scene) => scene.kind);
    expect(kinds[0]).toBe('user-prompt');

    // The 3 consecutive read_file calls coalesce into one scene with count 3,
    // carrying its own (pre-message-commit) timestamp.
    const reads = recording.scenes.filter(
      (scene) => scene.kind === 'tool-call' && scene.name === 'read_file',
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ count: 3, at: T(5), durationMs: 270 });

    // Delegation edge from the from-tagged message.
    const delegation = recording.scenes.find((scene) => scene.kind === 'delegation');
    expect(delegation).toMatchObject({
      actorId: 'ada',
      toActorId: 'rex',
      sessionId: 'sess-ada',
      toSessionId: 'sess-rex',
      delegationKind: 'delegation',
      excerpt: 'Please review src/ carefully.',
    });

    // History-derived scenes: step lifecycle, gate fail, artifact w/ screenshot.
    expect(kinds).toContain('step-transition');
    const gate = recording.scenes.find((scene) => scene.kind === 'gate-verdict');
    expect(gate).toMatchObject({ verdict: 'fail', attempt: 1, stepId: 'review' });
    const artifact = recording.scenes.find((scene) => scene.kind === 'artifact-produced');
    expect(artifact).toMatchObject({
      path: 'reviews/report.md',
      bytes: 2048,
      screenshotRef: 'screenshots/report.png',
    });
    expect(recording.screenshots?.[0]?.file).toBe('screenshots/report.png');

    // Actors: roster + synthetic user.
    expect(recording.actors.map((actor) => actor.id).sort()).toEqual(['ada', 'rex', 'user']);
    expect(recording.budget).toEqual({ droppedScenes: 0, truncatedExcerpts: 0 });
  });

  it('holds the byte budget on an adversarial run without dropping load-bearing scenes', () => {
    const big = 'x'.repeat(2000);
    const messages: ChatSession['messages'] = [];
    for (let i = 0; i < 400; i++) {
      messages.push({ role: 'assistant', content: `${big} reply ${i}`, at: T(i), reasoning: big });
    }
    const recording = distillRunRecording(
      {
        sessions: [
          session({ id: 's', gezelId: 'ada', messages }),
          session({
            id: 's2',
            gezelId: 'rex',
            messages: [
              {
                role: 'user',
                content: '[Message from Ada]: go',
                at: T(1),
                from: { gezelId: 'ada', gezelName: 'Ada' },
              },
            ],
          }),
        ],
        historyEvents: fixtureHistory(),
      },
      { maxScenes: 100, maxBytes: 64 * 1024 },
    );

    expect(new TextEncoder().encode(JSON.stringify(recording)).length).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(recording.scenes.length).toBeLessThanOrEqual(100);
    expect(recording.budget.droppedScenes).toBeGreaterThan(0);
    // Importance tiers held: every load-bearing scene survived the squeeze.
    const kinds = new Set(recording.scenes.map((scene) => scene.kind));
    expect(kinds.has('delegation')).toBe(true);
    expect(kinds.has('step-transition')).toBe(true);
    expect(kinds.has('gate-verdict')).toBe(true);
    expect(kinds.has('artifact-produced')).toBe(true);
    expect(parseRunRecording(recording).ok).toBe(true);
  });

  it('synthesizes the ask from a dispatched task, skips ambient tasks and harness seeding', () => {
    const recording = distillRunRecording({
      sessions: [session({ id: 's', gezelId: 'rex', messages: [] })],
      historyEvents: [
        {
          id: 'h1',
          at: T(1),
          kind: 'task.created',
          gezelId: 'rex',
          summary: 'Created task default/1',
          details: {
            ref: 'default/1',
            title: 'Snapshot-driven code review',
            steps: [{ id: 'scope', name: 'Scope the change set' }],
          },
        },
        {
          id: 'h2',
          at: T(2),
          kind: 'task.entry.dispatched',
          gezelId: 'rex',
          summary: 'Entry step "scope" handed to Rex',
          details: { ref: 'default/1', stepId: 'scope' },
        },
        // Ambient crew task: created, never dispatched → no scene.
        {
          id: 'h3',
          at: T(3),
          kind: 'task.created',
          summary: 'Created task shared/1 — "Boekwachter: indexing"',
          details: { ref: 'shared/1', title: 'Boekwachter: indexing' },
        },
        // Harness seeding: workspace.write with no gezelId → no scene.
        {
          id: 'h4',
          at: T(4),
          kind: 'workspace.write',
          summary: 'Wrote src/seeded.js',
          details: { path: 'src/seeded.js', bytes: 100 },
        },
        // Gate approval carries decision=approve → pass; absent → fail.
        {
          id: 'h5',
          at: T(5),
          kind: 'task.step.gated',
          gezelId: 'rex',
          summary: 'Gate approved',
          details: { ref: 'default/1', stepId: 'scope', decision: 'approve', attempt: 2 },
        },
      ] as HistoryEvent[],
    });
    const prompts = recording.scenes.filter((scene) => scene.kind === 'user-prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      taskRef: 'default/1',
      excerpt: 'Snapshot-driven code review',
    });
    const entry = recording.scenes.find((scene) => scene.kind === 'step-transition');
    expect(entry).toMatchObject({
      stepId: 'scope',
      stepName: 'Scope the change set',
      phase: 'activated',
    });
    expect(recording.scenes.some((scene) => scene.kind === 'artifact-produced')).toBe(false);
    const gate = recording.scenes.find((scene) => scene.kind === 'gate-verdict');
    expect(gate).toMatchObject({ verdict: 'pass', attempt: 2 });
  });

  it('recovers tool calls a killed turn never committed, without double-counting', () => {
    const aborted = session({
      id: 's-lost',
      gezelId: 'rex',
      messages: [
        { role: 'user', content: 'go', at: T(0) },
        { role: 'assistant', content: 'first turn done', at: T(10) },
        { role: 'user', content: 'continue', at: T(11) },
        { role: 'assistant', content: '', at: T(60), synthetic: 'turn-aborted' },
      ],
    });
    const recording = distillRunRecording({
      sessions: [aborted],
      chatEventLog: [
        // Before the last commit — belongs to the committed turn, ignored.
        { rx: T(5), sessionId: 's-lost', event: { type: 'tool', at: T(5), name: 'read_file' } },
        // After the last commit — the lost turn's work, recovered + coalesced.
        {
          rx: T(20),
          sessionId: 's-lost',
          event: { type: 'tool', at: T(20), name: 'read_file', durationMs: 100, success: true },
        },
        {
          rx: T(21),
          sessionId: 's-lost',
          event: { type: 'tool', at: T(21), name: 'read_file', durationMs: 90, success: true },
        },
        {
          rx: T(30),
          sessionId: 's-lost',
          event: {
            type: 'tool',
            at: T(30),
            name: 'write_task_note',
            durationMs: 50,
            success: true,
            path: 'notes.md',
          },
        },
        // Different session — ignored.
        { rx: T(25), sessionId: 'other', event: { type: 'tool', at: T(25), name: 'read_file' } },
      ],
    });
    const tools = recording.scenes.filter((scene) => scene.kind === 'tool-call');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'read_file', count: 2, at: T(20) });
    expect(tools[1]).toMatchObject({ name: 'write_task_note', path: 'notes.md' });
  });

  it('coalesces artifact write bursts into one beat with a revision count', () => {
    const writes: HistoryEvent[] = [1, 2, 3, 4].map((i) => ({
      id: `w${i}`,
      at: T(10 + i),
      kind: 'workspace.write',
      gezelId: 'jules',
      summary: 'Wrote index.html',
      details: { path: 'index.html', ...(i === 4 ? { bytes: 17146 } : {}) },
    })) as HistoryEvent[];
    const recording = distillRunRecording({
      sessions: [session({ id: 's', gezelId: 'jules', messages: [] })],
      historyEvents: [
        ...writes,
        {
          id: 'w5',
          at: T(20),
          kind: 'workspace.write',
          gezelId: 'jules',
          summary: 'Wrote styles.css',
          details: { path: 'styles.css', bytes: 300 },
        } as HistoryEvent,
      ],
      screenshots: [{ sourcePath: 'index.html', png: '00-index.png' }],
    });
    const artifacts = recording.scenes.filter((scene) => scene.kind === 'artifact-produced');
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({
      path: 'index.html',
      at: T(11),
      count: 4,
      bytes: 17146,
      screenshotRef: 'screenshots/00-index.png',
    });
    expect(artifacts[1]).toMatchObject({ path: 'styles.css' });
    expect(artifacts[1]!.count).toBeUndefined();
  });

  it('maps [Answer to: …] envelopes to answered-question beats, not fresh asks', () => {
    const recording = distillRunRecording({
      sessions: [
        session({
          id: 's',
          gezelId: 'javier',
          messages: [
            { role: 'user', content: 'Fix the pricing bug.', at: T(0) },
            {
              role: 'user',
              content: '[Answer to: "Proceed with the failing test?"]: Yes, go ahead.',
              at: T(30),
            },
          ],
        }),
      ],
    });
    const prompts = recording.scenes.filter((scene) => scene.kind === 'user-prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.excerpt).toBe('Fix the pricing bug.');
    const answer = recording.scenes.find((scene) => scene.kind === 'question');
    expect(answer).toMatchObject({ state: 'answered', actorId: 'user', excerpt: 'Yes, go ahead.' });
  });

  it('degrades gracefully with sessions alone (backfill mode)', () => {
    const recording = distillRunRecording({ sessions: fixtureSessions() });
    expect(parseRunRecording(recording).ok).toBe(true);
    expect(recording.scenes.length).toBeGreaterThan(0);
    expect(recording.actors.find((actor) => actor.id === 'user')).toBeDefined();
  });
});
