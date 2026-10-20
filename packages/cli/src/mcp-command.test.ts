import type { HarnessToolsClientStatus, HarnessToolsStatusResponse } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerMcpCommands } from './mcp-command.js';

const CURSOR: HarnessToolsClientStatus = {
  client: 'cursor',
  label: 'Cursor',
  state: 'configured',
  configPath: '/me/.cursor/mcp.json',
  reasons: [],
  canConfigure: true,
  canRemove: true,
};

const CLAUDE: HarnessToolsClientStatus = {
  client: 'claude-code',
  label: 'Claude Code',
  state: 'unavailable',
  reasons: ['Gezel could not find the claude command.'],
  manualCommand: 'claude mcp add --scope user gezel -- node launch.mjs --harness claude-code',
  canConfigure: false,
  canRemove: false,
};

function fixture() {
  const status: HarnessToolsStatusResponse = {
    config: { enabled: true, memory: 'save', images: 'local', newFolders: 'add' },
    clients: [CLAUDE, CURSOR],
    connections: [
      {
        appId: 'harness:cursor:p1',
        client: 'cursor',
        label: 'Cursor',
        projectId: 'p1',
        projectName: 'Website',
        folder: '/work/site',
        createdAt: 1,
        lastUsedAt: 2,
      },
    ],
    blocked: [],
  };
  const client = {
    getHarnessTools: vi.fn().mockResolvedValue(status),
    configureHarnessTools: vi.fn().mockResolvedValue(CURSOR),
    removeHarnessTools: vi.fn().mockResolvedValue({ ...CURSOR, state: 'not-configured' }),
  };
  const lines: string[] = [];
  const program = new Command().exitOverride();
  registerMcpCommands(
    program,
    async () => client as unknown as GezelClient,
    (v) => lines.push(v),
  );
  return {
    client,
    lines,
    run: (...args: string[]) => program.parseAsync(['node', 'gezel', ...args]),
  };
}

describe('gezel mcp', () => {
  it('shows each app, what to run by hand, and who is using the tools', async () => {
    const { run, lines } = fixture();
    await run('mcp', 'status');
    const out = lines.join('\n');
    expect(out).toContain(
      "Gezel's tools in other apps: on (memories: save, images: local, new folders: add)",
    );
    expect(out).toContain('Claude Code: unavailable');
    expect(out).toContain('to set it up yourself: claude mcp add --scope user gezel');
    expect(out).toContain('Cursor: set up');
    expect(out).toContain('Cursor: Website (/work/site)');
  });

  it('installs into one app with its options, and removes it', async () => {
    const { run, client } = fixture();
    await run('mcp', 'install', 'claude-desktop', '--project', 'p1', '--replace');
    expect(client.configureHarnessTools).toHaveBeenCalledWith('claude-desktop', {
      projectId: 'p1',
      replaceExisting: true,
    });
    await run('mcp', 'remove', 'cursor');
    expect(client.removeHarnessTools).toHaveBeenCalledWith('cursor');
  });

  it('names the apps it knows when given another', async () => {
    const { run } = fixture();
    await expect(run('mcp', 'install', 'emacs')).rejects.toThrow(
      /claude-code, claude-desktop, codex, cursor, vscode/,
    );
  });
});
