import { describe, expect, it } from 'vitest';
import { argValue, classifyRoute, handoffsFromSessions, routeOfCall } from './classify.ts';

describe('argValue', () => {
  it('reads one key from rendered args', () => {
    expect(argValue('option: type:trip-planner\n\nname: Lisbon', 'option')).toBe(
      'type:trip-planner',
    );
    expect(argValue('craftbookId: "status-report"', 'craftbookId')).toBe('status-report');
    expect(argValue(undefined, 'option')).toBeUndefined();
  });
});

describe('routeOfCall', () => {
  it('maps both arms onto one route vocabulary', () => {
    expect(
      routeOfCall({ name: 'start_work', argsFull: 'option: craftbook:status-report' }),
    ).toEqual({
      kind: 'craftbook',
      target: 'status-report',
      via: 'start_work',
    });
    expect(
      routeOfCall({ name: 'invoke_craftbook', argsFull: 'craftbookId: status-report' }),
    ).toEqual({ kind: 'craftbook', target: 'status-report', via: 'invoke_craftbook' });
    expect(routeOfCall({ name: 'start_work', argsFull: 'option: task-here' })?.kind).toBe('task');
    expect(
      routeOfCall({ name: 'invoke_craftbook', argsFull: 'craftbookId: build-loop' })?.kind,
    ).toBe('task');
    expect(routeOfCall({ name: 'start_project' })?.kind).toBe('new-project');
    expect(routeOfCall({ name: 'consult_researcher' })).toEqual({
      kind: 'consult',
      target: 'researcher',
      via: 'consult_researcher',
    });
    expect(routeOfCall({ name: 'search_memory' })).toBeNull();
    expect(routeOfCall({ name: 'suggest_work' })).toBeNull();
  });
});

describe('classifyRoute', () => {
  const trip = [{ kind: 'project-type' as const, target: /^trip-planner$/ }];

  it('takes the first successful routing call and skips lookups before it', () => {
    const verdict = classifyRoute({
      calls: [
        { name: 'suggest_work', success: true },
        { name: 'start_work', success: false, argsFull: 'option: type:nope' },
        { name: 'start_work', success: true, argsFull: 'option: type:trip-planner' },
        { name: 'ask_user_question', success: true },
      ],
      createdProjects: [],
      finished: true,
      assistantText: 'Saskia is on it.',
      acceptable: trip,
    });
    expect(verdict).toMatchObject({
      route: { kind: 'project-type', target: 'trip-planner' },
      accepted: true,
      firstCall: 'suggest_work',
      callsBeforeRoute: 2,
      fabricatedClaim: false,
    });
  });

  it('reads a start_project that routed to a type as that type', () => {
    const verdict = classifyRoute({
      calls: [{ name: 'start_project', success: true }],
      createdProjects: [{ id: 'lisbon', projectTypeId: 'trip-planner' }],
      finished: true,
      assistantText: '',
      acceptable: trip,
    });
    expect(verdict?.route).toEqual({
      kind: 'project-type',
      target: 'trip-planner',
      via: 'start_project',
    });
    expect(verdict?.accepted).toBe(true);
  });

  it('separates a wrong target from a wrong kind', () => {
    const verdict = classifyRoute({
      calls: [{ name: 'start_work', success: true, argsFull: 'option: type:event-planner' }],
      createdProjects: [],
      finished: true,
      assistantText: '',
      acceptable: trip,
    });
    expect(verdict).toMatchObject({ accepted: false, kindAccepted: true });
  });

  it('waits while the turn is running and nothing has routed', () => {
    expect(
      classifyRoute({
        calls: [{ name: 'suggest_work', success: true }],
        createdProjects: [],
        finished: false,
        assistantText: '',
        acceptable: trip,
      }),
    ).toBeNull();
  });

  it('scores an answer, and catches a claimed start with nothing behind it', () => {
    const verdict = classifyRoute({
      calls: [],
      createdProjects: [],
      finished: true,
      assistantText: "I've started your trip project and Saskia is on it.",
      acceptable: [{ kind: 'answer' }],
    });
    expect(verdict).toMatchObject({
      route: { kind: 'answer' },
      accepted: true,
      fabricatedClaim: true,
    });
  });
});

describe('classifyRoute — prefix-less start_work ids', () => {
  it('reads a typed project from the result and the project it made', () => {
    const verdict = classifyRoute({
      calls: [
        {
          name: 'start_work',
          success: true,
          argsFull: 'option: language-trainer',
          resultText:
            'Started "Practice Spanish" (practice-spanish) as a Language Trainer project. Manisha leads it.',
        },
      ],
      createdProjects: [{ id: 'practice-spanish', projectTypeId: 'language-trainer' }],
      finished: true,
      assistantText: '',
      acceptable: [{ kind: 'project-type', target: /^language-trainer$/ }],
    });
    expect(verdict?.route).toEqual({
      kind: 'project-type',
      target: 'language-trainer',
      via: 'start_work',
    });
    expect(verdict?.accepted).toBe(true);
  });

  it('reads a craftbook from the result', () => {
    expect(
      routeOfCall({
        name: 'start_work',
        argsFull: 'option: status-report',
        resultText: 'Invoked craftbook "status-report" — task default/1 (3 step(s)).',
      }),
    ).toEqual({ kind: 'craftbook', target: 'status-report', via: 'start_work' });
  });
});

describe('classifyRoute — self-built', () => {
  it('names a coordinator that wrote the deliverable itself', () => {
    const verdict = classifyRoute({
      calls: [{ name: 'write_artifact', success: true }],
      createdProjects: [],
      finished: true,
      assistantText: 'Here is your status report.',
      acceptable: [{ kind: 'craftbook' }],
    });
    expect(verdict?.route).toEqual({ kind: 'self-built', via: 'write_artifact' });
    expect(verdict?.accepted).toBe(false);
  });
});

describe('classifyRoute — handoffs', () => {
  const sessions = [
    {
      gezelId: 'nadia',
      createdAt: '2026-10-17T05:57:44Z',
      messages: [{ role: 'user' }],
    },
    {
      gezelId: 'alassane',
      createdAt: '2026-10-17T05:58:34Z',
      messages: [{ role: 'user', from: { gezelId: 'nadia', kind: 'consultation' } }],
    },
    {
      gezelId: 'lead',
      createdAt: '2026-10-17T05:59:00Z',
      taskRef: 'trip/1',
      messages: [{ role: 'user', from: { gezelId: 'nadia', kind: 'task-entry' } }],
    },
  ];

  it('reads a consultation the Meester opened, and skips task kickoffs', () => {
    expect(
      handoffsFromSessions(sessions, 'nadia', (id) =>
        id === 'alassane' ? 'researcher' : 'voorman',
      ),
    ).toEqual([{ kind: 'consult', role: 'researcher' }]);
  });

  it('routes on a handoff whose call never committed', () => {
    const verdict = classifyRoute({
      calls: [],
      createdProjects: [],
      handoffs: [{ kind: 'consult', role: 'researcher' }],
      finished: false,
      assistantText: '',
      acceptable: [{ kind: 'answer' }, { kind: 'consult' }],
    });
    expect(verdict).toMatchObject({
      route: { kind: 'consult', target: 'researcher', via: 'handoff' },
      accepted: true,
    });
  });
});
