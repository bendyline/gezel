/**
 * Connections to real test accounts, checked nightly by an in-process daemon.
 * Skipped unless `GEZEL_CONNECTOR_LIVE_ACCOUNTS=1`.
 *
 * Each account arrives as a bundle exported from a connection a person made
 * in the app (`pnpm run connectors:export-credential`), one per environment
 * variable. `GEZEL_LIVE_ACCOUNTS` names those variables (default
 * `GEZEL_LIVE_GMAIL,GEZEL_LIVE_OUTLOOK`); an unset one is reported missing, and
 * at least one must be set. Every bundle is bound in a fresh home over the
 * HTTP API, synced, and checked like `live-acceptance.test.ts`.
 *
 * A sign-in the provider no longer accepts is `needs-relink`: a warning, not a
 * failure, unless `GEZEL_LIVE_ACCOUNTS_STRICT=1`, since only a person can sign
 * in again and export it.
 *
 * Microsoft issues a new refresh token on every refresh, and each lasts about
 * 90 days. When a connection's refresh token changed, the renewed bundle is
 * written to `GEZEL_LIVE_ROTATED_DIR/<VARIABLE>.json` (mode 0600) for the
 * workflow to save back into the secret. Nothing here prints a credential, an
 * address or message content: the logs of a public repository are public.
 * `GEZEL_LIVE_REPORT` names a JSON file for the run's summary.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';
import { connectorSecretKey } from '../registry.js';
import { type ProjectApi, checkBinding, needsRelink } from './acceptance.js';

const LIVE = process.env.GEZEL_CONNECTOR_LIVE_ACCOUNTS === '1';
const STRICT = process.env.GEZEL_LIVE_ACCOUNTS_STRICT === '1';
const PROJECT = 'default';
const VARIABLE = /^GEZEL_LIVE_[A-Z0-9_]+$/;

const variables = (process.env.GEZEL_LIVE_ACCOUNTS ?? 'GEZEL_LIVE_GMAIL,GEZEL_LIVE_OUTLOOK')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

/** What `connectors:export-credential` writes. */
interface Bundle {
  v: 1;
  type: string;
  version?: string;
  sourceId?: string;
  config: Record<string, unknown>;
  displayName?: string;
  credential: string;
}

interface AccountReport {
  secret: string;
  type?: string;
  status: 'ok' | 'missing' | 'needs-relink' | 'failed';
  records?: number;
  /** The provider issued a new refresh token; the renewed bundle was written. */
  renewed?: boolean;
  note?: string;
}

/** Parse a bundle without ever repeating its text in an error. */
function parseBundle(raw: string): Bundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('the secret is not JSON; export the connection again');
  }
  const b = parsed as Partial<Bundle>;
  if (b?.v !== 1 || typeof b.type !== 'string' || typeof b.credential !== 'string') {
    throw new Error('the secret is not an exported connection; export it again');
  }
  return { ...b, config: b.config ?? {} } as Bundle;
}

/**
 * A failure's first line only. The lines under a corpus check name record
 * files, whose names carry message subjects and senders; run the check
 * locally with the same bundle to see them.
 */
function publicNote(failure: string): string {
  const [first = '', ...rest] = failure.split('\n').filter((l) => l.trim());
  return rest.length > 0 ? `${first.replace(/:$/, '')} (${rest.length} details not shown)` : first;
}

