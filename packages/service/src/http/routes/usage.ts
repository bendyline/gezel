import { join } from 'node:path';
import { Hono } from 'hono';
import {
  claudeRateLimitBuckets,
  readClaudeQuotaSnapshot,
} from '../../providers/anthropic-cli/quota.js';
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
      } else {
        // Claude Code runs its `statusLine` command for the interactive UI
        // only, so a headless worker never produces that snapshot. The
        // `rate_limit_event` stream events collected during turns are the
        // live source; publishing them here rather than waiting for the
        // next turn's usage block keeps the pill current mid-turn.
        // Authoritative, including when it empties: the registry drops a
        // window once its reset passes, and the pill must clear with it
        // rather than keep showing the last reading before the reset.
        ctx.chat.usageTracker.recordQuotaBuckets('anthropic-cli', claudeRateLimitBuckets());
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
