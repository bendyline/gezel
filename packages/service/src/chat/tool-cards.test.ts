import { describe, expect, it } from 'vitest';
import type { ToolCallEvent } from '../providers/types.js';
import { extractToolCard } from './tool-cards.js';

/** The powerpoint-deck-shaped task snapshot as invoke_craftbook returns it. */
function craftbookTask(overrides?: {
  status?: string;
  activeStepId?: string | undefined;
  steps?: Array<{ id: string; name: string; completedAt?: string }>;
  recommends?: unknown;
  sourceCraftbookIds?: unknown;
}) {
  return {
    ref: 'default/12',
    projectId: 'default',
    num: 12,
    title: 'PowerPoint from Content',
    status: overrides?.status ?? 'active',
    ...(overrides && 'activeStepId' in overrides
      ? overrides.activeStepId
        ? { activeStepId: overrides.activeStepId }
        : {}
      : { activeStepId: 'research' }),
    sourceCraftbookIds: overrides?.sourceCraftbookIds ?? [
      { role: 'main', catalogId: 'powerpoint-deck', version: '1.7.4' },
    ],
    craftbook: {
      id: 'task-abc123',
      name: 'PowerPoint from Content',
      ...(overrides?.recommends !== undefined ? { recommends: overrides.recommends } : {}),
      steps: overrides?.steps ?? [
        { id: 'research', name: 'Acquire and verify sources' },
        { id: 'outline', name: 'Lock the slide outline' },
        { id: 'write', name: 'Write the Markdown deck' },
      ],
    },
  };
}

function toolEvent(
  name: string,
  structuredContent: Record<string, unknown> | undefined,
  args?: Record<string, unknown>,
  success = true,
): ToolCallEvent {
  return {
    name,
    argKeys: Object.keys(args ?? {}),
    ...(args ? { args } : {}),
    durationMs: 42,
    success,
    ...(structuredContent ? { structuredContent } : {}),
  };
}

describe('extractToolCard — craftbook start', () => {
  it('builds a snapshot card from the invoke_craftbook structured task', () => {
    const card = extractToolCard(toolEvent('invoke_craftbook', { task: craftbookTask() }));
    expect(card).toMatchObject({
      kind: 'craftbook-start',
      craftbookId: 'powerpoint-deck',
      craftbookName: 'PowerPoint from Content',
      taskRef: 'default/12',
      projectId: 'default',
      status: 'active',
      activeStepId: 'research',
    });
    expect(card?.steps).toEqual([
      { id: 'research', name: 'Acquire and verify sources', status: 'active' },
      { id: 'outline', name: 'Lock the slide outline', status: 'pending' },
      { id: 'write', name: 'Write the Markdown deck', status: 'pending' },
    ]);
  });

  it('prefers the main sourceCraftbookIds catalog id, falling back to craftbook.id', () => {
    const adHoc = extractToolCard(
      toolEvent('invoke_craftbook', { task: craftbookTask({ sourceCraftbookIds: [] }) }),
    );
    expect(adHoc?.craftbookId).toBe('task-abc123');
  });

  it('copies the external-services recommendation onto the card', () => {
    const card = extractToolCard(
      toolEvent('invoke_craftbook', {
        task: craftbookTask({
          recommends: [{ kind: 'external-services', reason: 'verifies sources with web search' }],
        }),
      }),
    );
    expect(card?.kind).toBe('craftbook-start');
    if (card?.kind !== 'craftbook-start') return;
    expect(card.recommendsExternalServices).toEqual({
      reason: 'verifies sources with web search',
    });
  });

  it('marks reused invocations', () => {
    const card = extractToolCard(
      toolEvent('invoke_craftbook', { task: craftbookTask(), details: { reused: true } }),
    );
    expect(card?.kind).toBe('craftbook-start');
    if (card?.kind !== 'craftbook-start') return;
    expect(card.reused).toBe(true);
  });
});

