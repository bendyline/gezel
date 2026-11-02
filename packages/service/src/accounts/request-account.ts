import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The signed-in account a request runs for. The auth middleware enters it
 * and History reads it, so every event a request causes is attributed
 * without threading the account through every Store and ChatManager call.
 * Work a request starts in the background inherits it, which is the right
 * answer to "who did this".
 */
export interface RequestAccount {
  accountId: string;
  name: string;
}

const storage = new AsyncLocalStorage<RequestAccount>();

export function runAsAccount<T>(account: RequestAccount, fn: () => T): T {
  return storage.run(account, fn);
}

export function currentRequestAccount(): RequestAccount | undefined {
  return storage.getStore();
}
