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
    // Mirrors the real SDK export, which returns the decision-request kind.
    approveAll: () => ({ kind: 'approve-once' }),
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
  // The CLI accepts only the decision-*request* kinds. Answering with an
  // outcome kind (`approved`, `denied-by-rules`) is refused with
  // "unexpected user permission response", which errors the tool call
  // instead of allowing or denying it.
  it('approves mcp and custom-tool kinds with a decision the CLI accepts', () => {
    const handler = buildSandboxPermissionHandler();
    expect(handler({ kind: 'mcp', toolName: 'read_file' })).toEqual({ kind: 'approve-once' });
    expect(handler({ kind: 'custom-tool', toolName: 'lookup_issue' })).toEqual({
      kind: 'approve-once',
    });
  });

  it('denies every built-in permission kind with feedback for the model', () => {
    const handler = buildSandboxPermissionHandler();
    for (const kind of ['shell', 'write', 'read', 'url', 'memory', 'hook', 'unknown']) {
      expect(handler({ kind })).toEqual({
        kind: 'reject',
        feedback: expect.stringContaining('Sandbox mode'),
      });
    }
  });

  it('never answers with a CLI-side outcome kind', () => {
    const handler = buildSandboxPermissionHandler();
    const outcomes = ['approved', 'denied-by-rules', 'cancelled', 'denied-interactively-by-user'];
    for (const kind of ['mcp', 'custom-tool', 'shell', 'write', 'read', 'url']) {
      expect(outcomes).not.toContain(handler({ kind }).kind);
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
    expect(handler({ kind: 'url', toolName: 'web_fetch' }).kind).toBe('reject');
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
      (defaultConfig.onPermissionRequest as (request: object) => { kind: string })({
        kind: 'shell',
      }).kind,
    ).toBe('reject');

    await provider.createSession({ systemMessage: 'opt out', sandboxCopilot: false });
    const optedOutConfig = configs[1]!;
    expect(optedOutConfig.excludedTools).toBeUndefined();
    expect(optedOutConfig.systemMessage).toEqual({ mode: 'replace', content: 'opt out' });
    expect(
      (optedOutConfig.onPermissionRequest as (request: object) => object)({ kind: 'shell' }),
    ).toEqual({ kind: 'approve-once' });

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
