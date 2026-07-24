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
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { full: false, dryRun: false, verbose: false, help: false };
  for (const raw of argv) {
    if (raw === '--full') out.full = true;
    else if (raw === '--dry-run') out.dryRun = true;
    else if (raw === '--verbose' || raw === '-v') out.verbose = true;
    else if (raw === '--help' || raw === '-h') out.help = true;
    else if (raw.startsWith('--since=')) out.since = raw.slice('--since='.length);
    else if (raw.startsWith('--limit=')) {
      const n = Number.parseInt(raw.slice('--limit='.length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer (got ${raw})`);
      }
      out.limit = n;
    } else if (raw.startsWith('--package=')) out.singlePackage = raw.slice('--package='.length);
    else throw new Error(`unknown arg: ${raw}`);
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

  # full re-import
  GITHUB_TOKEN=ghp_xxx ... import-mcp-registry --full
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
    dryRun: args.dryRun,
    verbose: args.verbose,
    ...(args.since ? { since: args.since } : {}),
    ...(args.limit ? { limit: args.limit } : {}),
    ...(args.singlePackage ? { singlePackage: args.singlePackage } : {}),
    ...(githubToken ? { githubToken } : {}),
  };

  const startedAt = new Date().toISOString();
  console.log(`[importer] starting at ${startedAt}`);
  if (args.dryRun) console.log('[importer] DRY RUN — no disk writes');
  if (args.singlePackage) console.log(`[importer] single-package mode: ${args.singlePackage}`);
  else if (args.full) console.log('[importer] full sweep (watermark ignored)');
  else if (args.since) console.log(`[importer] updated_since=${args.since}`);

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
  if (summary.highestPublishedAtSeen) {
    const verb = summary.watermarkPersisted ? 'advanced to' : 'would be at';
    console.log(`  watermark ${verb} ${summary.highestPublishedAtSeen}`);
  }
}

main().catch((err) => {
  console.error('[importer] fatal:', err);
  process.exit(1);
});
