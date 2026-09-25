import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { createFanoutWorker } from './fanout-shared.ts';

const PROJECT = 'Molen structure workshop eval';
const TITLE = 'Research, build and review a school and the Space Needle';
const molen = resolve(
  process.env.MOLEN_REPO ?? fileURLToPath(new URL('../../../../molen-internal', import.meta.url)),
);
const run = '.artifacts/structure-workshop/eval';

interface WorkshopCase {
  title: string;
  ids: readonly string[];
  fixture: string;
  about: string;
  mission: string;
  task: string;
}

const originalCase: WorkshopCase = {
  title: TITLE,
  ids: ['brick-school', 'space-needle'],
  fixture: 'requests.json',
  about:
    'Use the project-local structure-workshop craftbook. Offline references are frozen photographs. Preserve the two seeded requests and fixture references. The geometry, visual observations and review must be your own work.',
  mission:
    'Deliver a textured school and Space Needle through real child tasks, inspect actual photos and rendered views, reject weak models, and retain all revisions.',
  task: `Use the actual structure-workshop craftbook to process the two seeded building requests at ${run}/requests.json. Retain fixture references, generate both models, inspect them and repair until accepted or the three-attempt limit is exhausted.`,
};

// Selection is frozen by the scenario, never inferred from model-writable files.
export function selectWorkshopRequests<T extends { id: string }>(
  data: { requests: T[] },
  ids: readonly string[],
): { requests: T[] } {
  assert(ids.length > 0 && new Set(ids).size === ids.length, 'Unique request ids required');
  return {
    requests: ids.map((id) => {
      const matches = data.requests.filter((request) => request.id === id);
      assert(matches.length === 1, `Expected exactly one fixture request: ${id}`);
      return matches[0]!;
    }),
  };
}

export function assertWorkshopOutputs(ids: readonly string[], rows: { id: string }[]): void {
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    [...ids].sort(),
    'Collected assets must match every seeded request exactly',
  );
}

async function setup(ctx: EvalContext, prepared = false, testCase = originalCase) {
  // Copy the actual project craftbook; frozen photos replace live search only.
  // The compiler runs unchanged against built Molen packages. No reference recipes
  // are copied: producing the geometry remains the model's task.
  const workspace = await mkdtemp(join(tmpdir(), 'molen-workshop-eval-'));
  for (const path of [
    '.gezel/craftbooks/structure-workshop',
    'scripts/structure-workshop/README.md',
    'docs-src/guide/3d-art-guidelines.md',
  ]) {
    await mkdir(resolve(workspace, path, '..'), { recursive: true });
    await cp(join(molen, path), join(workspace, path), { recursive: true });
  }
  await mkdir(join(workspace, run), { recursive: true });
  const fixture = join(molen, 'scripts/structure-workshop/fixtures', testCase.fixture);
  const data = selectWorkshopRequests(JSON.parse(await readFile(fixture, 'utf8')), testCase.ids);
  if (testCase === originalCase) {
    // Preserve the original two-asset baseline's input bytes for clean retries.
    await cp(fixture, join(workspace, run, 'requests.json'));
  } else {
    await writeFile(join(workspace, run, 'requests.json'), `${JSON.stringify(data, null, 2)}\n`);
  }
  if (prepared) {
    // Explicit ablation: isolate visual modelling from research orchestration.
    // Run the real preparation code; never seed recipes or review answers.
    const pipeline = await import(
      pathToFileURL(join(molen, 'scripts/structure-workshop/pipeline.mjs')).href
    );
    await pipeline.prepare(join(workspace, run));
    ctx.log('[molen-workshop] prepared-input ablation: research orchestration excluded');
  }
  // A fixed, trusted package command is the real Gezel command-consent path.
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify(
      {
        name: 'molen-workshop-eval',
        private: true,
        scripts: {
          'structure:workshop': `node ${JSON.stringify(join(molen, 'scripts/structure-workshop/cli.mjs'))}`,
        },
      },
      null,
      2,
    ),
  );
  const project = await ctx.client.createProject({
    name: PROJECT,
    workingDir: workspace,
    about: testCase.about,
    missionObjectives: testCase.mission,
  });
  await ctx.client.updateProject(project.id, {
    nudgeConfig: { enabled: false },
    // This disposable external workspace is the authorized eval jobsite.
    // External projects default to read-only for managed local tools.
    managedWorkspaceWritePolicy: 'allow',
  });
  const worker = await createFanoutWorker(ctx, project.id, {
    name: 'Structure workshop builder',
    role: 'Builder',
    description: 'Authors and inspects stylized architectural models.',
    about:
      'You build recognizable polygonal buildings from photographs. Follow the current craftbook step, perform the work with tools, inspect images honestly, and advance when its evidence is ready. Preserve seeded offline request and reference data. Report inability to see images instead of inventing observations.',
  });
  for (const id of ['builtin.code-execution', 'builtin.images', 'builtin.web']) {
    await ctx.client.installToolset(id, { scope: { kind: 'gezel', gezelId: worker } });
  }
  for (const id of [
    'workspace-fs-read',
    'workspace-fs-write',
    'code-execution',
    'images',
    'tasks',
    'web',
  ]) {
    await ctx.client.installToolset(`builtin.${id}`, {
      scope: { kind: 'project', projectId: project.id },
    });
  }
  const task = await ctx.client.createTask(project.id, {
    title: testCase.title,
    description: testCase.task,
    craftbookId: 'structure-workshop',
    craftbookParams: { runId: 'eval' },
    assignee: { kind: 'gezel', gezelId: worker },
    dispatchEntry: !prepared,
  });
  if (prepared) await ctx.client.completeTaskStep(project.id, task.num, 'research', {});
  ctx.log(`[molen-workshop] ${task.ref} workspace=${workspace}`);
}

