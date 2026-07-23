import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCodexConfigToml, writeRuntimeCodexHome } from './runtime-files.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-codex-runtime-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildCodexConfigToml', () => {
  it('writes instructions, model, and project_doc_max_bytes', () => {
    const body = buildCodexConfigToml({
      instructions: 'You are Maya.',
      model: 'gpt-5.5',
      mcpServers: {},
    });
    expect(body).toContain('instructions = "You are Maya."');
    expect(body).toContain('model = "gpt-5.5"');
    expect(body).toContain('project_doc_max_bytes = 0');
  });

  it('includes reasoning effort when set', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      mcpServers: {},
    });
    expect(body).toContain('model_reasoning_effort = "high"');
  });

  it('omits reasoning effort when unset', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      mcpServers: {},
    });
    expect(body).not.toContain('model_reasoning_effort');
  });

  it('emits model_auto_compact_token_limit when set (turns ON codex compaction)', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      autoCompactTokenLimit: 120_000,
      mcpServers: {},
    });
    expect(body).toContain('model_auto_compact_token_limit = 120000');
  });

  it('emits tool_output_token_limit when set (caps single-tool-result bloat)', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      toolOutputTokenLimit: 16_000,
      mcpServers: {},
    });
    expect(body).toContain('tool_output_token_limit = 16000');
  });

  it('omits both context-cap fields when unset (preserves codex per-model defaults)', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      mcpServers: {},
    });
    expect(body).not.toContain('model_auto_compact_token_limit');
    expect(body).not.toContain('tool_output_token_limit');
  });

  it('escapes quotes and backslashes in instructions', () => {
    const body = buildCodexConfigToml({
      instructions: 'Said "hello"\nNext\\line',
      model: 'gpt-5.5',
      mcpServers: {},
    });
    expect(body).toContain('instructions = "Said \\"hello\\"\\nNext\\\\line"');
  });

  it('writes [mcp_servers.<id>] tables with command, args, env', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      mcpServers: {
        gezel: {
          command: '/usr/bin/node',
          args: ['/path/to/server.js'],
          env: { GEZEL_TOKEN: 't0k3n', GEZEL_BASE_URL: 'http://127.0.0.1:9090' },
        },
      },
    });
    expect(body).toContain('[mcp_servers.gezel]');
    expect(body).toContain('command = "/usr/bin/node"');
    expect(body).toContain('args = ["/path/to/server.js"]');
    expect(body).toContain(
      'env = { GEZEL_TOKEN = "t0k3n", GEZEL_BASE_URL = "http://127.0.0.1:9090" }',
    );
  });

  it('omits env block when there are no entries', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      mcpServers: {
        bare: { command: '/bin/echo', args: ['hi'], env: {} },
      },
    });
    expect(body).toContain('[mcp_servers.bare]');
    expect(body).not.toMatch(/^env =/m);
  });

  it('quotes mcp server keys that contain unusual characters', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      mcpServers: {
        '@playwright/mcp': { command: 'node', args: [], env: {} },
      },
    });
    expect(body).toContain('[mcp_servers."@playwright/mcp"]');
  });

  it('writes Streamable HTTP MCP server config with env-sourced headers', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      mcpServers: {
        remote: {
          kind: 'http',
          url: 'https://example.com/mcp',
          bearerTokenEnvVar: 'REMOTE_TOKEN',
          httpHeaders: { 'X-Region': 'us-east-1' },
          envHttpHeaders: { Authorization: 'REMOTE_AUTH_HEADER' },
        },
      },
    });
    expect(body).toContain('[mcp_servers.remote]');
    expect(body).toContain('url = "https://example.com/mcp"');
    expect(body).toContain('bearer_token_env_var = "REMOTE_TOKEN"');
    expect(body).toContain('http_headers = { X-Region = "us-east-1" }');
    expect(body).toContain('env_http_headers = { Authorization = "REMOTE_AUTH_HEADER" }');
  });

  it('writes MCP tool policy and timeout knobs', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      mcpServers: {
        gezel: {
          command: 'node',
          args: ['server.js'],
          env: {},
          startupTimeoutSec: 20,
          toolTimeoutSec: 45,
          enabled: true,
          required: true,
          enabledTools: ['list_tasks', 'read_task_notes'],
          disabledTools: ['writeFile'],
          defaultToolsApprovalMode: 'auto',
          toolApprovalModes: { list_tasks: 'approve' },
        },
      },
    });
    expect(body).toContain('startup_timeout_sec = 20');
    expect(body).toContain('tool_timeout_sec = 45');
    expect(body).toContain('enabled = true');
    expect(body).toContain('required = true');
    expect(body).toContain('enabled_tools = ["list_tasks", "read_task_notes"]');
    expect(body).toContain('disabled_tools = ["writeFile"]');
    expect(body).toContain('default_tools_approval_mode = "auto"');
    expect(body).toContain('[mcp_servers.gezel.tools.list_tasks]');
    expect(body).toContain('approval_mode = "approve"');
  });

  it('preserves an intentionally empty enabled_tools allowlist', () => {
    const body = buildCodexConfigToml({
      instructions: 'x',
      model: 'gpt-5.5',
      mcpServers: {
        gezel: { command: 'node', args: [], env: {}, enabledTools: [] },
      },
    });
    expect(body).toContain('enabled_tools = []');
  });
});

describe('writeRuntimeCodexHome', () => {
  it('creates the directory and writes config.toml', async () => {
    const home = join(dir, 'p1', 's1');
    const path = await writeRuntimeCodexHome({
      path: home,
      config: { instructions: 'hi', model: 'gpt-5.5', mcpServers: {} },
      userAuthJsonPath: join(dir, '.codex-fake', 'auth.json'),
    });
    expect(path).toBe(home);
    const body = await readFile(join(home, 'config.toml'), 'utf8');
    expect(body).toContain('instructions = "hi"');
  });

  it('symlinks the user auth.json when present', async () => {
    const fakeCodexDir = join(dir, '.codex-fake');
    await mkdir(fakeCodexDir, { recursive: true });
    const sourceAuth = join(fakeCodexDir, 'auth.json');
    await writeFile(sourceAuth, '{"tokens":"redacted"}', 'utf8');

    const home = join(dir, 'p1', 's1');
    await writeRuntimeCodexHome({
      path: home,
      config: { instructions: 'hi', model: 'gpt-5.5', mcpServers: {} },
      userAuthJsonPath: sourceAuth,
    });

    // Either the symlink points to the source, or the fallback copy
    // landed there — both satisfy the auth-availability contract.
    const linked = await readFile(join(home, 'auth.json'), 'utf8');
    expect(linked).toBe('{"tokens":"redacted"}');
  });

  it('skips auth.json when the source does not exist', async () => {
    const home = join(dir, 'p1', 's1');
    await writeRuntimeCodexHome({
      path: home,
      config: { instructions: 'hi', model: 'gpt-5.5', mcpServers: {} },
      userAuthJsonPath: join(dir, 'no-such', 'auth.json'),
    });
    await expect(stat(join(home, 'auth.json'))).rejects.toThrow();
  });
});
