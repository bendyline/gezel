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

function resolveJudgeArtifact(runDir: string, judge: ScenarioJudgeSpec | undefined): string | null {
  const matches = judge
    ? (name: string) => name === judge.artifactBasename
    : (name: string) => name.toLowerCase().endsWith('.html');
  return (
    firstArtifactUnder(join(runDir, 'workspace'), matches) ??
    firstArtifactUnder(join(runDir, 'artifacts'), matches)
  );
}

/**
 * Run the optional advisory judge over a single trial's final artifact.
 * Scenarios with a judge spec name a non-HTML deliverable and custom axes;
 * scenarios without one retain the legacy first-HTML behavior.
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
  const artifactPath = resolveJudgeArtifact(args.runDir, args.scenario.judge);
  if (!artifactPath) {
    const expected = args.scenario.judge?.artifactBasename ?? 'HTML artifact';
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
