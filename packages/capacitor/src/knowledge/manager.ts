import type { KnowledgeEmbeddingProfile, UnifiedSearchResult } from '@bendyline/gezel';
import { parseKnowledgeUri } from '@bendyline/gezel';
import {
  GezelSdkError,
  type KnowledgeClient,
  type KnowledgeRetrieveInput,
  type KnowledgeState,
} from '@bendyline/gezel-app-sdk/browser';
import { admitsUnjudgedKnowledge } from '@bendyline/gezel-inference/internal/knowledge/admission';
import type { KnowledgeCatalogHost } from '@bendyline/gezel-inference/internal/knowledge/catalog-host';
import {
  type UnifiedSearchCatalog,
  searchUnifiedCatalogs,
} from '@bendyline/gezel-inference/internal/knowledge/unified-search';
import { resolveKnowledgeVectorFloors } from '@bendyline/gezel-inference/internal/knowledge/vector-floors';
import { registerPlugin } from '@capacitor/core';
import {
  type MobileKnowledgeCatalog,
  knowledgeCatalogUrl,
  mobileKnowledgeCatalogs,
  queryModelStoreId,
} from './catalog.js';
import type { GezelKnowledgePlugin } from './definitions.js';
import { createQueryEmbedder } from './query-model.js';
import { type KnowledgeWorkerUrls, createWorkerCatalogHost } from './worker-host.js';

export const GezelKnowledge = registerPlugin<GezelKnowledgePlugin>('GezelKnowledge');

type Action = Parameters<KnowledgeClient['update']>[0];
type Retrieval = Awaited<ReturnType<KnowledgeClient['retrieve']>>;
type Passage = Retrieval['passages'][number];
type CatalogState = KnowledgeState['catalogs'][number];

export interface MobileKnowledgeOptions extends KnowledgeWorkerUrls {
  plugin?: GezelKnowledgePlugin;
  /**
   * The catalog host; tests supply one in place of the worker.
   * @internal Stripped from the declarations: its type is inference's internal
   * surface, which an installed package does not have.
   */
  host?: KnowledgeCatalogHost & { terminate(): void };
  /** Catalogs the person turned off; an installed catalog is on unless listed. */
  readDisabled(): readonly string[];
  writeDisabled(ids: readonly string[]): void;
  /** Waits before each retry of an interrupted download that saved no new bytes. */
  downloadRetryDelaysMs?: readonly number[];
}

interface Installed {
  readonly id: string;
  readonly version: string;
  readonly catalog: MobileKnowledgeCatalog | undefined;
}
interface Job {
  received: number;
  total: number;
  error: string | null;
}

// About a minute of trying while the network is gone, as for chat models.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const ARCHIVE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/catalog\.gezk$/;

const sdkCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';

/**
 * Knowledge catalogs on this device, behind the App SDK's knowledge contract
 * (`state`, `update`, `retrieve`) with the daemon routes' semantics
 * (inference/src/http/routes/v1-knowledge.ts). Search is the daemon's own
 * `searchUnifiedCatalogs` over the daemon's catalog host, run in a worker that
 * reads each verified `.gezk` archive in place. Each catalog's query model
 * downloads with it and embeds questions natively; until it is installed the
 * catalog is searched by keyword, as on a desktop that has not cached it.
 */
