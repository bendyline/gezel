import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderQueue } from '../queue.js';
import { CodexCliSession, type CodexSessionDeps } from './session.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-codex-session-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeFakeCodex(stdout: string, exitCode = 0): Promise<string> {
  if (process.platform === 'win32') {
    // See `invoker.test.ts` for the rationale — multi-line NDJSON
    // stdout means `<NUL set /p =` can't carry it; sidecar file + `type`
    // preserves newlines.
    const stdoutFile = join(dir, 'codex.stdout');
    await writeFile(stdoutFile, stdout, 'utf8');
    const path = join(dir, 'codex.cmd');
    const script = ['@echo off', `type "${stdoutFile}"`, `exit /b ${exitCode}`, ''].join('\r\n');
    await writeFile(path, script, 'utf8');
    return path;
  }
  const path = join(dir, 'codex');
  const stdoutVar = stdout.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const script = `#!/bin/sh\nprintf "%s" "${stdoutVar}"\nexit ${exitCode}\n`;
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

function buildDeps(opts: {
  binaryPath: string;
  initialResumeId?: string;
}): CodexSessionDeps {
  const deps: CodexSessionDeps = {
    binaryPath: opts.binaryPath,
    model: 'gpt-5.5',
    permissionMode: 'acceptEdits',
    systemMessage: 'You are a test gezel.',
    context: {
      sessionId: 'sess-1',
      gezelId: 'gez-1',
      projectId: 'proj-1',
      cwd: dir,
    },
    runtimeDir: join(dir, 'runtime'),
    manageRuntimeFiles: true,
    queue: new ProviderQueue({ concurrency: 1 }),
  };
  if (opts.initialResumeId) deps.initialResumeId = opts.initialResumeId;
  return deps;
}

const happyPathStream = [
  '{"type":"thread.started","thread_id":"thr-99"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}',
  '',
].join('\n');