function refreshTokenOf(credential: string | null | undefined): string | undefined {
  if (!credential) return undefined;
  try {
    const token = (JSON.parse(credential) as { refreshToken?: unknown }).refreshToken;
    return typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

describe.runIf(LIVE)('connections to real test accounts', () => {
  let svc: RunningService;
  let home: string;
  let api: ProjectApi;
  const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

  beforeAll(async () => {
    process.env.GEZEL_MOCK_PROVIDER = '1';
    home = await mkdtemp(join(tmpdir(), 'gezel-live-accounts-'));
    svc = await startService({ home });
    const baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
    const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
    api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const res = await httpFetch(`${baseUrl}/api/projects/${PROJECT}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${svc.context.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok) {
        let message = text.slice(0, 500);
        try {
          message = (JSON.parse(text) as { error?: string }).error ?? message;
        } catch {
          /* keep the text */
        }
        throw new Error(`${method} ${path} → HTTP ${res.status}: ${message}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    };
  }, 120_000);

  afterAll(async () => {
    await svc?.stop();
    if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
    if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
    else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
  }, 60_000);

  /** Write the renewed bundle when the provider issued a new refresh token. */
  async function saveRenewed(
    variable: string,
    bundle: Bundle,
    binding: { id: string; type: string },
  ): Promise<boolean> {
    const stored = await svc.context.secrets.get(connectorSecretKey(binding.type, binding.id));
    const renewed = refreshTokenOf(stored);
    if (!stored || !renewed || renewed === refreshTokenOf(bundle.credential)) return false;
    const dir = process.env.GEZEL_LIVE_ROTATED_DIR;
    if (!dir) return true;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, `${variable}.json`),
      `${JSON.stringify({ ...bundle, credential: stored })}\n`,
      { mode: 0o600 },
    );
    return true;
  }

  it(
    'every exported connection binds, syncs, resumes quietly, and keeps its sign-in current',
    async () => {
      for (const v of variables) expect(v, 'GEZEL_LIVE_ACCOUNTS names variables').toMatch(VARIABLE);
      const artifactsDir = svc.context.store.projectArtifactsDir(PROJECT);
      const report: AccountReport[] = [];
      const failures: string[] = [];

      for (const variable of variables) {
        const raw = process.env[variable];
        if (!raw?.trim()) {
          report.push({ secret: variable, status: 'missing' });
          continue;
        }
        const entry: AccountReport = { secret: variable, status: 'ok' };
        report.push(entry);
        let bundle: Bundle;
        try {
          bundle = parseBundle(raw);
        } catch (err) {
          entry.status = 'failed';
          entry.note = (err as Error).message;
          failures.push(`${variable}: ${entry.note}`);
          continue;
        }
        entry.type = bundle.type;

        let binding: { id: string; type: string; corpusDir: string };
        try {
          binding = (
            await api<{ binding: typeof binding }>('POST', '/connectors/bind', {
              type: bundle.type,
              displayName: variable,
              config: bundle.config,
              credential: bundle.credential,
            })
          ).binding;
        } catch (err) {
          entry.status = 'failed';
          entry.note = `could not bind: ${(err as Error).message}`;
          failures.push(`${variable}: ${entry.note}`);
          continue;
        }

        let found: string[] = [];
        try {
          const checked = await checkBinding(api, artifactsDir, binding, {
            quietTolerance: Number(process.env.GEZEL_LIVE_QUIET_TOLERANCE ?? 3),
          });
          entry.records = checked.entry.records;
          if (checked.entry.records === 0) {
            checked.failures.push(
              `${binding.id}: the account synced nothing; keep a few messages in the test mailbox`,
            );
          }
          found = checked.failures;
        } finally {
          // Even a failed pass may have refreshed, and the old token may be spent.
          entry.renewed = await saveRenewed(variable, bundle, binding);
        }
        if (found.some(needsRelink)) {
          entry.status = 'needs-relink';
          entry.note =
            'the provider no longer accepts this sign-in; connect it again and export it';
          if (STRICT) failures.push(`${variable}: ${entry.note}`);
        } else if (found.length > 0) {
          entry.status = 'failed';
          const notes = found.map((f) => publicNote(f.replace(`${binding.id}: `, '')));
          entry.note = notes.join('; ');
          failures.push(...notes.map((n) => `${variable}: ${n}`));
        }
      }

      const reportPath = process.env.GEZEL_LIVE_REPORT;
      if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(
        report
          .map(
            (r) =>
              `${r.status.padEnd(12)} ${r.secret.padEnd(24)} ${(r.type ?? '').padEnd(14)} records=${r.records ?? '-'}${r.renewed ? ' renewed' : ''}${r.note ? ` (${r.note})` : ''}`,
          )
          .join('\n'),
      );
      expect(
        report.filter((r) => r.status !== 'missing').length,
        'no account bundle was set',
      ).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    },
    20 * 60_000,
  );
});
