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

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTrustingFetch, readRuntime } from '@bendyline/gezel-client/node';
import { describe, expect, it } from 'vitest';
import { type AcceptanceEntry, checkBinding } from './acceptance.js';

const LIVE = process.env.GEZEL_CONNECTOR_LIVE === '1';

interface BindingStatus {
  id: string;
  type: string;
  displayName?: string;
  completeness?: string;
  lastError?: string;
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

      const report: AcceptanceEntry[] = [];
      const failures: string[] = [];
      for (const b of bindings) {
        const checked = await checkBinding(
          api,
          artifactsDir,
          { ...b, corpusDir: project.connectors?.find((c) => c.id === b.id)?.corpusDir },
          { quietTolerance: tolerance, sample: true },
        );
        report.push(checked.entry);
        failures.push(...checked.failures);
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
