import type { GezelSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type AiProviderEditabilityConfig,
  projectNativeWorkspaceWritable,
  projectUsesClaude,
  projectUsesCodex,
  resolveProjectClaudePermissionMode,
  resolveProjectWorkspaceAccess,
} from './project-ai-editability.js';

function gezel(id: string, overrides: Partial<GezelSummary> = {}): GezelSummary {
  return {
    id,
    name: id,
    updatedAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

function editable(
  config: AiProviderEditabilityConfig,
  globalGezels: GezelSummary[] = [],
  gezelIds: string[] = [],
  localGezels: GezelSummary[] = [],
): boolean {
  return projectNativeWorkspaceWritable({ gezelIds }, globalGezels, localGezels, config);
}

describe('projectNativeWorkspaceWritable', () => {
  it('treats an editable Codex or Claude CLI install default as implicit edit access', () => {
    expect(editable({ provider: 'codex-cli' })).toBe(true);
    expect(editable({ provider: 'anthropic-cli' })).toBe(true);
  });

  it('keeps explicit CLI plan mode read-only', () => {
    expect(editable({ provider: 'codex-cli', codexCli: { defaultPermissionMode: 'plan' } })).toBe(
      false,
    );
    expect(
      editable(
        {
          provider: 'ollama',
          anthropicCli: { defaultPermissionMode: 'acceptEdits' },
        },
        [gezel('claude', { provider: 'anthropic-cli', claudePermissionMode: 'plan' })],
        ['claude'],
      ),
    ).toBe(false);
  });

  it('lets the project Codex posture override install and legacy gezel defaults', () => {
    expect(
      projectNativeWorkspaceWritable({ gezelIds: [], codexPermissionMode: 'plan' }, [], [], {
        provider: 'codex-cli',
        codexCli: { defaultPermissionMode: 'full' },
      }),
    ).toBe(false);
    expect(
      projectNativeWorkspaceWritable({ gezelIds: [], codexPermissionMode: 'reviewed' }, [], [], {
        provider: 'codex-cli',
        codexCli: { defaultPermissionMode: 'plan' },
      }),
    ).toBe(true);
  });

  it('lets the project Claude posture override install and gezel defaults', () => {
    expect(
      projectNativeWorkspaceWritable({ gezelIds: [], claudePermissionMode: 'plan' }, [], [], {
        provider: 'anthropic-cli',
        anthropicCli: { defaultPermissionMode: 'bypassPermissions' },
      }),
    ).toBe(false);
    expect(
      projectNativeWorkspaceWritable(
        { gezelIds: [], claudePermissionMode: 'acceptEdits' },
        [],
        [],
        { provider: 'anthropic-cli', anthropicCli: { defaultPermissionMode: 'plan' } },
      ),
    ).toBe(true);
  });

  it('detects an assigned gezel override without counting unassigned gezels', () => {
    const config = { provider: 'ollama' } satisfies AiProviderEditabilityConfig;
    const codex = gezel('codex', { provider: 'codex-cli' });
    expect(editable(config, [codex])).toBe(false);
    expect(editable(config, [codex], ['codex'])).toBe(true);
  });

  it('detects project-local CLI gezels', () => {
    expect(
      editable(
        { provider: 'llama-cpp' },
        [],
        [],
        [gezel('local-claude', { provider: 'anthropic-cli' })],
      ),
    ).toBe(true);
  });

  it('only treats Copilot as implicit edit access when its built-in tools are enabled', () => {
    expect(editable({ provider: 'copilot', sandboxCopilot: true })).toBe(false);
    expect(editable({ provider: 'copilot', sandboxCopilot: false })).toBe(true);
    expect(
      editable(
        { provider: 'ollama', sandboxCopilot: true },
        [gezel('copilot', { provider: 'copilot', sandboxCopilot: false })],
        ['copilot'],
      ),
    ).toBe(true);
  });

  it('ignores fixed-function gezels because they do not run their configured provider', () => {
    expect(
      editable(
        { provider: 'ollama' },
        [
          gezel('renderer', {
            provider: 'codex-cli',
            fixedFunction: { tool: 'render_image', promptKey: 'prompt' },
          }),
        ],
        ['renderer'],
      ),
    ).toBe(false);
  });
});

describe('resolveProjectWorkspaceAccess', () => {
  it('reports managed, native, and effective access without conflating them', () => {
    expect(
      resolveProjectWorkspaceAccess(
        {
          workingDir: '/repo',
          managedWorkspaceWritePolicy: 'deny',
          codexPermissionMode: 'edit',
          gezelIds: [],
        },
        [],
        [],
        { provider: 'codex-cli' },
      ),
    ).toEqual({ managedWritable: false, nativeWritable: true, effectiveWritable: true });
  });

  it('does not let managed defaults make a Codex Plan-only project look editable', () => {
    expect(
      resolveProjectWorkspaceAccess({ codexPermissionMode: 'plan', gezelIds: [] }, [], [], {
        provider: 'codex-cli',
      }),
    ).toEqual({ managedWritable: true, nativeWritable: false, effectiveWritable: false });
  });

  it('counts a managed-surface gezel in a mixed-provider project', () => {
    expect(
      resolveProjectWorkspaceAccess(
        { codexPermissionMode: 'plan', gezelIds: ['writer'] },
        [gezel('writer', { provider: 'openai' })],
        [],
        { provider: 'codex-cli' },
      ).effectiveWritable,
    ).toBe(true);
  });
});

describe('projectUsesCodex', () => {
  it('detects the install default and assigned Codex overrides', () => {
    expect(projectUsesCodex({ gezelIds: [] }, [], [], { provider: 'codex-cli' })).toBe(true);
    expect(
      projectUsesCodex(
        { gezelIds: ['builder'] },
        [gezel('builder', { provider: 'codex-cli' })],
        [],
        { provider: 'ollama' },
      ),
    ).toBe(true);
  });

  it('ignores unassigned and fixed-function Codex gezels', () => {
    const codex = gezel('codex', { provider: 'codex-cli' });
    const renderer = gezel('renderer', {
      provider: 'codex-cli',
      fixedFunction: { tool: 'render_image', promptKey: 'prompt' },
    });
    expect(projectUsesCodex({ gezelIds: [] }, [codex], [], { provider: 'ollama' })).toBe(false);
    expect(
      projectUsesCodex({ gezelIds: ['renderer'] }, [renderer], [], { provider: 'ollama' }),
    ).toBe(false);
  });
});

describe('projectUsesClaude', () => {
  it('detects only effective Claude CLI project participants', () => {
    expect(projectUsesClaude({ gezelIds: [] }, [], [], { provider: 'anthropic-cli' })).toBe(true);
    const claude = gezel('claude', { provider: 'anthropic-cli' });
    expect(projectUsesClaude({ gezelIds: [] }, [claude], [], { provider: 'ollama' })).toBe(false);
    expect(projectUsesClaude({ gezelIds: ['claude'] }, [claude], [], { provider: 'ollama' })).toBe(
      true,
    );
  });
});

describe('resolveProjectClaudePermissionMode', () => {
  it('reports a project override or the effective assigned modes', () => {
    const claudePlan = gezel('planner', {
      provider: 'anthropic-cli',
      claudePermissionMode: 'plan',
    });
    const claudeBuilder = gezel('builder', {
      provider: 'anthropic-cli',
      claudePermissionMode: 'acceptEdits',
    });
    expect(
      resolveProjectClaudePermissionMode(
        { gezelIds: ['planner'], claudePermissionMode: 'bypassPermissions' },
        [claudePlan],
        [],
        { provider: 'ollama' },
      ),
    ).toBe('bypassPermissions');
    expect(
      resolveProjectClaudePermissionMode(
        { gezelIds: ['planner', 'builder'] },
        [claudePlan, claudeBuilder],
        [],
        { provider: 'ollama' },
      ),
    ).toBe('mixed');
  });
});
