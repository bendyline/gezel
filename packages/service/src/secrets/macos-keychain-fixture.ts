/**
 * A fake keyring whose overwrite behaviour matches macOS Keychain semantics,
 * including the failure mode a permissive `Map`-backed fake cannot express.
 *
 * The bug this exists to catch: on macOS, a keychain item's ACL is bound to
 * the binary that created it. `security_framework`'s `set_generic_password`
 * is find-then-update — so when a *differently signed* build (a previous
 * beta, a dev build, an unsigned local run) writes the same
 * `(service, account)`, the find half fails, the call degrades to an add, and
 * the add returns errSecDuplicateItem: "The specified item already exists in
 * the keychain". The item is neither readable nor writable, yet plainly
 * present. Every in-memory fake in the suite silently overwrote instead, so
 * the release that shipped this reached users unguarded.
 *
 * Model:
 *   - `owner` marks which build wrote an item. `foreign` items are the ones
 *     this process cannot see.
 *   - `getPassword` on a foreign item throws an auth failure, NOT a
 *     not-found — mirroring how the OS distinguishes them, and why
 *     `isMissingEntry` must not swallow it.
 *   - `setPassword` over a foreign item throws errSecDuplicateItem.
 *   - `deletePassword` succeeds regardless of owner, as it does with a
 *     login keychain the user can unlock.
 */

import type { KeyringEntry, KeyringEntryFactory } from './keyring-store.js';

export interface MacKeychainItem {
  value: string;
  /** Which build wrote it. Anything but 'self' is invisible to this process. */
  owner: 'self' | 'foreign';
}

export interface MacKeychainFixtureOptions {
  /** Items already in the keychain before this process starts. */
  seed?: Record<string, MacKeychainItem>;
  /** Simulate a locked keychain: every operation raises an auth error. */
  locked?: boolean;
}

export class MacKeychainFixture {
  readonly items = new Map<string, MacKeychainItem>();
  locked: boolean;
  /** Every operation attempted, for asserting we did not thrash the keychain. */
  readonly calls: string[] = [];

  constructor(opts: MacKeychainFixtureOptions = {}) {
    this.locked = opts.locked ?? false;
    for (const [account, item] of Object.entries(opts.seed ?? {})) {
      this.items.set(account, { ...item });
    }
  }

  /** Pass to `new KeyringSecretStore({ entryFactory })`. */
  entryFactory: KeyringEntryFactory = (_service, account): KeyringEntry => ({
    getPassword: () => {
      this.calls.push(`get:${account}`);
      if (this.locked) throw new Error('User interaction is not allowed.');
      const item = this.items.get(account);
      if (!item) throw new Error('No matching entry found in secure storage');
      if (item.owner === 'foreign') {
        throw new Error('The user name or passphrase you entered is not correct.');
      }
      return item.value;
    },
    setPassword: (value: string) => {
      this.calls.push(`set:${account}`);
      if (this.locked) throw new Error('User interaction is not allowed.');
      const item = this.items.get(account);
      if (item && item.owner === 'foreign') {
        throw new Error('The specified item already exists in the keychain.');
      }
      this.items.set(account, { value, owner: 'self' });
    },
    deletePassword: () => {
      this.calls.push(`delete:${account}`);
      if (this.locked) throw new Error('User interaction is not allowed.');
      if (!this.items.delete(account)) {
        throw new Error('No matching entry found in secure storage');
      }
    },
  });
}