describe('extractToolCard — step advance', () => {
  it('records the completed step from args and the new active step', () => {
    const card = extractToolCard(
      toolEvent(
        'advance_task_step',
        {
          task: craftbookTask({
            activeStepId: 'outline',
            steps: [
              {
                id: 'research',
                name: 'Acquire and verify sources',
                completedAt: '2026-08-26T10:00:00Z',
              },
              { id: 'outline', name: 'Lock the slide outline' },
              { id: 'write', name: 'Write the Markdown deck' },
            ],
          }),
        },
        { ref: 'default/12', stepId: 'research' },
      ),
    );
    expect(card).toMatchObject({
      kind: 'task-step-advance',
      completedStepId: 'research',
      completedStepName: 'Acquire and verify sources',
      activeStepId: 'outline',
      activeStepName: 'Lock the slide outline',
    });
    expect(card?.steps.map((s) => s.status)).toEqual(['done', 'active', 'pending']);
  });

  it('handles the terminal advance: no active step, all-done statuses', () => {
    const card = extractToolCard(
      toolEvent(
        'advance_task_step',
        {
          task: craftbookTask({
            status: 'complete',
            activeStepId: undefined,
            steps: [
              { id: 'research', name: 'Research', completedAt: '2026-08-26T10:00:00Z' },
              { id: 'write', name: 'Write', completedAt: '2026-08-26T11:00:00Z' },
            ],
          }),
        },
        { ref: 'default/12', stepId: 'write' },
      ),
    );
    expect(card?.kind).toBe('task-step-advance');
    if (card?.kind !== 'task-step-advance') return;
    expect(card.status).toBe('complete');
    expect(card.activeStepId).toBeUndefined();
    expect(card.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('never marks the looped-back active step done-by-position (non-linear books)', () => {
    // review sent the task BACK to write: write has a completedAt from its
    // first pass AND is the active step again. completedAt wins (done) and
    // position math would have lied either way — the invariant is that the
    // later pending steps stay pending.
    const card = extractToolCard(
      toolEvent(
        'advance_task_step',
        {
          task: craftbookTask({
            activeStepId: 'write',
            steps: [
              { id: 'write', name: 'Write', completedAt: '2026-08-26T10:00:00Z' },
              { id: 'review', name: 'Review', completedAt: '2026-08-26T11:00:00Z' },
              { id: 'publish', name: 'Publish' },
            ],
          }),
        },
        { ref: 'default/12', stepId: 'review' },
      ),
    );
    expect(card?.steps.find((s) => s.id === 'publish')?.status).toBe('pending');
  });

  it('falls back to the most recently completed step when args carry no stepId', () => {
    const card = extractToolCard(
      toolEvent('advance_task_step', {
        task: craftbookTask({
          activeStepId: 'write',
          steps: [
            { id: 'research', name: 'Research', completedAt: '2026-08-26T10:00:00Z' },
            { id: 'outline', name: 'Outline', completedAt: '2026-08-26T11:00:00Z' },
            { id: 'write', name: 'Write' },
          ],
        }),
      }),
    );
    expect(card?.kind).toBe('task-step-advance');
    if (card?.kind !== 'task-step-advance') return;
    expect(card.completedStepId).toBe('outline');
  });
});

describe('extractToolCard — refusals', () => {
  it('returns undefined for failed calls (gate rejections are isError, no card)', () => {
    expect(
      extractToolCard(toolEvent('advance_task_step', { task: craftbookTask() }, {}, false)),
    ).toBeUndefined();
  });

  it('returns undefined for other tools even with a task-shaped payload', () => {
    expect(extractToolCard(toolEvent('get_task', { task: craftbookTask() }))).toBeUndefined();
  });

  it('returns undefined on malformed structuredContent instead of throwing', () => {
    expect(extractToolCard(toolEvent('invoke_craftbook', undefined))).toBeUndefined();
    expect(extractToolCard(toolEvent('invoke_craftbook', { task: 'nope' }))).toBeUndefined();
    expect(
      extractToolCard(toolEvent('invoke_craftbook', { task: { ref: 'default/1' } })),
    ).toBeUndefined();
    expect(
      extractToolCard(
        toolEvent('invoke_craftbook', {
          task: {
            ref: 'default/1',
            projectId: 'default',
            status: 'active',
            craftbook: { name: 'X', steps: [{ id: 'a' }] },
          },
        }),
      ),
    ).toBeUndefined();
  });
});
