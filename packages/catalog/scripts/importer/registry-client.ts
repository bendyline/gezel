import { fetchWithRetry } from './http.js';
import type {
  NormalizedRegistryServer,
  RegistryListResponse,
  RegistryServerResponse,
} from './types.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';

export interface RegistryClientOptions {
  baseUrl?: string;
  /** Page size; upstream caps at 100. */
  pageSize?: number;
}

export interface ListPageOptions {
  cursor?: string;
  /** RFC3339 timestamp; auto-includes deletions upstream. */
  updatedSince?: string;
}

export class RegistryClient {
  private readonly baseUrl: string;
  private readonly pageSize: number;

  constructor(options: RegistryClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? REGISTRY_BASE).replace(/\/+$/, '');
    this.pageSize = Math.min(100, Math.max(1, options.pageSize ?? 100));
  }

  /**
   * Async iterator over every server entry. Stops when the upstream
   * stops returning a `nextCursor`. Yields entries with their
   * `_meta.official` block hoisted onto the server itself for easier
   * downstream consumption.
   */
  async *iterAll(opts: ListPageOptions = {}): AsyncGenerator<NormalizedRegistryServer> {
    let cursor = opts.cursor;
    while (true) {
      const page = await this.listPage({ cursor, updatedSince: opts.updatedSince });
      for (const entry of page.servers ?? []) {
        yield normalize(entry);
      }
      const next = page.metadata?.nextCursor;
      if (!next || next === cursor) return;
      cursor = next;
    }
  }

  async listPage(opts: ListPageOptions = {}): Promise<RegistryListResponse> {
    const url = new URL('/v0/servers', this.baseUrl);
    url.searchParams.set('limit', String(this.pageSize));
    if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
    if (opts.updatedSince) url.searchParams.set('updated_since', opts.updatedSince);
    const res = await fetchWithRetry(url.toString(), {}, { throwOnError: true });
    return (await res.json()) as RegistryListResponse;
  }

  /**
   * Fetch a single server by its reverse-DNS name. The upstream API
   * doesn't expose a plain `/v0/servers/{name}` endpoint — instead
   * we list the server's versions and pick the one marked
   * `isLatest: true` (or the first when no flag is set).
   */
  async getByName(name: string): Promise<NormalizedRegistryServer | null> {
    const url = new URL(`/v0/servers/${encodeURIComponent(name)}/versions`, this.baseUrl);
    const res = await fetchWithRetry(url.toString());
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`registry getByName(${name}) failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as RegistryListResponse;
    const candidates = body.servers ?? [];
    if (candidates.length === 0) return null;
    const latest =
      candidates.find(
        (c) => c._meta?.['io.modelcontextprotocol.registry/official']?.isLatest === true,
      ) ?? candidates[0]!;
    return normalize(latest);
  }
}

function normalize(entry: RegistryServerResponse): NormalizedRegistryServer {
  const official = entry._meta?.['io.modelcontextprotocol.registry/official'];
  return official ? { ...entry.server, official } : entry.server;
}
