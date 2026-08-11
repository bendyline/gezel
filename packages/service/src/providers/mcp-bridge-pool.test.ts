import { describe, expect, it, vi } from 'vitest';
import { McpBridgePool } from './mcp-bridge-pool.js';
import { McpBridge, type OpenAIFunctionTool } from './mcp-bridge.js';

function poolWithFakeBridge(toolAllowlist: Set<string> | null): McpBridgePool {
  const pool = new McpBridgePool();
  const tools: OpenAIFunctionTool[] = [
    tool('start_project', 'Start a project.'),
    tool('ask_gezel', 'Ask another gezel.'),
    tool('delegate_reviewer', 'Delegate to a reviewer.'),
    tool('list_dir', 'List a directory.'),
    tool('write_file', 'Write a file.'),
    tool('append_to_file', 'Append to a file.'),
    tool('draft_email', 'Draft email.'),
    tool('draft_connector_action', 'Draft connector action.'),
  ];
  const bridge = new McpBridge();
  const mutableBridge = bridge as unknown as {
    tools: OpenAIFunctionTool[];
    toolNameSet: Set<string>;
  };
  mutableBridge.tools = tools;
  mutableBridge.toolNameSet = new Set(tools.map((entry) => entry.name));
  vi.spyOn(bridge, 'callTool').mockImplementation(async (name) => `called ${name}`);
  vi.spyOn(bridge, 'callToolRich').mockImplementation(async (name) => ({
    text: `called ${name}`,
    images: [],
    isError: false,
  }));
  const mutable = pool as unknown as {
    toolAllowlist: Set<string> | null;
    bridges: Array<{ id: string; bridge: McpBridge }>;
  };
  mutable.toolAllowlist = toolAllowlist;
  mutable.bridges.push({ id: 'gezel', bridge });
  return pool;
}

function tool(name: string, description: string): OpenAIFunctionTool {
  return { type: 'function', name, description, parameters: { type: 'object' } };
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

  it('authorizes only after alias spellings resolve to their advertised built-ins', async () => {
    const pool = poolWithFakeBridge(new Set(['start_project']));

    for (const name of ['write-file', 'WriteFile', 'read_dir']) {
      expect(pool.hasTool(name), name).toBe(false);
      await expect(pool.callTool(name, {})).rejects.toThrow(
        `tool "${name}" is not available in this session`,
      );
    }
    await expect(pool.callToolRich('write-file', {})).rejects.toThrow(
      'tool "write-file" is not available in this session',
    );
  });

  it('treats contextual registrations as built-ins instead of fail-open third-party tools', async () => {
    const denied = poolWithFakeBridge(new Set(['start_project']));
    expect(denied.hasTool('draft_email')).toBe(false);
    expect(denied.hasTool('draft_connector_action')).toBe(false);

    const allowed = poolWithFakeBridge(
      new Set(['start_project', 'draft_email', 'draft_connector_action']),
    );
    expect(allowed.hasTool('draft_email')).toBe(true);
    expect(allowed.hasTool('draft_connector_action')).toBe(true);
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
