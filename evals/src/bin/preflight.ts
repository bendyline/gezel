/**
 * `pnpm --filter @bendyline/gezel-evals run preflight --model <id> [--provider llama-cpp] [--min-tps N] [--force]`
 *
 * Run the per-model preflight admission probe standalone and print the
 * report. Exit 0 = admitted, 1 = excluded, 2 = usage/fatal. `--force`
 * ignores a cached passing report and re-probes.
 */
import { acquireEvalDeviceLockIfNeeded } from '../eval-device-lock.ts';
import { assertLocalEngineSource } from '../model-sources.ts';
import { ensurePreflightAdmission, runPreflight } from '../preflight.ts';
import { defaultModelFor, defaultProvider } from '../providers.ts';
import { parseArgs, resolveProviderFlag } from './args.ts';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = resolveProviderFlag(args.flags) ?? defaultProvider();
  const modelId = String(args.flags.model ?? defaultModelFor(engine));
  assertLocalEngineSource(engine, modelId);
  const minTps = args.flags['min-tps'] ? Number(args.flags['min-tps']) : undefined;
  if (minTps !== undefined && !(Number.isFinite(minTps) && minTps > 0)) {
    console.error('--min-tps must be a positive number');
    process.exit(2);
  }

  const opts = {
    modelId,
    engine,
    ...(minTps !== undefined ? { minGenTokensPerSec: minTps } : {}),
    ...(args.flags['mlx-source-home']
      ? { mlxSourceHome: String(args.flags['mlx-source-home']) }
      : {}),
    ...(args.flags['cache-root'] ? { cacheRoot: String(args.flags['cache-root']) } : {}),
    ...(args.flags['llama-bin'] ? { llamaBin: String(args.flags['llama-bin']) } : {}),
    log: (line: string) => console.log(line),
  };

  const deviceLock = acquireEvalDeviceLockIfNeeded({ provider: engine });
  try {
    const report = args.flags.force
      ? await runPreflight(opts)
      : await ensurePreflightAdmission(opts);

    console.log('');
    console.log(`model:    ${report.modelId} (${report.engine})`);
    console.log(`verdict:  ${report.admitted ? 'ADMITTED' : 'EXCLUDED'}`);
    console.log(`gen t/s:  ${report.genTokensPerSec ?? 'unmeasured'}`);
    for (const [name, check] of Object.entries(report.checks)) {
      console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${check.detail}`);
    }
    console.log(`probe trial: ${report.runDir}`);
    process.exitCode = report.admitted ? 0 : 1;
  } finally {
    deviceLock?.release();
  }
}

main().catch((err) => {
  console.error('[preflight] fatal:', err);
  process.exit(2);
});
