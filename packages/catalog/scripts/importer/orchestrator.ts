import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, pickNpmStdioPackage } from './filter.js';
import { formatPathsViaBiome } from './fs-utils.js';
import { LicenseResolver, isPermissive } from './license-resolver.js';
import { mapEntry } from './mapper.js';
import { NpmMetadataResolver } from './npm-metadata.js';
import { RegistryClient } from './registry-client.js';
import { SlugAllocator } from './slug.js';
import { readSlugMap, readWatermark, writeJson } from './state.js';
import type { NormalizedRegistryServer } from './types.js';
import { type WriteOutcome, writeToolset } from './writer.js';

export interface OrchestratorOptions {
  /** Catalog package root (`packages/catalog`). Used to derive default state/cache paths. */
  catalogRoot: string;
  /** Override the community data root. */
  communityRoot?: string;
  /** Override state dir (watermark, slug map, run logs). */
  stateDir?: string;
  /** Override cache dir (npm packuments, license lookups). */
  cacheDir?: string;
  /** GitHub PAT for license lookups. */
  githubToken?: string;
  /** Process at most N entries (after filtering). */
  limit?: number;
  /** Ignore the persisted watermark. */
  full?: boolean;
  /** Override `updated_since` parameter explicitly. */
  since?: string;
  /** Single-entry mode: only pull one server by upstream name. */
  singlePackage?: string;
  /** Don't touch disk — just compute outcomes and counts. */
  dryRun?: boolean;
  /** Verbose stdout. */
  verbose?: boolean;
}

export interface RunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: Record<string, number>;
  rejections: Array<{ name: string; reason: string; detail: string }>;
  integrityViolations: Array<{ name: string; detail: string }>;
  /** Highest `publishedAt` observed during this run. May be unwritten — see `watermarkPersisted`. */
  highestPublishedAtSeen?: string;
  /** True when the persisted watermark was actually advanced (i.e. full sweep, not capped). */
  watermarkPersisted: boolean;
}

export class Orchestrator {
  constructor(private readonly opts: OrchestratorOptions) {}

  async run(): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    const stateDir = this.opts.stateDir ?? resolve(this.opts.catalogRoot, 'scripts/.import-state');
    const cacheDir = this.opts.cacheDir ?? resolve(this.opts.catalogRoot, 'scripts/.import-cache');
    const communityRoot =
      this.opts.communityRoot ?? resolve(this.opts.catalogRoot, 'data/community');

    const watermarkPath = resolve(stateDir, 'import-watermark.json');
    const slugMapPath = resolve(stateDir, 'import-slug-map.json');
    const runLogPath = resolve(stateDir, 'runs', `${startedAt.replace(/[:]/g, '-')}.json`);

    const [watermark, slugMap] = await Promise.all([
      readWatermark(watermarkPath),
      readSlugMap(slugMapPath),
    ]);

    const updatedSince = this.opts.full ? undefined : (this.opts.since ?? watermark.lastUpdatedAt);

    const client = new RegistryClient();
    const npm = new NpmMetadataResolver({ cacheDir: resolve(cacheDir, 'npm') });
    const license = new LicenseResolver({
      cacheDir: resolve(cacheDir, 'license'),
      githubToken: this.opts.githubToken,
    });
    const slugs = new SlugAllocator(slugMap);

    const totals: Record<string, number> = {
      seen: 0,
      created: 0,
      updated: 0,
      noop: 0,
      'rejected-status-deleted': 0,
      'rejected-no-runnable-package': 0,
      'rejected-license-unknown': 0,
      'rejected-license-not-permissive': 0,
      'rejected-mapping-failed': 0,
      'rejected-npm-resolution-failed': 0,
      'integrity-violation': 0,
    };
    const bump = (key: string) => {
      totals[key] = (totals[key] ?? 0) + 1;
    };
    const rejections: RunSummary['rejections'] = [];
    const integrityViolations: RunSummary['integrityViolations'] = [];
    // Manifest paths touched this run. Drained through biome's
    // formatter at the end so the persisted shape (short arrays
    // inline, etc.) matches what `pnpm lint` expects. Skipped on
    // `dryRun`, since nothing actually landed on disk.
    const touchedPaths = new Set<string>();

    let highestPublishedAt = watermark.lastUpdatedAt;
    let processed = 0;

    const iter = this.opts.singlePackage
      ? singleServerIter(client, this.opts.singlePackage)
      : client.iterAll({ updatedSince });

