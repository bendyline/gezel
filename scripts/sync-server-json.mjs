#!/usr/bin/env node
/**
 * Stamp a package's MCP Registry `server.json` with the version
 * multi-semantic-release just chose for it.
 *
 * WHY THIS EXISTS: the registry lists a server at the version in
 * `server.json`, and it verifies ownership by reading `mcpName` from that
 * exact version of the npm package. The release writes the new version into
 * package.json and commits it; without this step `server.json` would keep
 * naming an older release, and `mcp-publisher publish` would publish the
 * wrong one.
 *
 * semantic-release runs this with cwd set to the package directory, once per
 * package. A package without a `server.json` is skipped, so the shared
 * release config can run it for every package. The release commit picks the
 * file up through @semantic-release/git's assets, and
 * format-release-manifest.mjs formats it.
 *
 * Usage: node scripts/sync-server-json.mjs <version>
 * Env:   GEZEL_RELEASE_DRY_RUN=1  print what would happen instead of doing it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const version = process.argv[2];
const dryRun = process.env.GEZEL_RELEASE_DRY_RUN === '1';
const serverPath = resolve(process.cwd(), 'server.json');
const manifestPath = resolve(process.cwd(), 'package.json');

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[\w.]+)?$/.test(version ?? '')) {
  console.error(`sync-server-json: expected a version argument, got ${JSON.stringify(version)}`);
  process.exit(1);
}
if (!existsSync(serverPath)) process.exit(0);

let manifest;
let server;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  server = JSON.parse(readFileSync(serverPath, 'utf8'));
} catch (err) {
  console.error(
    `sync-server-json: could not read ${serverPath} or its package.json: ${err.message}`,
  );
  process.exit(1);
}

// The registry refuses a publish whose name differs from the package's
// mcpName. Catch that here, before a release commits a file that cannot
// be published.
if (server.name !== manifest.mcpName) {
  console.error(
    `sync-server-json: server.json names ${JSON.stringify(server.name)} but package.json's mcpName is ${JSON.stringify(manifest.mcpName)}; they must match.`,
  );
  process.exit(1);
}
const own = (server.packages ?? []).filter(
  (entry) => entry.registryType === 'npm' && entry.identifier === manifest.name,
);
if (own.length === 0) {
  console.error(
    `sync-server-json: server.json lists no npm package named ${manifest.name}, so there is no version to stamp.`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log(`sync-server-json: [dry run] would set ${serverPath} to version ${version}`);
  process.exit(0);
}

server.version = version;
for (const entry of own) entry.version = version;
writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
console.log(`sync-server-json: ${server.name} is now version ${version}`);
