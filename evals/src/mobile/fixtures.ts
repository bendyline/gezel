import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CreateGezelRequest, CreateProjectRequest } from '@bendyline/gezel';
import { conflictSynthesisScenario } from '../scenarios/conflict-synthesis.ts';
import { dataWrangleScenario } from '../scenarios/data-wrangle.ts';
import { failingTestsSpecScenario } from '../scenarios/failing-tests-spec.ts';
import { incidentPostmortemScenario } from '../scenarios/incident-postmortem.ts';
import { opsRunbookScenario } from '../scenarios/ops-runbook.ts';
import { planAndEstimateScenario } from '../scenarios/plan-and-estimate.ts';
import { schemaMigrationScenario } from '../scenarios/schema-migration.ts';
import { symptomDebugScenario } from '../scenarios/symptom-debug.ts';
import { tankCombatScenario } from '../scenarios/tankcombat.ts';
import { ticTacToeScenario } from '../scenarios/tictactoe.ts';
import type { EvalContext, EvalScenario } from '../types.ts';

export interface MobileCanonicalFixture {
  id: string;
  sourceSha256: string;
  sourceFile: string;
  timeoutMs: number;
  kind: 'specialist' | 'meester';
  project?: CreateProjectRequest;
  gezel?: CreateGezelRequest;
  files: Array<{ path: string; content: string }>;
  prompts: string[];
  output: string;
}

/** Capture only setup, never generation: prompts and seeds remain owned by the desktop scenario. */
export async function captureCanonicalFixture(
  scenario: EvalScenario,
  output: string,
  sourceFile = scenario.id,
): Promise<MobileCanonicalFixture> {
  let project: CreateProjectRequest | undefined;
  let gezel: CreateGezelRequest | undefined;
  const files: MobileCanonicalFixture['files'] = [];
  const prompts: string[] = [];
  const methods = {
    listProjects: async () => ({ projects: [] }),
    createProject: async (input: CreateProjectRequest) => {
      if (project) throw new Error('The mobile canonical adapter supports one project');
      project = input;
      return { ...input, id: 'canonical-project' };
    },
    writeProjectWorkspaceFile: async (_id: string, file: { path: string; content: string }) => {
      files.push(file);
    },
    listGezels: async () => ({ gezels: [] }),
    createGezel: async (input: CreateGezelRequest) => {
      if (gezel) throw new Error('The mobile canonical adapter supports one specialist');
      gezel = input;
      return { ...input, id: 'canonical-gezel' };
    },
    addGezelToProject: async () => ({}),
    sendChatMessage: async (_id: string, input: { message: string }) => {
      prompts.push(input.message);
      return {};
    },
  };
  const client = new Proxy(methods, {
    get(target, name) {
      if (!(name in target))
        throw new Error(`Canonical setup needs an unadapted API: ${String(name)}`);
      return target[name as keyof typeof target];
    },
  }) as unknown as EvalContext['client'];
  await scenario.setup?.({ client, meesterId: 'meester', log: () => {} } as unknown as EvalContext);
  if (scenario.setup && (!project || !gezel || !files.length || !prompts.length))
    throw new Error(`${scenario.id} did not capture a complete setup`);
  if (!scenario.timeoutMs) throw new Error(`${scenario.id} needs its canonical time budget`);
  const source = await readFile(new URL(`../scenarios/${sourceFile}.ts`, import.meta.url));
  return {
    id: scenario.id,
    sourceFile,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    timeoutMs: scenario.timeoutMs,
    kind: scenario.setup ? 'specialist' : 'meester',
    project,
    gezel,
    files,
    prompts: scenario.setup ? prompts : [scenario.prompt],
    output,
  };
}

export async function canonicalMobileFixtures(): Promise<MobileCanonicalFixture[]> {
  return Promise.all([
    captureCanonicalFixture(incidentPostmortemScenario, 'postmortem.md'),
    captureCanonicalFixture(conflictSynthesisScenario, 'synthesis.md'),
    captureCanonicalFixture(dataWrangleScenario, 'out/customers.json'),
    captureCanonicalFixture(ticTacToeScenario, 'index.html'),
    captureCanonicalFixture(tankCombatScenario, 'index.html'),
    captureCanonicalFixture(schemaMigrationScenario, 'MIGRATION.md'),
    captureCanonicalFixture(failingTestsSpecScenario, 'src/machine.ts'),
    captureCanonicalFixture(symptomDebugScenario, 'lib/paginate.mjs'),
    captureCanonicalFixture(opsRunbookScenario, 'halt-report.md', 'ops-runbook'),
    captureCanonicalFixture(planAndEstimateScenario, 'plan.md'),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] ?? 'packages/mobile/evals/canonical-fixtures.json');
  await writeFile(output, `${JSON.stringify(await canonicalMobileFixtures(), null, 2)}\n`);
  console.log(`Captured unchanged canonical setup in ${output}`);
}
