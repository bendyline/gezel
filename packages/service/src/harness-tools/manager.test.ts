import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type GezelConfig, HARNESS_DOCUMENT_TOOL_NAMES, HARNESS_TOOL_NAMES } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TokenStore, createTokenStore } from '../http/token-store.js';
import { readJsonMember, upsertJsonMember } from '../local-harness/json-member.js';
import { readTomlMcpServer, writeSetupRecord } from './clients.js';
import { ensureHarnessLauncher, resolveHarnessNode } from './launcher.js';
import { HarnessToolsManager, type HarnessToolsManagerOptions } from './manager.js';

let root: string;
let home: string;
let userHome: string;
let config: GezelConfig;
let tokenStore: TokenStore;
let commands: Array<{ command: string; args: string[] }>;

const NODE = '/opt/node/bin/node';
const execFileAsync = promisify(execFile);
const launcherPath = () => join(home, 'integrations', 'mcp', 'launch.mjs');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gezel-harness-tools-'));
  home = join(root, 'gezel-home');
  userHome = join(root, 'me');
  await mkdir(home, { recursive: true });
  await mkdir(userHome, { recursive: true });
  config = {} as GezelConfig;
  tokenStore = await createTokenStore({ home, rootToken: 'ROOT' });
  commands = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manager(overrides: Partial<HarnessToolsManagerOptions> = {}): HarnessToolsManager {
  return new HarnessToolsManager({
    home,
    userHome,
    env: { APPDATA: join(userHome, 'AppData', 'Roaming') },
    platform: 'win32',
    store: {
      readConfig: async () => config,
      writeConfig: async (patch: Partial<GezelConfig>) => {
        config = { ...config, ...patch };
        return config;
      },
      getProject: async (id: string) =>
        (id === 'p1' ? { id: 'p1', name: 'Website' } : null) as never,
    } as never,
    tokenStore,
    launcher: () =>
      ensureHarnessLauncher({ home, entry: '/srv/gezel-mcp/dist/harness.js', node: NODE }),
    claudeBinary: async () => null,
    codexBinary: async () => null,
    vscodeProfiles: async () => [],
    run: async (command, args) => {
      commands.push({ command, args });
      return '';
    },
    ...overrides,
  });
}

const statusOf = async (m: HarnessToolsManager, client: string) =>
  (await m.status()).clients.find((c) => c.client === client)!;

describe('the launcher', () => {
  it('writes a stable launcher that follows this install', async () => {
    const first = await ensureHarnessLauncher({ home, entry: '/a/harness.js', node: NODE });
    expect(first.launcherPath).toBe(launcherPath());
    expect(await readFile(first.launcherPath, 'utf8')).toContain(
      'await import(pathToFileURL(entry).href)',
    );
    const pointer = join(home, 'integrations', 'mcp', 'current.json');
    expect(JSON.parse(await readFile(pointer, 'utf8'))).toEqual({ entry: '/a/harness.js' });
    await ensureHarnessLauncher({ home, entry: '/b/harness.js', node: NODE });
    expect(JSON.parse(await readFile(pointer, 'utf8'))).toEqual({ entry: '/b/harness.js' });
  });

  it('starts the server against the home that wrote it, unless the app names one', async () => {
    const probe = join(root, 'probe.mjs');
    await writeFile(probe, 'process.stdout.write(process.env.GEZEL_HOME ?? "unset");\n');
    const { launcherPath: path } = await ensureHarnessLauncher({ home, entry: probe, node: NODE });
    const run = (env: NodeJS.ProcessEnv) =>
      execFileAsync(process.execPath, [path], { env }).then((r) => r.stdout);
    const { GEZEL_HOME: _ignored, ...inherited } = process.env;
    expect(await run(inherited)).toBe(home);
    expect(await run({ ...inherited, GEZEL_HOME: join(root, 'other') })).toBe(join(root, 'other'));
  });

  it('never hands an app the Electron binary, or a pinned Node that is gone', () => {
    // NODE does not exist on disk here, and inside Electron execPath is Electron itself.
    expect(
      resolveHarnessNode({
        home,
        env: { GEZEL_NODE_PATH: NODE, PATH: '' },
        execPath: '/electron',
        isElectron: true,
      }),
    ).toBeNull();
    expect(
      resolveHarnessNode({ home, env: {}, execPath: '/usr/bin/node', isElectron: false }),
    ).toBe('/usr/bin/node');
  });
});

