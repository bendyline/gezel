/**
 * A per-process bearer token for the loopback engine APIs we spawn.
 *
 * ── Why a local-only HTTP server still needs auth ────────────────────────
 *
 * A supervised engine binds `127.0.0.1:<ephemeral>`, which sounds closed but
 * is not. Two callers can reach it that we do not want reaching it:
 *
 *  1. **Any web page in the user's browser.** llama.cpp defaults
 *     `--cors-origins` to `*` with credentials enabled, so it echoes back
 *     whatever `Origin` it is handed — measured directly against the pinned
 *     build, a request carrying `Origin: https://evil.example` came back
 *     `200` with `Access-Control-Allow-Origin: https://evil.example` and a
 *     full chat completion. The response body also leaks the absolute model
 *     path, which contains the account name. Passing `--cors-origins
 *     localhost` removes the header entirely for a foreign origin and closes
 *     this;`--no-webui` drops the built-in chat page nobody here uses.
 *  2. **Any other local process.** CORS is a *browser* policy; it does
 *     nothing about a native process that opens the port directly. Only a
 *     credential does, which is what this module is for.
 *
 * ── Shape ────────────────────────────────────────────────────────────────
 *
 * One random token per daemon process, generated lazily and never persisted.
 * Per-process rather than per-engine because the value it protects is
 * identical across replicas (a local model server holds no per-engine
 * secret), and one token keeps the wrapper below stateless.
 *
 * It is handed to the child through the **environment**, never `argv`:
 * command lines are world-readable via `ps` on a shared machine, whereas
 * `/proc/<pid>/environ` is owner-only and macOS requires root for `ps -E`.
 *
 * Engines this applies to are the ones we launch. An engine the user pointed
 * us at through an external base URL is theirs, not ours — we neither set its
 * flags nor assume a key, so the wrapper is applied only on the supervised
 * path.
 */

import { randomBytes } from 'node:crypto';

let cached: string | undefined;

/**
 * The token for this daemon process. Generated on first use so a daemon that
 * never starts an engine never mints one.
 */
export function engineApiKey(): string {
  if (!cached) cached = randomBytes(32).toString('hex');
  return cached;
}

/** Test seam — forget the token so a case can assert generation behaviour. */
export function resetEngineApiKeyForTests(): void {
  cached = undefined;
}

/**
 * Wrap a fetch so every request carries the engine bearer token.
 *
 * An existing `Authorization` header always wins: the wrapper is a default,
 * not an override, so a caller that deliberately authenticates some other way
 * is left alone.
 *
 * Note that the engine's readiness and health endpoints are deliberately
 * *unauthenticated* upstream (`/health` answers 200 without a key while
 * `/props`, `/slots` and `/v1/*` return 401), so the supervisor's readiness
 * probe and health watch keep working whether or not they go through this.
 */
export function withEngineApiKey(fetchImpl: typeof fetch, key: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}
