import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_COPILOT,
  DEFAULT_SECURITY_LEVEL,
  SECURITY_PRESETS,
  classifySecurityLevel,
  projectManagedWorkspaceWritable,
  projectManagedWorkspaceWritePolicy,
  providerNativeWorkspaceAccess,
  resolveGezelWorkspaceAccess,
  resolveSandboxCopilot,
  resolveSecurityPolicy,
  securityPolicyForLevel,
} from './policy.js';

describe('resolveSandboxCopilot', () => {
  it('defaults an absent setting to the scoped MCP sandbox', () => {
    expect(DEFAULT_SANDBOX_COPILOT).toBe(true);
    expect(resolveSandboxCopilot(undefined)).toBe(true);
  });

  it('preserves explicit install and per-gezel opt-outs', () => {
    expect(resolveSandboxCopilot(false)).toBe(false);
    expect(resolveSandboxCopilot(true, false)).toBe(false);
    expect(resolveSandboxCopilot(false, true)).toBe(true);
  });
});

describe('resolveSecurityPolicy', () => {
  it('resolves an absent policy to the fail-safe lockdown posture', () => {
    const resolved = resolveSecurityPolicy({});
    expect(DEFAULT_SECURITY_LEVEL).toBe('lockdown');
    expect(resolved.level).toBe('lockdown');
    expect(resolved.allowFileEdits).toBe(true);
    expect(resolved.allowExternalChat).toBe(true);
    expect(resolved.allowExternalServices).toBe(false);
    expect(resolved.allowScriptExecution).toBe(true);
    expect(resolved.allowAppNetwork).toBe(true);
    expect(resolved.allowNonBuiltinToolsets).toBe(false);
    expect(resolved.allowModelGit).toBe(true);
    expect(resolved.allowMail).toBe(false);
  });

  it('locks everything down under super-lockdown', () => {
    const resolved = resolveSecurityPolicy({
      securityPolicy: securityPolicyForLevel('super-lockdown'),
    });
    expect(resolved.allowFileEdits).toBe(false);
    expect(resolved.allowExternalChat).toBe(false);
    expect(resolved.allowExternalServices).toBe(false);
    expect(resolved.allowScriptExecution).toBe(false);
    expect(resolved.allowAppNetwork).toBe(false);
    expect(resolved.allowNonBuiltinToolsets).toBe(false);
    expect(resolved.allowModelGit).toBe(false);
    // Mail sync + send ride on external services → off under super-lockdown.
    expect(resolved.allowMail).toBe(false);
  });

  it('enables coding posture but not open-web research under lockdown', () => {
    const resolved = resolveSecurityPolicy({
      securityPolicy: securityPolicyForLevel('lockdown'),
    });
    expect(resolved.allowFileEdits).toBe(true);
    expect(resolved.allowScriptExecution).toBe(true);
    expect(resolved.allowExternalChat).toBe(true);
    expect(resolved.allowAppNetwork).toBe(true);
    // Services off → no general web research…
    expect(resolved.allowExternalServices).toBe(false);
    // …and no unconfined third-party MCP toolsets…
    expect(resolved.allowNonBuiltinToolsets).toBe(false);
    // …but GitHub R/W rides on file edits, which is on.
    expect(resolved.allowModelGit).toBe(true);
    // Mail also rides on external services → off under lockdown.
    expect(resolved.allowMail).toBe(false);
  });

  it('treats the five stored booleans as authoritative over the label', () => {
    // A hand-tampered "free" label with edits actually off must NOT grant edits.
    const resolved = resolveSecurityPolicy({
      securityPolicy: {
        level: 'free',
        allowFileEdits: false,
        allowExternalChat: true,
        allowExternalServices: true,
        allowScriptExecution: true,
        allowAppNetwork: true,
      },
    });
    expect(resolved.allowFileEdits).toBe(false);
    expect(resolved.allowModelGit).toBe(false);
  });
});

