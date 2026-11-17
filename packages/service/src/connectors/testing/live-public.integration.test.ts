/**
 * Connectors against public sources that need no account: a few long-lived
 * web feeds, fetched over the real network by the production RSS adapter.
 * Skipped unless `GEZEL_CONNECTOR_LIVE_PUBLIC=1`.
 *
 * The network is not ours, so a feed that fails is retried, and a feed that
 * still fails is reported as degraded rather than failing the run, unless
 * `GEZEL_LIVE_PUBLIC_STRICT=1` (the CI lane sets it on the third degraded
 * run in a row). A feed that answers but writes nothing valid always fails:
 * that is our adapter, not their server.
 *
 * `GEZEL_LIVE_FEEDS` overrides the list (comma-separated). `GEZEL_LIVE_REPORT`
 * names a JSON file to write what each feed produced.
 */

import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import { RssFeedAdapter } from '../natives/rss-feed.js';
import { assertCorpusInvariants, createConnectorTestEnv } from './harness.js';

const LIVE = process.env.GEZEL_CONNECTOR_LIVE_PUBLIC === '1';
const STRICT = process.env.GEZEL_LIVE_PUBLIC_STRICT === '1';

/** Long-lived feeds in each format the adapter reads. */
const DEFAULT_FEEDS = [
  'https://nodejs.org/en/feed/blog.xml',
  'https://blog.python.org/feeds/posts/default',
  'https://github.blog/feed/',
  'https://www.rfc-editor.org/rfcrss.xml',
];

const feeds = (process.env.GEZEL_LIVE_FEEDS ?? DEFAULT_FEEDS.join(','))
  .split(',')
  .map((f) => f.trim())
  .filter(Boolean);

interface FeedReport {
  feed: string;
  status: 'ok' | 'degraded' | 'broken';
  records?: number;
  attempts: number;
  error?: string;
}

describe.runIf(LIVE)('connectors against public sources', () => {
  it(
    'syncs each feed through the production adapter',
    async () => {
      const report: FeedReport[] = [];
      for (const feed of feeds) {
        const entry: FeedReport = { feed, status: 'degraded', attempts: 0 };
        report.push(entry);
        for (let attempt = 1; attempt <= 3; attempt++) {
          entry.attempts = attempt;
          const env = await createConnectorTestEnv();
          try {
            const result = await syncWithAdapter(
              new RssFeedAdapter(
                { id: 'rss-live', type: 'rss-feed', config: { feeds: [feed] } },
                env.deps(),
              ),
              {
                storageDir: env.artifactsDir,
                quarantineDir: env.quarantineDir,
                corpusDir: 'data/feed',
                backfillLimit: 50,
                cursor: undefined,
              },
            );
            if (result.error || result.rateLimited) {
              entry.error = result.error ?? 'rate limited';
            } else if (result.written === 0) {
              entry.status = 'broken';
              entry.error = 'the feed answered but no record was written';
              break;
            } else {
              const records = await assertCorpusInvariants(env.artifactsDir, 'data/feed').catch(
                (err: unknown) => {
                  entry.status = 'broken';
                  entry.error = `corpus invariant: ${err instanceof Error ? err.message : String(err)}`;
                  return null;
                },
              );
              if (records) {
                entry.status = 'ok';
                entry.records = records.length;
                delete entry.error;
              }
              break;
            }
          } finally {
            await env.dispose();
          }
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      const path = process.env.GEZEL_LIVE_REPORT;
      if (path) await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        report
          .map((r) => `${r.status.padEnd(9)} ${r.feed} ${r.records ?? ''} ${r.error ?? ''}`)
          .join('\n'),
      );
      expect(report.filter((r) => r.status === 'broken')).toEqual([]);
      if (STRICT) expect(report.filter((r) => r.status !== 'ok')).toEqual([]);
    },
    10 * 60_000,
  );
});
