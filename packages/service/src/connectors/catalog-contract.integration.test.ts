/**
 * The catalog contract sweep: every version of every `script` and `mcp`
 * connector type in the pinned gilde runs its real fetch script (in a real
 * sandboxed Node child) or its real MCP calls, through the real
 * `ConnectorManager`, against the exchanges in its contract sidecar, with no
 * network. The corpus it writes must match what the sidecar expects.
 *
 * Until gilde ships sidecars (`versions/<v>/test.json`), provisional ones live
 * in `__fixtures__/contract-provisional/<type>@<version>.json`. A type with no
 * contract fails the sweep unless it is on the exemption list, which may only
 * shrink. See connector-standards.md §8.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ConnectorTypeManifest,
  type ConnectorTypeTestSpec,
  ConnectorTypeTestSpecSchema,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import type { ScriptExecutor } from '@bendyline/gezel-script-runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { NodeScriptExecutor } from '../scripts/node-executor.js';
import { ScriptRunner } from '../scripts/runner.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ConnectorManager, resolveDeclaredOrigins } from './manager.js';
import { assertCorpusInvariants, readCorpus } from './testing/harness.js';
import { replayExchanges } from './testing/replay-exchanges.js';
import { RECORD_FILE_RE, sha8 } from './writer.js';

const PROVISIONAL = join(import.meta.dirname, '__fixtures__', 'contract-provisional');

/** Type versions with no contract yet. May only shrink. */
const EXEMPT = new Set<string>(['github-issues@1.0.0']);

/** Literal-address check only: the replay answers every host itself. */
const literalPublic = async (url: string) => {
  const host = new URL(url).hostname;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(host)) {
    throw new Error(`refusing a private address: ${host}`);
  }
};

/**
 * The real Node executor, with the source counted as provenance-trusted: the
 * scripts run in a real sandboxed child on every platform, including Linux CI,
 * which has no OS network boundary for an untrusted inline script.
 */
const trustedExecutor: ScriptExecutor = {
  execute: (options) => new NodeScriptExecutor().execute({ ...options, provenanceTrusted: true }),
};

interface Target {
  manifest: ConnectorTypeManifest;
  key: string;
  spec?: ConnectorTypeTestSpec;
}

function provisionalSpecs(): Map<string, ConnectorTypeTestSpec> {
  const out = new Map<string, ConnectorTypeTestSpec>();
  for (const file of readdirSync(PROVISIONAL).filter((f) => f.endsWith('.json'))) {
    const spec = ConnectorTypeTestSpecSchema.parse(
      JSON.parse(readFileSync(join(PROVISIONAL, file), 'utf8')),
    );
    const [type, version] = file.replace(/\.json$/, '').split('@') as [string, string];
    for (const v of [version, ...(spec.alsoCovers ?? [])]) out.set(`${type}@${v}`, spec);
  }
  return out;
}

const catalog = new CatalogService();
const provisional = provisionalSpecs();
const targets: Target[] = [];
for (const item of await catalog.list('connector-type')) {
  const latest = await catalog.get('connector-type', item.manifest.id, 'bundled');
  if (latest?.manifest.kind !== 'connector-type') continue;
  if (latest.manifest.driver !== 'script' && latest.manifest.driver !== 'mcp') continue;
  for (const { version } of await catalog.listVersions(
    'connector-type',
    item.manifest.id,
    'bundled',
  )) {
    const detail = await catalog.get('connector-type', item.manifest.id, 'bundled', version);
    if (detail?.manifest.kind !== 'connector-type') continue;
    const key = `${detail.manifest.id}@${version}`;
    const shipped = await catalog
      .readItemFile('connector-type', detail.manifest.id, 'test.json', 'bundled', version)
      .catch(() => null);
    const spec = shipped
      ? ConnectorTypeTestSpecSchema.parse(JSON.parse(shipped.toString('utf8')))
      : provisional.get(key);
    targets.push({ manifest: detail.manifest, key, ...(spec ? { spec } : {}) });
  }
}

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true })));
});

describe('connector catalog contracts', () => {
  it('every script and mcp type version has a contract, or is exempt', () => {
    const missing = targets.filter((t) => !t.spec).map((t) => t.key);
    expect(
      missing.filter((k) => !EXEMPT.has(k)),
      'add a contract sidecar',
    ).toEqual([]);
    const stale = [...EXEMPT].filter((k) => targets.some((t) => t.key === k && t.spec));
    expect(stale, 'remove from EXEMPT: these have a contract now').toEqual([]);
  });

  for (const target of targets.filter((t) => t.spec)) {
    for (const c of target.spec!.cases) {
      it(`${target.key}: ${c.id}`, async () => {
        const home = await mkdtemp(join(tmpdir(), 'gezel-contract-'));
        homes.push(home);
        const store = new Store({ home });
        await store.ensureLayout();
        await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
        const project = await store.createProject({ name: 'Contract' });
        const secrets = new FileSecretStore(home);
        const replay = replayExchanges(c.exchanges);
        const scriptRunner = new ScriptRunner({
          store,
          secrets,
          executor: trustedExecutor,
          http: { fetch: replay.fetch, assertPublicUrl: literalPublic },
        });
        const connectors = new ConnectorManager({
          store,
          secrets,
          catalog,
          scriptRunner,
          resolveMcpServer: () => replay.mcpServer(),
        });
        const binding = await connectors.bind(project, {
          type: target.manifest.id,
          version: target.manifest.version,
          sourceId: 'bundled',
          config: c.config,
          ...(c.credential === 'placeholder' ? { credential: 'contract-placeholder-token' } : {}),
        });

        for (let pass = 0; pass < c.passes; pass++) {
          const r = await connectors.syncBinding(project, binding.id);
          expect(r.error, `pass ${pass + 1} failed`).toBeUndefined();
          expect(r.errors, `pass ${pass + 1} had record errors`).toBe(0);
        }
        expect(replay.unmatched, 'requests the contract does not answer').toEqual([]);
        expect(replay.unused(), 'answers the type never asked for').toEqual([]);

        const declared = resolveDeclaredOrigins(target.manifest, c.config);
        if (declared.length > 0) {
          expect([...replay.origins].filter((o) => !declared.includes(o))).toEqual([]);
        }

        const artifacts = store.projectArtifactsDir(project.id);
        const corpusDir = (await store.getProject(project.id))!.connectors!.find(
          (b) => b.id === binding.id,
        )!.corpusDir!;
        if (c.expect.records) {
          const corpus = await readCorpus(artifacts, corpusDir);
          const byHash = new Map(
            corpus.map((r) => [RECORD_FILE_RE.exec(r.path.split('/').at(-1)!)?.[2] ?? '', r]),
          );
          expect(corpus.map((r) => r.path)).toHaveLength(c.expect.records.length);
          for (const want of c.expect.records) {
            const got = byHash.get(sha8(want.id));
            expect(got, `record ${want.id}`).toBeDefined();
            for (const [k, v] of Object.entries(want.frontmatter ?? {})) {
              expect(got!.frontmatter[k], `${want.id} ${k}`).toBe(v);
            }
            if (want.bodyIncludes) expect(got!.body).toContain(want.bodyIncludes);
          }
          if (corpus.length > 0) await assertCorpusInvariants(artifacts, corpusDir);
        }
        if (c.expect.rows !== undefined) {
          const status = await connectors.status((await store.getProject(project.id))!);
          const rows = (status.bindings.find((b) => b.id === binding.id)?.tables ?? []).reduce(
            (n, t) => n + t.rows,
            0,
          );
          expect(rows).toBe(c.expect.rows);
        }
      }, 60_000);
    }
  }
});
