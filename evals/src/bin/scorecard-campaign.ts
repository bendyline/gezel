import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '../native-bin.ts';
import { resolveEvalRunsDir } from '../run-paths.ts';
import { comparisonDefinition } from '../scorecard-campaign/plan.ts';
import { runComparison } from '../scorecard-campaign/run.ts';
import { installEvalSignalHandlers } from '../signal-handler.ts';
import { parseArgs } from './args.ts';

export async function comparisonOptions(argv: string[]) {
  const { flags, positional } = parseArgs(argv);
  if (positional.length) throw new Error('Unexpected positional argument');
  for (const key of Object.keys(flags))
    if (!['config', 'runs-dir', 'source-home', 'execute', 'limit'].includes(key))
      throw new Error(`Unknown flag --${key}`);
  for (const key of ['config', 'runs-dir'])
    if (typeof flags[key] !== 'string' || !String(flags[key]).trim())
      throw new Error(`--${key} is required`);
  if (flags['source-home'] !== undefined && typeof flags['source-home'] !== 'string')
    throw new Error('--source-home needs a path');
  if (flags.execute !== undefined && flags.execute !== true)
    throw new Error('--execute is a boolean flag');
  if (
    flags.limit !== undefined &&
    (typeof flags.limit !== 'string' ||
      !/^[1-9]\d*$/.test(flags.limit) ||
      !Number.isSafeInteger(Number(flags.limit)))
  )
    throw new Error('--limit must be a positive integer');
  const config = JSON.parse(await readFile(resolve(repoRoot(), String(flags.config)), 'utf8'));
  return {
    runsDir: resolveEvalRunsDir(String(flags['runs-dir'])),
    execute: flags.execute === true,
    ...(flags.limit !== undefined ? { limit: Number(flags.limit) } : {}),
    definition: comparisonDefinition(
      config,
      resolve(repoRoot(), String(flags['source-home'] ?? join(homedir(), '.gezel-dev'))),
    ),
  };
}
async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'pnpm eval:scorecard-campaign --config evals/campaigns/scorecard-six-providers.json --runs-dir evals/runs/scorecard-comparison [--source-home ~/.gezel-dev] [--execute] [--limit N]\nWithout --execute, prepare only. Resume with the same command; completed trials are never repeated. --limit bounds new trials in this invocation, not the frozen plan.',
    );
    return;
  }
  const opts = await comparisonOptions(process.argv.slice(2));
  const controller = opts.execute ? installEvalSignalHandlers('scorecard campaign') : undefined;
  const state = await runComparison({ ...opts, signal: controller?.signal });
  process.exitCode = state.stopped ? 1 : controller?.signal.aborted ? 130 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(`[scorecard-campaign] ${error.message}`);
    process.exitCode = 2;
  });
