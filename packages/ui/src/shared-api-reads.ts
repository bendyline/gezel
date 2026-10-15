import type { GezelClient } from '@bendyline/gezel-client';

/** Renderer-local, bounded snapshots. Files and the daemon remain authoritative. */
export class SharedRead<Args extends unknown[], Value> {
  private entries = new Map<
    string,
    {
      value?: Value;
      expiresAt: number;
      pending?: Promise<Value>;
    }
  >();

  constructor(
    private load: (...args: Args) => Promise<Value>,
    private ttlMs: number,
    private capacity = 100,
  ) {}

  peek(...args: Args): Value | undefined {
    const entry = this.entries.get(JSON.stringify(args));
    return entry?.value === undefined || entry.expiresAt <= Date.now()
      ? undefined
      : structuredClone(entry.value);
  }

  /** Paint a recently known view while its ordinary read revalidates it. */
  snapshot(...args: Args): Value | undefined {
    const entry = this.entries.get(JSON.stringify(args));
    return entry?.value === undefined || entry.expiresAt + 30_000 <= Date.now()
      ? undefined
      : structuredClone(entry.value);
  }

  read = (...args: Args): Promise<Value> => {
    const key = JSON.stringify(args);
    let entry = this.entries.get(key);
    if (entry?.value !== undefined && entry.expiresAt > Date.now()) {
      return Promise.resolve(structuredClone(entry.value));
    }
    if (!entry?.pending) {
      entry = {
        expiresAt: entry?.expiresAt ?? 0,
        ...(entry?.value !== undefined ? { value: entry.value } : {}),
      };
      this.entries.delete(key);
      this.entries.set(key, entry);
      while (this.entries.size > this.capacity) {
        this.entries.delete(this.entries.keys().next().value!);
      }
      const current = entry;
      current.pending = this.load(...args)
        .then((value) => {
          // An invalidation removes this generation, so an older response can
          // finish for its caller without repopulating the shared snapshot.
          current.value = structuredClone(value);
          current.expiresAt = Date.now() + this.ttlMs;
          return value;
        })
        .finally(() => {
          current.pending = undefined;
        });
    }
    // Callers historically owned their response objects (some sort in place).
    return entry.pending!.then((value) => structuredClone(value));
  };

  invalidate(): void {
    this.entries.clear();
  }
}

type ReadMethod =
  | 'getConfig'
  | 'listGezels'
  | 'listProjects'
  | 'getProject'
  | 'listProjectAttachments'
  | 'listChatSessions'
  | 'getQueueStatus'
  | 'listInflightTurns'
  | 'getSystemHomeInfo';
type Reads = {
  [K in ReadMethod]: SharedRead<Parameters<GezelClient[K]>, Awaited<ReturnType<GezelClient[K]>>>;
};
let reads: Reads | undefined;

export function installSharedApiReads(client: GezelClient): void {
  function wrap<K extends ReadMethod>(key: K, ttl: number): Reads[K] {
    const original = client[key].bind(client) as (
      ...args: Parameters<GezelClient[K]>
    ) => Promise<Awaited<ReturnType<GezelClient[K]>>>;
    const read = new SharedRead<Parameters<GezelClient[K]>, Awaited<ReturnType<GezelClient[K]>>>(
      original,
      ttl,
    );
    Object.assign(client, { [key]: read.read });
    return read as Reads[K];
  }
  reads = {
    getConfig: wrap('getConfig', 5_000),
    listGezels: wrap('listGezels', 5_000),
    listProjects: wrap('listProjects', 5_000),
    getProject: wrap('getProject', 5_000),
    listProjectAttachments: wrap('listProjectAttachments', 5_000),
    listChatSessions: wrap('listChatSessions', 1_000),
    getQueueStatus: wrap('getQueueStatus', 1_000),
    listInflightTurns: wrap('listInflightTurns', 1_000),
    getSystemHomeInfo: wrap('getSystemHomeInfo', 5_000),
  };
}

export function peekApiRead<K extends ReadMethod>(
  key: K,
  ...args: Parameters<GezelClient[K]>
): Awaited<ReturnType<GezelClient[K]>> | undefined {
  const read = reads?.[key] as
    | SharedRead<Parameters<GezelClient[K]>, Awaited<ReturnType<GezelClient[K]>>>
    | undefined;
  return read?.snapshot(...args);
}

export function invalidateApiReads(): void {
  if (reads) for (const read of Object.values(reads)) read.invalidate();
}

export function invalidateLiveApiReads(): void {
  reads?.getQueueStatus.invalidate();
  reads?.listInflightTurns.invalidate();
  reads?.listChatSessions.invalidate();
  reads?.listProjectAttachments.invalidate();
}

/** Invalidate on both sides of a write, including ambiguous failed writes. */
export function withReadInvalidation(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const url = String(input instanceof Request ? input.url : input);
    const changesData =
      method !== 'GET' &&
      method !== 'HEAD' &&
      !url.endsWith('/api/system/perf/client') &&
      !url.endsWith('/api/models/test');
    if (changesData) invalidateApiReads();
    try {
      return await fetchImpl(input, init);
    } finally {
      if (changesData) invalidateApiReads();
    }
  };
}
