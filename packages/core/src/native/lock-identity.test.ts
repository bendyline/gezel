import { describe, expect, it } from 'vitest';
import { type LockIdentity, sharesPidNamespace } from './lock-identity.js';

const linuxIdentity = (overrides: Partial<LockIdentity> = {}): LockIdentity => ({
  pid: 4242,
  hostname: 'gezel',
  bootId: 'boot-a',
  pidNs: 'pid:[1]',
  ...overrides,
});

const macIdentity = (overrides: Partial<LockIdentity> = {}): LockIdentity => ({
  pid: 4242,
  hostname: 'Mikes-MacBook-Pro.local',
  ...overrides,
});

describe('sharesPidNamespace', () => {
  it('treats a legacy pid-only record as ours', () => {
    expect(sharesPidNamespace({ pid: 1 }, linuxIdentity())).toBe(true);
    expect(sharesPidNamespace({ pid: 1 }, macIdentity())).toBe(true);
  });

  it('keeps a macOS or Windows daemon ours after the hostname changes with the network', () => {
    expect(
      sharesPidNamespace(macIdentity(), macIdentity({ hostname: 'Mikes-MacBook-Pro.lan' })),
    ).toBe(true);
  });

  it('keeps a Linux daemon ours when only its DHCP hostname changed', () => {
    expect(sharesPidNamespace(linuxIdentity({ hostname: 'desk.corp' }), linuxIdentity())).toBe(
      true,
    );
  });

  it('separates containers by pid namespace and machines by boot', () => {
    expect(sharesPidNamespace(linuxIdentity({ pidNs: 'pid:[2]' }), linuxIdentity())).toBe(false);
    expect(sharesPidNamespace(linuxIdentity({ bootId: 'boot-b' }), linuxIdentity())).toBe(false);
  });

  it('never matches a Linux holder with a macOS or Windows reader', () => {
    expect(sharesPidNamespace(linuxIdentity(), macIdentity())).toBe(false);
    expect(sharesPidNamespace(macIdentity(), linuxIdentity())).toBe(false);
  });

  it('falls back to the hostname on Linux when a pid namespace could not be read', () => {
    const noNs = { pidNs: undefined };
    expect(
      sharesPidNamespace(linuxIdentity({ ...noNs, hostname: 'ctr-a' }), linuxIdentity(noNs)),
    ).toBe(false);
    expect(sharesPidNamespace(linuxIdentity(noNs), linuxIdentity(noNs))).toBe(true);
  });
});
