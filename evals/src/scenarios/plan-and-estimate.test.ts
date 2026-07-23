import { toolsetGroupsForRole } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  PLAN_IMPLEMENTER_BRIEF,
  PLAN_KICKOFF_MESSAGE,
  PLAN_MISSION_OBJECTIVES,
  PLAN_SEED_FILES,
  checkRelocationPlan,
  planAndEstimateScenario,
  planHandoffArgs,
  planHandoffStatusForMessages,
  planKickoffMessage,
  planRepairDirective,
  plannerFileHandoffScenario,
} from './plan-and-estimate.ts';

const REFERENCE_PLAN = [
  '## Objective',
  '',
  'Relocate the 18-person studio to Harbourview by September 30 with zero downtime.',
  '',
  '## Assumptions',
  '',
  '- The Harbourview lease starts September 1.',
  '- Ola (Brightline Fitouts) executes the workshop build but owns no tasks.',
  '',
  '## Work plan',
  '',
  '| ID | Task | Owner | Depends on | Done when |',
  '|---|---|---|---|---|',
  '| T1 | Draft the floor plan (seating, meeting rooms, workshop corner) | Femke | - | Floor plan v1 shared with the whole team |',
  '| T2 | Collect team feedback on the floor plan | Femke | T1 | Every team member has commented |',
  '| T3 | Sign off the final floor plan | Beatrix | T2 | Signed floor plan PDF in the project drive |',
  '| T4 | Get mover quotes based on the signed plan | Cas | T3 | Three written quotes received |',
  '| T5 | Book the movers | Cas | T4 | Booking confirmation for the move date |',
  '| T6 | Order internet + wifi for Harbourview | Joris | - | Provider confirms install date before move day |',
  '| T7 | Set up the network and print corner on site | Joris | T6 | Wifi + print/scan tested from three desks |',
  '| T8 | Prepare the workshop corner build with Ola | Sanne | T3 | Build scope agreed and scheduled in writing |',
  '',
  '## Risks',
  '',
  '- Mover availability in late September is tight; T4 starts the day T3 lands.',
  '- Network install lead time may slip; Joris tracks the provider weekly.',
].join('\n');

describe('plan-and-estimate grader', () => {
  it('the reference plan passes structure, workstreams, and the ceiling', () => {
    const check = checkRelocationPlan(REFERENCE_PLAN);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
  });

  it('a missing section fails with the section named', () => {
    const check = checkRelocationPlan(REFERENCE_PLAN.replace('## Risks', '## Notes'));
    expect(check.ok).toBe(false);
    expect(check.failReason).toContain('Risks');
  });

  it('an off-roster owner (the contractor) fails with the owner named', () => {
    const check = checkRelocationPlan(REFERENCE_PLAN.replace('| Sanne |', '| Ola |'));
    expect(check.ok).toBe(false);
    expect(check.failReason).toContain('Ola');
  });

  it('a later-row dependency fails with both rows named', () => {
    // Swap the T4 and T5 rows so T5 (book movers) appears BEFORE the
    // T4 row it depends on — a forward reference in reading order.
    const t4 =
      '| T4 | Get mover quotes based on the signed plan | Cas | T3 | Three written quotes received |';
    const t5 = '| T5 | Book the movers | Cas | T4 | Booking confirmation for the move date |';
    const swapped = REFERENCE_PLAN.replace(`${t4}\n${t5}`, `${t5}\n${t4}`);
    const check = checkRelocationPlan(swapped);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/T5/);
    expect(check.failReason).toMatch(/LATER row/);
  });

  it('requires mover booking to depend on the floor-plan sign-off chain', () => {
    const unsequenced = REFERENCE_PLAN.replace(
      '| T5 | Book the movers | Cas | T4 |',
      '| T5 | Book the movers | Cas | T1 |',
    );
    const check = checkRelocationPlan(unsequenced);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/T5/);
    expect(check.failReason).toMatch(/floor-plan sign-off/);
  });

  it("accepts the brief's hyphenated sign-off wording in a floor-plan row", () => {
    const markdown = REFERENCE_PLAN.replace(
      'Sign off the final floor plan',
      'Finalize the floor plan',
    ).replace('Signed floor plan PDF in the project drive', 'Floor plan sign-off received');

    const check = checkRelocationPlan(markdown);

    expect(check.ok).toBe(true);
    expect(check.signals).toContain('plan-structure');
  });

  it('accepts floor-plan with a hyphen in the sign-off row', () => {
    const markdown = REFERENCE_PLAN.replaceAll('floor plan', 'floor-plan').replaceAll(
      'Floor plan',
      'Floor-plan',
    );

    const check = checkRelocationPlan(markdown);

    expect(check.ok).toBe(true);
    expect(check.signals).toContain('plan-structure');
    expect(check.signals).toContain('ws-floor-plan');
  });

  it('does not count a required workstream mentioned only outside the Work plan table', () => {
    const withoutNetworkTasks = REFERENCE_PLAN.replace(
      '| T6 | Order internet + wifi for Harbourview | Joris | - | Provider confirms install date before move day |',
      '| T6 | Review relocation communications | Joris | - | Communications checklist approved by the team |',
    ).replace(
      '| T7 | Set up the network and print corner on site | Joris | T6 | Wifi + print/scan tested from three desks |',
      '| T7 | Publish relocation communications | Joris | T6 | Message delivered to every studio member |',
    );
    const check = checkRelocationPlan(withoutNetworkTasks);
    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('ws-network');
  });

  it('a vague done-state fails with the row named', () => {
    const check = checkRelocationPlan(
      REFERENCE_PLAN.replace('Booking confirmation for the move date', 'done'),
    );
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/T5/);
    expect(check.failReason).toMatch(/done when/i);
  });

  it('the repair directive names the file and the table contract', () => {
    const directive = planRepairDirective();
    expect(directive).toContain('plan.md');
    expect(directive).toContain('ID | Task | Owner | Depends on | Done when');
  });

  it('the brief plants the ordering constraint and the no-own contractor', () => {
    const brief = PLAN_SEED_FILES.find((f) => f.path === 'brief.md')!.content;
    expect(brief).toMatch(/AFTER the floor plan is signed off/i);
    expect(brief).toMatch(/CANNOT own tasks/i);
  });
});

