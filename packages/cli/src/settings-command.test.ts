import type { GezelClient } from '@bendyline/gezel-client';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerProjectSettingsCommands, registerSecurityCommands } from './settings-command.js';

function program(): Command {
  return new Command().exitOverride().configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
}

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
});
