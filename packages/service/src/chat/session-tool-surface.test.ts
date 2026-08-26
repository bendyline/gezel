import type { ChatSession } from '@bendyline/gezel';
import { resolveSecurityPolicy, securityPolicyForLevel } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  availableBuiltinToolsForAllowlist,
  resolveSessionToolSurface,
  toolCapForTierAndRole,
} from './session-tool-surface.js';

/**
 * Pins the tier x role cap table. History that makes this worth a direct
 * test: the count-cap repeatedly rendered coordinator gezels inoperable by
 * evicting load-bearing tools while keeping incidental reads (the imara
 * office-hours kickoff loop,, was the 4th such incident). The
 * policy is now: small coordinators are capped to their complete curated
 * surface, while medium/large roles keep their full kit when the admitted
 * context can hold it. Explicit and memory-pressure coordinator diets are
 * covered independently. Implementation roles keep their broad workbench.
 */
describe('toolCapForTierAndRole', () => {
  it('by default medium/large are uncapped for every role', () => {
    for (const role of ['Meester', 'Voorman', 'Developer', 'Data Wizard', undefined] as const) {
      expect(toolCapForTierAndRole('medium', role)).toBeNull();
      expect(toolCapForTierAndRole('large', role)).toBeNull();
    }
  });

  it('small tier: coordinators capped AT their curated list length by default', () => {
    // Wild-caught (petshop, qwen3.5-9b-q4): the uncapped
    // 161-tool surface produced a ~36k-token first prompt on a 9B; the
    // meester streamed 0 visible chars for 9 minutes and the mid-stream
    // watchdog killed the kickoff turn. Capping AT list length keeps the
    // whole curated orchestration surface (incl. read_task_notes, rank
    // ~26 — the tool whose eviction under the old cap-of-13 caused the
    // imara incident), so the safety argument from the diet applies.
    for (const role of ['Meester', 'guildmaster meester', 'Voorman', 'shop foreman']) {
      const cap = toolCapForTierAndRole('small', role);
      expect(cap).not.toBeNull();
      expect(cap!).toBeGreaterThanOrEqual(27);
    }
  });

  it('small tier: implementation + custom roles stay uncapped', () => {
    expect(toolCapForTierAndRole('small', 'Developer')).toBeNull();
    expect(toolCapForTierAndRole('small', 'Data Wizard')).toBeNull();
    expect(toolCapForTierAndRole('small', undefined)).toBeNull();
  });

  describe('opt-in coordinator diet (GEZEL_MEESTER_TOOL_DIET=1)', () => {
    beforeEach(() => {
      process.env.GEZEL_MEESTER_TOOL_DIET = '1';
    });
    afterEach(() => {
      delete process.env.GEZEL_MEESTER_TOOL_DIET;
    });

    it('caps medium/large coordinators to their curated list length', () => {
      for (const tier of ['medium', 'large'] as const) {
        for (const role of ['Meester', 'guildmaster meester', 'Voorman', 'shop foreman']) {
          const cap = toolCapForTierAndRole(tier, role);
          expect(cap).not.toBeNull();
          expect(cap!).toBeGreaterThanOrEqual(27);
        }
      }
    });

    it('leaves implementation + custom roles uncapped at medium/large (diet is coordinator-only)', () => {
      expect(toolCapForTierAndRole('medium', 'Developer')).toBeNull();
      expect(toolCapForTierAndRole('large', 'Data Wizard')).toBeNull();
    });

    it('does not change the small-coordinator default cap or the tiny caps', () => {
      expect(toolCapForTierAndRole('small', 'Meester')).not.toBeNull();
      expect(toolCapForTierAndRole('tiny', 'Meester')).toBe(15);
      expect(toolCapForTierAndRole('tiny', 'Developer')).toBe(75);
    });
  });

  it('accepts an explicit coordinator-diet override for deterministic matrix coverage', () => {
    expect(
      toolCapForTierAndRole('medium', 'Meester', { coordinatorToolDiet: true }),
    ).not.toBeNull();
    expect(toolCapForTierAndRole('medium', 'Meester', { coordinatorToolDiet: false })).toBeNull();
  });

  it('automatically diets a medium coordinator when admission clamps below 48K', () => {
    const clamped = toolCapForTierAndRole('medium', 'Meester', {
      effectiveContextWindow: 35_840,
    });
    expect(clamped).not.toBeNull();
    expect(clamped!).toBeGreaterThanOrEqual(27);

    // At the full-roster floor the established medium-tier behavior remains
    // unchanged: no count cap unless the operator explicitly opts into it.
    expect(
      toolCapForTierAndRole('medium', 'Meester', { effectiveContextWindow: 49_152 }),
    ).toBeNull();
    expect(
      toolCapForTierAndRole('medium', 'Developer', { effectiveContextWindow: 35_840 }),
    ).toBeNull();
  });

  it('tiny tier: implementation roles keep the broad workbench (75)', () => {
    expect(toolCapForTierAndRole('tiny', 'Developer')).toBe(75);
    expect(toolCapForTierAndRole('tiny', 'senior engineer')).toBe(75);
  });

  it('tiny tier: coordinator and custom roles share the flat ceiling (15)', () => {
    expect(toolCapForTierAndRole('tiny', 'Meester')).toBe(15);
    expect(toolCapForTierAndRole('tiny', 'Voorman')).toBe(15);
    expect(toolCapForTierAndRole('tiny', 'Data Wizard')).toBe(15);
    expect(toolCapForTierAndRole('tiny', undefined)).toBe(15);
  });
});

/**
 * What survives a trim must be a decision, not a side effect of how the
 * toolset groups happened to be ordered. Before this, the slots left over
 * after a role's curated priority list were filled by `Set` iteration
 * order: `read_file` / `list_dir` reached a small-tier Meester purely as
 * residue, and reordering a group would have taken them away with nothing
 * in the code saying so.
 */
