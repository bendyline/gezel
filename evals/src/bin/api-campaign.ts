import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type CampaignOptions, runCampaign } from '../api-campaign/run.ts';
import { resolveEvalRunsDir } from '../run-paths.ts';
import { installEvalSignalHandlers } from '../signal-handler.ts';
import { parseArgs } from './args.ts';

export function campaignOptions(argv: string[]): CampaignOptions {
  const { flags, positional } = parseArgs(argv);
  if (positional.length) throw new Error('Unexpected positional argument');
  for (const key of Object.keys(flags)) {
    if (!['count', 'runs-dir', 'execute'].includes(key)) throw new Error(`Unknown flag --${key}`);
  }
  if (typeof flags['runs-dir'] !== 'string' || !flags['runs-dir'].trim())
    throw new Error('--runs-dir is required, for example evals/runs/api-phase1');
  if (flags.count !== undefined && flags.count !== '1' && flags.count !== '3')
    throw new Error('--count must be 1 or 3');
  if (flags.execute !== undefined && flags.execute !== true)
    throw new Error('--execute is a boolean flag');
  return {
    runsDir: resolveEvalRunsDir(flags['runs-dir']),
    execute: flags.execute === true,
    ...(flags.count ? { count: Number(flags.count) } : {}),
  };
}

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    console.log(
      'pnpm eval:api-campaign --runs-dir evals/runs/api-phase1 [--count 1|3] [--execute]\nDefault: prepare a 12-trial plan. --execute resumes pending trials. --count 3 extends to 36 total.',
    );
    return;
  }
  const opts = campaignOptions(process.argv.slice(2));
  const controller = opts.execute ? installEvalSignalHandlers('API campaign') : undefined;
  const state = await runCampaign({ ...opts, signal: controller?.signal });
  process.exitCode = state.stopped ? 1 : controller?.signal.aborted ? 130 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[api-campaign] ${error.message}`);
    process.exitCode = 2;
  });
}
