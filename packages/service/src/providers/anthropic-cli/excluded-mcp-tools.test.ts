import { describe, expect, it } from 'vitest';
import { CODEX_CLI_EXCLUDED_MCP_TOOLS } from '../codex-cli/excluded-mcp-tools.js';
import { CLAUDE_CLI_EXCLUDED_MCP_TOOLS } from './excluded-mcp-tools.js';

// A `commandEvidence` gate counts only the receipts these runners write; a
// shell run of the same command is invisible to it. Both CLI providers hid
// them as Bash duplicates and every suite-verifying book failed its verify
// step on those providers (Opus codemod-sweep, 2026-09-19).
const RECEIPT_BEARING_RUNNERS = ['run_package_script', 'run_npx', 'list_package_scripts'];

describe('CLI provider MCP exclusions', () => {
  it.each([
    ['claude', CLAUDE_CLI_EXCLUDED_MCP_TOOLS],
    ['codex', CODEX_CLI_EXCLUDED_MCP_TOOLS],
  ])('%s keeps the receipt-bearing package-script runners advertised', (_label, list) => {
    for (const name of RECEIPT_BEARING_RUNNERS) {
      expect(list).not.toContain(name);
    }
  });

  it.each([
    ['claude', CLAUDE_CLI_EXCLUDED_MCP_TOOLS],
    ['codex', CODEX_CLI_EXCLUDED_MCP_TOOLS],
  ])('%s still hides the execution tools no gate depends on', (_label, list) => {
    for (const name of ['npm_install', 'run_nodejs_script', 'run_playwright_script']) {
      expect(list).toContain(name);
    }
  });
});
