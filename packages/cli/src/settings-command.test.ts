import type { GezelClient } from '@bendyline/gezel-client';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import {
  registerGrowthCommand,
  registerProjectSettingsCommands,
  registerSecurityCommands,
} from './settings-command.js';

function program(): Command {
  return new Command().exitOverride().configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
}

describe('gezel security level', () => {
  async function run(args: string[], config: Record<string, unknown> = {}) {
    const client = {
      getConfig: vi.fn().mockResolvedValue(config),
      updateConfig: vi.fn().mockResolvedValue({}),
    };
    const lines: string[] = [];
    const output = vi.spyOn(console, 'log').mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      const command = program();
      registerSecurityCommands(
        command,
        (async () => client) as () => Promise<Pick<GezelClient, 'getConfig' | 'updateConfig'>>,
      );
      await command.parseAsync(['security', 'level', ...args], { from: 'user' });
    } finally {
      output.mockRestore();
    }
    return { client, lines };
  }

  it('shows the fail-safe default and what it allows when nothing is stored', async () => {
    const { client, lines } = await run([]);
    expect(client.updateConfig).not.toHaveBeenCalled();
    expect(lines[0]).toBe('Security level: Lockdown (lockdown)');
    expect(lines.join('\n')).toMatch(/Cloud models\s+on/);
    expect(lines.join('\n')).toMatch(/Web search, mail and other outside services\s+off/);
  });

  it('writes every capability of a preset in one update', async () => {
    const { client, lines } = await run(['set', 'super-lockdown']);
    expect(client.updateConfig).toHaveBeenCalledWith({
      securityPolicy: {
        level: 'super-lockdown',
        allowFileEdits: false,
        allowExternalChat: false,
        allowExternalServices: false,
        allowScriptExecution: false,
        allowAppNetwork: false,
        allowPackageScriptEdits: false,
        allowPackageScriptExecution: false,
      },
    });
    expect(lines[0]).toBe('Security level: Super Lockdown (super-lockdown)');
  });

  it('accepts the Settings name for free and reports custom combinations as custom', async () => {
    const set = await run(['set', 'unrestricted', '--json']);
    expect(JSON.parse(set.lines[0]!)).toMatchObject({ level: 'free', allowExternalServices: true });
    const shown = await run(['show', '--json'], {
      securityPolicy: { ...{ level: 'lockdown' }, allowExternalChat: false },
    });
    expect(JSON.parse(shown.lines[0]!)).toMatchObject({
      level: 'custom',
      allowExternalChat: false,
    });
  });

  it('refuses unknown levels and malformed commands before connecting', async () => {
    await expect(run(['set', 'paranoid'])).rejects.toThrow(/Unknown security level "paranoid"/);
    await expect(run(['set'])).rejects.toThrow(/Name a level/);
    await expect(run(['lockdown'])).rejects.toThrow(/level show/);
    await expect(run(['show', 'free'])).rejects.toThrow(/level set <level>/);
  });
});

describe('explicit settings commands', () => {
  it('updates external-service access without dropping the rest of the security policy', async () => {
    const client = {
      getConfig: vi.fn().mockResolvedValue({
        securityPolicy: {
          level: 'custom',
          allowExternalServices: false,
          allowFileEdits: false,
        },
      }),
      updateConfig: vi.fn().mockResolvedValue({}),
    };
    const connect = vi.fn().mockResolvedValue(client);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const command = program();
      registerSecurityCommands(
        command,
        connect as () => Promise<Pick<GezelClient, 'getConfig' | 'updateConfig'>>,
      );

      await command.parseAsync(['security', 'external-services', 'on', '--json'], {
        from: 'user',
      });

      expect(client.updateConfig).toHaveBeenCalledWith({
        securityPolicy: expect.objectContaining({
          level: 'custom',
          allowExternalServices: true,
          allowFileEdits: false,
        }),
      });
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
        allowExternalServices: true,
      });
    } finally {
      output.mockRestore();
    }
  });

  it('rejects ambiguous setting values before connecting', async () => {
    const connect = vi.fn();
    const command = program();
    registerSecurityCommands(
      command,
      connect as () => Promise<Pick<GezelClient, 'getConfig' | 'updateConfig'>>,
    );

    await expect(
      command.parseAsync(['security', 'external-services', 'yes'], { from: 'user' }),
    ).rejects.toThrow('Use on or off');
    expect(connect).not.toHaveBeenCalled();
  });

  it('reads and updates indexing for the resolved project', async () => {
    const client = {
      getProject: vi.fn().mockResolvedValue({ id: 'project-one', indexingEnabled: undefined }),
      updateProject: vi.fn().mockResolvedValue({ id: 'project-one', indexingEnabled: false }),
    };
    const connect = vi.fn().mockResolvedValue(client);
    const projectFor = vi.fn().mockResolvedValue('project-one');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const read = program();
      registerProjectSettingsCommands(read, connect as () => Promise<GezelClient>, projectFor);
      await read.parseAsync(['indexing', '--json'], { from: 'user' });
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
        projectId: 'project-one',
        indexingEnabled: true,
      });

      output.mockClear();
      const update = program();
      registerProjectSettingsCommands(update, connect as () => Promise<GezelClient>, projectFor);
      await update.parseAsync(['indexing', 'off', '--json'], { from: 'user' });
      expect(client.updateProject).toHaveBeenCalledWith('project-one', {
        indexingEnabled: false,
      });
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
        projectId: 'project-one',
        indexingEnabled: false,
      });
    } finally {
      output.mockRestore();
    }
  });

  it('shows growth as on by default and switches it off for the home', async () => {
    const client = {
      getConfig: vi.fn().mockResolvedValue({}),
      updateConfig: vi.fn().mockResolvedValue({ growth: { enabled: false } }),
    };
    const connect = vi.fn().mockResolvedValue(client);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const read = program();
      registerGrowthCommand(
        read,
        connect as () => Promise<Pick<GezelClient, 'getConfig' | 'updateConfig'>>,
      );
      await read.parseAsync(['growth'], { from: 'user' });
      expect(output.mock.calls[0]?.[0]).toBe('Growth (XP and level-ups): on');
      expect(client.updateConfig).not.toHaveBeenCalled();

      output.mockClear();
      const update = program();
      registerGrowthCommand(
        update,
        connect as () => Promise<Pick<GezelClient, 'getConfig' | 'updateConfig'>>,
      );
      await update.parseAsync(['growth', 'off', '--json'], { from: 'user' });
      expect(client.updateConfig).toHaveBeenCalledWith({ growth: { enabled: false } });
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ growthEnabled: false });

      const ambiguous = program();
      const unused = vi.fn();
      registerGrowthCommand(
        ambiguous,
        unused as () => Promise<Pick<GezelClient, 'getConfig' | 'updateConfig'>>,
      );
      await expect(ambiguous.parseAsync(['growth', 'no'], { from: 'user' })).rejects.toThrow(
        'Use on or off',
      );
      expect(unused).not.toHaveBeenCalled();
    } finally {
      output.mockRestore();
    }
  });
});
