/**
 * Pre-warm the eval cache for a set of llama-cpp chat models.
 *
 * `ensureWarmModel` already warms lazily on first trial, but a multi-model
 * sweep then interleaves multi-GB downloads with measurement: a network
 * failure surfaces hours in, and the first trial of each model carries
 * download time that looks like trial latency. Warming up front makes the
 * fetch a separate, restartable step.
 *
 *   pnpm --filter @bendyline/gezel-evals exec tsx src/bin/warm-models.ts a,b,c
 */
import { defaultCacheRoot, ensureWarmModel } from '../model-cache.ts';
import { resolveLlamaBinary } from '../native-bin.ts';

const ids = (process.argv[2] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (ids.length === 0) {
  console.error('usage: warm-models.ts <comma-separated-model-ids>');
  process.exit(2);
}

const cacheRoot = defaultCacheRoot();
const llamaBin = resolveLlamaBinary().path;
console.log(`[warm] cacheRoot=${cacheRoot}`);
console.log(`[warm] llamaBin=${llamaBin}`);

const failed: Array<{ id: string; error: string }> = [];
for (const [i, modelId] of ids.entries()) {
  console.log(`\n[warm] (${i + 1}/${ids.length}) ${modelId}`);
  try {
    await ensureWarmModel({
      cacheRoot,
      engine: 'llama-cpp',
      modelId,
      llamaBin,
      log: (line) => console.log(line),
    });
    console.log(`[warm] ${modelId} OK`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[warm] ${modelId} FAILED: ${error}`);
    failed.push({ id: modelId, error });
  }
}

console.log(`\n[warm] done: ${ids.length - failed.length}/${ids.length} warm`);
for (const f of failed) console.log(`[warm] FAILED ${f.id}: ${f.error}`);
process.exit(failed.length > 0 ? 1 : 0);
