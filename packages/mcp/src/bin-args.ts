/**
 * Command-line handling for `gezel-mcp`, run before either server loads.
 * The full server connects to the Gezel service as it is imported, so
 * `gezel-mcp --help` used to wait on a stdio client that never came whenever
 * a service was running (2026-10-22 and 2026-11-08 npm ship audits).
 *
 * Imported only by the bin, so it must stay free of imports.
 */

export type GezelMcpArgs = { kind: 'help' } | { kind: 'version' } | { kind: 'run' };

export function parseGezelMcpArgs(argv: readonly string[]): GezelMcpArgs {
  if (argv.some((arg) => arg === '--help' || arg === '-h')) return { kind: 'help' };
  if (argv.some((arg) => arg === '--version' || arg === '-V' || arg === '-v')) {
    return { kind: 'version' };
  }
  return { kind: 'run' };
}

export const GEZEL_MCP_HELP = `Usage: gezel-mcp [--harness <app>] [--help] [--version]

gezel-mcp is Gezel's tool server, spoken over MCP on stdin and stdout. You
do not usually run it yourself.

  gezel-mcp                  the full tool set Gezel uses itself;
                             the Gezel service starts it for each chat
  gezel-mcp --harness <app>  Gezel's tools for another AI app: claude-code,
                             claude-desktop, codex, cursor or vscode

To give an app Gezel's tools, run \`gezel mcp install <app>\`, or set it up
from Settings -> Integrations in the Gezel app.

More: https://github.com/bendyline/gezel/tree/main/packages/mcp
`;