describe('Cursor', () => {
  it('reports not installed until Cursor has its folder', async () => {
    expect((await statusOf(manager(), 'cursor')).state).toBe('unavailable');
    await mkdir(join(userHome, '.cursor'));
    expect((await statusOf(manager(), 'cursor')).state).toBe('not-configured');
  });

  it('adds, recognizes and removes its own entry, leaving the rest of mcp.json', async () => {
    await mkdir(join(userHome, '.cursor'));
    const path = join(userHome, '.cursor', 'mcp.json');
    await writeFile(path, '{\n  "mcpServers": {\n    "github": { "command": "gh-mcp" }\n  }\n}\n');
    const m = manager();
    const after = await m.configure('cursor', {});
    expect(after.state).toBe('configured');
    const entry = readJsonMember(await readFile(path, 'utf8'), ['mcpServers', 'gezel']);
    expect(entry).toEqual({
      command: NODE,
      args: [launcherPath(), '--harness', 'cursor', '--folder', '${workspaceFolder}'],
    });
    await m.remove('cursor');
    const left = await readFile(path, 'utf8');
    expect(readJsonMember(left, ['mcpServers', 'gezel'])).toBeUndefined();
    expect(readJsonMember(left, ['mcpServers', 'github'])).toEqual({ command: 'gh-mcp' });
  });

  it('never replaces a gezel entry it did not write without being asked, and backs it up when it does', async () => {
    await mkdir(join(userHome, '.cursor'));
    const path = join(userHome, '.cursor', 'mcp.json');
    await writeFile(
      path,
      upsertJsonMember(null, ['mcpServers', 'gezel'], {
        command: 'npx',
        args: ['@bendyline/gezel-mcp'],
      }),
    );
    const m = manager();
    expect((await statusOf(m, 'cursor')).state).toBe('conflict');
    await expect(m.configure('cursor', {})).rejects.toMatchObject({ code: 'conflict' });
    await expect(m.remove('cursor')).rejects.toMatchObject({ code: 'conflict' });
    await m.configure('cursor', { replaceExisting: true });
    expect(await readdir(join(userHome, '.cursor'))).toContain('mcp.json.backup');
    expect((await statusOf(m, 'cursor')).state).toBe('configured');
  });

  it('repairs an entry it wrote for an older launch command at start', async () => {
    await mkdir(join(userHome, '.cursor'));
    const path = join(userHome, '.cursor', 'mcp.json');
    const old = {
      command: '/old/node',
      args: [launcherPath(), '--harness', 'cursor', '--folder', '${workspaceFolder}'],
    };
    await writeFile(path, upsertJsonMember(null, ['mcpServers', 'gezel'], old));
    await writeSetupRecord(home, { version: 1, client: 'cursor', spec: old, at: 'then' });
    const m = manager();
    expect((await statusOf(m, 'cursor')).state).toBe('update-needed');
    await m.reconcile();
    expect((await statusOf(m, 'cursor')).state).toBe('configured');
  });
});

