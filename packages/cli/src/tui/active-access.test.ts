import type { ConfigResponse } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import { activeAccessMode } from './active-access.js';

describe('activeAccessMode', () => {
  it('uses the project workspace gate for local and ordinary cloud providers', () => {
    expect(activeAccessMode({ provider: 'mlx', project: {}, gezel: undefined, config: null })).toBe(
      'editable',
    );
    expect(
      activeAccessMode({
        provider: 'llama-cpp',
        project: { workingDir: '/repo' },
        gezel: undefined,
        config: null,
      }),
    ).toBe('read-only');
    expect(
      activeAccessMode({
        provider: 'openai',
        project: { workingDir: '/repo', managedWorkspaceWritePolicy: 'allow' },
        gezel: undefined,
        config: null,
      }),
    ).toBe('editable');
  });

  it('surfaces the effective Codex execution posture with project precedence', () => {
    const config = {
      codexCli: { defaultPermissionMode: 'full' },
    } as ConfigResponse;
    const gezel = {
      id: 'builder',
      name: 'Builder',
      codexPermissionMode: 'edit' as const,
      updatedAt: '2026-08-08T00:00:00.000Z',
    };
    expect(
      activeAccessMode({
        provider: 'codex-cli',
        project: { codexPermissionMode: 'plan' },
        gezel,
        config,
      }),
    ).toBe('read-only');
    expect(
      activeAccessMode({
        provider: 'codex-cli',
        project: { codexPermissionMode: 'reviewed' },
        gezel,
        config,
      }),
    ).toBe('reviewed edits');
    expect(activeAccessMode({ provider: 'codex-cli', project: {}, gezel: undefined, config })).toBe(
      'full access',
    );
  });

  it('accounts for Claude Plan and unsandboxed Copilot bypasses', () => {
    expect(
      activeAccessMode({
        provider: 'anthropic-cli',
        project: {},
        gezel: {
          id: 'reviewer',
          name: 'Reviewer',
          claudePermissionMode: 'plan',
          updatedAt: '2026-08-08T00:00:00.000Z',
        },
        config: null,
      }),
    ).toBe('read-only');
    expect(
      activeAccessMode({
        provider: 'anthropic-cli',
        project: { claudePermissionMode: 'bypassPermissions' },
        gezel: {
          id: 'reviewer',
          name: 'Reviewer',
          claudePermissionMode: 'plan',
          updatedAt: '2026-08-08T00:00:00.000Z',
        },
        config: null,
      }),
    ).toBe('full access');
    expect(
      activeAccessMode({
        provider: 'copilot',
        project: { workingDir: '/repo' },
        gezel: undefined,
        config: { sandboxCopilot: false },
      }),
    ).toBe('editable');
  });

  it('falls back cleanly when an older core package lacks the shared resolver', () => {
    const reflectGet = Reflect.get.bind(Reflect);
    const get = vi
      .spyOn(Reflect, 'get')
      .mockImplementation((target, key, receiver) =>
        key === 'resolveGezelWorkspaceAccess'
          ? undefined
          : receiver === undefined
            ? reflectGet(target, key)
            : reflectGet(target, key, receiver),
      );
    try {
      expect(
        activeAccessMode({
          provider: 'codex-cli',
          project: { codexPermissionMode: 'reviewed' },
          gezel: undefined,
          config: null,
        }),
      ).toBe('reviewed edits');
      expect(
        activeAccessMode({
          provider: 'openai',
          project: { workingDir: '/repo', managedWorkspaceWritePolicy: 'allow' },
          gezel: undefined,
          config: null,
        }),
      ).toBe('editable');
    } finally {
      get.mockRestore();
    }
  });
});