describe('tool-cap trim is deliberate, not incidental', () => {
  const surface = async (over: {
    role: string;
    toolsetsGroupOverride?: readonly string[];
  }): Promise<Set<string>> => {
    const res = await resolveSessionToolSurface({
      surface: 'bridge',
      session: {
        id: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        providerName: 'llama-cpp',
        title: '',
        messages: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        lastActivityAt: '2026-08-01T00:00:00.000Z',
      } as unknown as ChatSession,
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4:e4b',
      toolsetsGroupOverride: [],
      githubLinked: false,
      isGitRepo: false,
      tier: 'small',
      latestUserMessage: undefined,
      ...over,
    });
    expect(res.allowlist).not.toBeNull();
    return res.allowlist!;
  };

  it('the small-tier Meester keeps the tools its own schemas point at', async () => {
    const allow = await surface({ role: 'Meester' });
    // `craftbook_read`'s argument description reads "Craftbook id from
    // list_craftbooks" — the cap used to drop the tool it names while
    // keeping the pointer, on the one role built around craftbooks.
    expect(allow.has('craftbook_read')).toBe(true);
    expect(allow.has('craftbook_write')).toBe(true);
    expect(allow.has('list_craftbooks')).toBe(true);
    expect(allow.has('suggest_craftbook')).toBe(true);
    expect(allow.has('invoke_craftbook')).toBe(true);
  });

  it('reordering the toolset groups does not change what survives', async () => {
    const groups = [
      'memory',
      'workspace-fs-read',
      'tasks',
      'craftbooks',
      'team-management',
      'artifacts',
      'documents',
      'code-intel',
    ] as const;
    const forward = await surface({ role: 'Meester', toolsetsGroupOverride: groups });
    const reversed = await surface({
      role: 'Meester',
      toolsetsGroupOverride: [...groups].reverse(),
    });
    expect([...forward].sort()).toEqual([...reversed].sort());
  });

  it('a custom role with no curated list still gets a coherent generalist kit', async () => {
    // Tiny tier, cap 15, empty priority list — every slot comes from the
    // generic fallback ladder. Previously this was whichever group the
    // resolver visited first, so the 15 tools a custom gezel kept were
    // effectively arbitrary.
    const res = await resolveSessionToolSurface({
      surface: 'bridge',
      session: {
        id: 's1',
        gezelId: 'g1',
        projectId: 'p1',
        providerName: 'llama-cpp',
        title: '',
        messages: [],
        createdAt: '2026-08-01T00:00:00.000Z',
        lastActivityAt: '2026-08-01T00:00:00.000Z',
      } as unknown as ChatSession,
      role: 'Data Wizard',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'llama3.2:3b',
      toolsetsGroupOverride: [],
      githubLinked: false,
      isGitRepo: false,
      tier: 'tiny',
      latestUserMessage: undefined,
    });
    const allow = res.allowlist!;
    // Read before write, then somewhere to put the result — plus the
    // load-bearing floor, which the cap never counts.
    expect(allow.has('read_file')).toBe(true);
    expect(allow.has('list_dir')).toBe(true);
    expect(allow.has('write_artifact')).toBe(true);
    expect(allow.has('search_memory')).toBe(true);
    expect(allow.has('write_file')).toBe(true);
    expect(allow.has('ask_user_question')).toBe(true);
  });
});

/**
 * The two safeguards that keep a step-scoped session operable regardless of
 * role kit or cap: (1) the step-completion grant, and (2) the load-bearing
 * floor across every count-capped tier.
 */
