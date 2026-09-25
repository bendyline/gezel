/**
 * Node sandbox entry. The synchronous stdin payload keeps `gezel.input`
 * available on the first line of an existing script; fd 3 carries RPC.
 * Hosts without Node should import `@bendyline/gezel-sdk/portable` instead.
 */

import { createGezelSDK } from './portable.js';
import { RpcClient } from './rpc.js';

export * from './portable.js';

export const gezel = createGezelSDK(new RpcClient(), {
  log(...args: unknown[]): void {
    process.stderr.write(
      `${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
    );
  },
});
