import { describe, expect, it } from 'vitest';
import { getScenario } from '../scenarios/index.ts';
import { craftbookEvalMissionObjectives, craftbookEvalProjectAbout } from './scenario.ts';
import { loadCraftbookTestSpecsSync } from './test-spec-loader.ts';

/**
 * A craftbook's working files belong in the run's OWN task folder
 * (`{{task.dir}}` → `artifacts/tasks/<num>/`), not a shared name every run
 * writes over. The eval sidecars had drifted to pinning `workPath` at a
 * literal `tasks/eval` — 272 of 274 of them — so the shipped `{{task.dir}}`
 * default was never the thing under test, and concurrent runs shared a
 * folder. The grader now resolves `{{task.dir}}` against the real task, so
 * a sidecar has no reason to pin it.
 *
 * Two exemptions, both structural rather than stylistic:
 *  - a sidecar that SEEDS a fixture into the working folder must name a
 *    stable path, because seeding happens before any task exists;
 *  - a freehand sidecar whose kickoff prompt names the folder must keep
 *    that concrete path, because no craftbook task is guaranteed to exist
 *    for `{{task.dir}}` to resolve against.
 */
describe('craftbook eval sidecars keep working files task-scoped', () => {
  const specs = loadCraftbookTestSpecsSync();

  it('no sidecar pins workPath outside the task folder without a structural reason', () => {
    const offenders: string[] = [];
    for (const { craftbookId, spec } of specs) {
      const workPath = spec.setup?.craftbookParams?.workPath;
      if (typeof workPath !== 'string' || workPath.includes('{{task.')) continue;
      const seedsIntoWorkPath = (spec.setup?.files ?? []).some(
        (f) => typeof f.path === 'string' && f.path.startsWith(`${workPath}/`),
      );
      const promptNamesWorkPath = (spec.prompt ?? '').includes(workPath);
      if (seedsIntoWorkPath || promptNamesWorkPath) continue;
      offenders.push(`${craftbookId} (workPath=${workPath})`);
    }
    expect(offenders, `pin {{task.dir}} instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no craftbook scenario shows a raw {{task.*}} token to the model', () => {
    // Mission objectives and the kickoff prompt are composed BEFORE any task
    // exists and are injected verbatim into the system prompt. Emitting a raw
    // token taught the model to write `{{task.dir}}/sources.md` into its own
    // deliverable, which then failed the citation gate as an unresolvable path.
    const offenders: string[] = [];
    for (const { craftbookId } of specs) {
      let scenario: Record<string, unknown>;
      try {
        scenario = getScenario(`craftbook-${craftbookId}`) as unknown as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const [field, text] of Object.entries(scenario)) {
        if (typeof text === 'string' && /\{\{\s*task\.(?:dir|num)\s*\}\}/.test(text)) {
          offenders.push(`${craftbookId}.${field}`);
        }
      }
      // The project `about` and `missionObjectives` are the ones that bit:
      // both are injected verbatim into every session's system prompt but are
      // NOT fields on the scenario object, so a scenario-only sweep missed them.
      const spec = specs.find((s) => s.craftbookId === craftbookId)?.spec;
      if (!spec) continue;
      for (const [field, text] of [
        ['about', craftbookEvalProjectAbout(spec as never)],
        ['missionObjectives', craftbookEvalMissionObjectives(spec as never)],
      ] as const) {
        if (/\{\{\s*task\.(?:dir|num)\s*\}\}/.test(text)) offenders.push(`${craftbookId}.${field}`);
      }
    }
    expect(
      offenders,
      `describe the folder instead of emitting the token:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