describe('resolveSessionToolSurface — step-scoped sessions', () => {
  const baseSession = (over: Partial<ChatSession>): ChatSession =>
    ({
      id: 's1',
      gezelId: 'imara',
      projectId: 'p1',
      providerName: 'llama-cpp',
      title: '',
      messages: [],
      createdAt: '2026-07-05T00:00:00.000Z',
      lastActivityAt: '2026-07-05T00:00:00.000Z',
      ...over,
    }) as unknown as ChatSession;

  const baseOpts = {
    surface: 'prompt' as const,
    role: 'Meester',
    mode: 'always' as const,
    provider: 'llama-cpp' as const,
    toolsetsGroupOverride: [] as readonly string[],
    githubLinked: false,
    isGitRepo: false,
    latestUserMessage:
      "[Message from Adwoa]: You're still assigned step `kickoff`; pick up where you left off.",
  };

  it('leanProfile collapses the builtin surface to the minimal essential set', async () => {
    // A game / chat-room gezel: even a broad-surface role (Meester here)
    // loses the whole developer workbench — only `ask_user_question`
    // survives. Its project-type script tools (make_move, get_board) aren't
    // builtins, so they pass the bridge filter separately and are never in
    // this builtin allowlist. This is what keeps a small model from drowning
    // in 60+ irrelevant tools while playing checkers.
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({}),
      tier: 'medium',
      leanProfile: true,
    });
    expect(allowlist).not.toBeNull();
    expect([...allowlist!]).toEqual(['ask_user_question']);
    expect(allowlist!.has('write_file')).toBe(false);
    expect(allowlist!.has('list_tasks')).toBe(false);
  });

  it('loads the large step-patch schema only for an explicit craftbook editor session', async () => {
    const ordinary = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({}),
      tier: 'medium',
    });
    const editor = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ craftbookRef: 'weekly-review' }),
      tier: 'medium',
    });

    expect(ordinary.allowlist?.has('craftbook_update_step')).toBe(false);
    expect(editor.allowlist?.has('craftbook_update_step')).toBe(true);
    expect(editor.allowlist?.has('craftbook_write')).toBe(true);
    expect(editor.allowlist?.has('set_step_deliverable')).toBe(true);
  });

  it('admits and predicts only conditionals enabled for this session', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({}),
      tier: 'medium',
      contextualBuiltinTools: ['draft_email', 'draft_connector_action'],
    });

    expect(allowlist?.has('draft_email')).toBe(true);
    expect(allowlist?.has('draft_connector_action')).toBe(true);
    expect(allowlist?.has('send_email')).toBe(false);
    expect(
      availableBuiltinToolsForAllowlist(allowlist, [
        'draft_email',
        'draft_connector_action',
        'request_tool_permission',
      ]).map((tool) => tool.name),
    ).toEqual(expect.arrayContaining(['draft_email', 'draft_connector_action']));
    expect(
      availableBuiltinToolsForAllowlist(allowlist, ['request_tool_permission']).map(
        (tool) => tool.name,
      ),
    ).not.toContain('request_tool_permission');
    expect(
      availableBuiltinToolsForAllowlist(
        allowlist,
        ['draft_email', 'draft_connector_action'],
        new Set(['draft_connector_action']),
      ).map((tool) => tool.name),
    ).toEqual(['draft_connector_action']);
  });

  it('admits the social post trio only when granted, and strips it under a no-services posture', async () => {
    const granted = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({}),
      tier: 'medium',
      contextualBuiltinTools: ['draft_post', 'queue_post', 'publish_post'],
    });
    expect(granted.allowlist?.has('draft_post')).toBe(true);
    expect(granted.allowlist?.has('queue_post')).toBe(true);
    expect(granted.allowlist?.has('publish_post')).toBe(true);

    const ungranted = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({}),
      tier: 'medium',
    });
    expect(ungranted.allowlist?.has('draft_post')).toBe(false);
    expect(ungranted.allowlist?.has('publish_post')).toBe(false);

    // Outbound social agency is external-service class: even a granted trio
    // is stripped by the security ceiling when services are off.
    const locked = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({}),
      tier: 'medium',
      contextualBuiltinTools: ['draft_post', 'queue_post', 'publish_post'],
      securityPolicy: resolveSecurityPolicy({
        securityPolicy: securityPolicyForLevel('super-lockdown'),
      }),
    });
    expect(locked.allowlist?.has('draft_post')).toBe(false);
    expect(locked.allowlist?.has('queue_post')).toBe(false);
    expect(locked.allowlist?.has('publish_post')).toBe(false);
  });

  it('grants write_task_note/advance_task_step to a Meester assigned a step', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ taskRef: 'p1/7', stepId: 'kickoff' }),
      tier: 'medium',
    });
    expect(allowlist).not.toBeNull();
    // The meester role kit is `tasks-readonly` — these two are NOT in it,
    // so their presence proves the step-completion grant fired.
    expect(allowlist!.has('write_task_note')).toBe(true);
    expect(allowlist!.has('advance_task_step')).toBe(true);
    expect(allowlist!.has('read_task_notes')).toBe(true);
  });

  it('grants a task-scoped Planner the Markdown kit for its authored planning file', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Planner',
      session: baseSession({ taskRef: 'p1/8', stepId: 'outline' }),
      tier: 'medium',
      activeStep: {
        advanceWhen: { file: 'notes/outline.md', minBytes: 400 },
      },
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('read_file')).toBe(true);
    expect(allowlist!.has('read_files')).toBe(true);
    expect(allowlist!.has('write_file')).toBe(true);
    expect(allowlist!.has('replace_in_file')).toBe(true);
    expect(allowlist!.has('advance_task_step')).toBe(true);
  });

  it('keeps ordinary Planner chat read-only and honors a non-writable project ceiling', async () => {
    const ordinary = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Planner',
      session: baseSession({}),
      tier: 'medium',
    });
    const lockedStep = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Planner',
      session: baseSession({ taskRef: 'p1/8', stepId: 'outline' }),
      tier: 'medium',
      workspaceWritable: false,
      activeStep: {
        advanceWhen: { file: 'notes/outline.md', minBytes: 400 },
      },
    });

    expect(ordinary.allowlist?.has('write_file')).toBe(false);
    expect(lockedStep.allowlist?.has('read_file')).toBe(true);
    expect(lockedStep.allowlist?.has('write_file')).toBe(false);
    expect(lockedStep.allowlist?.has('replace_in_file')).toBe(false);
  });

  it('a writes-off step session keeps the artifact drawer as its write channel', async () => {
    // Wild-caught (molen dependency-audit night shift): kit narrowing
    // stripped the drawer tools from a Developer on a writes-off project,
    // leaving zero write channels while the gate demanded a deliverable.
    const clamps: string[] = [];
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Developer',
      session: baseSession({ taskRef: 'molen/3', stepId: 'scan' }),
      tier: 'large',
      workspaceWritable: false,
      activeStep: {
        advanceWhen: { file: 'notes/scan.md', minBytes: 1, sniff: 'nonempty' },
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'notes/scan.md', bytes: 120 }],
          onReject: 'scan',
        },
        gateAttempts: 1,
        lastGateReject: {
          messageFingerprint: 'fp',
          message: 'notes/scan.md is 0 bytes, need >= 120',
          at: '2026-08-01T00:00:00.000Z',
        },
      },
      onClamp: (kind) => clamps.push(kind),
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('write_file')).toBe(false);
    expect(allowlist!.has('replace_in_file')).toBe(false);
    expect(allowlist!.has('write_artifact')).toBe(true);
    expect(allowlist!.has('read_artifact')).toBe(true);
    expect(allowlist!.has('list_artifacts')).toBe(true);
    expect(allowlist!.has('write_task_note')).toBe(true);
    expect(allowlist!.has('advance_task_step')).toBe(true);
    // The repair clamp applies (write_artifact satisfies the starvation
    // guard) instead of silently skipping and leaving the wide surface.
    expect(clamps).toContain('gate-repair');
  });

  it('does NOT grant step tools to a session with no active step', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({}),
      tier: 'medium',
    });
    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('write_task_note')).toBe(false);
    expect(allowlist!.has('advance_task_step')).toBe(false);
  });

  it('load-bearing floor keeps step tools alive even under the tiny cap', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ taskRef: 'p1/7', stepId: 'kickoff' }),
      tier: 'tiny',
    });
    expect(allowlist).not.toBeNull();
    // At tiny the count-cap (15) is active and would otherwise rank these
    // below the cut for a meester; the floor protects them.
    expect(allowlist!.has('read_task_notes')).toBe(true);
    expect(allowlist!.has('write_task_note')).toBe(true);
    expect(allowlist!.has('advance_task_step')).toBe(true);
  });

  it('keeps procedure-required task tools through an urgent write_file clamp', async () => {
    const clamps: string[] = [];
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Developer',
      provider: 'mlx',
      session: baseSession({
        gezelId: 'callum',
        providerName: 'mlx',
        taskRef: 'space-wars/1',
        stepId: 'build',
      }),
      tier: 'medium',
      latestUserMessage:
        'Build a new game at `workspace/index.html`. First pass: call `write_file` with the complete file.',
      activeStep: {
        advanceWhen: { file: 'index.html', sniff: 'html-game' },
        onExit: { name: 'verify-space-war' },
        gate: {
          at: 'completion',
          checks: [{ kind: 'jsParses', file: 'index.html' }],
          onReject: 'build',
        },
      },
      forceDirectFileWork: true,
      onClamp: (kind) => clamps.push(kind),
    });

    expect(clamps).toContain('immediate-file-write');
    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('write_file')).toBe(true);
    expect(allowlist!.has('read_task_notes')).toBe(true);
    expect(allowlist!.has('write_task_note')).toBe(true);
    expect(allowlist!.has('advance_task_step')).toBe(true);
    expect(allowlist!.has('set_task_status')).toBe(true);
    expect(allowlist!.has('run_installed_script')).toBe(true);
    expect(allowlist!.has('read_file')).toBe(false);
  });
});

