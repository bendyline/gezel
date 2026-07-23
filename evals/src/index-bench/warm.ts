import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext, EvalScenario } from '../types.ts';
import { driveEnrichmentToCompletion } from './drive.ts';

/**
 * Warm-vs-cold index arms for agent-outcome scenarios. Trials run with the
 * background enrichment tick disabled (`disableBackgroundEnrich`), so the
 * arm is the ONLY enrichment path: `warm` drives the index to completion
 * (structural + summaries + areas) before the agent starts; `cold` leaves
 * whatever the structural scan produced.
 *
 * Two integration styles:
 *  - scenarios that kick off INSIDE setup call {@link maybeWarmProject}
 *    between corpus seed and kickoff (ordering matters: warm must finish
 *    before the agent's first turn);
 *  - prompt-kickoff scenarios are wrapped with {@link withIndexArm}, which
 *    warms every project the inner setup created before the runner sends
 *    the scenario prompt.
 */

export type IndexArm = 'warm' | 'cold';

export function indexArmFromEnv(): IndexArm {
  return process.env.GEZEL_INDEX_ARM === 'cold' ? 'cold' : 'warm';
}

export async function maybeWarmProject(
  ctx: { client: GezelClient; log: (line: string) => void },
  projectId: string,
  opts: { deadlineMs?: number } = {},
): Promise<void> {
  if (indexArmFromEnv() === 'cold') {
    ctx.log(`[index-arm] cold — skipping enrichment for ${projectId}`);
    return;
  }
  ctx.log(`[index-arm] warm — driving enrichment for ${projectId}`);
  await ctx.client.refreshProjectIndex(projectId).catch(() => undefined);
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    const status = await ctx.client.getProjectIndexStatus(projectId).catch(() => null);
    if (status?.state === 'fresh') break;
    if (Date.now() > deadline) throw new Error('warm arm: structural scan did not complete');
    await new Promise((r) => setTimeout(r, 3_000));
  }
  const totals = await driveEnrichmentToCompletion(ctx.client, projectId, {
    deadlineMs: opts.deadlineMs ?? 90 * 60_000,
    areas: true,
    log: ctx.log,
  });
  // A drained drive with ZERO summaries means the summarizer silently
  // no-oped on every file (enrichFile's summarize catch returns '' per
  // file, so a dead enricher — wrong model id, engine that can't load the
  // weights, no local provider — looks exactly like success). A warm arm
  // measured against that index is garbage; fail the trial at setup
  // instead. Wild-caught: gemma4-e4b linked into a trial whose
  // uv venv had a pre-e4b mlx-lm — every one-shot died in "Missing 54
  // parameters", the drive "drained" 351 files in 16s, and the QA arm ran
  // 66 minutes against a summary-less index.
  if (totals.files > 0 && totals.summarized === 0) {
    throw new Error(
      `warm arm: drive drained ${totals.files} files with 0 summaries — enricher is silently failing (check daemon.log for engine/one-shot errors)`,
    );
  }
  ctx.log(
    `[index-arm] warm ready: ${totals.summarized} summaries, ${totals.areasUpdated} areas in ${Math.round(totals.durationMs / 60_000)}m`,
  );
}

/** Wrap a prompt-kickoff scenario so its projects are warmed post-setup. */
export function withIndexArm(scenario: EvalScenario, arm: IndexArm): EvalScenario {
  return {
    ...scenario,
    description: `${scenario.description} [index arm: ${arm}]`,
    setup: async (ctx: EvalContext) => {
      const before = new Set((await ctx.client.listProjects()).projects.map((p) => p.id));
      await scenario.setup?.(ctx);
      if (arm === 'cold') return;
      const created = (await ctx.client.listProjects()).projects.filter((p) => !before.has(p.id));
      for (const p of created) {
        await maybeWarmProject(ctx, p.id);
      }
    },
  };
}
