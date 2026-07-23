import { describe, expect, it, vi } from 'vitest';
import { resolveUpdaterPermission } from './updater-policy.js';

const allowingPolicy = {
  level: 'free',
  allowFileEdits: true,
  allowExternalChat: true,
  allowExternalServices: true,
  allowScriptExecution: true,
  allowAppNetwork: true,
} as const;

describe('resolveUpdaterPermission', () => {
  it('uses the default lockdown posture for a loaded config with no policy', async () => {
    await expect(resolveUpdaterPermission(async () => ({}))).resolves.toEqual({
      allowed: true,
      reason: 'allowed',
    });
  });

  it('honors an explicitly allowing policy', async () => {
    await expect(
      resolveUpdaterPermission(async () => ({ securityPolicy: allowingPolicy })),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });
  });

  it('denies an explicitly disabled app network capability', async () => {
    await expect(
      resolveUpdaterPermission(async () => ({
        securityPolicy: { ...allowingPolicy, level: 'super-lockdown', allowAppNetwork: false },
      })),
    ).resolves.toEqual({ allowed: false, reason: 'policy-denied' });
  });

  it.each([
    ['missing API client', undefined],
    ['undefined response', async () => undefined],
    ['null response', async () => null],
    ['non-object response', async () => 'invalid'],
  ])('fails closed for %s', async (_label, loader) => {
    const result = await resolveUpdaterPermission(loader as (() => Promise<unknown>) | undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('policy-unavailable');
  });

  it('fails closed when config retrieval rejects', async () => {
    const result = await resolveUpdaterPermission(async () => {
      throw new Error('daemon offline');
    });
    expect(result).toEqual({
      allowed: false,
      reason: 'policy-unavailable',
      error: 'daemon offline',
    });
  });

  it('fails closed for a malformed explicit policy', async () => {
    const result = await resolveUpdaterPermission(async () => ({
      securityPolicy: { ...allowingPolicy, allowAppNetwork: 'yes' },
    }));
    expect(result).toEqual({
      allowed: false,
      reason: 'policy-unavailable',
      error: 'Security policy was malformed',
    });
  });

  it('re-evaluates a changed policy on every invocation', async () => {
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ securityPolicy: allowingPolicy })
      .mockResolvedValueOnce({
        securityPolicy: { ...allowingPolicy, level: 'super-lockdown', allowAppNetwork: false },
      });

    await expect(resolveUpdaterPermission(load)).resolves.toMatchObject({ allowed: true });
    await expect(resolveUpdaterPermission(load)).resolves.toMatchObject({
      allowed: false,
      reason: 'policy-denied',
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