describe('plan-and-estimate role-aligned kickoff', () => {
  it('keeps Planner as a pure delegation role', () => {
    const groups = toolsetGroupsForRole('Planner');

    expect(groups).toContain('team-management');
    expect(groups).toContain('interaction');
    expect(groups).not.toContain('workspace-fs-read');
    expect(groups).not.toContain('workspace-fs-write');
    expect(groups).not.toContain('code-execution');
  });

  it('builds one blocking file handoff to the writable implementer', () => {
    expect(planHandoffArgs('deepak-id', 'harbourview-id')).toEqual({
      gezel: 'deepak-id',
      project: 'harbourview-id',
      question: PLAN_IMPLEMENTER_BRIEF,
      timeoutMs: 15 * 60_000,
      expectedDeliverable: { kind: 'file', filePath: 'plan.md' },
    });
  });

  it('tells Planner to delegate instead of guessing at workspace/document tools', () => {
    const kickoff = planKickoffMessage('deepak-id', 'harbourview-id');
    const callLine = kickoff.split('\n').find((line) => line.startsWith('ask_gezel('));

    expect(kickoff).toContain('coordination-only Planner');
    expect(kickoff).toContain('do not have project-workspace read or write tools');
    expect(kickoff).toContain('Do not call\n`read_document`');
    expect(kickoff).toContain('Do not ask the user');
    expect(kickoff).not.toContain('readFile');
    expect(kickoff).not.toContain('writeFile');
    expect(callLine).toBeDefined();
    expect(kickoff.match(/ask_gezel\(/g)).toHaveLength(1);

    const args = JSON.parse(callLine!.slice('ask_gezel('.length, -1));
    expect(args).toEqual(planHandoffArgs('deepak-id', 'harbourview-id'));
  });

  it('puts every hard output contract in the delegated brief', () => {
    expect(PLAN_IMPLEMENTER_BRIEF).toMatch(/18-person studio/i);
    expect(PLAN_IMPLEMENTER_BRIEF).toMatch(/September 30/i);
    expect(PLAN_IMPLEMENTER_BRIEF).toMatch(/ID \| Task \| Owner \| Depends on \| Done when/i);
    expect(PLAN_IMPLEMENTER_BRIEF).toMatch(/at least 8 rows/i);
    expect(PLAN_IMPLEMENTER_BRIEF).toMatch(/booking the movers depends on/i);
    expect(PLAN_IMPLEMENTER_BRIEF).toMatch(/Ola .* cannot own/i);
    expect(PLAN_IMPLEMENTER_BRIEF).toMatch(/under 1200 words/i);
  });

  it('registers the mission and direct author brief as user-shaped plan evidence', () => {
    expect(planAndEstimateScenario.evidenceTexts).toEqual([
      PLAN_MISSION_OBJECTIVES,
      PLAN_IMPLEMENTER_BRIEF,
    ]);

    const userShapedText = [
      planAndEstimateScenario.prompt,
      ...(planAndEstimateScenario.evidenceTexts ?? []),
    ]
      .join('\n')
      .toLowerCase();
    for (const evidence of planAndEstimateScenario.requiredPromptEvidence ?? []) {
      evidence.pattern.lastIndex = 0;
      expect(evidence.pattern.test(userShapedText), evidence.signal).toBe(true);
    }
  });

  it('splits plan quality from Planner-to-Developer handoff provenance', () => {
    expect(planAndEstimateScenario.requiredPromptEvidence?.map((entry) => entry.signal)).toEqual([
      'ordered-sections',
      'plan-structure',
      'ws-floor-plan',
      'ws-movers',
      'ws-network',
      'word-ceiling',
    ]);
    expect(plannerFileHandoffScenario.requiredPromptEvidence?.map((entry) => entry.signal)).toEqual(
      ['planner-handoff'],
    );
    expect(plannerFileHandoffScenario.evidenceTexts).toEqual([PLAN_KICKOFF_MESSAGE]);
  });

  it('starts the plan-quality probe directly on the writable author', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'harbourview-office-relocation', name: 'Harbourview Office Relocation' }],
      }),
      writeProjectWorkspaceFile: vi.fn().mockResolvedValue({}),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'deepak', name: 'Deepak', role: 'Developer' }],
      }),
      addGezelToProject: vi.fn().mockResolvedValue({}),
      sendChatMessage: vi.fn().mockResolvedValue({}),
    } as unknown as EvalContext['client'];
    const ctx = {
      client,
      meesterId: 'zephyr',
      log: vi.fn(),
    } as unknown as EvalContext;

    await planAndEstimateScenario.setup?.(ctx);

    expect(client.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(client.sendChatMessage).toHaveBeenCalledWith('deepak', {
      message: PLAN_IMPLEMENTER_BRIEF,
      projectId: 'harbourview-office-relocation',
    });
  });

  it('starts the handoff probe on the coordination-only Planner', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'harbourview-office-relocation', name: 'Harbourview Office Relocation' }],
      }),
      writeProjectWorkspaceFile: vi.fn().mockResolvedValue({}),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [
          { id: 'ismay', name: 'Ismay', role: 'Planner' },
          { id: 'deepak', name: 'Deepak', role: 'Developer' },
        ],
      }),
      addGezelToProject: vi.fn().mockResolvedValue({}),
      sendChatMessage: vi.fn().mockResolvedValue({}),
    } as unknown as EvalContext['client'];
    const ctx = {
      client,
      meesterId: 'zephyr',
      log: vi.fn(),
    } as unknown as EvalContext;

    await plannerFileHandoffScenario.setup?.(ctx);

    expect(client.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(client.sendChatMessage).toHaveBeenCalledWith('ismay', {
      message: planKickoffMessage('deepak', 'harbourview-office-relocation'),
      projectId: 'harbourview-office-relocation',
    });
  });
});