describe('resolveSessionToolSurface — Meester routing precedence', () => {
  it('routes an exact-format PowerPoint request through the compact craftbook front door', async () => {
    const prompt = 'Create a PowerPoint presentation about D-Day and deliver the .pptx file.';
    for (const role of ['Meester', 'Voorman']) {
      const { allowlist, projectOrchestrationConstrained } = await resolveSessionToolSurface({
        surface: 'bridge',
        session: {
          id: `powerpoint-${role.toLowerCase()}`,
          gezelId: role.toLowerCase(),
          projectId: 'default',
          providerName: 'llama-cpp',
          title: prompt,
          messages: [{ role: 'user', content: prompt, at: '2026-07-27T00:00:00.000Z' }],
          createdAt: '2026-07-27T00:00:00.000Z',
          lastActivityAt: '2026-07-27T00:00:00.000Z',
        } as ChatSession,
        role,
        mode: 'always',
        provider: 'llama-cpp',
        modelId: 'qwen3.6-27b-q4',
        parameterSize: '27B',
        toolsetsGroupOverride: [],
        githubLinked: false,
        isGitRepo: false,
        tier: 'medium',
        latestUserMessage: prompt,
      });

      expect(projectOrchestrationConstrained).toBe(true);
      expect(allowlist?.has('suggest_craftbook')).toBe(true);
      expect(allowlist?.has('invoke_craftbook')).toBe(true);
      expect(allowlist?.has('message_gezel')).toBe(true);
      expect(allowlist?.has('write_file')).toBe(false);
      expect(allowlist!.size).toBeLessThan(25);
    }
  });

  it('keeps the craftbook authoring surface for reusable-procedure requests', async () => {
    const prompt =
      'Create a reusable weekly procedure for reviewing project quality and invoking the right crew.';
    const { allowlist, projectOrchestrationConstrained } = await resolveSessionToolSurface({
      surface: 'prompt',
      session: {
        id: 'procedure-session',
        gezelId: 'meester',
        projectId: 'default',
        providerName: 'ollama',
        title: prompt,
        messages: [{ role: 'user', content: prompt, at: '2026-07-17T00:00:00.000Z' }],
        createdAt: '2026-07-17T00:00:00.000Z',
        lastActivityAt: '2026-07-17T00:00:00.000Z',
      } as ChatSession,
      role: 'Meester',
      mode: 'always',
      provider: 'ollama',
      modelId: 'deepseek-r1-8b-q4',
      parameterSize: '8B',
      toolsetsGroupOverride: [],
      githubLinked: false,
      isGitRepo: false,
      tier: 'small',
      latestUserMessage: prompt,
    });

    expect(projectOrchestrationConstrained).toBe(false);
    expect(allowlist?.has('suggest_craftbook')).toBe(true);
    expect(allowlist?.has('craftbook_read')).toBe(true);
    expect(allowlist?.has('craftbook_write')).toBe(true);
  });

  // The clamp answers "a user asked a coordinator to BUILD something". A
  // coordinator already assigned a craftbook step was routed by the step
  // itself, and clamping there swaps its write channel for kickoff macros —
  // leaving `message_gezel` as the only survivor, so the model tries to
  // delegate work it was itself handed.
  //
  // Wild-caught on the bundled night-shift oversight step (ornith-9b-q4):
  // the runtime's OWN handoff seed trips `asksForBuild` on "make" and
  // `namesDeliverable` on "tool" — no user request involved. The roster went
  // 10 → 5, `write_artifact` vanished while the step demanded
  // `artifacts/night-shift-report.md`, the Meester invented a `writer` gezel
  // to hand it to, 400'd twice, and advanced the step on a report that was
  // never written.
  it('does not clamp a coordinator executing a step that declares a deliverable', async () => {
    const seed =
      'The previous step has been completed and handed step `oversight` of task default/1 to ' +
      'you. Follow the step instructions already in your prompt — make the first tool call they ' +
      'name this turn. Append focused notes with `write_task_note` as you go so the next gezel ' +
      'can pick up where you left off. When the step is done, call `advance_task_step` to hand ' +
      "off to whoever's next.";
    const clamps: string[] = [];

    const { allowlist, projectOrchestrationConstrained } = await resolveSessionToolSurface({
      surface: 'bridge',
      session: {
        id: 'night-shift-session',
        gezelId: 'linnea',
        projectId: 'default',
        providerName: 'llama-cpp',
        title: '',
        messages: [],
        taskRef: 'default/1',
        stepId: 'oversight',
        createdAt: '2026-08-21T00:00:00.000Z',
        lastActivityAt: '2026-08-21T00:00:00.000Z',
      } as unknown as ChatSession,
      role: 'Meester',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'ornith-9b-q4',
      parameterSize: '9B',
      toolsetsGroupOverride: [],
      githubLinked: false,
      isGitRepo: false,
      tier: 'small',
      activeStep: {
        id: 'oversight',
        name: 'Review active projects',
        prompt: 'write ONE consolidated report to artifacts/night-shift-report.md',
        advanceWhen: { file: 'night-shift-report.md', artifact: true, requireChange: true },
        next: 'oversight',
      } as never,
      latestUserMessage: seed,
      onClamp: (kind) => clamps.push(kind),
    });

    expect(projectOrchestrationConstrained).toBe(false);
    expect(clamps).not.toContain('project-orchestration');
    // The drawer is this step's only write channel — the Meester has no
    // workspace-fs-write group.
    expect(allowlist?.has('write_artifact')).toBe(true);
    expect(allowlist?.has('read_artifact')).toBe(true);
    // Step progression survives, as it did before.
    expect(allowlist?.has('advance_task_step')).toBe(true);
    expect(allowlist?.has('write_task_note')).toBe(true);
  });

  // The exemption is scoped to step execution: ordinary coordinator chat
  // must still route a build request instead of building it.
  it('still clamps a genuine build request outside a step-scoped session', async () => {
    const prompt = 'Build me a tetris game as an HTML app.';
    const { allowlist, projectOrchestrationConstrained } = await resolveSessionToolSurface({
      surface: 'bridge',
      session: {
        id: 'chat-session',
        gezelId: 'linnea',
        projectId: 'default',
        providerName: 'llama-cpp',
        title: prompt,
        messages: [{ role: 'user', content: prompt, at: '2026-08-21T00:00:00.000Z' }],
        createdAt: '2026-08-21T00:00:00.000Z',
        lastActivityAt: '2026-08-21T00:00:00.000Z',
      } as ChatSession,
      role: 'Meester',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'ornith-9b-q4',
      parameterSize: '9B',
      toolsetsGroupOverride: [],
      githubLinked: false,
      isGitRepo: false,
      tier: 'small',
      latestUserMessage: prompt,
    });

    expect(projectOrchestrationConstrained).toBe(true);
    expect(allowlist?.has('write_file')).toBe(false);
  });
});