    for await (const server of iter) {
      bump('seen');
      if (this.opts.limit && processed >= this.opts.limit) break;
      const decision = classify(server);
      if (decision.kind === 'drop') {
        bump(`rejected-${decision.reason}`);
        rejections.push({ name: server.name, reason: decision.reason, detail: decision.detail });
        if (this.opts.verbose) {
          console.log(`drop ${server.name}: ${decision.reason} (${decision.detail})`);
        }
        continue;
      }

      processed++;
      const { slug } = slugs.assign(server.name);

      let npmFacts: Awaited<ReturnType<NpmMetadataResolver['resolve']>>['facts'] | undefined;
      let npmLicenseFallback: string | null = null;
      const npmPkg = pickNpmStdioPackage(server);
      if (npmPkg) {
        try {
          const resolved = await npm.resolve(npmPkg.identifier, npmPkg.version ?? 'latest');
          npmFacts = resolved.facts;
          npmLicenseFallback = resolved.licenseSpdx;
        } catch (err) {
          bump('rejected-npm-resolution-failed');
          rejections.push({
            name: server.name,
            reason: 'npm-resolution-failed',
            detail: (err as Error).message,
          });
          if (this.opts.verbose) {
            console.log(`drop ${server.name}: npm resolution: ${(err as Error).message}`);
          }
          continue;
        }
      }

      const licenseLookup = await license.resolve({
        repoUrl: server.repository?.url,
        npmFallback: npmLicenseFallback,
      });
      if (licenseLookup.kind !== 'resolved') {
        bump('rejected-license-unknown');
        rejections.push({
          name: server.name,
          reason: 'license-unknown',
          detail: licenseLookup.reason,
        });
        if (this.opts.verbose) {
          console.log(`drop ${server.name}: license unknown (${licenseLookup.reason})`);
        }
        continue;
      }
      if (!isPermissive(licenseLookup.spdx)) {
        bump('rejected-license-not-permissive');
        rejections.push({
          name: server.name,
          reason: 'license-not-permissive',
          detail: licenseLookup.spdx,
        });
        if (this.opts.verbose) {
          console.log(`drop ${server.name}: non-permissive license ${licenseLookup.spdx}`);
        }
        continue;
      }

      let mapped: ReturnType<typeof mapEntry>;
      try {
        mapped = mapEntry({
          server,
          slug,
          license: licenseLookup.spdx,
          ...(npmFacts ? { npmFacts } : {}),
        });
      } catch (err) {
        bump('rejected-mapping-failed');
        rejections.push({
          name: server.name,
          reason: 'mapping-failed',
          detail: (err as Error).message,
        });
        continue;
      }

      let outcome: WriteOutcome;
      try {
        outcome = await writeToolset(mapped.identity, mapped.version, {
          root: communityRoot,
          dryRun: this.opts.dryRun ?? false,
        });
      } catch (err) {
        bump('rejected-mapping-failed');
        rejections.push({
          name: server.name,
          reason: 'mapping-failed',
          detail: `write failed: ${(err as Error).message}`,
        });
        continue;
      }

      switch (outcome.kind) {
        case 'created':
          bump('created');
          touchedPaths.add(outcome.identityPath);
          touchedPaths.add(outcome.versionPath);
          if (this.opts.verbose) console.log(`created ${slug} (${server.name})`);
          break;
        case 'updated':
          bump('updated');
          touchedPaths.add(outcome.identityPath);
          touchedPaths.add(outcome.versionPath);
          if (this.opts.verbose) console.log(`updated ${slug} (${server.name})`);
          break;
        case 'noop':
          bump('noop');
          break;
        case 'integrity-violation':
          bump('integrity-violation');
          integrityViolations.push({ name: server.name, detail: outcome.detail });
          if (this.opts.verbose) console.warn(`INTEGRITY ${slug}: ${outcome.detail}`);
          break;
      }

      const publishedAt = server.official?.publishedAt;
      if (publishedAt && (!highestPublishedAt || publishedAt > highestPublishedAt)) {
        highestPublishedAt = publishedAt;
      }
    }

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;
    // Only advance the watermark on full sweeps with no limit — a
    // capped run can leave fresher entries unimported and would
    // poison `updated_since` for the next sweep.
    const willPersistWatermark =
      !this.opts.dryRun &&
      !this.opts.singlePackage &&
      !this.opts.limit &&
      Boolean(highestPublishedAt);

    const summary: RunSummary = {
      startedAt,
      finishedAt,
      durationMs,
      totals,
      rejections,
      integrityViolations,
      watermarkPersisted: willPersistWatermark,
      ...(highestPublishedAt ? { highestPublishedAtSeen: highestPublishedAt } : {}),
    };

    if (!this.opts.dryRun) {
      await writeJson(slugMapPath, slugs.toJSON());
      if (willPersistWatermark) {
        await writeJson(watermarkPath, {
          lastUpdatedAt: highestPublishedAt,
          lastRunAt: finishedAt,
        });
      }
      await writeJson(runLogPath, summary);
      // Run biome over the manifest paths we touched this turn so the
      // persisted shape matches `pnpm lint`. JSON.stringify expands
      // every array vertically, but biome's formatter wants short
      // arrays inline (e.g. `"envHints": ["FOO"]`). Skipping this
      // step is what produced 5000+ lint errors in the wild.
      // Excludes the slug-map and watermark since they live under
      // `.import-state/` which biome ignores anyway.
      if (touchedPaths.size > 0) {
        await formatPathsViaBiome([...touchedPaths]);
      }
    }

    return summary;
  }
}

async function* singleServerIter(
  client: RegistryClient,
  name: string,
): AsyncGenerator<NormalizedRegistryServer> {
  const server = await client.getByName(name);
  if (server) yield server;
}

/** Resolve `packages/catalog` from this file's location. */
export function defaultCatalogRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}
