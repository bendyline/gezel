/**
 * Publish runtime-enforced review routing across the Gstack wave and tighten
 * the root-cause eval so a prose claim cannot substitute for a real test run.
 * The normal importer creates the immutable craftbook/test payloads after
 * this authoring migration advances the wave.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireGildeCheckout } from './gilde-checkout.js';

const SOURCE_VERSION = '2.0.9';
const TARGET_VERSION = '2.0.11';
const RELEASED_AT = '2026-09-26T19:00:00Z';

interface FixtureFile {
  path: string;
  content: string;
  surface?: string;
  modelInput?: boolean;
}

interface ContainsCheck {
  kind: string;
  label?: string;
  pattern?: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const checkout = requireGildeCheckout();
  const root = join(checkout.root, 'authoring', 'gstack');
  const wavePath = join(root, 'wave.json');
  const evalPath = join(root, 'evals', 'investigate.json');
  const wave = JSON.parse(await readFile(wavePath, 'utf8')) as Record<string, unknown>;
  if (wave.version !== SOURCE_VERSION) {
    throw new Error(`expected gstack wave ${SOURCE_VERSION}, found ${String(wave.version)}`);
  }

  const spec = JSON.parse(await readFile(evalPath, 'utf8')) as Record<string, any>;
  const files = spec.setup?.files as FixtureFile[] | undefined;
  const packageFile = files?.find((file) => file.path === 'package.json');
  if (!packageFile || !packageFile.content.includes('cart-total-fixture')) {
    throw new Error('investigate eval package.json fixture is missing or unexpected');
  }
  packageFile.content = `${JSON.stringify(
    {
      name: 'cart-total-fixture',
      private: true,
      type: 'module',
      scripts: { test: 'node tests/cart-total.test.mjs' },
    },
    null,
    2,
  )}\n`;
  // The package manifest is execution scaffolding. Running the named script
  // is evidence of use; forcing the model to quote the manifest is not.
  packageFile.modelInput = false;

  const runInstruction =
    'During the fix-and-verify step, use `list_package_scripts` and then call `run_package_script` with the named `test` script. The report may cite the resulting receipt, but text alone is not proof: the eval requires a successful run attributed to that task step.';
  if (!String(spec.prompt).includes('run_package_script')) {
    spec.prompt = `${String(spec.prompt).trim()} ${runInstruction}`;
  }

  const deliverable = spec.success?.deliverables?.find(
    (item: Record<string, unknown>) => item.path === 'tasks/eval/reports/root-cause-investigation.md',
  );
  const verification = (deliverable?.checks as ContainsCheck[] | undefined)?.find(
    (check) => check.label === 'verification command and result',
  );
  if (!verification || verification.kind !== 'contains') {
    throw new Error('investigate eval verification check is missing or unexpected');
  }
  verification.pattern =
    '(?:npm\\s+(?:run\\s+)?test|node\\s+(?:--test\\s+)?tests/cart-total\\.test\\.mjs)[\\s\\S]*(?:pass|2\\s+tests?|exit(?:ed)?\\s+0)';

  const taskNoteCheck = spec.success?.taskNotes?.checks?.find(
    (check: ContainsCheck) => check.label === 'terminal note records proof and report',
  ) as ContainsCheck | undefined;
  if (!taskNoteCheck || taskNoteCheck.kind !== 'contains') {
    throw new Error('investigate eval task-note proof check is missing or unexpected');
  }
  taskNoteCheck.pattern =
    '\\bDONE\\b[\\s\\S]*(?:npm\\s+(?:run\\s+)?test|node\\s+(?:--test\\s+)?tests/cart-total\\.test\\.mjs)[\\s\\S]*tasks/eval/reports/root-cause-investigation\\.md';

  const history = (spec.success.history ?? []) as Array<Record<string, unknown>>;
  if (history.some((entry) => entry.kind === 'workspace.script.run')) {
    throw new Error('investigate eval already has a workspace.script.run expectation');
  }
  history.push({
    kind: 'workspace.script.run',
    minEntries: 1,
    details: {
      name: 'test',
      exitCode: 0,
      taskRef: 'decimal-cart-total-regression/1',
      stepId: 'fix-and-verify',
    },
  });
  spec.success.history = history;

  wave.version = TARGET_VERSION;
  wave.releasedAt = RELEASED_AT;
  console.log(`planned Gstack review-routing wave ${TARGET_VERSION}`);
  console.log('  investigate eval: named test script + attributed successful run receipt');
  if (dryRun) return;
  await writeFile(evalPath, `${JSON.stringify(spec, null, 2)}\n`);
  await writeFile(wavePath, `${JSON.stringify(wave, null, 2)}\n`);
}

await main();
