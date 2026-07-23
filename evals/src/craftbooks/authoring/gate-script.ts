import type { EvalContext, EvalScenario, SuccessCheckResult } from '../../types.ts';
import { findProjectIdByName, workspaceFromClient } from '../shared.ts';
import {
  AUTHORING_PROJECT_PIN,
  AUTHORING_TOOL_STEER,
  checkGateScriptSubstance,
  countCraftbookToolCalls,
  craftbookGateScriptRefs,
  ensureAuthoringProject,
  ensureAuthoringWorker,
  findAuthoredCraftbook,
  findTaskForCraftbookAnywhere,
  finishAuthoringPoll,
  parseJsonValue,
  progressBytes,
  sendWorkerKickoff,
} from './helpers.ts';

/**
 * craftbook-author-gate-script — author a craftbook whose build step is
 * gated by a CUSTOM inline script carried inside the book itself.
 *
 * Axis: the `scripts` map of the single-document craftbook format. The
 * linear scenario proves a model can emit steps + declarative gates; this
 * one proves it can also embed executable gate logic (import from
 * `@bendyline/gezel-sdk/checks`, stamp `gezel.output(gateResult(...))`)
 * in the same document. An anti-stub floor rejects bare always-approve
 * scripts. Prompt stays format-blind about the document codec.
 */

const PROJECT_NAME = 'Inventory Health Check';
const BOOK_NAME_HINT = /inventor|stock|report/i;

export const INVENTORY_JSON_PATH = 'data/inventory.json';
export const INVENTORY_REPORT_PATH = 'out/inventory-report.json';

export const INVENTORY_JSON = `${JSON.stringify(
  [
    { sku: 'SKU-201', name: 'Ceramic mug 350ml', qty: 140, unitPrice: 12.5 },
    { sku: 'SKU-118', name: 'Hardcover notebook A5', qty: 62, unitPrice: 34.0 },
    { sku: 'SKU-330', name: 'Beeswax candle small', qty: 0, unitPrice: 3.75 },
    { sku: 'SKU-442', name: 'Cotton tote bag', qty: 18, unitPrice: 18.2 },
    { sku: 'SKU-509', name: 'Walnut phone stand', qty: -3, unitPrice: 55.0 },
    { sku: 'SKU-612', name: 'Enamel pin set', qty: 240, unitPrice: 9.9 },
    { sku: 'SKU-707', name: 'Linen tea towel', qty: 7, unitPrice: 14.0 },
    { sku: 'SKU-815', name: 'Brass bottle opener', qty: 0, unitPrice: 21.5 },
    { sku: 'SKU-903', name: 'Recycled gift wrap', qty: 88, unitPrice: 6.25 },
    { sku: 'SKU-950', name: 'Cork coaster set', qty: 31, unitPrice: 11.0 },
  ],
  null,
  2,
)}\n`;

export const GATE_SCRIPT_MISSION_OBJECTIVES = [
  `Author a reusable craftbook that reads ${INVENTORY_JSON_PATH} and produces a structured`,
  `stock-health report at ${INVENTORY_REPORT_PATH}, then run it here to completion.`,
  'The build step that produces the report must be gated by a CUSTOM inline check script',
  'embedded in the craftbook itself — a script that imports helpers from',
  '"@bendyline/gezel-sdk/checks" and finishes by stamping gezel.output(gateResult(...)),',
  'verifying the report file really parses and covers the inventory before the step may',
  'complete. A gate that approves unconditionally does not count.',
  'The eval only passes when the craftbook (with its embedded gate script) exists, the task',
  `created from it is complete, and ${INVENTORY_REPORT_PATH} exists and parses.`,
].join(' ');

export const GATE_SCRIPT_KICKOFF_MESSAGE = [
  `Our stock file ${INVENTORY_JSON_PATH} keeps drifting (some quantities are zero or even`,
  'negative), and I want a repeatable, self-checking recipe for reporting on it.',
  'Please AUTHOR a reusable craftbook for this: its build step reads the stock file and writes',
  `a structured stock-health report to ${INVENTORY_REPORT_PATH} (totals, items out of stock,`,
  'items with impossible negative quantities, low-stock items).',
  'The important part: gate that build step with a CUSTOM inline check script carried inside',
  'the craftbook itself. The script must import from "@bendyline/gezel-sdk/checks", actually',
  `verify ${INVENTORY_REPORT_PATH} (it parses, it is non-trivial, it covers the inventory), and`,
  'finish with gezel.output(gateResult(...)) so the step can only complete when the report is',
  'real. Do not write a gate that approves unconditionally.',
  'Add a short verification step after the build step so the recipe ends with an explicit check.',
  'Then invoke the craftbook on this project and drive the task to completion — do not stop',
  'after authoring. All paths are workspace-root-relative.',
  AUTHORING_TOOL_STEER,
  AUTHORING_PROJECT_PIN,
].join(' ');

