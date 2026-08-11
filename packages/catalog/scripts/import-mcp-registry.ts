#!/usr/bin/env node
/**
 * Import MCP server entries from `registry.modelcontextprotocol.io`
 * into gezel's community catalog under `data/community/toolsets/`.
 *
 * Usage:
 *   pnpm --filter @bendyline/gezel-catalog import-mcp-registry [flags]
 *
 * Flags:
 *   --full                  Ignore the persisted watermark; sweep everything.
 *   --since=<RFC3339>       Override `updated_since` explicitly.
 *   --limit=<N>             Process at most N entries (after filtering).
 *   --package=<name>        Single-entry mode (e.g. `--package=io.github.modelcontextprotocol/server-filesystem`).
 *   --prune                 Remove on-disk entries upstream no longer vouches for.
 *   --prune-only            Reconcile without importing (minutes, not hours).
 *   --prune-max-ratio=<F>   Abort the prune above this removal fraction (default 0.1).
 *   --all-versions          Import every published version, not just the newest.
 *   --keep-versions=<N>     Trim each toolset to its newest N eligible versions.
 *   --dry-run               Compute outcomes without touching disk.
 *   --verbose               Per-entry stdout.
 *   --help                  Show this message.
 *
 * Env:
 *   GITHUB_TOKEN            Required for `--full`. 60/hr unauth limit
 *                           is too low for any real sweep.
 *
 * Output:
 *   - Toolsets land in the gilde checkout's `data/community/toolsets/`.
 *   - State (watermark + slug map) lives in
 *     `packages/catalog/scripts/.import-state/`.
 *   - HTTP-fetch caches in `packages/catalog/scripts/.import-cache/`.
 *   - Gitignored per-run summary in `.import-state/runs/{ISO}.json`.
 */

import { join } from 'node:path';
import process from 'node:process';
import { requireGildeCheckout } from './gilde-checkout.js';
import {
  Orchestrator,
  type OrchestratorOptions,
  defaultCatalogRoot,
} from './importer/orchestrator.js';

interface CliArgs {
  full: boolean;
  since?: string;
  limit?: number;
  singlePackage?: string;
  prune: boolean;
  pruneOnly: boolean;
  pruneMaxRatio?: number;
  allVersions: boolean;
  keepVersions?: number;
  retainOnly: boolean;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    full: false,
    prune: false,
    pruneOnly: false,
    allVersions: false,
    retainOnly: false,
    dryRun: false,
    verbose: false,
    help: false,
  };
  for (const raw of argv) {
    if (raw === '--full') out.full = true;
    else if (raw === '--all-versions') out.allVersions = true;
    else if (raw === '--retain-only') out.retainOnly = true;
    else if (raw === '--prune') out.prune = true;
    else if (raw === '--prune-only') {
      out.prune = true;
      out.pruneOnly = true;
    } else if (raw === '--dry-run') out.dryRun = true;
    else if (raw === '--verbose' || raw === '-v') out.verbose = true;
    else if (raw === '--help' || raw === '-h') out.help = true;
    else if (raw.startsWith('--since=')) out.since = raw.slice('--since='.length);
    else if (raw.startsWith('--limit=')) {
      const n = Number.parseInt(raw.slice('--limit='.length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer (got ${raw})`);
      }
      out.limit = n;
    } else if (raw.startsWith('--prune-max-ratio=')) {
      const n = Number.parseFloat(raw.slice('--prune-max-ratio='.length));
      if (!Number.isFinite(n) || n <= 0 || n > 1) {
        throw new Error(`--prune-max-ratio must be in (0, 1] (got ${raw})`);
      }
      out.pruneMaxRatio = n;
    } else if (raw.startsWith('--keep-versions=')) {
      const n = Number.parseInt(raw.slice('--keep-versions='.length), 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--keep-versions must be an integer >= 1 (got ${raw})`);
      }
      out.keepVersions = n;
    } else if (raw.startsWith('--package=')) out.singlePackage = raw.slice('--package='.length);
    else throw new Error(`unknown arg: ${raw}`);
  }
  // `--package` and `--limit` are smoke-test modes. Prune deletes based
  // on a full listing sweep, so pairing them reads as "test one entry"
  // but behaves as "reconcile the entire catalog" — refuse instead.
  if (out.prune && out.singlePackage) {
    throw new Error('--prune cannot be combined with --package (single-entry smoke-test mode)');
  }
  if (out.prune && out.limit) {
    throw new Error('--prune cannot be combined with --limit (capped smoke-test mode)');
  }
  // Retention sweeps every importer-owned toolset on disk, so it falls
  // into the same trap: the flags read as "touch one entry" and the pass
  // rewrites the whole catalog.
  if (out.keepVersions !== undefined && (out.singlePackage || out.limit)) {
    throw new Error(
      '--keep-versions cannot be combined with --package/--limit (smoke-test modes); it sweeps every imported toolset',
    );
  }
  if (out.retainOnly && out.keepVersions === undefined) {
    throw new Error('--retain-only needs --keep-versions=<N> — there is nothing else for it to do');
  }
  return out;
}

