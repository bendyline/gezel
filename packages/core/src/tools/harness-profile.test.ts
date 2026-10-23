import { describe, expect, it } from 'vitest';
import {
  HARNESS_AGENT_FILE,
  harnessAgentFileLine,
  isHarnessHiddenCatalog,
} from './harness-profile.js';

describe('harness agent-file line', () => {
  it('tells Claude Code the tool by the name it uses, in CLAUDE.md', () => {
    expect(HARNESS_AGENT_FILE['claude-code']).toBe('CLAUDE.md');
    expect(harnessAgentFileLine('claude-code')).toBe(
      "This folder is indexed by Gezel. To find where a behavior or feature is implemented, call Gezel's `search` tool (`mcp__gezel__search`) with a plain-words description before grepping. It ranks files by meaning and returns paths with line ranges.",
    );
  });

  it('names the server for the apps that read AGENTS.md', () => {
    for (const client of ['codex', 'cursor', 'vscode'] as const) {
      expect(HARNESS_AGENT_FILE[client]).toBe('AGENTS.md');
      const line = harnessAgentFileLine(client);
      expect(line).toContain('the `search` tool from the `gezel` MCP server');
      expect(line).not.toContain('mcp__');
    }
  });

  it('has no line for Claude Desktop, which has no folder', () => {
    expect(harnessAgentFileLine('claude-desktop')).toBeNull();
  });
});

describe('hidden catalogs', () => {
  it('hides the Handboek by id or address', () => {
    expect(isHarnessHiddenCatalog('handboek')).toBe(true);
    expect(isHarnessHiddenCatalog('knowledge://bendyline/handboek/x')).toBe(true);
    expect(isHarnessHiddenCatalog('wikipedia')).toBe(false);
  });
});
