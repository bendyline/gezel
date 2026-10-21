/**
 * Live acceptance for connectors: real accounts, a real running daemon.
 *
 * Skipped unless `GEZEL_CONNECTOR_LIVE=1`. Everything else in this folder runs
 * adapters against fakes; this is the check that the fakes were right. It
 * deliberately goes through the product path a person uses — bindings linked
 * in the app's Connections tab (so the OAuth flow, the bring-your-own client
 * setup, and the SecretStore are all real), syncs triggered over the daemon's
 * HTTP API — and then audits what landed on disk with the same invariants the
 * fake-driven tests use.
 *
 * Run it (PowerShell):
 *   1. Start Gezel against the home you linked accounts in (e.g. `pnpm app`,
 *      which uses ~/.gezel-dev, or the installed app with ~/.gezel).
 *   2. In one project, link every account you want checked (Connections tab).
 *   3. $env:GEZEL_CONNECTOR_LIVE = '1'
 *      $env:GEZEL_LIVE_HOME = "$HOME\.gezel-dev"        # the daemon's GEZEL_HOME
 *      $env:GEZEL_LIVE_PROJECT = '<project id>'
 *      # optional: GEZEL_LIVE_ARTIFACTS_DIR (external project), GEZEL_LIVE_REPORT (json path),
 *      # GEZEL_LIVE_ONLY (comma-separated binding ids or types)
 *      Set-Location packages\service
 *      & ..\..\node_modules\.bin\vitest.CMD run src/connectors/testing/live-acceptance.test.ts
 *
 * Per binding it asserts: the sync reports no hard error; the corpus satisfies
 * the connector invariants (trust frontmatter, filename grammar, sidecars,
 * nothing outside the corpus root); `_meta.json` names the binding and its
 * completeness; the type's expected frontmatter keys are present; and a
 * second sync right after is quiet (a live mailbox may receive a message in
 * between, so up to GEZEL_LIVE_QUIET_TOLERANCE writes, default 3, pass).
 * A JSON report of what each binding produced is written for the record.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTrustingFetch, readRuntime } from '@bendyline/gezel-client/node';
import { describe, expect, it } from 'vitest';
import { assertCorpusInvariants } from './harness.js';

const LIVE = process.env.GEZEL_CONNECTOR_LIVE === '1';

/** Frontmatter keys a record of each family should carry. */
const EXPECTED_KEYS: Array<[RegExp, string[]]> = [
  [/^mail-/, ['subject', 'from', 'date', 'message_id']],
  [/^calendar-/, ['title', 'date']],
  [/^files-/, ['title', 'path', 'file_id']],
  [/^rss-feed$/, ['title', 'url']],
  [/^youtube-/, ['title', 'url', 'date']],
  [/^(x|bluesky|instagram|linkedin)-/, ['url']],
];

interface BindingStatus {
  id: string;
  type: string;
  displayName?: string;
  completeness?: string;
  lastError?: string;
}

interface SyncResult {
  written: number;
  quarantined: number;
  skipped: number;
  pruned: number;
  errors: number;
  error?: string;
  rateLimited?: boolean;
}

