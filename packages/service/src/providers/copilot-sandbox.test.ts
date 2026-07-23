import { describe, expect, it, vi } from 'vitest';
import {
  CopilotProvider,
  NON_SANDBOX_EXCLUDED_MCP_TOOLS,
  SANDBOX_EXCLUDED_TOOLS,
  buildSandboxPermissionHandler,
  buildSandboxSystemMessage,
} from './copilot.js';

function fakeCopilotSdk(configs: Array<Record<string, unknown>>) {
  const session = {
    sessionId: 'sandbox-test',
    on: () => () => {},
    sendAndWait: async () => ({ data: { content: 'ok' } }),
    disconnect: async () => {},
  };
  return {
    approveAll: () => ({ kind: 'approved' }),
    CopilotClient: class {
      async start() {}
      async stop() {}
      async createSession(config: Record<string, unknown>) {
        configs.push(config);
        return session;
      }
      async resumeSession(_sessionId: string, config: Record<string, unknown>) {
        configs.push(config);
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

describe('sandbox permission handler', () => {
  it('approves mcp and custom-tool kinds', () => {
    const handler = buildSandboxPermissionHandler();
    expect(handler({ kind: 'mcp', toolName: 'readFile' })).toEqual({ kind: 'approved' });
    expect(handler({ kind: 'custom-tool', toolName: 'lookup_issue' })).toEqual({
      kind: 'approved',
    });
  });

  it('denies every built-in permission kind', () => {
    const handler = buildSandboxPermissionHandler();
    for (const kind of ['shell', 'write', 'read', 'url', 'memory', 'hook', 'unknown']) {
      expect(handler({ kind })).toEqual({ kind: 'denied-by-rules' });
    }
  });

  it('invokes the denial callback with the request metadata', () => {
    const onDenial = vi.fn();
    const handler = buildSandboxPermissionHandler(onDenial);
    handler({
      kind: 'shell',
      toolName: 'bash',
      fullCommandText: 'curl https://example.com',
    });
    expect(onDenial).toHaveBeenCalledWith({
      kind: 'shell',
      toolName: 'bash',
      fullCommandText: 'curl https://example.com',
    });
  });

  it('swallows callback exceptions and still denies', () => {
    const handler = buildSandboxPermissionHandler(() => {
      throw new Error('denial hook exploded');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(handler({ kind: 'url', toolName: 'web_fetch' })).toEqual({ kind: 'denied-by-rules' });
    warn.mockRestore();
  });

  it('forwards only the fields present on the request', () => {
    const onDenial = vi.fn();
    const handler = buildSandboxPermissionHandler(onDenial);
    handler({ kind: 'write', fileName: '/tmp/out.txt' });
    expect(onDenial).toHaveBeenCalledWith({ kind: 'write', fileName: '/tmp/out.txt' });
  });
});

describe('sandbox system message hint', () => {
  it('appends the built-in-disabled notice to the base prompt', () => {
    const out = buildSandboxSystemMessage('you are a helpful gezel');
    expect(out.startsWith('you are a helpful gezel')).toBe(true);
    expect(out).toContain('Sandbox mode is active');
    expect(out).toContain('MCP');
  });
});

describe('sandbox excluded-tools list', () => {
  it('covers the Copilot built-ins we explicitly deny', () => {
    for (const name of ['bash', 'web_fetch', 'view', 'edit_file', 'str_replace_editor']) {
      expect(SANDBOX_EXCLUDED_TOOLS).toContain(name);
    }
  });
});

describe('Copilot provider sandbox default', () => {
  it('denies SDK built-ins when absent and preserves explicit false', async () => {
    const configs: Array<Record<string, unknown>> = [];
    const provider = new CopilotProvider({});
    vi.spyOn(
      provider as unknown as { loadSdk: () => Promise<unknown> },
      'loadSdk',
    ).mockResolvedValue(fakeCopilotSdk(configs));

    await provider.createSession({ systemMessage: 'default' });
    const defaultConfig = configs[0]!;
    expect(defaultConfig.excludedTools).toEqual(SANDBOX_EXCLUDED_TOOLS);
    expect(defaultConfig.systemMessage).toEqual({
      mode: 'replace',
      content: expect.stringContaining('Sandbox mode is active'),
    });
    expect(
      (defaultConfig.onPermissionRequest as (request: object) => object)({ kind: 'shell' }),
    ).toEqual({ kind: 'denied-by-rules' });

    await provider.createSession({ systemMessage: 'opt out', sandboxCopilot: false });
    const optedOutConfig = configs[1]!;
    expect(optedOutConfig.excludedTools).toBeUndefined();
    expect(optedOutConfig.systemMessage).toEqual({ mode: 'replace', content: 'opt out' });
    expect(
      (optedOutConfig.onPermissionRequest as (request: object) => object)({ kind: 'shell' }),
    ).toEqual({ kind: 'approved' });

    await provider.shutdown();
  });
});

describe('non-sandbox overlap hiding', () => {
  it('hides our MCP tools that duplicate a Copilot built-in', () => {
    for (const name of ['fetch_url', 'search_files', 'find_files', 'read_image_as_base64']) {
      expect(NON_SANDBOX_EXCLUDED_MCP_TOOLS).toContain(name);
    }
  });

  it('keeps tools with no built-in equivalent available', () => {
    for (const name of ['run_git', 'diff_files', 'list_archive', 'extract_archive']) {
      expect(NON_SANDBOX_EXCLUDED_MCP_TOOLS).not.toContain(name);
    }
  });
});
