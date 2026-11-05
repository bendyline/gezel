import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HistoryEvent } from '@bendyline/gezel';
import { accountSessionsFile, accountsFile, tokensFile } from '@bendyline/gezel/paths';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenStore } from '../http/token-store.js';
import { AccountError, AccountManager } from './manager.js';
import { hashPassword, needsRehash, verifyPassword } from './passwords.js';

// A pass-through spy, so a test can count how many tries reached the slow check.
vi.mock('./passwords.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./passwords.js')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function open(opts: { now?: () => number } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'gezel-accounts-'));
  homes.push(home);
  const events: Array<Omit<HistoryEvent, 'id' | 'at'>> = [];
  const manager = await AccountManager.open({
    home,
    scrypt: FAST,
    history: { log: async (event) => void events.push(event) },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { home, manager, events };
}

async function refusal(promise: Promise<unknown>): Promise<AccountError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AccountError);
  return err as AccountError;
}

describe('passwords', () => {
  it('round-trips and records its own parameters', async () => {
    const hash = await hashPassword('correct horse', FAST);
    expect(hash.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('correct hors', hash)).toBe(false);
    expect(needsRehash(hash, { N: 2 ** 11, r: 8, p: 1 })).toBe(true);
    expect(needsRehash(hash, FAST)).toBe(false);
  });

  it('refuses a tampered hash that asks for absurd memory', async () => {
    expect(await verifyPassword('x', 'scrypt$1073741824$8$1$AAAAAAAAAAA$AAAA')).toBe(false);
  });
});