describe('projectManagedWorkspaceWritable', () => {
  it('is independent of the global file-adjacent capability gate', () => {
    const policy = resolveSecurityPolicy({
      securityPolicy: securityPolicyForLevel('super-lockdown'),
    });

    expect(policy.allowFileEdits).toBe(false);
    expect(projectManagedWorkspaceWritable({})).toBe(true);
    expect(projectManagedWorkspaceWritable({ workingDir: '/home/user/repo' })).toBe(false);
    expect(
      projectManagedWorkspaceWritable({
        workingDir: '/home/user/repo',
        allowGezelWrites: true,
      }),
    ).toBe(true);
  });

  it('defaults internal workspaces to writable', () => {
    expect(projectManagedWorkspaceWritable({})).toBe(true);
    expect(projectManagedWorkspaceWritable(undefined)).toBe(true);
    expect(projectManagedWorkspaceWritable(null)).toBe(true);
  });

  it('defaults external working dirs to read-only (consent gate)', () => {
    expect(projectManagedWorkspaceWritable({ workingDir: '/home/user/repo' })).toBe(false);
  });

  it('lets the explicit flag win in both directions', () => {
    expect(
      projectManagedWorkspaceWritable({
        workingDir: '/home/user/repo',
        managedWorkspaceWritePolicy: 'allow',
      }),
    ).toBe(true);
    expect(projectManagedWorkspaceWritable({ managedWorkspaceWritePolicy: 'deny' })).toBe(false);
  });

  it('reads the legacy boolean but gives the named policy precedence', () => {
    expect(projectManagedWorkspaceWritePolicy({ allowGezelWrites: true })).toBe('allow');
    expect(projectManagedWorkspaceWritePolicy({ allowGezelWrites: false })).toBe('deny');
    expect(
      projectManagedWorkspaceWritePolicy({
        managedWorkspaceWritePolicy: 'deny',
        allowGezelWrites: true,
      }),
    ).toBe('deny');
  });
});

describe('provider-native workspace access', () => {
  it('resolves Codex posture independently from the managed-write policy', () => {
    expect(
      resolveGezelWorkspaceAccess({
        project: { workingDir: '/repo', codexPermissionMode: 'edit' },
        provider: 'codex-cli',
      }),
    ).toEqual({
      managedWritable: false,
      nativeAccess: 'edit',
      effectiveWritable: true,
    });
    expect(
      resolveGezelWorkspaceAccess({
        project: { managedWorkspaceWritePolicy: 'deny', codexPermissionMode: 'plan' },
        provider: 'codex-cli',
      }),
    ).toEqual({
      managedWritable: false,
      nativeAccess: 'read-only',
      effectiveWritable: false,
    });
  });

  it('centralizes Claude and Copilot native bypass behavior', () => {
    expect(
      providerNativeWorkspaceAccess({
        provider: 'anthropic-cli',
        gezel: {
          id: 'claude',
          name: 'Claude',
          claudePermissionMode: 'bypassPermissions',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      }),
    ).toBe('full');
    expect(
      providerNativeWorkspaceAccess({
        provider: 'anthropic-cli',
        projectClaudeMode: 'plan',
        gezel: {
          id: 'claude',
          name: 'Claude',
          claudePermissionMode: 'bypassPermissions',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      }),
    ).toBe('read-only');
    expect(
      providerNativeWorkspaceAccess({ provider: 'copilot', config: { sandboxCopilot: true } }),
    ).toBe('none');
    expect(
      providerNativeWorkspaceAccess({ provider: 'copilot', config: { sandboxCopilot: false } }),
    ).toBe('edit');
  });
});

describe('classifySecurityLevel', () => {
  it('round-trips each preset', () => {
    for (const level of ['super-lockdown', 'lockdown', 'free'] as const) {
      expect(classifySecurityLevel(SECURITY_PRESETS[level])).toBe(level);
    }
  });

  it('returns custom for an off-preset mix', () => {
    expect(
      classifySecurityLevel({
        ...SECURITY_PRESETS['super-lockdown'],
        allowFileEdits: true,
      }),
    ).toBe('custom');
  });
});