describe('resolveSessionToolSurface — project retrieval-first route', () => {
  const baseSession = (over: Partial<ChatSession>): ChatSession =>
    ({
      id: 's-retrieval',
      gezelId: 'meester',
      projectId: 'default',
      providerName: 'mlx',
      title: '',
      messages: [],
      createdAt: '2026-07-09T00:00:00.000Z',
      lastActivityAt: '2026-07-09T00:00:00.000Z',
      ...over,
    }) as unknown as ChatSession;

  it('gives a Default-scoped local Meester a handoff route instead of repo-fetch/memory tools', async () => {
    const clamps: string[] = [];
    const prompt =
      'In the "winkelwagen" project there is a bug: gift-voucher discounts come out one cent too high. ' +
      'Find where gift-voucher discounts are applied and reply in chat with the file path, line, and what is wrong. Do not fix anything.';

    const { allowlist } = await resolveSessionToolSurface({
      surface: 'bridge',
      session: baseSession({
        title: prompt,
        messages: [{ role: 'user', content: prompt, at: '2026-07-09T00:00:00.000Z' }],
      }),
      role: 'Meester',
      mode: 'always',
      provider: 'mlx',
      modelId: 'qwen3.5-9b-q4',
      toolsetsGroupOverride: [],
      githubLinked: false,
      isGitRepo: false,
      tier: 'small',
      latestUserMessage: prompt,
      onClamp: (kind) => clamps.push(kind),
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('list_projects')).toBe(true);
    expect(allowlist!.has('ensure_gezel')).toBe(true);
    expect(allowlist!.has('ask_gezel')).toBe(true);
    expect(allowlist!.has('message_gezel')).toBe(true);
    expect(allowlist!.has('search_code')).toBe(false);
    expect(allowlist!.has('grep_files')).toBe(false);
    expect(allowlist!.has('find_symbol')).toBe(false);
    expect(allowlist!.has('fetch_repo')).toBe(false);
    expect(allowlist!.has('start_project')).toBe(false);
    expect(allowlist!.has('search_memory')).toBe(false);
    expect(clamps).toContain('project-retrieval-first');
  });
});

describe('resolveSessionToolSurface — direct file-work retention', () => {
  const baseSession = (over: Partial<ChatSession>): ChatSession =>
    ({
      id: 's1',
      gezelId: 'dev',
      projectId: 'p1',
      providerName: 'llama-cpp',
      title: '',
      messages: [],
      createdAt: '2026-07-05T00:00:00.000Z',
      lastActivityAt: '2026-07-05T00:00:00.000Z',
      ...over,
    }) as unknown as ChatSession;

  it('can keep an expected file deliverable on the compact file-work surface', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      surface: 'bridge',
      session: baseSession({
        expectedDeliverable: { kind: 'file', filePath: 'out/customers.json' },
      }),
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      toolsetsGroupOverride: [],
      githubLinked: false,
      isGitRepo: false,
      tier: 'large',
      latestUserMessage: 'Queued validator note: keep going.',
      forceDirectFileWork: true,
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('read_file')).toBe(true);
    expect(allowlist!.has('read_files')).toBe(true);
    expect(allowlist!.has('write_file')).toBe(true);
    expect(allowlist!.has('run_nodejs_script')).toBe(true);
    expect(allowlist!.has('message_gezel')).toBe(false);
    expect(allowlist!.has('start_project')).toBe(false);
  });

  it('keeps revision prompts for an existing file on the compact edit surface', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      surface: 'bridge',
      session: baseSession({}),
      role: 'Developer',
      mode: 'always',
      provider: 'llama-cpp',
      toolsetsGroupOverride: [],
      githubLinked: false,
      isGitRepo: false,
      tier: 'large',
      latestUserMessage:
        'Revision 2 for `tracker.html`: remove the Add button — adding a habit should happen with the Enter key.',
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('read_file')).toBe(true);
    expect(allowlist!.has('read_files')).toBe(true);
    expect(allowlist!.has('replace_in_file')).toBe(true);
    expect(allowlist!.has('replace_lines')).toBe(true);
    expect(allowlist!.has('write_file')).toBe(true);
    expect(allowlist!.has('message_gezel')).toBe(false);
    expect(allowlist!.has('start_project')).toBe(false);
  });
});

