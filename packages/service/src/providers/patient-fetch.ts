/**
 * The one `fetch` that local engines are allowed to be slow on.
 *
 * Node's global `fetch` is undici, and undici defaults `headersTimeout`
 * and `bodyTimeout` to 5 minutes. A local inference engine routinely
 * blows through that before it emits its first byte — a 72k-token
 * prefill on a 27B at 7 tok/s is a quarter of an hour — and when undici
 * gives up it throws a bare `TypeError: terminated` that reads exactly
 * like the engine died.
 *
 * Every engine provider already owns its real deadline through an
 * AbortController budget scaled to prompt size. undici's 5 minutes is a
 * second, invisible deadline underneath that one, and it is always the
 * shorter of the two. So: disable it here, and let the provider's own
 * budget be the only thing that can end a call.
 *
 * Wild-caught (mlx qwen3.8-27b-q4): six turns died at ~300s against
 * declared pre-first-byte budgets of 595s, 722s and 900s. The engine was
 * healthy throughout — another session was streaming on it at 6.8 tok/s
 * — and the error told the user the server had crashed or run out of
 * memory and advised retrying, which could not work: the same prompt
 * hits the same wall every time. The MLX provider was the only local
 * engine whose factory never injected a patient fetch, because this
 * helper had been copy-pasted into five separate modules and MLX was
 * simply missed. Hence one owner, plus `scripts/check-patient-fetch.mjs`
 * so the sixth copy cannot be written and a new engine cannot forget.
 *
 * NOT for calls that leave this machine. A remote host that goes away
 * mid-request should fail on a timeout rather than hang forever; web
 * search, model downloads and registry probes keep the global default.
 */

import { Agent, fetch as undiciFetch } from 'undici';

let cached: typeof fetch | undefined;

/**
 * Lazily built so the dispatcher only spins up in a process that
 * actually talks to a local engine.
 */
export function patientFetch(): typeof fetch {
  if (!cached) {
    const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    cached = ((url: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
      undiciFetch(url, { ...init, dispatcher })) as unknown as typeof fetch;
  }
  return cached;
}