async function successCheck(
  ctx: EvalContext,
  testCase = originalCase,
): Promise<SuccessCheckResult> {
  const { projects } = await ctx.client.listProjects();
  const project = projects.find((p) => p.name === PROJECT);
  if (!project?.workingDir) return { done: false };
  const { tasks } = await ctx.client.listProjectTasks(project.id);
  const host = tasks.find((t) => t.title === testCase.title && !t.parentTaskRef);
  if (!host) return { done: false };
  // The harness is the user for this one trusted command only. Do not approve
  // model-invented scripts or unrelated questions.
  const { questions } = await ctx.client.listQuestions({ projectId: project.id, pending: true });
  for (const q of questions) {
    if (q.intent?.kind === 'command-approval' && q.intent.name === 'structure:workshop') {
      await ctx.client.answerQuestion(q.id, { selectedChoices: [0] });
      ctx.log('[molen-workshop] approved structure:workshop command');
    }
  }
  const { tasks: children } = await ctx.client.listTaskChildren(project.id, host.num, {
    limit: 100,
  });
  let built = 0;
  for (const id of testCase.ids) {
    try {
      await readFile(join(project.workingDir, run, id, 'build.json'));
      built++;
    } catch {
      /* pending */
    }
  }
  const completed = children.filter((c) => c.status === 'complete').length;
  ctx.recordSniff?.({
    key: 'molen-workshop',
    score: built + completed,
    bytes: built * 1000,
    milestones: built + completed,
    deliverableMissing: built === 0,
  });
  ctx.logChanged(
    'molen-workshop',
    `[molen-workshop] host=${host.status}:${host.activeStepId} children=${completed}/${children.length} built=${built}/${testCase.ids.length}`,
  );
  if (
    host.status === 'paused' ||
    host.status === 'canceled' ||
    children.some((c) => c.status === 'paused' || c.status === 'canceled')
  ) {
    return {
      done: true,
      success: false,
      reason:
        'Workshop paused or exhausted its bounded repair loop; inspect task notes and compiler logs.',
      diagnostics: {
        workspace: project.workingDir,
        children: children.map((c) => ({ ref: c.ref, status: c.status, step: c.activeStepId })),
      },
    };
  }
  if (host.status !== 'complete') return { done: false };
  if (children.length !== testCase.ids.length || completed !== testCase.ids.length)
    return {
      done: true,
      success: false,
      reason: `Expected ${testCase.ids.length} completed model child tasks.`,
    };
  // Re-run the real validator. File existence and model-authored "PASS" text
  // cannot approve stale/missing GLBs, textures, screenshots or review data.
  try {
    const pipeline = await import(
      pathToFileURL(join(molen, 'scripts/structure-workshop/pipeline.mjs')).href
    );
    const rows = await pipeline.collect(join(project.workingDir, run));
    assertWorkshopOutputs(testCase.ids, rows);
    const { entries } = await ctx.client.listHistory({
      projectId: project.id,
      kind: 'tool.called',
      limit: 2000,
    });
    const viewed = entries.filter(
      (e) =>
        e.entryType === 'event' &&
        e.details?.name === 'read_image_as_base64' &&
        e.details?.success === true,
    );
    const viewedPaths = new Set(
      viewed.flatMap((e) => {
        if (e.entryType !== 'event') return [];
        const path = e.details?.path;
        return typeof path === 'string' ? [resolve(project.workingDir!, path)] : [];
      }),
    );
    const expectedPaths: string[] = [];
    for (const id of testCase.ids) {
      const dir = join(project.workingDir, run, id);
      const brief = JSON.parse(await readFile(join(dir, 'brief.json'), 'utf8'));
      const build = JSON.parse(await readFile(join(dir, 'build.json'), 'utf8'));
      for (const item of [...brief.references, ...build.images])
        expectedPaths.push(resolve(dir, item.path));
    }
    const missingViews = expectedPaths.filter((path) => !viewedPaths.has(path));
    if (missingViews.length > 0)
      return {
        done: true,
        success: false,
        reason: `Missing actual image-read receipts for ${missingViews.length} current reference/rendered images. Repeated reads and base64 text do not count.`,
        diagnostics: { workspace: project.workingDir, missingViews },
      };
    return {
      done: true,
      success: true,
      reason: `${testCase.ids.length} model children produced current textured GLBs, eight views each, image-read receipts and passing reviews.`,
      diagnostics: { workspace: project.workingDir, rows, imageReadReceipts: viewed.length },
    };
  } catch (error) {
    return {
      done: true,
      success: false,
      reason: `Final asset validation failed: ${String(error)}`,
      diagnostics: { workspace: project.workingDir },
    };
  }
}

