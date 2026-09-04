import { auditCraftbookTemplates } from '../craftbooks/audit.ts';
import { buildCraftbookBatchPlan } from '../craftbooks/batch-plan.ts';
import { loadCraftbookTemplates } from '../craftbooks/catalog.ts';
import { CRAFTBOOK_EVAL_SPECS } from '../craftbooks/specs.ts';
import type { CraftbookEvalMode } from '../craftbooks/types.ts';

function flagValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

async function main(): Promise<void> {
  const target = Number(flagValue('--target') ?? '50');
  const json = hasFlag('--json');
  const modeValue = flagValue('--mode');
  if (modeValue && modeValue !== 'workflow' && modeValue !== 'artifact-task') {
    throw new Error('--mode must be "workflow" or "artifact-task"');
  }
  const mode = modeValue as CraftbookEvalMode | undefined;
  const templates = await loadCraftbookTemplates();
  const { audits } = auditCraftbookTemplates(templates);
  const plan = buildCraftbookBatchPlan({
    templates,
    audits,
    target: Number.isFinite(target) && target > 0 ? target : 50,
    ...(mode ? { mode } : {}),
    // Declared test.json tags are the harness truth; regex is fallback.
    tagsByCraftbookId: new Map(
      CRAFTBOOK_EVAL_SPECS.filter((spec) => spec.tags && spec.tags.length > 0).map((spec) => [
        spec.craftbookId,
        spec.tags!,
      ]),
    ),
  });

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(
    `Craftbook local-model batch plan (${plan.items.length}/${plan.target}, mode=${plan.mode ?? 'all'})`,
  );
  console.log(`Runnable now: ${plan.runnableNow.join(', ') || '(none)'}`);
  console.log('Harness counts:');
  for (const [kind, count] of Object.entries(plan.harnessCounts)) {
    if (count > 0) console.log(`  ${kind.padEnd(20)} ${count}`);
  }
  console.log('\nPriority list:');
  for (const item of plan.items) {
    const simulators =
      item.simulatorIds.length > 0 ? ` simulators=${item.simulatorIds.join(',')}` : '';
    console.log(
      `  ${String(item.priority).padStart(3)} ${item.craftbookId.padEnd(28)} ${item.evalMode.padEnd(13)} ${item.harness.join('+')}${simulators}`,
    );
    console.log(`      ${item.reason}`);
  }
}

main().catch((err) => {
  console.error('[craftbook-plan] fatal:', err);
  process.exit(2);
});