describe('resolveSessionToolSurface — D4 step kit + gate-repair clamp', () => {
  const baseSession = (over: Partial<ChatSession>): ChatSession =>
    ({
      id: 's1',
      gezelId: 'dev',
      projectId: 'p1',
      providerName: 'llama-cpp',
      title: '',
      messages: [],
      createdAt: '2026-07-07T00:00:00.000Z',
      lastActivityAt: '2026-07-07T00:00:00.000Z',
      ...over,
    }) as unknown as ChatSession;

  const baseOpts = {
    surface: 'prompt' as const,
    role: 'Developer',
    mode: 'always' as const,
    provider: 'llama-cpp' as const,
    toolsetsGroupOverride: [] as readonly string[],
    githubLinked: false,
    isGitRepo: false,
    latestUserMessage: 'Continue the step.',
  };

  const reportStep = {
    advanceWhen: { file: 'report.md' },
    gate: {
      at: 'completion' as const,
      checks: [{ kind: 'minBytes' as const, file: 'report.md', bytes: 500 }],
      onReject: 'build',
    },
  };

  it('the kit narrows a Developer report step to the file core + floors', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ taskRef: 'p1/1', stepId: 'build' }),
      tier: 'medium',
      activeStep: reportStep,
    });
    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('write_file')).toBe(true);
    expect(allowlist!.has('replace_in_file')).toBe(true);
    // Floors survive the kit.
    expect(allowlist!.has('advance_task_step')).toBe(true);
    expect(allowlist!.has('validate')).toBe(true);
    expect(allowlist!.has('ask_user_question')).toBe(true);
    // Off-kit breadth drops: a doc step needs no sandbox or delegation.
    expect(allowlist!.has('run_nodejs_script')).toBe(false);
    expect(allowlist!.has('ask_specialist')).toBe(false);
    expect(allowlist!.has('message_gezel')).toBe(false);
  });

  it('keeps source-acquisition tools throughout a Researcher step and gate repair', async () => {
    for (const repairing of [false, true]) {
      const { allowlist } = await resolveSessionToolSurface({
        ...baseOpts,
        role: 'Researcher',
        session: baseSession({ taskRef: 'p1/2', stepId: 'research' }),
        tier: 'medium',
        activeStep: {
          suggestedRole: 'researcher',
          advanceWhen: { file: 'notes/sources.md' },
          gate: {
            at: 'completion',
            checks: [
              { kind: 'minBytes', file: 'notes/sources.md', bytes: 500 },
              {
                kind: 'researchEvidence',
                sourcePath: '',
                tools: ['wikipedia_search', 'fetch_url', 'run_playwright_script'],
                minSuccessful: 1,
              },
            ],
            onReject: 'research',
          },
          ...(repairing
            ? {
                gateAttempts: 1,
                lastGateReject: {
                  at: '2026-07-07T00:00:00Z',
                  message: 'No successful source retrieval was observed.',
                } as never,
              }
            : {}),
        },
      });

      expect(allowlist).not.toBeNull();
      expect(allowlist!.has('wikipedia_search')).toBe(true);
      expect(allowlist!.has('fetch_url')).toBe(true);
      expect(allowlist!.has('run_playwright_script')).toBe(true);
      expect(allowlist!.has('write_file')).toBe(true);
      expect(allowlist!.has('advance_task_step')).toBe(true);
    }
  });

  it('keeps a fixed image-generator tool through a generic task-step kit', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Image generator',
      session: baseSession({
        gezelId: 'image-worker',
        taskRef: 'p1/2',
        stepId: 'build',
      }),
      tier: 'large',
      requiredTool: 'generate_image',
      activeStep: {
        advanceWhen: { file: 'sunset.png' },
        gate: {
          at: 'completion',
          checks: [{ kind: 'minBytes', file: 'sunset.png', bytes: 100 }],
          onReject: 'build',
        },
      },
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('generate_image')).toBe(true);
  });

  it('kit narrowing skips on toolset override and on mode never', async () => {
    const withOverride = await resolveSessionToolSurface({
      ...baseOpts,
      toolsetsGroupOverride: ['workspace-fs-read', 'workspace-fs-write', 'code-execution'],
      session: baseSession({ taskRef: 'p1/1', stepId: 'build' }),
      tier: 'medium',
      activeStep: reportStep,
    });
    expect(withOverride.allowlist?.has('run_nodejs_script')).toBe(true);

    const neverMode = await resolveSessionToolSurface({
      ...baseOpts,
      mode: 'never' as const,
      session: baseSession({ taskRef: 'p1/1', stepId: 'build' }),
      tier: 'medium',
      activeStep: reportStep,
    });
    // 'never' opts out of role reduction; gates may still shape the
    // surface, but the kit must not narrow it.
    expect(neverMode.allowlist?.has('run_nodejs_script') ?? true).toBe(true);
  });

  // Wild-caught (koray, gezel/2 "Pull Request Review", 2026-08-10): the
  // `scope` step called github_pr_* successfully with 102 tools, then the
  // `report` step dispatched with 38 and none of the tools its own first
  // action mandated. The deliverable-class kit is authored around file
  // work; it cannot know a review step must read the PR first.
  const prReviewStep = {
    prompt: [
      'Use the PR number selected in the Scope note. Call `github_pr_diff` for the complete unified diff and `github_pr_files` for the per-file patches. Use `read_file` only when you need surrounding workspace context.',
      '',
      'Do not modify source and do not call `github_pr_comment`; the user asked for a review report, not a public side effect.',
    ].join('\n'),
    advanceWhen: { file: 'pr-review.md', minBytes: 500 },
    gate: {
      at: 'completion' as const,
      checks: [
        { kind: 'minBytes' as const, file: 'pr-review.md', bytes: 500 },
        {
          kind: 'tableShape' as const,
          file: 'pr-review.md',
          requiredColumns: ['Severity', 'File', 'Finding'],
        },
      ],
      onReject: 'report',
    },
  };

  it('a step keeps the repo tools its own procedure mandates', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Reviewer',
      githubLinked: true,
      isGitRepo: true,
      session: baseSession({ taskRef: 'p1/2', stepId: 'report' }),
      tier: 'medium',
      activeStep: prReviewStep,
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('github_pr_diff')).toBe(true);
    expect(allowlist!.has('github_pr_files')).toBe(true);
    // The procedure explicitly forbids commenting — a negative mention is
    // not a mandate, so the kit still drops it.
    expect(allowlist!.has('github_pr_comment')).toBe(false);
    // Everything the kit itself provides is untouched.
    expect(allowlist!.has('write_file')).toBe(true);
    expect(allowlist!.has('read_file')).toBe(true);
    expect(allowlist!.has('advance_task_step')).toBe(true);
  });

  it('a mandate cannot resurrect what the security/workspace ceiling removed', async () => {
    // Same procedure, writes-off project: `write_file` was stripped before
    // the kit intersection and must stay stripped. The mandate widening is
    // an intersection over an already-filtered surface, never a re-grant.
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Reviewer',
      githubLinked: true,
      isGitRepo: true,
      workspaceWritable: false,
      session: baseSession({ taskRef: 'p1/2', stepId: 'report' }),
      tier: 'medium',
      activeStep: prReviewStep,
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('write_file')).toBe(false);
    expect(allowlist!.has('write_artifact')).toBe(true);
    expect(allowlist!.has('read_file')).toBe(true);
    expect(allowlist!.has('read_files')).toBe(true);
    expect(allowlist!.has('list_dir')).toBe(true);
  });

  it("keeps a voorman's workspace readers when managed writes are off", async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Voorman',
      workspaceWritable: false,
      session: baseSession({}),
      tier: 'medium',
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('write_file')).toBe(false);
    expect(allowlist!.has('read_file')).toBe(true);
    expect(allowlist!.has('read_files')).toBe(true);
    expect(allowlist!.has('list_dir')).toBe(true);
    expect(allowlist!.has('grep_files')).toBe(true);
  });

  it('does not offer a project voorman escalation tools that target themselves', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Reviewer',
      rolesAsTools: true,
      isProjectVoorman: true,
      session: baseSession({}),
      tier: 'medium',
    });

    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('delegate_voorman')).toBe(false);
    expect(allowlist!.has('consult_voorman')).toBe(false);
    expect(allowlist!.has('delegate_meester')).toBe(true);
    expect(allowlist!.has('consult_meester')).toBe(true);
  });

  it('a github mandate stays stripped when the project has no repo linked', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Reviewer',
      githubLinked: false,
      session: baseSession({ taskRef: 'p1/2', stepId: 'report' }),
      tier: 'medium',
      activeStep: prReviewStep,
    });
    expect(allowlist!.has('github_pr_diff')).toBe(false);
  });

  it('GEZEL_DISABLE_STEP_TOOL_KIT=1 leaves the full role surface', async () => {
    process.env.GEZEL_DISABLE_STEP_TOOL_KIT = '1';
    try {
      const { allowlist } = await resolveSessionToolSurface({
        ...baseOpts,
        session: baseSession({ taskRef: 'p1/1', stepId: 'build' }),
        tier: 'medium',
        activeStep: reportStep,
      });
      expect(allowlist?.has('run_nodejs_script')).toBe(true);
    } finally {
      delete process.env.GEZEL_DISABLE_STEP_TOOL_KIT;
    }
  });

  it('a rejected gate forces the repair clamp with onClamp telemetry, without any message marker', async () => {
    const clamps: string[] = [];
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ taskRef: 'p1/1', stepId: 'build' }),
      tier: 'medium',
      activeStep: {
        ...reportStep,
        gateAttempts: 1,
        lastGateReject: { at: '2026-07-07T00:00:00Z', message: 'too small' } as never,
      },
      onClamp: (kind) => clamps.push(kind),
    });
    expect(clamps).toContain('gate-repair');
    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('write_file')).toBe(true);
    expect(allowlist!.has('replace_in_file')).toBe(true);
    // Repair surface drops everything outside file-core + floors.
    expect(allowlist!.has('list_dir')).toBe(true);
    expect(allowlist!.has('make_dir')).toBe(false);
  });

  it('gateAttemptHistory alone (post-bump reset) keeps the clamp — the widen-back fix', async () => {
    const clamps: string[] = [];
    await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ taskRef: 'p1/1', stepId: 'build' }),
      tier: 'medium',
      activeStep: {
        ...reportStep,
        gateAttemptHistory: [{ at: 'T', signature: 'x' }] as never,
      },
      onClamp: (kind) => clamps.push(kind),
    });
    expect(clamps).toContain('gate-repair');
  });

  it('the ad-hoc deliverableGatePlateau clamps a no-step session', async () => {
    const clamps: string[] = [];
    await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ deliverableGatePlateau: { count: 2 } as never }),
      tier: 'medium',
      onClamp: (kind) => clamps.push(kind),
    });
    expect(clamps).toContain('gate-repair');
  });

  it('a completed step (approve) lifts the clamp', async () => {
    const clamps: string[] = [];
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ taskRef: 'p1/1', stepId: 'build' }),
      tier: 'medium',
      activeStep: {
        ...reportStep,
        gateAttempts: 2,
        completedAt: '2026-07-07T01:00:00Z',
      },
      onClamp: (kind) => clamps.push(kind),
    });
    expect(clamps).not.toContain('gate-repair');
    expect(allowlist!.has('write_file')).toBe(true);
  });

  it('starvation guard: a role with no mutation tool on its surface skips the clamp', async () => {
    const clamps: string[] = [];
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      role: 'Meester',
      // No step scope → no STEP_COMPLETION grant; meester kit is
      // tasks-readonly with no write_file.
      session: baseSession({ deliverableGatePlateau: { count: 1 } as never }),
      tier: 'medium',
      latestUserMessage: 'How are the projects doing?',
      onClamp: (kind) => clamps.push(kind),
    });
    expect(clamps).not.toContain('gate-repair');
    expect(allowlist!.has('list_projects')).toBe(true);
  });

  it('a data step keeps derive_file under the tiny cap (deliverable-aware priority)', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: baseSession({ taskRef: 'p1/1', stepId: 'build' }),
      tier: 'tiny',
      activeStep: {
        advanceWhen: { file: 'out/rows.csv', sniff: 'data-table' as const },
        gate: {
          at: 'completion' as const,
          checks: [{ kind: 'minBytes' as const, file: 'out/rows.csv', bytes: 120 }],
          onReject: 'build',
        },
      },
    });
    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('derive_file')).toBe(true);
    expect(allowlist!.has('run_nodejs_script')).toBe(true);
  });
});

