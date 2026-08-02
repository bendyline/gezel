import { ALWAYS_REGISTERED_TOOLS } from '@bendyline/gezel-mcp';
import { describe, expect, it, vi } from 'vitest';
import { CopilotProvider } from './copilot.js';
import type { SessionOpts } from './types.js';

function fakeSdk() {
  const session = {
    sessionId: 'roster-test',
    on: () => () => {},
    sendAndWait: async () => ({ data: { content: 'ok' } }),
    disconnect: async () => {},
  };
  return {
    approveAll: () => ({ kind: 'approve-once' }),
    CopilotClient: class {
      async start() {}
      async stop() {}
      async createSession() {
        return session;
      }
      async resumeSession() {
        return session;
      }
      async listModels() {
        return [];
      }
      async getAuthStatus() {
        return { isAuthenticated: true };
      }
    },
  };
}

async function rosterFor(opts: Partial<SessionOpts>): Promise<string[]> {
  const provider = new CopilotProvider({});
  vi.spyOn(provider as unknown as { loadSdk: () => Promise<unknown> }, 'loadSdk').mockResolvedValue(
    fakeSdk(),
  );
  const session = await provider.createSession({
    systemMessage: 'go',
    ...opts,
  } as SessionOpts);
  const names = session.getRegisteredToolNames?.() ?? [];
  await provider.shutdown();
  return names;
}

const MCP_SERVER = { command: 'node', args: ['server.js'], env: {} };

describe('CopilotSession.getRegisteredToolNames', () => {
  // The Copilot CLI spawns our MCP server itself, so nothing here comes
  // from a live handshake. Before this existed the method was absent
  // entirely and every consumer saw `[]`: the chat-coded-file salvage
  // (gated on `includes('write_file')`) never fired on Copilot, and the
  // unsaved-file-claim nudge told write-capable gezels they couldn't write.
  it('reports the configured gezel-mcp roster', async () => {
    const names = await rosterFor({ mcpServer: MCP_SERVER });
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('write_file');
    expect(names).toContain('read_file');
    // Unprefixed, matching the `includes('write_file')` membership tests
    // and gezel's own tool-call records — not the CLI's `gezel-<tool>`
    // user-visible wire form.
    expect(names.every((n) => !n.startsWith('gezel-'))).toBe(true);
  });

  it('honors the role allowlist', async () => {
    const names = await rosterFor({
      mcpServer: MCP_SERVER,
      toolAllowlist: new Set(['read_file', 'list_dir']),
    });
    expect(names.sort()).toEqual(['list_dir', 'read_file']);
    expect(names).not.toContain('write_file');
  });

  it('reports nothing when no MCP server is wired', async () => {
    expect(await rosterFor({})).toEqual([]);
  });

  it('never claims a tool gezel-mcp does not register', async () => {
    const known = new Set<string>(ALWAYS_REGISTERED_TOOLS);
    const names = await rosterFor({ mcpServer: MCP_SERVER });
    for (const name of names) {
      expect(known.has(name)).toBe(true);
    }
  });
});
