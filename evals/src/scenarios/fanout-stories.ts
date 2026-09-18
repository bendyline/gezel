import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import {
  createFanoutWorker,
  fanoutDiagnostics,
  findFanoutState,
  readWorkspaceText,
  reviewHostSessions,
} from './fanout-shared.ts';

/**
 * Hermetic declarative fanout, prose flavour: one host task fans out to five
 * child tasks (one story each), the host is held by the fanout barrier until
 * the last child settles, then collects the stories into an anthology. Cheap
 * enough to run on a local model in both execution modes.
 *
 * Grades fanout MECHANICS, not prose quality: exactly N children spawned and
 * completed, each story written by its own child, the host writing NO story
 * itself (the crew's work done by the wrong hands is the generalist-mode
 * failure this exists to catch), the host's first activity after the last
 * child settled (barrier held), and the anthology covering every story.
 */

const PROJECT_NAME = 'Fanout Stories Eval';
const HOST_TITLE = 'Write five short stories and collect them';
const WORKER_NAME = 'Fanout Stories Writer';
const STORY_MIN_BYTES = 1_200;
const ANTHOLOGY_MIN_BYTES = 600;

export const FANOUT_STORY_TOPICS = [
  { slug: 'lighthouse', topic: 'a lighthouse keeper who hears the sea stop' },
  { slug: 'clockmaker', topic: 'a clockmaker whose clocks run a day ahead' },
  { slug: 'market', topic: 'a night market that sells forgotten names' },
  { slug: 'glacier', topic: 'two surveyors mapping a glacier that moves toward them' },
  { slug: 'orchard', topic: 'an orchard that fruits only when someone leaves' },
] as const;