async function setup(ctx: EvalContext): Promise<void> {
  const projectId = await ensureAuthoringProject(ctx, {
    name: PROJECT_NAME,
    about:
      'Produce a structured stock-health report from a drifting inventory file via a reusable ' +
      'craftbook whose build step is gated by a custom embedded check script.',
    missionObjectives: GATE_SCRIPT_MISSION_OBJECTIVES,
  });
  await ctx.client.writeProjectWorkspaceFile(projectId, {
    path: INVENTORY_JSON_PATH,
    content: INVENTORY_JSON,
  });
  ctx.log(`[authoring:setup] seeded ${INVENTORY_JSON_PATH} (10 items, 3 anomalous)`);
  const workerId = await ensureAuthoringWorker(ctx, 'Reza');
  await sendWorkerKickoff(ctx, workerId, projectId, GATE_SCRIPT_KICKOFF_MESSAGE);
}

const TOTAL_CHECKS = 5;

async function successCheck(ctx: EvalContext): Promise<SuccessCheckResult> {
  const projectId = await findProjectIdByName(ctx.client, PROJECT_NAME);
  if (!projectId) return { done: false };

  const failures: string[] = [];
  const book = await findAuthoredCraftbook(ctx.client, {
    projectId,
    minSteps: 2,
    nameHint: BOOK_NAME_HINT,
  });
  let gradeProjectId = projectId;
  let scriptSource: string | undefined;
  if (!book) {
    failures.push(
      'no reusable authored craftbook with at least 2 steps exists yet — author the inventory-report craftbook as a reusable template',
    );
  } else {
    const gatedStep = book.craftbook.steps.find((step) => craftbookGateScriptRefs(step).length > 0);
    if (!gatedStep) {
      failures.push(
        `craftbook "${book.craftbook.id}" has no step gated by a scope:"craftbook" script — attach the custom check script to the build step's gate`,
      );
    } else {
      const ref = craftbookGateScriptRefs(gatedStep)[0];
      scriptSource = ref ? book.craftbook.scripts?.[ref.name] : undefined;
      if (!scriptSource) {
        failures.push(
          `craftbook "${book.craftbook.id}" step "${gatedStep.id}" references gate script "${ref?.name}" but the book does not carry that script source — embed the script in the craftbook itself`,
        );
      } else {
        const substance = checkGateScriptSubstance(scriptSource);
        if (!substance.ok) failures.push(substance.reason);
      }
    }
    const found = await findTaskForCraftbookAnywhere(ctx.client, projectId, book.craftbook.id);
    if (!found) {
      failures.push(
        `no task has been created from craftbook "${book.craftbook.id}" yet — invoke the craftbook on this project`,
      );
    } else {
      gradeProjectId = found.projectId;
      if (found.task.status !== 'complete') {
        failures.push(
          `task ${found.task.ref} (from craftbook "${book.craftbook.id}") has status "${found.task.status}" — drive it to completion`,
        );
      }
    }
  }

  const workspace = workspaceFromClient(ctx.client, gradeProjectId);
  const reportText = await workspace.read(INVENTORY_REPORT_PATH);
  const parsed = parseJsonValue(reportText, INVENTORY_REPORT_PATH);
  if (!parsed.ok) failures.push(parsed.reason);

  return finishAuthoringPoll(ctx, {
    scenarioId: gateScriptScenario.id,
    projectId,
    totalChecks: TOTAL_CHECKS,
    failures,
    bytes:
      progressBytes(reportText, scriptSource, book ? book.craftbook.id : null) +
      500 * (await countCraftbookToolCalls(ctx, projectId)),
    repairPath: 'craftbook: inventory report gate script',
    repairDirective: [
      'CRAFTBOOK_GATE_SCRIPT_REPAIR: fix the FIRST failure above with craftbook/task tools.',
      'The craftbook must carry its own gate script (embedded in the book, referenced from the',
      'build step\'s gate with scope "craftbook"), the script must import from',
      '"@bendyline/gezel-sdk/checks" and stamp gezel.output(gateResult(...)) after really',
      `verifying ${INVENTORY_REPORT_PATH}, and the invoked task must run to completion.`,
    ].join(' '),
    successReason:
      'authored a craftbook with a substantive embedded gate script, the report parses, and the task completed',
  });
}

export const gateScriptScenario: EvalScenario = {
  id: 'craftbook-author-gate-script',
  description:
    'Author a craftbook whose build step is gated by a custom inline script embedded in the ' +
    'book (imports @bendyline/gezel-sdk/checks, stamps gezel.output(gateResult(...))), with an ' +
    'anti-stub floor, then run the invoked task to completion.',
  prompt: GATE_SCRIPT_KICKOFF_MESSAGE,
  evidenceTexts: [GATE_SCRIPT_KICKOFF_MESSAGE, GATE_SCRIPT_MISSION_OBJECTIVES],
  suggestedTrials: 1,
  skipInitialPrompt: true,
  timeoutMs: 45 * 60_000,
  progressTimeoutMs: 10 * 60_000,
  setup,
  successCheck,
};