describe('CodexCliSession', () => {
  it('returns the assistant text and captures the thread id on the first turn', async () => {
    const codex = await makeFakeCodex(happyPathStream);
    const session = new CodexCliSession(buildDeps({ binaryPath: codex }));
    const text = await session.sendAndWait('hello');
    expect(text).toBe('hi');
    expect(session.providerState()).toEqual({ codexCliThreadId: 'thr-99' });
  });

  it('writes the per-session config.toml with instructions, model, mcp servers', async () => {
    const codex = await makeFakeCodex(happyPathStream);
    const deps = buildDeps({ binaryPath: codex });
    deps.mcpServer = {
      command: 'node',
      args: ['/tmp/gezel-mcp.js'],
      env: { GEZEL_TOKEN: 'tk' },
    };
    const session = new CodexCliSession(deps);
    await session.sendAndWait('hello');
    const configPath = join(deps.runtimeDir, 'proj-1', 'sess-1', 'config.toml');
    const body = await readFile(configPath, 'utf8');
    expect(body).toContain('instructions = "You are a test gezel."');
    expect(body).toContain('model = "gpt-5.5"');
    expect(body).toContain('[mcp_servers.gezel]');
    expect(body).toContain('GEZEL_TOKEN = "tk"');
  });

  it('forwards an initial resume id as providerState until a fresh one arrives', async () => {
    // First invocation: no thread.started in stream, only completion.
    // Means the cached id from the seed stays put.
    const noInitStream = [
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed"}',
      '',
    ].join('\n');
    const codex = await makeFakeCodex(noInitStream);
    const session = new CodexCliSession(
      buildDeps({ binaryPath: codex, initialResumeId: 'old-thread' }),
    );
    await session.sendAndWait('follow-up');
    expect(session.providerState()).toEqual({ codexCliThreadId: 'old-thread' });
  });

  it('clears the cached id after a SessionResumeError', async () => {
    // Run #1: capture a thread id.
    const codex1 = await makeFakeCodex(happyPathStream);
    const session = new CodexCliSession(
      buildDeps({ binaryPath: codex1, initialResumeId: 'old-thread' }),
    );
    await session.sendAndWait('hi');
    expect(session.providerState()).toEqual({ codexCliThreadId: 'thr-99' });
  });

  describe('getRegisteredToolNames', () => {
    it('returns [] when no mcpServer is wired (one-shot completion path)', () => {
      const codex = '/usr/bin/false';
      const session = new CodexCliSession(buildDeps({ binaryPath: codex }));
      expect(session.getRegisteredToolNames()).toEqual([]);
    });

    it('lists gezel-mcp tools (mcp__gezel__-prefixed) minus the codex-cli exclusions when mcpServer is wired', () => {
      const codex = '/usr/bin/false';
      const deps = buildDeps({ binaryPath: codex });
      deps.mcpServer = {
        command: 'node',
        args: ['/tmp/gezel-mcp.js'],
        env: {},
      };
      const names = new CodexCliSession(deps).getRegisteredToolNames();
      // Gezel-unique tools the model should see exposed via the codex MCP loop.
      expect(names).toContain('mcp__gezel__ask_specialist');
      expect(names).toContain('mcp__gezel__message_gezel');
      expect(names).toContain('mcp__gezel__start_project');
      expect(names).toContain('mcp__gezel__list_tasks');
      // Codex has built-in file/shell/web tools — these are explicitly
      // excluded via GEZEL_MCP_EXCLUDE and must NOT appear.
      expect(names).not.toContain('mcp__gezel__read_file');
      expect(names).not.toContain('mcp__gezel__write_file');
      expect(names).not.toContain('mcp__gezel__fetch_url');
      expect(names).not.toContain('mcp__gezel__run_npx');
      expect(names).not.toContain('mcp__gezel__craftbook_update_step');
      expect(names).not.toContain('mcp__gezel__craftbook_create');
      expect(names).not.toContain('mcp__gezel__create_gezel_from_gilde');
    });

    it('reports contextual and opt-in compatibility tools only when their MCP env gates are active', () => {
      const codex = '/usr/bin/false';
      const deps = buildDeps({ binaryPath: codex });
      deps.mcpServer = {
        command: 'node',
        args: ['/tmp/gezel-mcp.js'],
        env: {
          GEZEL_CRAFTBOOK_ID: 'weekly-review',
          GEZEL_MCP_LEGACY_TOOLS: '1',
        },
      };
      deps.toolAllowlist = new Set([
        'craftbook_update_step',
        'craftbook_create',
        'create_gezel_from_gilde',
      ]);
      const names = new CodexCliSession(deps).getRegisteredToolNames();
      expect(names).toContain('mcp__gezel__craftbook_update_step');
      expect(names).toContain('mcp__gezel__craftbook_create');
      expect(names).toContain('mcp__gezel__create_gezel_from_gilde');
    });

    it('applies the role/tool allowlist to the reported gezel-mcp surface', () => {
      const codex = '/usr/bin/false';
      const deps = buildDeps({ binaryPath: codex });
      deps.mcpServer = {
        command: 'node',
        args: ['/tmp/gezel-mcp.js'],
        env: {},
      };
      deps.toolAllowlist = new Set(['list_tasks', 'read_task_notes', 'read_file']);
      const names = new CodexCliSession(deps).getRegisteredToolNames();
      expect(names).toContain('mcp__gezel__list_tasks');
      expect(names).toContain('mcp__gezel__read_task_notes');
      expect(names).not.toContain('mcp__gezel__ask_specialist');
      // Still hidden by Codex's duplicate-built-in exclusion layer.
      expect(names).not.toContain('mcp__gezel__read_file');
    });

    it('lists project-type script tools from GEZEL_SCRIPT_TOOLS regardless of the role allowlist', () => {
      const codex = '/usr/bin/false';
      const deps = buildDeps({ binaryPath: codex });
      deps.mcpServer = {
        command: 'node',
        args: ['/tmp/gezel-mcp.js'],
        env: {
          GEZEL_SCRIPT_TOOLS: JSON.stringify([
            { name: 'record_application', description: 'x', script: 'application-store' },
          ]),
        },
      };
      // Session-build unions script-tool names into GEZEL_MCP_ALLOW, so the
      // reported surface keeps them even when the role allowlist doesn't.
      deps.toolAllowlist = new Set(['list_tasks']);
      const names = new CodexCliSession(deps).getRegisteredToolNames();
      expect(names).toContain('mcp__gezel__record_application');
      expect(names).toContain('mcp__gezel__list_tasks');
    });

    it('appends a wildcard marker per stdio extra MCP server', () => {
      const codex = '/usr/bin/false';
      const deps = buildDeps({ binaryPath: codex });
      deps.mcpServer = { command: 'node', args: ['/tmp/gezel-mcp.js'], env: {} };
      deps.extraMcpServers = [
        { id: 'playwright', kind: 'stdio', command: 'node', args: [], env: {} },
        { id: 'figma', kind: 'stdio', command: 'node', args: [], env: {} },
      ];
      const names = new CodexCliSession(deps).getRegisteredToolNames();
      expect(names).toContain('mcp__playwright__*');
      expect(names).toContain('mcp__figma__*');
    });

    it('appends a wildcard marker per http extra MCP server', () => {
      const codex = '/usr/bin/false';
      const deps = buildDeps({ binaryPath: codex });
      deps.mcpServer = { command: 'node', args: ['/tmp/gezel-mcp.js'], env: {} };
      deps.extraMcpServers = [
        {
          id: 'remote-api',
          kind: 'http',
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: {},
        },
      ];
      const names = new CodexCliSession(deps).getRegisteredToolNames();
      expect(names).toContain('mcp__remote-api__*');
    });
  });

  it('writes Codex tool policy for the built-in gezel MCP server', async () => {
    const codex = await makeFakeCodex(happyPathStream);
    const deps = buildDeps({ binaryPath: codex });
    deps.mcpServer = {
      command: 'node',
      args: ['/tmp/gezel-mcp.js'],
      env: {},
    };
    deps.toolAllowlist = new Set(['list_tasks', 'read_task_notes', 'read_file']);
    const session = new CodexCliSession(deps);
    await session.sendAndWait('hello');
    const configPath = join(deps.runtimeDir, 'proj-1', 'sess-1', 'config.toml');
    const body = await readFile(configPath, 'utf8');
    expect(body).toContain('enabled_tools = ["list_tasks", "read_task_notes"]');
    expect(body).toContain('disabled_tools = [');
    expect(body).toContain('"read_file"');
  });

  it('writes http MCP extras into Codex config without storing header values', async () => {
    const codex = await makeFakeCodex(happyPathStream);
    const deps = buildDeps({ binaryPath: codex });
    deps.mcpServer = { command: 'node', args: ['/tmp/gezel-mcp.js'], env: {} };
    deps.extraMcpServers = [
      {
        id: 'remote-api',
        kind: 'http',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer secret-token', 'X-Api-Key': 'secret-key' },
      },
    ];
    const session = new CodexCliSession(deps);
    await session.sendAndWait('hello');
    const body = await readFile(join(deps.runtimeDir, 'proj-1', 'sess-1', 'config.toml'), 'utf8');
    expect(body).toContain('[mcp_servers.remote-api]');
    expect(body).toContain('url = "https://example.com/mcp"');
    expect(body).toContain('env_http_headers = {');
    expect(body).toContain('Authorization = "GEZEL_CODEX_MCP_HEADER_REMOTE_API_0"');
    expect(body).toContain('X-Api-Key = "GEZEL_CODEX_MCP_HEADER_REMOTE_API_1"');
    expect(body).not.toContain('secret-token');
    expect(body).not.toContain('secret-key');
  });

  it('materializes image attachments under the per-session Codex runtime home', async () => {
    const codex = await makeFakeCodex(happyPathStream);
    const deps = buildDeps({ binaryPath: codex });
    const session = new CodexCliSession(deps);
    const png = Buffer.from('fake-png');
    await session.sendAndWait('look', {
      attachments: [
        {
          base64: png.toString('base64'),
          mimeType: 'image/png',
          filename: 'screen.png',
        },
      ],
    });
    const attachmentsRoot = join(deps.runtimeDir, 'proj-1', 'sess-1', 'attachments');
    const turnDirs = await readdir(attachmentsRoot);
    expect(turnDirs).toHaveLength(1);
    const files = await readdir(join(attachmentsRoot, turnDirs[0]!));
    expect(files).toEqual(['image-01.png']);
    const written = await readFile(join(attachmentsRoot, turnDirs[0]!, 'image-01.png'));
    expect(written.equals(png)).toBe(true);
  });
});