describe('plan-and-estimate collaboration evidence', () => {
  const plannerHandoff = {
    role: 'user',
    content:
      '[Question from Ismay]: Write plan.md.\n\n' +
      '[Deliverable expected as a FILE at `plan.md`. Your first assistant action should be writeFile.]',
    from: { gezelId: 'ismay' },
  };
  const successfulPlanWrite = {
    role: 'assistant',
    content: 'Wrote plan.md.',
    toolCalls: [{ name: 'writeFile', success: true, path: 'plan.md' }],
  };

  it('requires the target to mutate plan.md in the Planner-origin handoff response', () => {
    expect(planHandoffStatusForMessages([plannerHandoff, successfulPlanWrite], 'ismay')).toBe(
      'completed',
    );
    expect(planHandoffStatusForMessages([plannerHandoff], 'ismay')).toBe('pending');
    expect(
      planHandoffStatusForMessages(
        [plannerHandoff, { role: 'assistant', content: 'I only described a plan.' }],
        'ismay',
      ),
    ).toBe('failed');
  });

  it('does not credit the frozen harness-rescue shape as Planner collaboration', () => {
    const frozenRescue = [
      {
        role: 'user',
        content:
          '[Message from Zephyr]: Write plan.md.\n\n' +
          '[Deliverable expected as a FILE at `plan.md`. Your first assistant action should be writeFile.]',
        from: { gezelId: 'zephyr' },
      },
      successfulPlanWrite,
    ];

    expect(planHandoffStatusForMessages(frozenRescue, 'ismay')).toBe('none');
  });

  it('does not attribute a later harness write to an earlier failed Planner handoff', () => {
    const rescuedAfterPlanner = [
      plannerHandoff,
      { role: 'assistant', content: 'I did not write the file.' },
      {
        role: 'user',
        content:
          '[Message from Zephyr]: Write plan.md now.\n\n' +
          '[Deliverable expected as a FILE at `plan.md`. Write it.]',
        from: { gezelId: 'zephyr' },
      },
      successfulPlanWrite,
    ];

    expect(planHandoffStatusForMessages(rescuedAfterPlanner, 'ismay')).toBe('failed');
  });

  function successCheckContext(implementerMessages: Array<Record<string, unknown>>) {
    const plannerSession = {
      id: 'planner-session',
      lastActivityAt: '2026-07-10T18:00:00.000Z',
      messages: [
        { role: 'user', content: PLAN_KICKOFF_MESSAGE },
        {
          role: 'assistant',
          content: 'The handoff failed validation.',
          toolCalls: [{ name: 'message_gezel', success: false }],
        },
      ],
    };
    const implementerSession = {
      id: 'implementer-session',
      lastActivityAt: '2026-07-10T18:01:00.000Z',
      messages: implementerMessages,
    };
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'harbourview-office-relocation', name: 'Harbourview Office Relocation' }],
      }),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [
          { id: 'ismay', name: 'Ismay' },
          { id: 'deepak', name: 'Deepak' },
        ],
      }),
      fetchProjectWorkspaceBlob: vi.fn().mockResolvedValue(new Blob([REFERENCE_PLAN])),
      listChatSessions: vi.fn().mockImplementation(({ gezelId }: { gezelId?: string }) => {
        if (gezelId === 'ismay') return Promise.resolve({ sessions: [plannerSession] });
        if (gezelId === 'deepak') return Promise.resolve({ sessions: [implementerSession] });
        return Promise.resolve({ sessions: [] });
      }),
      getChatSession: vi.fn().mockImplementation((id: string) => {
        if (id === plannerSession.id) return Promise.resolve(plannerSession);
        if (id === implementerSession.id) return Promise.resolve(implementerSession);
        return Promise.reject(new Error(`unknown session ${id}`));
      }),
      sendChatMessage: vi.fn().mockResolvedValue({}),
    } as unknown as EvalContext['client'];
    const recordSniff = vi.fn();
    const ctx = {
      client,
      meesterId: 'zephyr',
      log: vi.fn(),
      logChanged: vi.fn(),
      recordSniff,
    } satisfies EvalContext;
    return { client, ctx, recordSniff };
  }

  it('passes a structurally valid plan independently of handoff provenance', async () => {
    const rescued = [
      {
        role: 'user',
        content:
          '[Message from Zephyr]: Write plan.md.\n\n' +
          '[Deliverable expected as a FILE at `plan.md`. Write it.]',
        from: { gezelId: 'zephyr' },
      },
      successfulPlanWrite,
    ];
    const { client, ctx, recordSniff } = successCheckContext(rescued);

    await expect(planAndEstimateScenario.successCheck(ctx)).resolves.toMatchObject({
      done: true,
      success: true,
      reason: expect.stringContaining('Plan satisfies structure'),
    });
    expect(recordSniff).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'plan-and-estimate', score: 6 }),
    );
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('keeps the Planner handoff as a separate target-side provenance gate', async () => {
    const { client, ctx, recordSniff } = successCheckContext([plannerHandoff, successfulPlanWrite]);

    await expect(plannerFileHandoffScenario.successCheck(ctx)).resolves.toMatchObject({
      done: true,
      success: true,
      reason: expect.stringContaining('Planner-origin file handoff'),
    });
    expect(recordSniff).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'planner-file-handoff', score: 1 }),
    );
    expect(client.sendChatMessage).not.toHaveBeenCalled();
  });

  it('does not let a harness-rescued plan satisfy the separate handoff probe', async () => {
    const rescued = [
      {
        role: 'user',
        content:
          '[Message from Zephyr]: Write plan.md.\n\n' +
          '[Deliverable expected as a FILE at `plan.md`. Write it.]',
        from: { gezelId: 'zephyr' },
      },
      successfulPlanWrite,
    ];
    const { client, ctx, recordSniff } = successCheckContext(rescued);

    await expect(plannerFileHandoffScenario.successCheck(ctx)).resolves.toEqual({ done: false });
    expect(recordSniff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        key: 'planner-file-handoff',
        score: 0,
        failReason: expect.stringContaining('Planner handoff is none'),
      }),
    );
    expect(client.sendChatMessage).toHaveBeenCalledWith(
      'ismay',
      expect.objectContaining({
        projectId: 'harbourview-office-relocation',
        message: expect.stringContaining('ask_gezel('),
      }),
    );
  });
});