describe('Claude Desktop', () => {
  it('works in the project the person picks', async () => {
    const dir = join(userHome, 'AppData', 'Roaming', 'Claude');
    await mkdir(dir, { recursive: true });
    const m = manager();
    await expect(m.configure('claude-desktop', { projectId: 'missing' })).rejects.toMatchObject({
      status: 404,
    });
    const status = await m.configure('claude-desktop', { projectId: 'p1' });
    expect(status).toMatchObject({ state: 'configured', projectId: 'p1' });
    const entry = readJsonMember(await readFile(join(dir, 'claude_desktop_config.json'), 'utf8'), [
      'mcpServers',
      'gezel',
    ]) as { args: string[] };
    expect(entry.args).toEqual([launcherPath(), '--harness', 'claude-desktop', '--project', 'p1']);
  });

  it('finds the Store-style Windows build, which keeps no %APPDATA%\\Claude folder', async () => {
    const local = join(userHome, 'AppData', 'Local');
    const virtualized = join(
      local,
      'Packages',
      'Claude_pzs8sxrjxfjjc',
      'LocalCache',
      'Roaming',
      'Claude',
    );
    await mkdir(virtualized, { recursive: true });
    const m = manager();
    expect(await statusOf(m, 'claude-desktop')).toMatchObject({
      state: 'not-configured',
      configPath: join(virtualized, 'claude_desktop_config.json'),
    });

    const current = join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc');
    await mkdir(current, { recursive: true });
    await writeFile(join(current, 'claude_desktop_config.json'), '{"preferences": {}}\n');
    await m.configure('claude-desktop', { projectId: 'p1' });
    const config = await readFile(join(current, 'claude_desktop_config.json'), 'utf8');
    expect(readJsonMember(config, ['preferences'])).toEqual({});
    expect(readJsonMember(config, ['mcpServers', 'gezel'])).toMatchObject({
      args: [launcherPath(), '--harness', 'claude-desktop', '--project', 'p1'],
    });
  });

  it('is unavailable on Linux', async () => {
    expect((await statusOf(manager({ platform: 'linux' }), 'claude-desktop')).state).toBe(
      'unavailable',
    );
  });
});

describe('apps with their own MCP command', () => {
  it('offers the command to run by hand when the app is not found', async () => {
    const status = await statusOf(manager(), 'claude-code');
    expect(status.state).toBe('unavailable');
    expect(status.canConfigure).toBe(false);
    expect(status.manualCommand).toContain('claude mcp add --scope user gezel --');
    expect(status.manualCommand).toContain('--harness claude-code');
  });

  it('sets Claude Code up through its own command and reads the result back', async () => {
    const claudeJson = join(userHome, '.claude.json');
    const m = manager({
      claudeBinary: async () => '/bin/claude',
      run: async (command, args) => {
        commands.push({ command, args });
        if (args[1] === 'add') {
          const dashdash = args.indexOf('--');
          await writeFile(
            claudeJson,
            JSON.stringify({
              mcpServers: {
                gezel: {
                  type: 'stdio',
                  command: args[dashdash + 1],
                  args: args.slice(dashdash + 2),
                  env: {},
                },
              },
            }),
          );
        }
        if (args[1] === 'remove') await writeFile(claudeJson, '{"mcpServers": {}}');
        return '';
      },
    });
    expect((await m.configure('claude-code', {})).state).toBe('configured');
    expect(commands.at(-1)).toEqual({
      command: '/bin/claude',
      args: [
        'mcp',
        'add',
        '--scope',
        'user',
        'gezel',
        '--',
        NODE,
        launcherPath(),
        '--harness',
        'claude-code',
      ],
    });
    expect((await m.remove('claude-code')).state).toBe('not-configured');
    expect(commands.at(-1)?.args).toEqual(['mcp', 'remove', '--scope', 'user', 'gezel']);
  });

  it('reads the gezel server out of a Codex config.toml', () => {
    const toml = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.gezel]',
      `command = "C:\\\\gezel\\\\node.exe"`,
      'args = [\'C:\\x\\launch.mjs\', "--harness", "codex"]',
      '',
      '[mcp_servers.other]',
      'command = "x"',
    ].join('\n');
    expect(readTomlMcpServer(toml, 'gezel')).toEqual({
      command: 'C:\\gezel\\node.exe',
      args: ['C:\\x\\launch.mjs', '--harness', 'codex'],
    });
    expect(readTomlMcpServer('[mcp_servers.other]\ncommand = "x"', 'gezel')).toBeUndefined();
  });
});

