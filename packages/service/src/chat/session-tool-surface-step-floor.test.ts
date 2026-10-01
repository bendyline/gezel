import type { ChatSession } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { resolveSessionToolSurface } from './session-tool-surface.js';

/**
 * A message-shaped clamp must never strip a craftbook step's own writer or
 * the tools its procedure names. The clamps list WORKSPACE writers, and an
 * artifact-medium step has already lost `workspace-fs-write` to its policy,
 * so clamp ∩ roster was readers only: a bug-fix-tdd `reproduce` session fell
 * to 8 tools (no `write_artifact`, no `run_package_script`) after a harness
 * "[scenario check]" message, paused itself as blocked, and could never
 * resume (2026-09-30).
 */
describe('resolveSessionToolSurface — step floor survives message clamps', () => {
  const session = (over: Partial<ChatSession>): ChatSession =>
    ({
      id: 's-floor',
      gezelId: 'heilani',
      projectId: 'orderly-pricing',
      providerName: 'llama-cpp',
      title: '',
      messages: [],
      createdAt: '2026-09-30T00:00:00.000Z',
      lastActivityAt: '2026-09-30T00:00:00.000Z',
      ...over,
    }) as unknown as ChatSession;

  const baseOpts = {
    surface: 'bridge' as const,
    role: 'Developer',
    mode: 'always' as const,
    provider: 'llama-cpp' as const,
    toolsetsGroupOverride: [] as readonly string[],
    githubLinked: false,
    isGitRepo: false,
    tier: 'medium' as const,
  };

  // The shape of bug-fix-tdd 2.0.4 `reproduce`: the result is an artifact,
  // the workspace writers are denied, and the procedure mandates the suite run.
  const reproduceStep = {
    name: 'Reproduce',
    prompt:
      'Find how this project runs its tests (`list_package_scripts`). Then run the suite with `run_package_script` (`test`) and confirm it FAILS. Write `tasks/1/repro.md` in the artifacts drawer with `write_artifact`.',
    advanceWhen: { file: 'tasks/1/repro.md', minBytes: 500, artifact: true },
    toolPolicy: {
      outputMedium: 'artifact' as const,
      disallowBuiltinToolsets: ['web', 'images', 'workspace-fs-write'],
    },
  };

  const scenarioCheck =
    '[scenario check] `tasks/1/repro.md` still fails 2 checks: the Symptom section check failed. Fix the existing file.';
  const directKick =
    'Direct kick from the eval harness: write the deliverable to `tasks/1/repro.md` with write_file. Do not call more read-only tools.';

  it('keeps write_artifact and the mandated run_package_script under the scenario-file-repair clamp', async () => {
    const clamps: string[] = [];
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: session({ taskRef: 'orderly-pricing/1', stepId: 'reproduce' }),
      latestUserMessage: scenarioCheck,
      activeStep: reproduceStep,
      onClamp: (kind) => clamps.push(kind),
    });
    expect(clamps).toContain('scenario-file-repair');
    expect(allowlist).not.toBeNull();
    expect(allowlist!.has('write_artifact')).toBe(true);
    expect(allowlist!.has('run_package_script')).toBe(true);
    // The clamp still does its job on everything the step did not ask for.
    expect(allowlist!.has('write_file')).toBe(false);
    expect(allowlist!.has('search')).toBe(false);
  });

  it('keeps write_artifact and the mandated run_package_script under the direct-file-work clamp', async () => {
    const clamps: string[] = [];
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: session({ taskRef: 'orderly-pricing/1', stepId: 'reproduce' }),
      latestUserMessage: directKick,
      activeStep: reproduceStep,
      forceDirectFileWork: true,
      onClamp: (kind) => clamps.push(kind),
    });
    expect(clamps).toContain('direct-file-work');
    expect(allowlist!.has('write_artifact')).toBe(true);
    expect(allowlist!.has('run_package_script')).toBe(true);
    expect(allowlist!.has('write_file')).toBe(false);
  });

  it('restores the workspace writer for a workspace-medium step', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: session({ taskRef: 'p1/2', stepId: 'build' }),
      latestUserMessage:
        'Your next and only action must be `read_file({ path: "src/app.js" })`. Then continue.',
      activeStep: {
        name: 'Build',
        prompt: 'Build the app.',
        advanceWhen: { file: 'src/app.js', minBytes: 200 },
        toolPolicy: { outputMedium: 'workspace' as const },
      },
    });
    expect(allowlist!.has('read_file')).toBe(true);
    expect(allowlist!.has('write_file')).toBe(true);
    expect(allowlist!.has('write_artifact')).toBe(false);
  });

  it('never adds a writer or mandated tool the raw allowlist does not hold', async () => {
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: session({ taskRef: 'orderly-pricing/1', stepId: 'reproduce' }),
      latestUserMessage: scenarioCheck,
      activeStep: {
        ...reproduceStep,
        toolPolicy: {
          ...reproduceStep.toolPolicy,
          disallowTools: ['write_artifact', 'run_package_script'],
        },
      },
    });
    expect(allowlist!.has('write_artifact')).toBe(false);
    expect(allowlist!.has('run_package_script')).toBe(false);
  });

  it('leaves a session outside a task step exactly as the clamp left it', async () => {
    const clamps: string[] = [];
    const { allowlist } = await resolveSessionToolSurface({
      ...baseOpts,
      session: session({}),
      latestUserMessage: scenarioCheck,
      onClamp: (kind) => clamps.push(kind),
    });
    expect(clamps).toContain('scenario-file-repair');
    expect(allowlist!.has('write_artifact')).toBe(false);
    expect(allowlist!.has('run_package_script')).toBe(false);
    expect(allowlist!.has('advance_task_step')).toBe(false);
  });
});
