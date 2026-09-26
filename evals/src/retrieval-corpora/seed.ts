import { isSharedLibraryProject } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import {
  BENCH_CATALOG,
  BENCH_CATALOG_VERSION,
  BENCH_PUBLISHER,
  type BenchCorpus,
  benchTopics,
} from '../retrieval-bench/corpus/build.ts';
import { compileAndInstallCatalog } from './catalog.ts';

export interface SeedReport {
  embedModel: string;
  knowledgeDocs: number;
  sharedDocs: number;
  workspaceFiles: number;
  /** Files still waiting for vectors when seeding gave up (0 = full coverage). */
  embedPending: { project: number; shared: number };
  seedMs: number;
}

/**
 * Put a retrieval corpus in place: the catalog compiled and mounted, shared
 * documents written to the library, workspace files written to the project,
 * and both indexes drained through the embed-only tier (vectors without any
 * chat model) so the vector arms are measured, not skipped. Coverage is
 * reported, never assumed — a half-embedded corpus would pass as a ranking
 * regression.
 */
export async function seedRetrievalCorpus(
  client: GezelClient,
  projectId: string,
  corpus: BenchCorpus,
  log: (line: string) => void,
  opts: { deadlineMs?: number } = {},
): Promise<SeedReport> {
  const started = Date.now();
  const { embedModel } = await compileAndInstallCatalog(
    client,
    {
      publisherId: BENCH_PUBLISHER,
      catalogId: BENCH_CATALOG,
      version: BENCH_CATALOG_VERSION,
      name: 'Retrieval Bench Reference',
      description: 'Retrieval-bench fixture catalog: fictional entity families plus filler.',
      topics: benchTopics(),
      documents: corpus.knowledge,
    },
    log,
  );
  for (const doc of corpus.shared) await client.writeDocument(doc.path, doc.content);
  for (const file of corpus.workspace) {
    await client.writeProjectWorkspaceFile(projectId, { path: file.path, content: file.content });
  }
  log(
    `[seed] wrote ${corpus.shared.length} shared documents and ${corpus.workspace.length} workspace files`,
  );

  const sharedId = await sharedLibraryProjectId(client);
  const deadline = started + (opts.deadlineMs ?? 20 * 60_000);
  const pending = { project: 0, shared: 0 };
  for (const [label, id] of [
    ['project', projectId],
    ['shared', sharedId],
  ] as const) {
    if (!id) continue;
    pending[label] = await drainEmbeddings(client, id, deadline, (line) =>
      log(`[seed:${label}] ${line}`),
    );
  }
  return {
    embedModel,
    knowledgeDocs: corpus.knowledge.length,
    sharedDocs: corpus.shared.length,
    workspaceFiles: corpus.workspace.length,
    embedPending: pending,
    seedMs: Date.now() - started,
  };
}

/**
 * Re-scan, then run the embed-only tier dry. With AI engagement set to
 * reactive the enrich route drains embeddings only — no summaries, so no
 * chat model is involved.
 */
export async function drainEmbeddings(
  client: GezelClient,
  projectId: string,
  deadline: number,
  log: (line: string) => void,
): Promise<number> {
  await client.refreshProjectIndex(projectId);
  let lastPending = Number.POSITIVE_INFINITY;
  for (;;) {
    const status = await client.getProjectIndexStatus(projectId);
    const embedPending = status.enrichment?.embedOnlyPending ?? 0;
    const scanning = status.state === 'indexing' || status.state === 'never';
    if (!scanning && embedPending === 0) {
      log('index fresh, every file embedded');
      return 0;
    }
    if (Date.now() > deadline) {
      log(`deadline reached with ${embedPending} files unembedded (state ${status.state})`);
      return embedPending;
    }
    if (!scanning) await client.driveIndexEnrichment(projectId, {});
    if (embedPending !== lastPending) log(`state=${status.state} embedPending=${embedPending}`);
    lastPending = embedPending;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** The shared document library's project id (it is not always `shared`). */
export async function sharedLibraryProjectId(client: GezelClient): Promise<string | undefined> {
  const { projects } = await client.listProjects();
  return projects.find((project) => isSharedLibraryProject(project))?.id;
}
