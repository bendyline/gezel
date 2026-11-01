import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLlmJudge } from './llm-judge.ts';
import { writeTrialFacts } from './trial-facts.ts';
import type { ScenarioJudgeSpec } from './types.ts';

export interface TrialJudgeScenario {
  id: string;
  prompt: string;
  description: string;
  judge?: ScenarioJudgeSpec;
  /** See `EvalScenario.htmlDeliverable`. */
  htmlDeliverable?: string;
}

function firstArtifactUnder(dir: string, matches: (name: string) => boolean): string | null {
  let candidate: string | null = null;
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      if (candidate) return;
      const full = join(current, name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full);
      else if (matches(name)) candidate = full;
    }
  };
  walk(dir);
  return candidate;
}

function resolveJudgeArtifact(runDir: string, scenario: TrialJudgeScenario): string | null {
  const { judge, htmlDeliverable } = scenario;
  if (judge) {
    const matches = (name: string) => name === judge.artifactBasename;
    return (
      firstArtifactUnder(join(runDir, 'workspace'), matches) ??
      firstArtifactUnder(join(runDir, 'artifacts'), matches)
    );
  }
  if (!htmlDeliverable) return null;
  // The snapshot holds one folder per project; the page is in the one the
  // model built it in.
  const workspace = join(runDir, 'workspace');
  let projects: string[];
  try {
    projects = readdirSync(workspace);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(workspace, project, htmlDeliverable);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this project.
    }
  }
  return null;
}

/**
 * Run the optional advisory judge over a single trial's final artifact.
 * Scenarios with a judge spec name a deliverable and custom axes; scenarios
 * with an `htmlDeliverable` get the default HTML rubric on that page; every
 * other scenario is skipped.
 * When a report is written, facts.json is immediately regenerated so the
 * canonical facts snapshot exposes `judge` in the same command invocation.
 * Returns true only when a judge report was persisted.
 */
export async function maybeJudgeTrial(args: {
  scenario: TrialJudgeScenario;
  runDir: string;
  log?: (line: string) => void;
}): Promise<boolean> {
  const log = args.log ?? ((line: string) => console.log(line));
  if (!args.scenario.judge && !args.scenario.htmlDeliverable) {
    log('[llm-judge] scenario declares no judged deliverable — skipping advisory judge');
    return false;
  }
  const artifactPath = resolveJudgeArtifact(args.runDir, args.scenario);
  if (!artifactPath) {
    const expected = args.scenario.judge?.artifactBasename ?? args.scenario.htmlDeliverable;
    log(`[llm-judge] no ${expected} in trial dir — skipping advisory judge`);
    return false;
  }

  const report = await runLlmJudge({
    scenarioId: args.scenario.id,
    userPrompt: args.scenario.prompt,
    scenarioBrief: args.scenario.description,
    artifact: readFileSync(artifactPath, 'utf8'),
    ...(args.scenario.judge
      ? {
          artifactKind: args.scenario.judge.artifactKind,
          axisOverrides: args.scenario.judge.axes,
          ...(args.scenario.judge.contextNote
            ? { judgeContextNote: args.scenario.judge.contextNote }
            : {}),
        }
      : {}),
    log,
  });
  if (!report) return false;

  writeFileSync(join(args.runDir, 'llm-judge.json'), `${JSON.stringify(report, null, 2)}\n`);
  try {
    await writeTrialFacts(args.runDir);
  } catch (err) {
    // The judge report is advisory and must not change the trial exit code.
    // Preserve the report and make a stale/missing facts snapshot loud.
    log(`[llm-judge] facts.json refresh skipped (score failed): ${String(err)}`);
  }
  return true;
}
