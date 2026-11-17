/**
 * Record the HTTP exchanges of one connector pass: a `fetch` that forwards to
 * the real one and keeps what was asked and answered, bounded. What it keeps
 * is raw and private until `scrubExchanges` has run over it; nothing here
 * writes to disk or leaves the process.
 */

export interface RawExchange {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  /** The body as text, when it is text and within the limit. */
  bodyText?: string;
  /** Why the body was not kept. */
  bodyOmitted?: 'binary' | 'too-large';
}

export interface CaptureLimits {
  /** Largest body kept, in bytes (default 256 KiB). */
  maxBodyBytes?: number;
  /** Exchanges kept per capture (default 200); later ones pass through unrecorded. */
  maxExchanges?: number;
}

const TEXTUAL = /^(?:text\/|application\/(?:[a-z.+-]*json|[a-z.+-]*xml|x-www-form-urlencoded))/i;

export function captureFetch(
  inner: typeof fetch,
  limits: CaptureLimits = {},
): { fetch: typeof fetch; exchanges: RawExchange[] } {
  const maxBody = limits.maxBodyBytes ?? 256 * 1024;
  const maxExchanges = limits.maxExchanges ?? 200;
  const exchanges: RawExchange[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await inner(input, init);
    if (exchanges.length >= maxExchanges) return response;
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const entry: RawExchange = { method, url, status: response.status, headers };
    const type = headers['content-type'] ?? '';
    const declared = Number(headers['content-length'] ?? Number.NaN);
    if (type && !TEXTUAL.test(type)) {
      entry.bodyOmitted = 'binary';
    } else if (Number.isFinite(declared) && declared > maxBody) {
      entry.bodyOmitted = 'too-large';
    } else {
      const text = await response
        .clone()
        .text()
        .catch(() => undefined);
      if (text === undefined) entry.bodyOmitted = 'binary';
      else if (Buffer.byteLength(text) > maxBody) entry.bodyOmitted = 'too-large';
      else entry.bodyText = text;
    }
    exchanges.push(entry);
    return response;
  };
  return { fetch: recording, exchanges };
}
