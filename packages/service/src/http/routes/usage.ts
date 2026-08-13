import { join } from 'node:path';
import { Hono } from 'hono';
import { readClaudeQuotaSnapshot } from '../../providers/anthropic-cli/quota.js';
import { getCliPresence } from '../../providers/cli-detection.js';
import { readCodexQuotaBucketsCached } from '../../providers/codex-cli/quota.js';
import type { ServiceContext } from '../context.js';

export function usageRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    // CLI subscriptions report account windows outside ordinary turn usage.
    // Refresh them opportunistically before building the shared summary.
    // Either provider may be absent, signed out, or temporarily unhealthy;
    // none of those conditions should make the usage endpoint fail.
    try {
      const config = await ctx.store.readConfig();
      const detections = getCliPresence({
        ...(config.anthropicCli ? { anthropicCli: config.anthropicCli } : {}),
        ...(config.codexCli ? { codexCli: config.codexCli } : {}),
      });
      const prior = ctx.chat.usageTracker.summary();
      const refreshCodexQuota =
        config.provider === 'codex-cli' || prior.providers['codex-cli'] !== undefined;
      const [codexBuckets, claudeSnapshot] = await Promise.all([
        refreshCodexQuota && detections.codexCli.installed && detections.codexCli.path
          ? readCodexQuotaBucketsCached({ binaryPath: detections.codexCli.path }).catch(() => null)
          : Promise.resolve(null),
        readClaudeQuotaSnapshot(join(ctx.home, 'runtime', 'anthropic-cli')),
      ]);
      if (codexBuckets) {
        ctx.chat.usageTracker.recordQuotaBuckets('codex-cli', codexBuckets);
      }
      if (claudeSnapshot) {
        ctx.chat.usageTracker.recordQuotaBuckets(
          'anthropic-cli',
          claudeSnapshot.buckets,
          claudeSnapshot.capturedAt,
        );
      }
    } catch {
      // Usage already collected from turns is still useful. Keep this route
      // best-effort so one CLI's local account probe cannot hide the rest.
    }
    const summary = ctx.chat.usageTracker.summary();
    return c.json(summary);
  });

  return app;
}