/**
 * The count cap and the kit clamp are two different narrowings, and only
 * the clamp consulted the step's own procedure — so whether a step could
 * call the tool its text named depended on which one happened to bind.
 * Both now read the same signal.
 *
 * The tool under test is the one powerpoint-deck `publish` step 5 names:
 * DocBlocks can write only to the artifacts root, so
 * `copy_artifact_to_workspace` is the sole route to the requested
 * workspace path, and a roster without it leaves the step unable to
 * comply (ADR 0001's failure reached from the opposite side).
 */
describe('the count cap keeps what the active step positively instructs', () => {
  const WIDE_GROUPS = [
    'memory',
    'workspace-fs-read',
    'workspace-fs-write',
    'tasks',
    'craftbooks',
    'team-management',
    'artifacts',
    'documents',
    'code-execution',
    'web',
    'archives',
  ];

  const surfaceWithStepPrompt = async (prompt: string): Promise<Set<string>> => {
    const { allowlist } = await resolveSessionToolSurface({
      surface: 'bridge',
      session: {
        id: 'publish-session',
        gezelId: 'meester',
        projectId: 'p1',
        providerName: 'llama-cpp',
        title: '',
        messages: [],
        createdAt: '2026-08-26T00:00:00.000Z',
        lastActivityAt: '2026-08-26T00:00:00.000Z',
      } as unknown as ChatSession,
      role: 'Meester',
      mode: 'always',
      provider: 'llama-cpp',
      modelId: 'gemma4:e4b',
      toolsetsGroupOverride: WIDE_GROUPS,
      githubLinked: false,
      isGitRepo: false,
      tier: 'small',
      latestUserMessage: undefined,
      activeStep: {
        prompt,
        advanceWhen: { file: 'powerpoint/task-8/deck.pptx', minBytes: 1 },
      },
    } as never);
    expect(allowlist).not.toBeNull();
    return allowlist!;
  };

  const MANDATES =
    'Call `copy_artifact_to_workspace` with source `"tasks/8/deck.pptx"` and dest `"powerpoint/task-8/deck.pptx"` so the user receives the exact requested workspace file without a text/binary round-trip.';
  const SILENT = 'Publish the reviewed deck and record the result in the task notes.';

  it('keeps a step-mandated tool the cap would otherwise evict', async () => {
    expect((await surfaceWithStepPrompt(MANDATES)).has('copy_artifact_to_workspace')).toBe(true);
  });

  it('control: the same tool is evicted when no step instructs it', async () => {
    expect((await surfaceWithStepPrompt(SILENT)).has('copy_artifact_to_workspace')).toBe(false);
  });
});
