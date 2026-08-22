/**
 * Pre-warm the eval cache with a ds4 (DeepSeek-V4 / GLM) GGUF.
 *
 * `warm-models.ts` is llama-cpp only; ds4 weights run to hundreds of GB and
 * are installed through the ds4 engine's own GGUF pipeline, so a scorecard
 * that includes a ds4 model needs this as a separate, restartable step.
 *
 *   pnpm --filter @bendyline/gezel-evals exec tsx src/bin/warm-ds4.ts <catalog-id>
 */
import { defaultCacheRoot } from '../model-cache.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';

const modelId = (process.argv[2] ?? '').trim();
if (!modelId) {
  console.error('usage: warm-ds4.ts <ds4-catalog-model-id>');
  process.exit(2);
}

const cacheRoot = defaultCacheRoot();
console.log(`[warm-ds4] cacheRoot=${cacheRoot} model=${modelId}`);

const spawned = await spawnTrialDaemon({
  home: cacheRoot,
  stderrLogPath: `${cacheRoot}/warm-ds4-stderr.log`,
  timeoutMs: 120_000,
});

let lastPct = -1;
try {
  await spawned.client.updateConfig({ firstRunCompleted: true });
  await spawned.client.installDs4Model(modelId, (event) => {
    const e = event as Record<string, unknown>;
    if (e.type === 'progress') {
      const done = Number(e.bytesCompleted ?? 0);
      const total = Number(e.bytesTotal ?? 0);
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      if (pct !== lastPct && pct % 5 === 0) {
        lastPct = pct;
        console.log(`[warm-ds4] ${modelId} ${pct}% (${done}/${total})`);
      }
    } else {
      console.log(`[warm-ds4] ${JSON.stringify(event).slice(0, 300)}`);
    }
  });
  console.log(`[warm-ds4] ${modelId} OK`);
} catch (err) {
  console.error(`[warm-ds4] ${modelId} FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await shutdownTrialDaemon(spawned);
}
