/** Native SDK/CLI loops bypass Gezel's managed MCP wrapper layer. */
export function providerUsesManagedMcpBridge(name: string | undefined): boolean {
  return name !== 'copilot' && name !== 'anthropic-cli' && name !== 'codex-cli';
}
