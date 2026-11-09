/**
 * The `gezel-mcp` command. `--harness <client>` runs the small profile for an
 * outside AI app; anything else runs the full server Gezel gives its own
 * gezels. Each is loaded only when chosen, so the harness never pays for the
 * full server's start-up. The URLs keep the bundler from inlining either.
 */
import { GEZEL_MCP_HELP, parseGezelMcpArgs } from './bin-args.js';

const args = parseGezelMcpArgs(process.argv.slice(2));
if (args.kind === 'help') {
  process.stdout.write(GEZEL_MCP_HELP);
} else if (args.kind === 'version') {
  // External to this bundle, so a literal import() stays a runtime import.
  const { GEZEL_VERSION } = await import('@bendyline/gezel');
  process.stdout.write(`${GEZEL_VERSION}\n`);
} else {
  const entry = process.argv.includes('--harness') ? './harness.js' : './server.js';
  await import(new URL(entry, import.meta.url).href);
}