describe('AccountManager', () => {
  it('sets up the first account with the setup code, once', async () => {
    const { manager, events } = await open();
    expect(manager.hasAccounts()).toBe(false);
    const code = manager.mintSetupCode();
    expect(code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(manager.setupCodeAvailable()).toBe(true);

    const bad = await refusal(
      manager.setup({ code: 'WRONG', name: 'Mike', password: 'longenough' }, {}),
    );
    expect(bad.code).toBe('setup_code_invalid');

    // Typed in lower case without dashes still matches.
    const signedIn = await manager.setup(
      { code: code!.toLowerCase().replaceAll('-', ''), name: 'Mike', password: 'longenough' },
      { label: 'Firefox on Linux', address: '172.17.0.1' },
    );
    expect(signedIn.account.name).toBe('Mike');
    expect(signedIn.account.role).toBe('admin');
    expect(manager.resolve(signedIn.token)?.principal).toEqual({
      id: signedIn.account.id,
      source: 'password',
      label: 'Mike',
    });
    expect(manager.setupCodeAvailable()).toBe(false);
    expect(manager.mintSetupCode()).toBeNull();
    const again = await refusal(
      manager.setup({ code: code!, name: 'Eve', password: 'longenough' }, {}),
    );
    expect(again.code).toBe('setup_closed');
    expect(events.map((e) => e.kind)).toEqual(['account.created', 'account.signed-in']);
    expect(JSON.stringify(events)).not.toContain('longenough');
  });

  it('keeps names unique without regard to case', async () => {
    const { manager } = await open();
    await manager.create({ name: 'Mike', password: 'longenough' });
    expect((await refusal(manager.create({ name: ' mike ', password: 'longenough' }))).code).toBe(
      'name_taken',
    );
  });

  it('signs in by name in any case, and says the same thing for a missing name and a wrong password', async () => {
    const { manager } = await open();
    await manager.create({ name: 'Mike', password: 'longenough' });
    const ok = await manager.signIn({ name: 'MIKE', password: 'longenough' }, {});
    expect(manager.resolve(ok.token)?.account.name).toBe('Mike');
    const wrong = await refusal(manager.signIn({ name: 'Mike', password: 'nope-nope' }, {}));
    const missing = await refusal(manager.signIn({ name: 'Nobody', password: 'nope-nope' }, {}));
    expect(wrong.message).toBe(missing.message);
    expect(wrong.code).toBe('sign_in_failed');
  });

  it('backs off after repeated failures from one address', async () => {
    const { manager } = await open();
    await manager.create({ name: 'Mike', password: 'longenough' });
    for (let i = 0; i < 6; i++) {
      await refusal(
        manager.signIn({ name: 'Mike', password: 'wrong-pass' }, { address: '10.0.0.9' }),
      );
    }
    const throttled = await refusal(
      manager.signIn({ name: 'Mike', password: 'longenough' }, { address: '10.0.0.9' }),
    );
    expect(throttled.code).toBe('throttled');
    expect(throttled.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts a burst of concurrent tries before any password check runs', async () => {
    const { manager } = await open();
    await manager.create({ name: 'Mike', password: 'longenough' });
    vi.mocked(verifyPassword).mockClear();
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        refusal(manager.signIn({ name: 'Mike', password: 'wrong-pass' }, { address: '10.0.0.9' })),
      ),
    );
    // Five free failures, then the sixth starts the backoff, same as one at a time.
    expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(6);
    expect(results.filter((e) => e.code === 'sign_in_failed')).toHaveLength(6);
    expect(results.filter((e) => e.code === 'throttled')).toHaveLength(24);
  });

  it('forgives the name and address after a right password', async () => {
    let at = 1_000_000;
    const { manager } = await open({ now: () => at });
    await manager.create({ name: 'Mike', password: 'longenough' });
    const address = { address: '10.0.0.9' };
    for (let i = 0; i < 5; i++) {
      await refusal(manager.signIn({ name: 'Mike', password: 'wrong-pass' }, address));
    }
    await manager.signIn({ name: 'Mike', password: 'longenough' }, address);
    at += 1;
    for (let i = 0; i < 6; i++) {
      const err = await refusal(manager.signIn({ name: 'Mike', password: 'wrong-pass' }, address));
      expect(err.code).toBe('sign_in_failed');
    }
    expect(
      (await refusal(manager.signIn({ name: 'Mike', password: 'longenough' }, address))).code,
    ).toBe('throttled');
  });

  it('refuses to sign in a role this build does not know', async () => {
    const { home, manager } = await open();
    const created = await manager.create({ name: 'Mike', password: 'longenough' });
    const file = JSON.parse(await readFile(accountsFile(home), 'utf8'));
    file.accounts[0].role = 'member';
    await writeFile(accountsFile(home), JSON.stringify(file));
    const reopened = await AccountManager.open({ home, scrypt: FAST });
    expect(reopened.get(created.id)?.role).toBe('member');
    expect(
      (await refusal(reopened.signIn({ name: 'Mike', password: 'longenough' }, {}))).code,
    ).toBe('sign_in_failed');
  });

  it('never removes or disables the last admin', async () => {
    const { manager } = await open();
    const mike = await manager.create({ name: 'Mike', password: 'longenough' });
    expect((await refusal(manager.remove(mike.id))).code).toBe('last_admin');
    expect((await refusal(manager.update(mike.id, { disabled: true }))).code).toBe('last_admin');
    const ana = await manager.create({ name: 'Ana', password: 'longenough' });
    await manager.update(mike.id, { disabled: true });
    expect((await refusal(manager.remove(ana.id))).code).toBe('last_admin');
  });

  it('a password change signs out the other sessions and keeps the current one', async () => {
    const { manager } = await open();
    const mike = await manager.create({ name: 'Mike', password: 'longenough' });
    const laptop = await manager.signIn({ name: 'Mike', password: 'longenough' }, {});
    const phone = await manager.signIn({ name: 'Mike', password: 'longenough' }, {});
    const laptopSession = manager.resolve(laptop.token)!.sessionId;
    await refusal(
      manager.setPassword(mike.id, 'a-new-password', {
        requireCurrent: true,
        currentPassword: 'wrong',
      }),
    );
    await manager.setPassword(mike.id, 'a-new-password', {
      requireCurrent: true,
      currentPassword: 'longenough',
      keepSessionId: laptopSession,
    });
    expect(manager.resolve(laptop.token)).not.toBeNull();
    expect(manager.resolve(phone.token)).toBeNull();
  });

  it('disabling an account signs it out everywhere', async () => {
    const { manager } = await open();
    await manager.create({ name: 'Mike', password: 'longenough' });
    const ana = await manager.create({ name: 'Ana', password: 'longenough' });
    const session = await manager.signIn({ name: 'Ana', password: 'longenough' }, {});
    await manager.update(ana.id, { disabled: true });
    expect(manager.resolve(session.token)).toBeNull();
    expect((await refusal(manager.signIn({ name: 'Ana', password: 'longenough' }, {}))).code).toBe(
      'sign_in_failed',
    );
  });

  it('expires sessions after thirty unused days and after ninety in any case', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    const { manager } = await open({ now: () => now });
    await manager.create({ name: 'Mike', password: 'longenough' });
    const idle = await manager.signIn({ name: 'Mike', password: 'longenough' }, {});
    const busy = await manager.signIn({ name: 'Mike', password: 'longenough' }, {});
    const day = 24 * 60 * 60_000;
    for (let i = 0; i < 9; i++) {
      now += 10 * day;
      if (i < 2) expect(manager.resolve(busy.token)).not.toBeNull();
      else manager.resolve(busy.token);
    }
    // 90 days on: the busy one hit the absolute limit; the idle one slid out long ago.
    expect(manager.resolve(idle.token)).toBeNull();
    expect(manager.resolve(busy.token)).toBeNull();
  });

  it('stores session token hashes, never tokens, and survives a restart', async () => {
    const { home, manager } = await open();
    await manager.create({ name: 'Mike', password: 'longenough' });
    const session = await manager.signIn({ name: 'Mike', password: 'longenough' }, {});
    const raw = await readFile(accountSessionsFile(home), 'utf8');
    expect(raw).not.toContain(session.token);
    expect(await readFile(accountsFile(home), 'utf8')).not.toContain('longenough');
    const reopened = await AccountManager.open({ home, scrypt: FAST });
    expect(reopened.resolve(session.token)?.account.name).toBe('Mike');
  });

  it('seeds the owner only into an empty store', async () => {
    const { manager } = await open();
    expect((await manager.seedOwner('Mike', 'longenough'))?.name).toBe('Mike');
    expect(await manager.seedOwner('Eve', 'longenough')).toBeNull();
    expect(manager.list().map((a) => a.name)).toEqual(['Mike']);
  });

  it('leaves tokens.json alone, so an older daemon still starts', async () => {
    const { home, manager } = await open();
    await manager.create({ name: 'Mike', password: 'longenough' });
    await manager.signIn({ name: 'Mike', password: 'longenough' }, {});
    const store = await createTokenStore({ home, rootToken: 'root-token' });
    expect(store.list().map((r) => r.appId)).toEqual(['root']);
    await expect(readFile(tokensFile(home), 'utf8')).rejects.toThrow();
  });
});
