/**
 * The `gezel-mcp` command. `--harness <client>` runs the small profile for an
 * outside AI app; anything else runs the full server Gezel gives its own
 * gezels. Each is loaded only when chosen, so the harness never pays for the
 * full server's start-up. The URLs keep the bundler from inlining either.
 */
const entry = process.argv.includes('--harness') ? './harness.js' : './server.js';
await import(new URL(entry, import.meta.url).href);
