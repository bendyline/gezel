import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_COPILOT,
  DEFAULT_SECURITY_LEVEL,
  SECURITY_PRESETS,
  classifySecurityLevel,
  projectWorkspaceWritable,
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

describe('projectWorkspaceWritable', () => {
  it('is independent of the global file-adjacent capability gate', () => {
    const policy = resolveSecurityPolicy({
      securityPolicy: securityPolicyForLevel('super-lockdown'),
    });

    expect(policy.allowFileEdits).toBe(false);
    expect(projectWorkspaceWritable({})).toBe(true);
    expect(projectWorkspaceWritable({ workingDir: '/home/user/repo' })).toBe(false);
    expect(
      projectWorkspaceWritable({
        workingDir: '/home/user/repo',
        allowGezelWrites: true,
      }),
    ).toBe(true);
  });

  it('defaults internal workspaces to writable', () => {
    expect(projectWorkspaceWritable({})).toBe(true);
    expect(projectWorkspaceWritable(undefined)).toBe(true);
    expect(projectWorkspaceWritable(null)).toBe(true);
  });

  it('defaults external working dirs to read-only (consent gate)', () => {
    expect(projectWorkspaceWritable({ workingDir: '/home/user/repo' })).toBe(false);
  });

  it('lets the explicit flag win in both directions', () => {
    expect(
      projectWorkspaceWritable({ workingDir: '/home/user/repo', allowGezelWrites: true }),
    ).toBe(true);
    expect(projectWorkspaceWritable({ allowGezelWrites: false })).toBe(false);
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
