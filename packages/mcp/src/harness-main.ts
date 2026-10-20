/**
 * `gezel-mcp --harness <client>`: Gezel's tools for an outside AI app
 * (Claude Code, Codex, Cursor, Claude Desktop, VS Code). Started by that
 * app's MCP configuration, usually through the launcher Gezel writes in
 * `~/.gezel/integrations/mcp/`. Never imports `server.js`, the in-app
 * server whose surface is a gezel's.
 */
import { runHarness } from './harness/index.js';

try {
  await runHarness(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