const HELP = `import-mcp-registry — pull permissively-licensed MCP servers
                       into the gezel community catalog.

Flags:
  --full                  Ignore the persisted watermark; sweep everything.
  --since=<RFC3339>       Override updated_since explicitly.
  --limit=<N>             Process at most N entries (after filtering).
  --package=<name>        Single-entry mode (skips watermark advance).
  --prune                 Reconcile: remove on-disk entries upstream no longer
                          vouches for (deleted or gone). Runs its own complete
                          listing sweep, so it is accurate alongside an
                          incremental import. Not valid with --package/--limit.
  --prune-only            Reconcile without importing. Minutes instead of hours
                          — no npm tarball hashing. Leaves the watermark alone.
  --prune-max-ratio=<F>   Abort the prune when it would remove more than this
                          fraction of imported entries (default 0.1).
  --all-versions          Import every published version rather than only the
                          newest. Off by default: nothing downstream reads the
                          older folders, so an unfiltered sweep just backfills
                          every publisher's history into the gilde diff.
  --keep-versions=<N>     Trim each imported toolset to its newest N eligible
                          versions. Off by default — compacting rewrites files
                          already in gilde's history. 3 is a good starting
                          point: two fallbacks deep if the newest gets yanked.
                          Not valid with --package/--limit.
  --retain-only           Trim version history and nothing else — no import, no
                          reconcile, no network at all. Requires --keep-versions.
  --dry-run               No disk writes; print summary.
  --verbose               Per-entry stdout.
  --help                  This message.

Env:
  GITHUB_TOKEN            Required for --full (otherwise 60/hr rate limit).

Examples:
  # smoke test one well-known entry
  ... import-mcp-registry --package=io.github.modelcontextprotocol/server-filesystem --dry-run --verbose

  # bounded run for license/sha256 sanity check
  GITHUB_TOKEN=ghp_xxx ... import-mcp-registry --limit=50 --verbose

  # incremental sync (uses stored watermark)
  GITHUB_TOKEN=ghp_xxx ... import-mcp-registry

  # see what a reconcile would drop, without touching disk
  ... import-mcp-registry --prune-only --dry-run --verbose

  # drop what's gone, skip the re-import
  ... import-mcp-registry --prune-only

  # routine refresh: pull what changed, drop what's gone
  GITHUB_TOKEN=ghp_xxx ... import-mcp-registry --prune

  # full re-import
  GITHUB_TOKEN=ghp_xxx ... import-mcp-registry --full --prune

  # see how much version history a trim would drop (local only, seconds)
  ... import-mcp-registry --retain-only --keep-versions=3 --dry-run

  # compact accumulated version history (a deliberate, separate PR)
  ... import-mcp-registry --retain-only --keep-versions=3
`;

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}\n`);
    console.error(HELP);
    process.exit(2);
  }

  if (args.help) {
    console.log(HELP);
    return;
  }

  const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (args.full && !githubToken) {
    console.error(
      'error: --full requires GITHUB_TOKEN — the unauth 60/hr GitHub rate limit will not get through ~9k entries.',
    );
    console.error('       Set GITHUB_TOKEN to a fine-grained PAT with public-repo read access.');
    process.exit(2);
  }

  const opts: OrchestratorOptions = {
    // catalogRoot anchors operator state (.import-state/.import-cache) in
    // gezel; the imported CONTENT lands in the sibling gilde checkout.
    catalogRoot: defaultCatalogRoot(),
    communityRoot: join(requireGildeCheckout().dataDir, 'community'),
    full: args.full,
    prune: args.prune,
    pruneOnly: args.pruneOnly,
    allVersions: args.allVersions,
    retainOnly: args.retainOnly,
    dryRun: args.dryRun,
    verbose: args.verbose,
    ...(args.keepVersions !== undefined ? { keepVersions: args.keepVersions } : {}),
    ...(args.since ? { since: args.since } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
    ...(args.singlePackage ? { singlePackage: args.singlePackage } : {}),
    ...(args.pruneMaxRatio !== undefined ? { pruneMaxRatio: args.pruneMaxRatio } : {}),
    ...(githubToken ? { githubToken } : {}),
  };

  const startedAt = new Date().toISOString();
  console.log(`[importer] starting at ${startedAt}`);
  if (args.dryRun) console.log('[importer] DRY RUN — no disk writes');
  if (args.singlePackage) console.log(`[importer] single-package mode: ${args.singlePackage}`);
  else if (args.full) console.log('[importer] full sweep (watermark ignored)');
  else if (args.since) console.log(`[importer] updated_since=${args.since}`);

  if (args.pruneOnly) console.log('[importer] prune-only: reconciling without importing');
  if (args.retainOnly) console.log('[importer] retain-only: trimming versions, no network');
  if (args.allVersions) {
    console.log('[importer] all-versions: importing every published version, not just the newest');
  }
  if (args.keepVersions !== undefined) {
    console.log(`[importer] retention: trimming to the newest ${args.keepVersions} version(s)`);
  }

  const summary = await new Orchestrator(opts).run();

  console.log('\n[importer] done');
  console.log(`  duration:  ${(summary.durationMs / 1000).toFixed(1)}s`);
  console.log('  totals:');
  for (const [k, v] of Object.entries(summary.totals)) {
    if (v === 0) continue;
    console.log(`    ${k.padEnd(34)} ${v}`);
  }
  if (summary.integrityViolations.length > 0) {
    console.log(`\n  ${summary.integrityViolations.length} integrity violation(s):`);
    for (const v of summary.integrityViolations.slice(0, 10)) {
      console.log(`    - ${v.name}: ${v.detail}`);
    }
  }
  const prune = summary.prune;
  if (prune) {
    console.log(
      `\n  prune: ${prune.candidates.length} of ${prune.ownedOnDisk} imported entries gone upstream ` +
        `(${prune.upstreamSeen} listed)`,
    );
    for (const c of prune.candidates.slice(0, 25)) {
      console.log(`    - ${c.slug} (${c.upstreamName}): ${c.reason}`);
    }
    if (prune.candidates.length > 25) {
      console.log(`    … and ${prune.candidates.length - 25} more`);
    }
    if (prune.unmapped.length > 0) {
      console.log(
        `    ${prune.unmapped.length} on-disk entr(ies) have no slug-map record; left untouched.`,
      );
    }
    if (prune.abortedReason) {
      console.log(`    ABORTED — nothing removed: ${prune.abortedReason}`);
    } else if (args.dryRun) {
      console.log('    dry run — nothing removed');
    } else {
      console.log(`    removed ${prune.removed.length} director(ies)`);
    }
  }
  const retention = summary.retention;
  if (retention) {
    const after = retention.versionsBefore - retention.candidates.length;
    console.log(
      `\n  retention (keep ${retention.keep}): ${retention.candidates.length} of ` +
        `${retention.versionsBefore} version folder(s) across ${retention.toolsetsScanned} ` +
        `toolset(s) — ${after} would remain`,
    );
    const skipCounts = new Map<string, number>();
    for (const s of retention.skipped) {
      skipCounts.set(s.reason, (skipCounts.get(s.reason) ?? 0) + 1);
    }
    for (const [reason, count] of skipCounts) {
      console.log(`    ${count} toolset(s) skipped: ${reason}`);
    }
    if (retention.unmapped.length > 0) {
      console.log(
        `    ${retention.unmapped.length} on-disk entr(ies) have no slug-map record; left untouched.`,
      );
    }
    console.log(
      args.dryRun
        ? '    dry run — nothing removed'
        : `    removed ${retention.removed.length} version folder(s)`,
    );
  }
  if (summary.highestPublishedAtSeen) {
    const verb = summary.watermarkPersisted ? 'advanced to' : 'would be at';
    console.log(`  watermark ${verb} ${summary.highestPublishedAtSeen}`);
  }
}

main().catch((err) => {
  console.error('[importer] fatal:', err);
  process.exit(1);
});