export function createMobileKnowledge(options: MobileKnowledgeOptions) {
  const plugin = options.plugin ?? GezelKnowledge;
  let baseUrl: Promise<string> | undefined;
  const storeUrl = () => {
    baseUrl ??= plugin.info().then((info) => info.baseUrl);
    return baseUrl;
  };
  const host = options.host ?? createWorkerCatalogHost(options, storeUrl);
  const embedder = createQueryEmbedder(plugin, storeUrl);
  // The daemon's measured floors; a hit under its profile's floor is not evidence.
  const floors = resolveKnowledgeVectorFloors({});
  /** Profiles whose query model has every file installed. */
  const readyModels = async (): Promise<Set<string>> => {
    const stored = new Map((await plugin.info()).catalogs.map((entry) => [entry.id, entry.files]));
    return new Set(
      mobileKnowledgeCatalogs
        .map((catalog) => catalog.embeddingProfile.id)
        .filter((id) => {
          const files = stored.get(queryModelStoreId(id));
          return files && embedder.model(id)?.files.every((file) => files.includes(file.name));
        }),
    );
  };
  const mounted = new Map<string, UnifiedSearchCatalog & { readonly id: string }>();
  const mountErrors = new Map<string, string>();
  const jobs = new Map<string, Job>();
  let syncing: Promise<void> | undefined;

  const installed = async (): Promise<Installed[]> =>
    (await plugin.info()).catalogs.flatMap(({ id, files }) => {
      const version = files.map((file) => ARCHIVE.exec(file)?.[1]).find(Boolean);
      return version
        ? [{ id, version, catalog: mobileKnowledgeCatalogs.find((c) => c.id === id) }]
        : [];
    });
  const enabled = (id: string) => !options.readDisabled().includes(id);
  const keyOf = (entry: Installed) => `${entry.catalog?.publisherId ?? 'bendyline'}/${entry.id}`;

  /** Mount exactly the installed, enabled catalogs, at their installed versions. */
  const sync = (): Promise<void> => {
    syncing ??= (async () => {
      const wanted = new Map(
        (await installed()).filter((e) => enabled(e.id)).map((e) => [keyOf(e), e]),
      );
      const ready = await readyModels();
      const mode = (profileId: string) => (ready.has(profileId) ? 'profile' : 'keyword-only');
      for (const [key, info] of mounted) {
        if (wanted.get(key)?.version === info.ref.version) {
          info.semanticSearch = mode(info.embedding.id);
          continue;
        }
        mounted.delete(key);
        await host.unmount(key).catch(() => undefined);
      }
      for (const [key, entry] of wanted) {
        if (mounted.has(key)) continue;
        try {
          await host.mount({
            key,
            rootDir: `/${entry.id}/${entry.version}/catalog.gezk`,
            catalogId: entry.id,
            version: entry.version,
          });
          const topics = await host.topics(key);
          mounted.set(key, {
            id: entry.id,
            key,
            ref: {
              publisherId: key.split('/')[0]!,
              catalogId: entry.id,
              version: entry.version,
              contentDigest: entry.catalog?.version === entry.version ? entry.catalog.sha256 : '',
              storageScope: 'user',
            },
            name: entry.catalog?.name ?? entry.id,
            semanticSearch: mode(entry.catalog?.embeddingProfile.id ?? ''),
            embedding: {
              id: entry.catalog?.embeddingProfile.id ?? 'unknown',
            } as KnowledgeEmbeddingProfile,
            topicNames: new Map(topics.map((topic) => [topic.id, topic.name])),
          });
          mountErrors.delete(entry.id);
        } catch (error) {
          mountErrors.set(entry.id, error instanceof Error ? error.message : String(error));
        }
      }
      // Load each query model now, so the first question is not the slow one.
      for (const profileId of new Set([...mounted.values()].map((info) => info.embedding.id)))
        if (ready.has(profileId)) void embedder.embed(profileId, 'warm').catch(() => undefined);
    })().finally(() => {
      syncing = undefined;
    });
    return syncing;
  };

  /**
   * The catalog's archive, then its profile's query model when this device
   * lacks it, as one job: progress covers both, and an interrupted transfer
   * resumes where it stopped while it keeps making progress.
   */
  async function download(catalog: MobileKnowledgeCatalog) {
    const model = embedder.model(catalog.embeddingProfile.id);
    const needModel = model && !(await readyModels()).has(model.id);
    const modelBytes = needModel ? model.files.reduce((sum, file) => sum + file.size, 0) : 0;
    const job: Job = { received: 0, total: catalog.archiveBytes + modelBytes, error: null };
    jobs.set(catalog.id, job);
    const steps: { id: string; offset: number; run(): Promise<unknown> }[] = [
      {
        id: catalog.id,
        offset: 0,
        run: () =>
          plugin.install({
            id: catalog.id,
            version: catalog.version,
            url: knowledgeCatalogUrl(catalog),
            sha256: catalog.sha256,
            size: catalog.archiveBytes,
          }),
      },
      ...(needModel
        ? [
            {
              id: queryModelStoreId(model.id),
              offset: catalog.archiveBytes,
              run: () =>
                plugin.installModel({ id: queryModelStoreId(model.id), files: model.files }),
            },
          ]
        : []),
    ];
    let current = steps[0]!;
    const listener = await plugin.addListener('knowledgeDownload', (event) => {
      if (event.id === current.id) job.received = current.offset + event.receivedBytes;
    });
    try {
      for (const step of steps) {
        current = step;
        let saved = 0;
        let stalled = 0;
        while (true) {
          try {
            await step.run();
            break;
          } catch (error) {
            if (job.received > saved) {
              saved = job.received;
              stalled = 0;
            }
            const delay = (options.downloadRetryDelaysMs ?? RETRY_DELAYS_MS)[stalled++];
            if (sdkCode(error) !== 'interrupted' || delay === undefined) {
              job.error =
                sdkCode(error) === 'cancelled'
                  ? null
                  : sdkCode(error) === 'paused' || sdkCode(error) === 'interrupted'
                    ? 'The download stopped. Download the catalog again to continue where it stopped.'
                    : sdkCode(error) === 'storage'
                      ? 'This catalog could not be saved. Free up storage on this device and try again.'
                      : 'The catalog download failed. Try downloading it again.';
              if (!job.error) jobs.delete(catalog.id);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
      jobs.delete(catalog.id);
    } finally {
      await listener.remove();
    }
    await sync().catch(() => undefined);
  }

  async function state(): Promise<KnowledgeState> {
    const info = await plugin.info();
    const present = await installed();
    const catalogs = new Map<string, CatalogState>();
    for (const catalog of mobileKnowledgeCatalogs) {
      catalogs.set(catalog.id, {
        id: catalog.id,
        name: catalog.name,
        description: catalog.description,
        version: catalog.version,
        installedVersion: null,
        enabled: false,
        updateAvailable: false,
        downloadBytes: catalog.archiveBytes,
        documents: catalog.documents,
        state: 'available',
        percent: null,
        message: null,
      });
    }
    for (const entry of present) {
      const latest = catalogs.get(entry.id);
      const error = mountErrors.get(entry.id);
      catalogs.set(entry.id, {
        id: entry.id,
        name: entry.catalog?.name ?? entry.id,
        description: entry.catalog?.description ?? '',
        version: entry.catalog?.version ?? entry.version,
        installedVersion: entry.version,
        enabled: enabled(entry.id),
        updateAvailable: Boolean(entry.catalog && entry.catalog.version !== entry.version),
        downloadBytes: latest?.downloadBytes ?? null,
        documents: entry.catalog?.version === entry.version ? entry.catalog.documents : null,
        state: error ? 'error' : 'installed',
        percent: null,
        message: error
          ? 'This catalog could not be opened. Remove it and download it again.'
          : null,
      });
    }
    for (const [id, job] of jobs) {
      const entry = catalogs.get(id);
      if (!entry) continue;
      if (job.error) {
        entry.state = 'error';
        entry.message = job.error;
      } else {
        entry.state = 'downloading';
        entry.percent = job.total > 0 ? Math.min(100, (job.received / job.total) * 100) : null;
        entry.message = 'Downloading catalog…';
      }
    }
    if (info.downloading && !jobs.has(info.downloading)) {
      const entry = catalogs.get(info.downloading);
      if (entry)
        Object.assign(entry, {
          state: 'downloading',
          percent: null,
          message: 'Downloading catalog…',
        });
    }
    // No relevance model runs on this device yet; `auto` uses Gezel's own bar.
    return {
      catalogs: [...catalogs.values()],
      reranker: { ready: false, downloading: false, message: null },
      improvement: null,
    };
  }

  async function update(action: Action): Promise<void> {
    if (action.action === 'prepare-reranker')
      throw new GezelSdkError('Better knowledge results are not available on this device yet', {
        code: 'unsupported',
      });
    const id = action.catalogId;
    const disabled = new Set(options.readDisabled());
    switch (action.action) {
      case 'install': {
        const catalog = mobileKnowledgeCatalogs.find((entry) => entry.id === id);
        if (!catalog)
          throw new GezelSdkError('This catalog is not available on this device', {
            code: 'not_found',
          });
        if (jobs.has(id) && !jobs.get(id)?.error) return;
        disabled.delete(id);
        options.writeDisabled([...disabled]);
        void download(catalog);
        return;
      }
      case 'remove': {
        for (const [key, info] of mounted)
          if (info.id === id) {
            mounted.delete(key);
            await host.unmount(key).catch(() => undefined);
          }
        jobs.delete(id);
        mountErrors.delete(id);
        await plugin.remove({ id });
        return;
      }
      case 'enable':
      case 'disable': {
        if (action.action === 'enable') disabled.delete(id);
        else disabled.add(id);
        options.writeDisabled([...disabled]);
        await sync().catch(() => undefined);
        return;
      }
      case 'cancel':
        await plugin.cancelInstall();
        jobs.delete(id);
        return;
    }
  }

  async function resolve(hit: UnifiedSearchResult): Promise<Passage | null> {
    const uri = hit.uri ? parseKnowledgeUri(hit.uri) : null;
    const info = uri && [...mounted.values()].find((entry) => entry.id === uri.catalogId);
    if (!uri || !info || info.ref.publisherId !== uri.publisherId) return null;
    const doc = await host.getDocument(info.key, uri.documentId).catch(() => null);
    if (!doc) return null;
    let text: string;
    if (uri.fragment && 'chunk' in uri.fragment) {
      const chunk = await host
        .getChunk(info.key, uri.documentId, uri.fragment.chunk)
        .catch(() => null);
      if (!chunk) return null;
      text = chunk.text;
    } else text = doc.markdown;
    text = text.slice(0, 6000);
    if (!text) return null;
    return {
      uri: hit.uri!,
      title: doc.title.slice(0, 256),
      text,
      catalogId: uri.catalogId,
      version: info.ref.version,
    };
  }

  async function retrieve(
    query: KnowledgeRetrieveInput,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Retrieval> {
    await sync();
    opts.signal?.throwIfAborted();
    if (mounted.size === 0) return { reranked: true, passages: [] };
    if (query.rerank === 'required')
      throw new GezelSdkError('Better knowledge results are not available on this device yet', {
        code: 'reranker_required',
      });
    const hits = await searchUnifiedCatalogs(
      {
        catalog: (key) => mounted.get(key),
        host,
        // The route's budget: a query model not ready in time searches by keyword.
        embedForProfile: (text, profile, budgetMs) =>
          Promise.race([
            embedder.embed(profile.id, text).catch(() => undefined),
            new Promise<undefined>((resolve) => setTimeout(resolve, budgetMs ?? 5000)),
          ]),
        vectorFloorFor: (key, modality) => {
          const info = mounted.get(key);
          return info
            ? floors.floorFor({
                catalogKey: key,
                profileId: info.embedding.id,
                ...(modality ? { modality } : {}),
              })
            : null;
        },
        warn: () => undefined,
      },
      [...mounted.keys()],
      query.query,
      {
        vector: null,
        localModelsOnly: true,
        maxResults: 24,
        queryEmbedBudgetMs: 5000,
        chunksPerDocument: 3,
      },
    );
    opts.signal?.throwIfAborted();
    const passages: Passage[] = [];
    let remaining = query.maxCharacters;
    for (const hit of hits.slice(0, 24)) {
      if (!remaining || passages.length >= query.maxResults) break;
      // Without the relevance model, only what Gezel's unjudged bar admits.
      if (!hit.uri || !admitsUnjudgedKnowledge(hit)) continue;
      const passage = await resolve(hit);
      opts.signal?.throwIfAborted();
      if (!passage) continue;
      const text = passage.text.slice(0, remaining);
      passages.push({ ...passage, text });
      remaining -= text.length;
    }
    return { reranked: false, passages };
  }

  return {
    state,
    update,
    retrieve,
    /** Stop the worker; the next request starts it again. */
    release() {
      mounted.clear();
      host.terminate();
    },
  };
}

export type MobileKnowledge = ReturnType<typeof createMobileKnowledge>;
