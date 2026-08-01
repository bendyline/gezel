import { describe, expect, it, vi } from 'vitest';
import {
  CopilotProvider,
  NON_SANDBOX_EXCLUDED_MCP_TOOLS,
  SANDBOX_ALLOWED_TOOL_PATTERNS,
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

describe('sandbox tool surface', () => {
  // A deny-list of built-in NAMES rotted silently when the CLI renamed
  // them: five of the eight we excluded no longer existed, so shell and
  // file-write tools stayed advertised. Patterns can't rot that way.
  it('allows only the MCP + custom surface the permission handler approves', () => {
    expect(SANDBOX_ALLOWED_TOOL_PATTERNS).toEqual(['mcp:*', 'custom:*']);
    for (const pattern of SANDBOX_ALLOWED_TOOL_PATTERNS) {
      expect(pattern.endsWith(':*')).toBe(true);
    }
  });

  it('names no built-in tool, so an upstream rename cannot silently widen it', () => {
    for (const stale of ['bash', 'write_file', 'edit_file', 'powershell', 'create', 'edit']) {
      expect(SANDBOX_ALLOWED_TOOL_PATTERNS).not.toContain(stale);
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
    expect(defaultConfig.availableTools).toEqual(SANDBOX_ALLOWED_TOOL_PATTERNS);
    expect(defaultConfig.excludedTools).toBeUndefined();
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
    expect(optedOutConfig.availableTools).toBeUndefined();
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