describe('VS Code', () => {
  it('writes the chosen profile’s mcp.json with the workspace folder', async () => {
    const profileDir = join(root, 'Code', 'User');
    await mkdir(profileDir, { recursive: true });
    const m = manager({
      vscodeProfiles: async () => [
        { id: 'code:default', label: 'Default profile', dir: profileDir },
      ],
    });
    const status = await m.configure('vscode', { profileId: 'code:default' });
    expect(status).toMatchObject({ state: 'configured', profileId: 'code:default' });
    expect(
      readJsonMember(await readFile(join(profileDir, 'mcp.json'), 'utf8'), ['servers', 'gezel']),
    ).toEqual({
      type: 'stdio',
      command: NODE,
      args: [launcherPath(), '--harness', 'vscode', '--folder', '${workspaceFolder}'],
    });
    await expect(m.configure('vscode', { profileId: 'nope' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('the person’s choices', () => {
  it('saves them and revokes every harness token so apps learn them', async () => {
    const token = tokenStore.issueHarness({ client: 'codex', projectId: 'p1', appName: 'Codex' });
    const status = await manager().updateConfig({ memory: 'read', images: 'off' });
    expect(status.config).toMatchObject({
      enabled: true,
      memory: 'read',
      images: 'off',
      newFolders: 'add',
    });
    expect(config.harnessTools).toMatchObject({ memory: 'read', images: 'off' });
    expect(tokenStore.lookup(token.token)).toBeNull();
  });

  it('lists live connections, stops one for its folder, and undoes it', async () => {
    tokenStore.issueHarness({
      client: 'cursor',
      projectId: 'p1',
      appName: 'Cursor',
      folder: '/work/site',
    });
    const m = manager();
    const before = await m.status();
    expect(before.connections).toEqual([
      expect.objectContaining({
        appId: 'harness:cursor:p1',
        label: 'Cursor',
        projectName: 'Website',
        folder: '/work/site',
      }),
    ]);
    const stopped = await m.stopConnection('harness:cursor:p1');
    expect(stopped.connections).toEqual([]);
    expect(stopped.blocked).toEqual([
      { client: 'cursor', projectId: 'p1', label: 'Cursor', projectName: 'Website' },
    ]);
    const undone = await m.unblock({ client: 'cursor', projectId: 'p1' });
    expect(undone.blocked).toEqual([]);
  });

  it('says why no app can connect under lockdown', async () => {
    config = {
      securityPolicy: {
        level: 'super-lockdown',
        allowFileEdits: false,
        allowExternalChat: false,
        allowExternalServices: false,
        allowScriptExecution: false,
        allowAppNetwork: false,
      },
    } as GezelConfig;
    expect((await manager().status()).unavailableReason).toMatch(/security level/);
  });
});

describe('the launcher, run as an app runs it', () => {
  it('starts the harness server, which says to open Gezel when it is not running', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { resolveHarnessEntry } = await import('./launcher.js');
    const launcher = await ensureHarnessLauncher({
      home,
      entry: resolveHarnessEntry(),
      node: process.execPath,
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] =>
          typeof pair[1] === 'string' && !pair[0].startsWith('GEZEL_'),
      ),
    );
    const client = new Client({ name: 'launcher-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [launcher.launcherPath, '--harness', 'cursor', '--folder', root],
        env: { ...env, GEZEL_HOME: join(root, 'no-gezel-here') },
        stderr: 'pipe',
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [...HARNESS_TOOL_NAMES, ...HARNESS_DOCUMENT_TOOL_NAMES].sort(),
      );
      const status = await client.callTool({ name: 'gezel_status', arguments: {} });
      expect(status.isError).toBe(true);
      expect(JSON.stringify(status.content)).toContain("Gezel isn't running");
    } finally {
      await client.close();
    }
  }, 30_000);
});
