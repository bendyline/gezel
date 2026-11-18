/**
 * Keep a fake honest against a recording of the real service. For each
 * recorded exchange, the fake answers the same request, and the two responses
 * are compared by shape: status, and the keys and value types of the JSON
 * body. Values are never compared (a cassette's strings are pseudonyms).
 *
 * What fails is the fake being kinder than the service: a field the adapter
 * may rely on that the service did not send, a value of another type, a
 * success where the service answered an error, or a single page where the
 * service paged. A field the service sent and the fake leaves out is
 * reported as missing, since an adapter that never sees it is never tested
 * on it.
 */

import type { ConnectorTestExchange } from '@bendyline/gezel';

type Shape =
  | { kind: 'null' | 'boolean' | 'number' | 'string' }
  | { kind: 'array'; items?: Shape }
  | { kind: 'object'; fields: Record<string, Shape> };

export function shapeOf(value: unknown): Shape {
  if (value === null || value === undefined) return { kind: 'null' };
  if (Array.isArray(value)) {
    // The first element stands for the array: recorded pages are uniform.
    return value.length ? { kind: 'array', items: shapeOf(value[0]) } : { kind: 'array' };
  }
  if (typeof value === 'object') {
    return {
      kind: 'object',
      fields: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v)]),
      ),
    };
  }
  if (typeof value === 'boolean') return { kind: 'boolean' };
  if (typeof value === 'number') return { kind: 'number' };
  return { kind: 'string' };
}

export interface FidelityGap {
  request: string;
  /** `extra`: the fake sends what the service did not; `missing`: the reverse. */
  kind: 'status' | 'type' | 'extra' | 'missing' | 'paging';
  path: string;
  detail: string;
}

function compare(
  real: Shape,
  fake: Shape,
  path: string,
  request: string,
  gaps: FidelityGap[],
): void {
  if (real.kind === 'null' || fake.kind === 'null') return;
  if (real.kind !== fake.kind) {
    gaps.push({
      request,
      kind: 'type',
      path,
      detail: `service sent ${real.kind}, fake sent ${fake.kind}`,
    });
    return;
  }
  if (real.kind === 'array' && fake.kind === 'array') {
    if (real.items && fake.items) compare(real.items, fake.items, `${path}[]`, request, gaps);
    return;
  }
  if (real.kind === 'object' && fake.kind === 'object') {
    for (const [key, shape] of Object.entries(fake.fields)) {
      const there = real.fields[key];
      if (!there) {
        gaps.push({
          request,
          kind: 'extra',
          path: `${path}.${key}`,
          detail: 'the service did not send it',
        });
      } else compare(there, shape, `${path}.${key}`, request, gaps);
    }
    for (const key of Object.keys(real.fields)) {
      if (!(key in fake.fields)) {
        gaps.push({
          request,
          kind: 'missing',
          path: `${path}.${key}`,
          detail: 'the fake never sends it',
        });
      }
    }
  }
}

const PAGING_KEYS =
  /^(?:next_?page_?token|nextpagetoken|next_?token|@odata\.nextlink|nextlink|cursor|next)$/i;

function pages(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.entries(body as Record<string, unknown>).some(
    ([k, v]) => PAGING_KEYS.test(k) && typeof v === 'string' && v.length > 0,
  );
}

/**
 * Replay each recorded HTTP exchange against the fake and list where it is
 * kinder than (or different from) the service. An empty list is a pass.
 */
export async function checkFakeFidelity(
  recorded: readonly ConnectorTestExchange[],
  fakeFetch: typeof fetch,
): Promise<FidelityGap[]> {
  const gaps: FidelityGap[] = [];
  for (const ex of recorded) {
    if (ex.kind !== 'http') continue;
    const method = ex.request.method ?? 'GET';
    const request = `${method} ${ex.request.url}`;
    const res = await fakeFetch(ex.request.url, { method });
    const realStatus = ex.response.status ?? 200;
    if (Math.floor(res.status / 100) !== Math.floor(realStatus / 100)) {
      gaps.push({
        request,
        kind: 'status',
        path: '',
        detail: `service answered ${realStatus}, fake answered ${res.status}`,
      });
      continue;
    }
    const text = await res.text();
    let fakeBody: unknown;
    try {
      fakeBody = text ? JSON.parse(text) : undefined;
    } catch {
      fakeBody = text;
    }
    const realBody = ex.response.body;
    if (typeof realBody === 'string' && realBody.startsWith('[')) continue;
    if (pages(realBody) && !pages(fakeBody)) {
      gaps.push({
        request,
        kind: 'paging',
        path: '',
        detail: 'the service paged; the fake did not',
      });
    }
    compare(shapeOf(realBody), shapeOf(fakeBody), '$', request, gaps);
  }
  return gaps;
}
