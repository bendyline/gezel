/**
 * `evals catalog [--out <file>]`
 *
 * Print the harness's own registry — every scenario with the metadata a
 * runner needs to plan (ceiling, repeat cap, requirements, judge axes, suite
 * membership), every suite, and the provider defaults — as one JSON document
 * matching `EvalCatalogSchema`. The in-app Benchmarks runner reads this
 * instead of keeping a hand-maintained copy that drifts from the harness.
 *
 * `--out` writes the file rather than stdout, so nothing a module prints
 * while the registry loads can corrupt the JSON.
 */
import { writeFile } from 'node:fs/promises';
import { buildEvalCatalog } from '../eval-catalog.ts';
import { assertKnownFlags, parseArgs } from './args.ts';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertKnownFlags(args.flags, ['out']);
  const json = `${JSON.stringify(buildEvalCatalog(), null, 2)}\n`;
  const out = args.flags.out;
  if (typeof out === 'string' && out.length > 0) {
    await writeFile(out, json, 'utf8');
    return;
  }
  process.stdout.write(json);
}

main().catch((err) => {
  console.error('[evals] catalog failed:', err);
  process.exit(2);
});
