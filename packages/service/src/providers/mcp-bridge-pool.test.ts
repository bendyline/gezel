import { describe, expect, it, vi } from 'vitest';
import { McpBridgePool } from './mcp-bridge-pool.js';

function poolWithFakeBridge(toolAllowlist: Set<string> | null): McpBridgePool {
  const pool = new McpBridgePool();
  const mutable = pool as unknown as {
    toolAllowlist: Set<string> | null;
    bridges: Array<{
      id: string;
      bridge: {
        getOpenAITools: () => Array<{ type: 'function'; name: string; description: string }>;
        getAnthropicTools: () => Array<{
          name: string;
          description: string;
          input_schema: Record<string, unknown>;
        }>;
        hasTool: (name: string) => boolean;
        callTool: (name: string) => Promise<string>;
        callToolRich: (
          name: string,
        ) => Promise<{ text: string; images: Array<{ base64: string; mimeType: string }> }>;
      };
    }>;
  };
  mutable.toolAllowlist = toolAllowlist;
  mutable.bridges.push({
    id: 'gezel',
    bridge: {
      getOpenAITools: () => [
        { type: 'function', name: 'start_project', description: 'Start a project.' },
        { type: 'function', name: 'ask_gezel', description: 'Ask another gezel.' },
        { type: 'function', name: 'delegate_reviewer', description: 'Delegate to a reviewer.' },
        { type: 'function', name: 'write_file', description: 'Write a file.' },
        { type: 'function', name: 'append_to_file', description: 'Append to a file.' },
      ],
      getAnthropicTools: () => [],
      hasTool: (name) =>
        name === 'start_project' ||
        name === 'ask_gezel' ||
        name === 'delegate_reviewer' ||
        name === 'write_file' ||
        name === 'append_to_file',
      callTool: async (name) => `called ${name}`,
      callToolRich: async (name) => ({ text: `called ${name}`, images: [] }),
    },
  });
  return pool;
}

describe('McpBridgePool allowlist enforcement', () => {
  it('hides and rejects built-in tools omitted from the session allowlist', async () => {
    const pool = poolWithFakeBridge(new Set(['start_project']));

    expect(pool.getOpenAITools().map((tool) => tool.name)).toEqual(['start_project']);
    expect(pool.hasTool('start_project')).toBe(true);
    expect(pool.hasTool('ask_gezel')).toBe(false);
    expect(pool.hasTool('delegate_reviewer')).toBe(false);
    await expect(pool.callTool('ask_gezel', {})).rejects.toThrow(
      'tool "ask_gezel" is not available in this session',
    );
    await expect(pool.callTool('delegate_reviewer', {})).rejects.toThrow(
      'tool "delegate_reviewer" is not available in this session',
    );
    await expect(pool.callToolRich('ask_gezel', {})).rejects.toThrow(
      'tool "ask_gezel" is not available in this session',
    );
  });

  it('allows the hidden append recovery primitive when write_file is authorized', async () => {
    const pool = poolWithFakeBridge(new Set(['write_file']));

    // The first-turn model surface stays write_file-only. Local providers
    // inject append_to_file only after detecting a truncated saved partial.
    expect(pool.getOpenAITools().map((tool) => tool.name)).toEqual(['write_file']);
    expect(pool.hasTool('append_to_file')).toBe(true);
    await expect(
      pool.callTool('append_to_file', { path: 'index.html', content: '</html>' }),
    ).resolves.toBe('called append_to_file');
  });
});

describe('McpBridgePool.fromSessionOpts strict-ID seeding', () => {
  it('seeds wrappers from the volatile band, not just the stable system message', async () => {
    // Regression: the active-task context (`### Current task: squisq/5`)
    // is tagged `volatile` in the prompt-layer split, so it lands in
    // `volatileContext` (the second `system` message), not
    // `systemMessage`. Seeding only the stable prefix left the canonical
    // task ref unseen, so `mcp.validate-ids-strict` false-rejected the
    // step's very first `write_task_note({ ref: "squisq/5" })` and wedged
    // the craftbook gate. Both bands must reach the seeder.
    const seed = vi.spyOn(McpBridgePool.prototype, 'seedWrappersFromText');
    let seededText: string[] = [];
    try {
      await McpBridgePool.fromSessionOpts(
        {
          systemMessage: 'You are working in the project "squisq".',
          volatileContext: '### Current task: squisq/5 — "Accessibility Audit"',
        },
        '[test]',
      );
      // Read the recorded calls BEFORE mockRestore — restoring clears them.
      seededText = seed.mock.calls.map((call) => call[0]);
    } finally {
      seed.mockRestore();
    }
    expect(seededText).toContain('You are working in the project "squisq".');
    expect(seededText.some((text) => text.includes('squisq/5'))).toBe(true);
  });
});
