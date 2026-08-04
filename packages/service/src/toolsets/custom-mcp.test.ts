import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecretKey, SecretStore } from '../secrets/types.js';
import {
  customMcpToolsetId,
  discoverProjectMcpToolsets,
  importedRuntimeFor,
  parseMcpConfigText,
  resolveImportedMcpRuntime,
  resolveMcpDefinition,
  storeImportedMcpSecrets,
} from './custom-mcp.js';

const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('custom MCP configuration', () => {
  it('parses VS Code JSONC stdio and HTTP servers without corrupting string commas', () => {
    const parsed = parseMcpConfigText(`{
      // Workspace MCP servers
      "servers": {
        "local": {
          "type": "stdio",
          "command": "node",
          "args": ["server.js", "value,}"],
          "env": { "MODE": "test" },
        },
        "remote": {
          "type": "http",
          "url": "https://example.test/mcp",
          "headers": { "Authorization": "Bearer token" },
        },
      },
    }`);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.servers).toEqual([
      {
        name: 'local',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', 'value,}'],
        env: { MODE: 'test' },
        headers: {},
      },
      {
        name: 'remote',
        transport: 'streamable-http',
        args: [],
        env: {},
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer token' },
      },
    ]);
  });

  it('accepts the common mcpServers envelope and skips unresolved prompt inputs', () => {
    const parsed = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          claudeStyle: { command: 'uvx', args: ['mcp-server-fetch'] },
          needsPrompt: {
            command: 'node',
            env: { TOKEN: '${input:api-key}' },
          },
          disabled: { command: 'node', disabled: true },
        },
      }),
    );

    expect(parsed.servers.map((server) => server.name)).toEqual(['claudeStyle']);
    expect(parsed.warnings).toEqual([
      {
        serverName: 'needsPrompt',
        message:
          'Uses unsupported input variable ${input:api-key}; replace it with an environment variable or literal value',
      },
      { serverName: 'disabled', message: 'Server is disabled and was skipped' },
    ]);
  });

  it('discovers project files with Gezel > VS Code > root precedence', async () => {
    const workspace = await tempWorkspace();
    await mkdir(join(workspace, '.gezel'), { recursive: true });
    await mkdir(join(workspace, '.vscode'), { recursive: true });
    await writeFile(
      join(workspace, '.gezel/mcp.json'),
      JSON.stringify({
        servers: {
          primary: { command: 'node', args: ['gezel.js'], env: { TOKEN: 'not-in-roster' } },
        },
      }),
    );
    await writeFile(
      join(workspace, '.vscode/mcp.json'),
      JSON.stringify({
        servers: {
          primary: { command: 'node', args: ['vscode.js'] },
          secondary: { command: 'node', args: ['secondary.js'] },
        },
      }),
    );
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: { tertiary: { command: 'node', args: ['third.js'] } },
      }),
    );

    const discovered = await discoverProjectMcpToolsets(workspace, 'project-1');
    expect(discovered.toolsets.map((entry) => entry.definition.name)).toEqual([
      'primary',
      'secondary',
      'tertiary',
    ]);
    expect(discovered.toolsets[0]?.installed.runtime).toMatchObject({
      kind: 'custom-mcp',
      source: { kind: 'project-file', relativePath: '.gezel/mcp.json' },
    });
    expect(JSON.stringify(discovered.toolsets.map((entry) => entry.installed))).not.toContain(
      'not-in-roster',
    );
    expect(discovered.warnings).toContainEqual({
      serverName: 'primary',
      message: '.vscode/mcp.json: overridden by a higher-priority project MCP config',
    });
  });

  it('does not adopt executable MCP configuration from a machine-shared workspace', async () => {
    const workspace = await tempWorkspace();
    await writeFile(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          attacker: { command: 'node', args: ['other-account-controlled.js'] },
        },
      }),
    );

    const discovered = await discoverProjectMcpToolsets(workspace, 'shared-project', {
      allowProjectFiles: false,
    });
    expect(discovered).toEqual({ toolsets: [], warnings: [] });
  });

  it('expands workspace/env variables, loads envFile, and sets the project cwd', async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace, '.mcp.env'), 'FROM_FILE=wood\n');
    const knownSecrets = new Set<string>();
    const spec = await resolveMcpDefinition(
      {
        name: 'local',
        transport: 'stdio',
        command: 'node',
        args: ['${workspaceFolder}/server.js', '${TOKEN}', '${FROM_FILE}'],
        envFile: '.mcp.env',
        env: { TOKEN: 'bench' },
        headers: {},
      },
      { workspaceDir: workspace, knownSecretValues: knownSecrets },
    );

    expect(spec).toEqual({
      kind: 'stdio',
      command: 'node',
      args: [`${workspace}/server.js`, 'bench', 'wood'],
      env: { FROM_FILE: 'wood', TOKEN: 'bench' },
      cwd: workspace,
    });
    expect(knownSecrets).toEqual(new Set(['wood', 'bench']));
  });

  it('keeps explicitly imported env and headers in SecretStore', async () => {
    const secrets = memorySecrets();
    const scope = { kind: 'project' as const, projectId: 'p1' };
    const definition = {
      name: 'remote',
      transport: 'streamable-http' as const,
      args: [],
      env: { API_HOST: 'example.test' },
      url: 'https://${API_HOST}/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    };
    const toolsetId = customMcpToolsetId(scope, definition.name);
    const runtime = importedRuntimeFor(definition, 'pasted.json');
    await storeImportedMcpSecrets(secrets, toolsetId, definition);

    expect(JSON.stringify(runtime)).not.toContain('secret-token');
    expect(JSON.stringify(runtime)).not.toContain('example.test');
    const knownSecrets = new Set<string>();
    const spec = await resolveImportedMcpRuntime({
      runtime,
      toolsetId,
      secrets,
      workspaceDir: '/tmp/project',
      knownSecretValues: knownSecrets,
    });
    expect(spec).toEqual({
      kind: 'http',
      transport: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(knownSecrets).toEqual(new Set(['example.test', 'Bearer secret-token']));
  });
});

async function tempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-custom-mcp-'));
  dirs.push(dir);
  return dir;
}

function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  const key = (secret: SecretKey) =>
    secret.kind === 'toolset'
      ? `toolset:${secret.toolsetId}:${secret.fieldId}`
      : secret.kind === 'providerCredential'
        ? `provider:${secret.name}`
        : 'device';
  return {
    backend: 'file',
    async get(secret) {
      return values.get(key(secret)) ?? null;
    },
    async set(secret, value) {
      values.set(key(secret), value);
    },
    async delete(secret) {
      values.delete(key(secret));
    },
    async has(secret) {
      return values.has(key(secret));
    },
    async listForToolset(toolsetId) {
      const prefix = `toolset:${toolsetId}:`;
      return [...values.keys()]
        .filter((item) => item.startsWith(prefix))
        .map((item) => item.slice(prefix.length));
    },
  };
}
