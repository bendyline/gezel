import type { ChatSession } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSessionToolSurface, toolCapForTierAndRole } from './session-tool-surface.js';

/**
 * Pins the tier x role cap table. History that makes this worth a direct
 * test: the count-cap repeatedly rendered coordinator gezels inoperable by
 * evicting load-bearing tools while keeping incidental reads (the imara
 * office-hours kickoff loop,, was the 4th such incident). The
 * policy is now: small coordinators are capped to their complete curated
 * surface, while medium/large roles keep their full kit by default. The
 * opt-in coordinator diet remains covered independently. Implementation
 * roles keep their broad workbench.
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
    expect(allowlist!.has('run_script')).toBe(true);
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
    expect(allowlist!.has('search_files')).toBe(false);
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