async function setup(ctx: EvalContext): Promise<void> {
  const project = await ctx.client.createProject({
    name: PROJECT_NAME,
    about:
      'A hermetic fanout exercise: one host task spawns one child task per story topic, then collects the stories into an anthology.',
    missionObjectives:
      'Every child writes its own story into stories/; the host writes only anthology.md after all children have finished.',
  });
  const workerId = await createFanoutWorker(ctx, project.id, {
    name: WORKER_NAME,
    role: 'Copywriter',
    description: 'Writes short stories and collects them into anthologies.',
    about:
      'You write tight, original short fiction and you keep to the brief. When a task step names a file, write exactly that file, then advance the step.',
  });
  const task = await ctx.client.createTask(project.id, {
    title: HOST_TITLE,
    description:
      'Fan out one child task per story topic; each child writes one story into stories/. When every child has finished, collect the stories into anthology.md.',
    assignee: { kind: 'gezel', gezelId: workerId },
    steps: [
      {
        id: 'collect',
        name: 'Collect the anthology',
        description: 'Runs after every story child has finished.',
        prompt:
          'Five short stories were written by child tasks into `stories/` (one file per story). Call `list_dir` on `stories/`, read each story with `read_file`, then call `write_file` to write `anthology.md`: a `# Anthology` heading, then one `## ` section per story that names the story file, gives its approximate word count, and summarizes it in two sentences. Do not write or rewrite any story yourself. When `anthology.md` covers every story, call `advance_task_step`.',
        terminal: true,
      },
    ],
    entryStepId: 'collect',
    spawnsSteps: [
      {
        id: 'write',
        name: 'Write story: {{topic}}',
        description: 'One story, one file.',
        prompt:
          'Write an original short story of 300 to 600 words about {{topic}}. Call `write_file` to save it to `stories/{{slug}}.md`, starting with a `# ` title line. Then call `advance_task_step` to finish this task.',
        terminal: true,
      },
    ],
    fanout: {
      count: FANOUT_STORY_TOPICS.length,
      variations: FANOUT_STORY_TOPICS.map((t) => ({
        title: `Story: ${t.topic}`,
        context: { topic: t.topic, slug: t.slug },
      })),
    },
  });
  ctx.log(
    `[fanout-stories] created fanout host ${task.ref} with ${FANOUT_STORY_TOPICS.length} children for worker ${workerId}`,
  );
}

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const state = await findFanoutState(ctx.client, PROJECT_NAME, HOST_TITLE);
  if (!state) return { done: false };
  const { project, host, children } = state;

  const stories: Array<{ slug: string; text: string | null }> = [];
  for (const { slug } of FANOUT_STORY_TOPICS) {
    stories.push({
      slug,
      text: await readWorkspaceText(ctx.client, project.id, `stories/${slug}.md`),
    });
  }
  const storiesPresent = stories.filter(
    (s) => (s.text?.length ?? 0) >= STORY_MIN_BYTES && s.text!.trimStart().startsWith('# '),
  ).length;
  const anthology = await readWorkspaceText(ctx.client, project.id, 'anthology.md');
  const anthologyBytes = anthology?.length ?? 0;
  const completedChildren = children.filter((c) => c.status === 'complete').length;
  const hostDone = host.status === 'complete';

  ctx.recordSniff?.({
    key: 'fanout-stories',
    score: storiesPresent + (anthologyBytes >= ANTHOLOGY_MIN_BYTES ? 1 : 0),
    bytes: anthologyBytes,
    milestones: completedChildren + storiesPresent + (hostDone ? 1 : 0),
    deliverableMissing: anthologyBytes === 0,
    ...(storiesPresent < FANOUT_STORY_TOPICS.length
      ? { failReason: `${storiesPresent}/${FANOUT_STORY_TOPICS.length} stories present` }
      : {}),
  });
  ctx.logChanged(
    'fanout-stories',
    `[fanout-stories] host=${host.status}:${host.activeStepId ?? '-'} children=${completedChildren}/${children.length} stories=${storiesPresent}/${FANOUT_STORY_TOPICS.length} anthology=${anthologyBytes}B checks=${storiesPresent + (anthologyBytes > 0 ? 1 : 0)}/${FANOUT_STORY_TOPICS.length + 1}`,
  );

  if (host.status === 'paused' || host.status === 'canceled') {
    return {
      done: true,
      success: false,
      reason: `fanout host ${host.ref} is ${host.status} with ${completedChildren}/${children.length} children complete`,
    };
  }
  if (!hostDone) return { done: false };

  const failures: string[] = [];
  if (children.length !== FANOUT_STORY_TOPICS.length) {
    failures.push(`fanout created ${children.length}/${FANOUT_STORY_TOPICS.length} children`);
  }
  const unfinished = children.filter((c) => c.status !== 'complete');
  if (unfinished.length > 0) failures.push(`${unfinished.length} child task(s) did not complete`);
  for (const story of stories) {
    if (!story.text) failures.push(`stories/${story.slug}.md is missing`);
    else if (story.text.length < STORY_MIN_BYTES)
      failures.push(`stories/${story.slug}.md is ${story.text.length}B (< ${STORY_MIN_BYTES})`);
    else if (!story.text.trimStart().startsWith('# '))
      failures.push(`stories/${story.slug}.md does not start with a # title`);
  }
  if (!anthology) failures.push('anthology.md is missing');
  else {
    if (anthology.length < ANTHOLOGY_MIN_BYTES)
      failures.push(`anthology.md is ${anthology.length}B (< ${ANTHOLOGY_MIN_BYTES})`);
    for (const { slug } of FANOUT_STORY_TOPICS) {
      if (!anthology.includes(slug)) failures.push(`anthology.md does not mention ${slug}`);
    }
  }

  // Receipts: each story written by its OWN child, the host writing none.
  const { entries } = await ctx.client.listHistory({
    projectId: project.id,
    kind: 'tool.called',
    limit: 2_000,
  });
  for (const child of children) {
    const wrote = entries.some(
      (entry) =>
        entry.entryType === 'event' &&
        entry.details?.taskRef === child.ref &&
        entry.details?.success === true &&
        entry.details?.name === 'write_file',
    );
    if (!wrote) failures.push(`${child.ref} has no successful write_file receipt`);
  }
  const review = await reviewHostSessions(ctx.client, project.id, host.ref, 'stories/');
  if (review.hostWrotePaths.length > 0) {
    failures.push(
      `the host wrote ${review.hostWrotePaths.length} story file(s) itself: ${[...new Set(review.hostWrotePaths)].join(', ')}`,
    );
  }
  const diagnostics = fanoutDiagnostics(host, children, review);
  const fanout = diagnostics.fanout as { barrierHeld: boolean | null };
  if (fanout.barrierHeld === false) {
    failures.push('the host was active before its last child settled (fanout barrier not held)');
  }

  if (failures.length > 0) {
    return { done: true, success: false, reason: failures.join('; '), diagnostics };
  }
  return {
    done: true,
    success: true,
    reason: `${children.length} children each wrote a story; host collected anthology.md after the barrier released`,
    diagnostics,
  };
}

export const fanoutStoriesScenario: EvalScenario = {
  id: 'fanout-stories',
  description:
    'Hermetic declarative fanout, prose: a host spawns five story children, is held until they settle, then collects an anthology. Grades fanout mechanics (children spawned and completed, stories written by children not the host, barrier held, anthology coverage).',
  prompt:
    'Write five short stories, one per topic, by fanning out one child task per story, then collect them into an anthology once every story is finished.',
  skipInitialPrompt: true,
  setup,
  successCheck,
  timeoutMs: 30 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  suggestedTrials: 1,
  repairPolicy: 'runtime',
};