describe.skipIf(!LIVE)('connectors — live acceptance against a running daemon', () => {
  it(
    'every linked binding syncs, satisfies the corpus invariants, and resumes quietly',
    async () => {
      const home = process.env.GEZEL_LIVE_HOME;
      const projectId = process.env.GEZEL_LIVE_PROJECT;
      if (!home || !projectId) {
        throw new Error(
          'Set GEZEL_LIVE_HOME and GEZEL_LIVE_PROJECT (see the header of this file).',
        );
      }
      const runtime = await readRuntime(home);
      if (!runtime)
        throw new Error(`No running daemon found under ${home}\\runtime. Start Gezel first.`);
      const httpFetch = runtime.cert ? createTrustingFetch({ cert: runtime.cert }) : fetch;
      const api = async <T>(method: string, path: string): Promise<T> => {
        const res = await httpFetch(
          `${runtime.baseUrl}/api/projects/${encodeURIComponent(projectId)}${path}`,
          {
            method,
            headers: { Authorization: `Bearer ${runtime.token}` },
          },
        );
        const text = await res.text();
        if (!res.ok)
          throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
        return (text ? JSON.parse(text) : {}) as T;
      };

      const status = await api<{ bindings: BindingStatus[] }>('GET', '/connectors');
      const only = (process.env.GEZEL_LIVE_ONLY ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const bindings = status.bindings.filter(
        (b) => only.length === 0 || only.includes(b.id) || only.includes(b.type),
      );
      if (bindings.length === 0) {
        throw new Error(
          `Project ${projectId} has no connector bindings to check. Link accounts first.`,
        );
      }
      const project = (await (
        await httpFetch(`${runtime.baseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
          headers: { Authorization: `Bearer ${runtime.token}` },
        })
      ).json()) as { connectors?: { id: string; corpusDir?: string }[] };
      const artifactsDir =
        process.env.GEZEL_LIVE_ARTIFACTS_DIR ?? join(home, 'projects', projectId, 'artifacts');
      const tolerance = Number(process.env.GEZEL_LIVE_QUIET_TOLERANCE ?? 3);

      const report: Record<string, unknown>[] = [];
      const failures: string[] = [];
      for (const b of bindings) {
        const entry: Record<string, unknown> = {
          id: b.id,
          type: b.type,
          completeness: b.completeness,
        };
        report.push(entry);
        try {
          // Paging adapters may need several passes to finish a first backfill.
          const passes: SyncResult[] = [];
          for (let i = 0; i < 6; i++) {
            const r = (
              await api<{ result: SyncResult }>(
                'POST',
                `/connectors/${encodeURIComponent(b.id)}/sync`,
              )
            ).result;
            passes.push(r);
            if (r.error) throw new Error(`sync failed: ${r.error}`);
            if (r.rateLimited) break;
            if (r.written === 0 && i > 0) break;
          }
          entry.passes = passes;
          const corpusDir = project.connectors?.find((c) => c.id === b.id)?.corpusDir;
          if (!corpusDir) throw new Error('binding has no corpusDir after syncing');
          const records = await assertCorpusInvariants(artifactsDir, corpusDir);
          entry.records = records.length;
          const keys = EXPECTED_KEYS.find(([re]) => re.test(b.type))?.[1] ?? [];
          const missing = new Map<string, number>();
          for (const r of records) {
            for (const k of keys) if (!r.frontmatter[k]) missing.set(k, (missing.get(k) ?? 0) + 1);
          }
          entry.missingKeys = Object.fromEntries(missing);
          if (records.length > 0 && missing.size > 0) {
            failures.push(`${b.id}: records missing ${[...missing.keys()].join(', ')}`);
          }
          entry.sample = records
            .slice(0, 3)
            .map((r) => ({ path: r.path, frontmatter: r.frontmatter }));
          const meta = JSON.parse(
            await readFile(join(artifactsDir, corpusDir, '_meta.json'), 'utf8'),
          );
          if (meta.binding !== b.id) failures.push(`${b.id}: _meta.json names ${meta.binding}`);
          const last = passes[passes.length - 1]!;
          if (!last.rateLimited) {
            const quiet = (
              await api<{ result: SyncResult }>(
                'POST',
                `/connectors/${encodeURIComponent(b.id)}/sync`,
              )
            ).result;
            entry.quietPass = quiet;
            if (quiet.error) failures.push(`${b.id}: resume pass failed: ${quiet.error}`);
            else if (quiet.written > tolerance) {
              failures.push(
                `${b.id}: resume pass rewrote ${quiet.written} records (cursor not resuming?)`,
              );
            }
          }
        } catch (err) {
          entry.error = err instanceof Error ? err.message : String(err);
          failures.push(`${b.id}: ${entry.error}`);
        }
      }

      const reportPath = process.env.GEZEL_LIVE_REPORT;
      if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        report
          .map(
            (e) =>
              `${String(e.type).padEnd(22)} ${String(e.id).padEnd(34)} records=${e.records ?? '-'} ${e.error ? `ERROR ${e.error}` : 'ok'}`,
          )
          .join('\n'),
      );
      expect(failures).toEqual([]);
    },
    30 * 60_000,
  );
});