export const molenStructureWorkshopScenario: EvalScenario = {
  id: 'molen-structure-workshop',
  description:
    'Actual Molen project craftbook: frozen reference photos → per-building fanout → model-authored geometry → textured GLB → visual review and bounded repair. Requires built sibling molen-internal; no live research in this repeatable probe.',
  prompt: TITLE,
  skipInitialPrompt: true,
  setup: (ctx) => setup(ctx),
  successCheck: (ctx) => successCheck(ctx),
  timeoutMs: 90 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  repairPolicy: 'runtime',
  suggestedTrials: 1,
};

export const molenStructureAssetsScenario: EvalScenario = {
  ...molenStructureWorkshopScenario,
  id: 'molen-structure-workshop-assets',
  description:
    'Prepared-input ablation of the Molen workshop: actual reference inspection, geometry, textures, child tasks and review; excludes the parent research/preparation step. No model recipes are seeded.',
  setup: (ctx) => setup(ctx, true),
};

function singleAssetScenario(id: string, title: string, fixture: string): EvalScenario {
  const testCase: WorkshopCase = {
    title: `Build and review ${title}`,
    ids: [id],
    fixture,
    about:
      'Use the project-local structure-workshop craftbook. Offline references are frozen photographs. Preserve the seeded request and fixture references. The geometry, visual observations and review must be your own work.',
    mission: `Deliver a textured model of ${title} through a real child task, inspect actual photos and all rendered views, reject weak models, and retain all revisions. Follow docs-src/guide/3d-art-guidelines.md.`,
    task: `Use the actual structure-workshop craftbook to process the single seeded request at ${run}/requests.json. Retain fixture references, generate the model, inspect it and repair until accepted or the three-attempt limit is exhausted.`,
  };
  return {
    ...molenStructureAssetsScenario,
    id: `molen-structure-${id}`,
    description: `Standalone prepared-input workshop evaluation: ${title}. Actual photograph inspection, model-authored geometry, textured GLB, eight views and bounded visual repair. No geometry answers are seeded.`,
    prompt: testCase.title,
    setup: (ctx) => setup(ctx, true, testCase),
    successCheck: (ctx) => successCheck(ctx, testCase),
  };
}

export const molenSpaceNeedleScenario = singleAssetScenario(
  'space-needle',
  'the Seattle Space Needle',
  'requests.json',
);
export const molenFootballStadiumScenario = singleAssetScenario(
  'football-stadium',
  'a medium-size American football stadium',
  'requests-stadium.json',
);
