import { describe, expect, it, vi } from 'vitest';
import { resolveRendererNetworkPermission } from './renderer-network-policy.js';

const allowingPolicy = {
  level: 'free',
  allowFileEdits: true,
  allowExternalChat: true,
  allowExternalServices: true,
  allowScriptExecution: true,
  allowAppNetwork: true,
} as const;

describe('resolveRendererNetworkPermission', () => {
  it('denies the default lockdown posture', async () => {
    await expect(resolveRendererNetworkPermission(async () => ({}))).resolves.toEqual({
      allowed: false,
      reason: 'policy-denied',
    });
  });

  it('requires both external services and app network', async () => {
    await expect(
      resolveRendererNetworkPermission(async () => ({ securityPolicy: allowingPolicy })),
    ).resolves.toEqual({ allowed: true, reason: 'allowed' });

    for (const policy of [
      { ...allowingPolicy, level: 'custom', allowExternalServices: false },
      { ...allowingPolicy, level: 'custom', allowAppNetwork: false },
    ] as const) {
      await expect(
        resolveRendererNetworkPermission(async () => ({ securityPolicy: policy })),
      ).resolves.toEqual({ allowed: false, reason: 'policy-denied' });
    }
  });

  it.each([
    ['missing API client', undefined],
    ['undefined response', async () => undefined],
    ['null response', async () => null],
    ['non-object response', async () => 'invalid'],
  ])('fails closed for %s', async (_label, loader) => {
    const result = await resolveRendererNetworkPermission(
      loader as (() => Promise<unknown>) | undefined,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('policy-unavailable');
  });

  it('fails closed when config retrieval rejects', async () => {
    await expect(
      resolveRendererNetworkPermission(async () => {
        throw new Error('daemon offline');
      }),
    ).resolves.toEqual({
      allowed: false,
      reason: 'policy-unavailable',
      error: 'daemon offline',
    });
  });

  it('fails closed for a malformed explicit policy', async () => {
    await expect(
      resolveRendererNetworkPermission(async () => ({
        securityPolicy: { ...allowingPolicy, allowAppNetwork: 'yes' },
      })),
    ).resolves.toEqual({
      allowed: false,
      reason: 'policy-unavailable',
      error: 'Security policy was malformed',
    });
  });

  it('re-evaluates changed daemon policy', async () => {
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ securityPolicy: allowingPolicy })
      .mockResolvedValueOnce({
        securityPolicy: { ...allowingPolicy, level: 'custom', allowAppNetwork: false },
      });

    await expect(resolveRendererNetworkPermission(load)).resolves.toMatchObject({ allowed: true });
    await expect(resolveRendererNetworkPermission(load)).resolves.toMatchObject({
      allowed: false,
      reason: 'policy-denied',
    });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
