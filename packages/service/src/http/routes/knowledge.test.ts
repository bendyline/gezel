/**
 * Phase-2a exit tests over the real HTTP surface: install a real .gezk via
 * the route, browse it, search it (omni + knowledge routes), resume a
 * killed download from `.partial`, and verify the model-facing project
 * search carries cited knowledge results without disturbing project arms.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GezelClient, type KnowledgeInstallEvent } from '@bendyline/gezel-client';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { knowledgeDownloadsDir } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestCatalog } from '../../knowledge/test-catalog-fixture.js';
import { type RunningService, startService } from '../../service.js';

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

let dir: string;
let home: string;
let archivePath: string;
let svc: RunningService;
let client: GezelClient;

async function waitForJob(jobId: string): Promise<{ error?: string }> {
  for (let i = 0; i < 200; i++) {
    const job = await client.getKnowledgeJob(jobId);
    if (job.finished) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('install job did not finish');
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  dir = await mkdtemp(join(tmpdir(), 'gezel-knowledge-routes-'));
  home = join(dir, 'home');
  archivePath = join(dir, 'test-notes-1.0.0.gezk');
  await buildTestCatalog({ outputPath: archivePath, workDir: join(dir, 'work') });
  svc = await startService({ home });
  const baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  const httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  client = new GezelClient({ baseUrl, token: svc.context.token, fetch: httpFetch });
}, 60_000);

afterAll(async () => {
  await svc.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

describe('knowledge routes', () => {
  it('installs from a file, lists, browses, and reads a document', async () => {
    const { jobId } = await client.installKnowledgeCatalog({
      source: { kind: 'file', path: archivePath },
    });
    const job = await waitForJob(jobId);
    expect(job.error).toBeUndefined();

    const { catalogs } = await client.listKnowledgeCatalogs();
    expect(catalogs.length).toBe(1);
    expect(catalogs[0]?.mounted).toBe(true);

    const { topics } = await client.knowledgeCatalogTopics('test-notes');
    expect(topics.map((t) => t.name).sort()).toEqual(['Finishing', 'Joinery']);

    const page = await client.knowledgeCatalogDocuments('test-notes', { topicId: 'joinery' });
    expect(page.total).toBe(1);

    const doc = await client.readKnowledgeDocument('test-notes', 'dovetails');
    expect(doc.markdown).toContain('Tails and pins');
  });

  it('answers the knowledge search route with cited results', async () => {
    const { results } = await client.searchKnowledge({ query: 'dovetail corner joint' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.uri).toMatch(/^knowledge:\/\/gezel-tests\/test-notes\//);
  });

  it('model-facing project search returns knowledge hits alongside project arms', async () => {
    const res = await client.toolSearch('default', {
      query: 'dovetail corner joint',
      sources: ['knowledge'],
    });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r) => r.kind === 'knowledge')).toBe(true);
    expect(res.results[0]?.retrievalSource).toBe('knowledge');
    expect(res.results[0]?.uri).toContain('knowledge://gezel-tests/test-notes/');
  });

  it('quarantine leaves project search unaffected', async () => {
    // Even with the catalog disabled, the project search route stays healthy.
    await client.updateKnowledgeCatalog('test-notes', { enabled: false });
    const res = await client.toolSearch('default', { query: 'dovetail corner joint' });
    expect(res.results.every((r) => r.kind !== 'knowledge')).toBe(true);
    await client.updateKnowledgeCatalog('test-notes', { enabled: true });
  });

  it('supports pinned and unpinned URL installs while preserving resume', async () => {
    const bytes = await readFile(archivePath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    // First response sends half the file then destroys the socket; the
    // second honors Range and serves the rest.
    let requests = 0;
    const server: Server = createServer((req, res) => {
      requests++;
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const from = range ? Number.parseInt(range[1] as string, 10) : 0;
      if (requests === 1) {
        res.writeHead(200, {
          'content-length': String(bytes.length),
          'content-type': 'application/zip',
        });
        res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
        setTimeout(() => res.destroy(), 30);
        return;
      }
      if (from > 0) {
        res.writeHead(206, {
          'content-range': `bytes ${from}-${bytes.length - 1}/${bytes.length}`,
          'content-length': String(bytes.length - from),
        });
        res.end(bytes.subarray(from));
      } else {
        res.writeHead(200, { 'content-length': String(bytes.length) });
        res.end(bytes);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      await client.removeKnowledgeCatalog('test-notes').catch(() => {});
      const { jobId } = await client.installKnowledgeCatalog({
        source: {
          kind: 'url',
          url: `http://127.0.0.1:${port}/test-notes.gezk`,
          expectedSha256: digest,
        },
      });
      const job = await waitForJob(jobId);
      expect(job.error, JSON.stringify(job)).toBeUndefined();
      expect(requests).toBeGreaterThanOrEqual(2);
      const { catalogs } = await client.listKnowledgeCatalogs();
      expect(catalogs.find((c) => c.ref.catalogId === 'test-notes')?.mounted).toBe(true);

      const { jobId: mismatchedJobId } = await client.installKnowledgeCatalog({
        source: {
          kind: 'url',
          url: `http://127.0.0.1:${port}/test-notes.gezk`,
          expectedSha256: '0'.repeat(64),
        },
      });
      const mismatchedJob = await waitForJob(mismatchedJobId);
      expect(mismatchedJob.error).toContain('archive sha256 mismatch');

      // The pin is optional for arbitrary untrusted imports. The daemon still
      // hashes the archive for its immutable identity and validates its contents.
      await client.removeKnowledgeCatalog('test-notes');
      const { jobId: unpinnedJobId } = await client.installKnowledgeCatalog({
        source: { kind: 'url', url: `http://127.0.0.1:${port}/test-notes.gezk` },
      });
      const unpinnedJob = await waitForJob(unpinnedJobId);
      expect(unpinnedJob.error, JSON.stringify(unpinnedJob)).toBeUndefined();
      const { catalogs: unpinnedCatalogs } = await client.listKnowledgeCatalogs();
      expect(
        unpinnedCatalogs.find((catalog) => catalog.ref.catalogId === 'test-notes')?.ref
          .contentDigest,
      ).toBe(digest);

      // The staging download is gone once installed.
      const leftovers = await stat(knowledgeDownloadsDir(home)).catch(() => null);
      if (leftovers) {
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(knowledgeDownloadsDir(home));
        expect(files.filter((f) => f.endsWith('.partial'))).toEqual([]);
      }
    } finally {
      server.close();
    }
  }, 60_000);

  it('read_document-style URI resolution rejects unknown catalogs', async () => {
    await expect(client.readKnowledgeDocument('no-such-catalog', 'x')).rejects.toThrow();
  });

  it('a chat turn proactively injects cited knowledge within budget (Phase 4)', async () => {
    const gezels = await client.listGezels();
    const gezelId = gezels.gezels[0]?.id;
    expect(gezelId).toBeDefined();
    if (!gezelId) return;

    // Sends are fire-and-forget (`accepted: true`); wait for the assistant
    // turn to land before reading the audit log.
    //
    // A reply appearing is NOT the end of the turn: the prose-deliverable
    // detector re-prompts this send, so one message yields a second
    // assistant bubble, persisted after the first. Returning on the first
    // one leaves that continuation in flight, and it then satisfies the
    // NEXT send's wait before that send has retrieved anything — the whole
    // point of the second half of this test. So wait for the reply, then
    // for the transcript to go quiet.
    const assistantCount = async (): Promise<number> =>
      (await client.chatHistory(gezelId, 'default')).messages.filter((m) => m.role === 'assistant')
        .length;
    // Poll cadence and the quiet window that has to elapse after the last
    // new message before the turn counts as settled. A continuation is
    // dispatched from inside the same send loop, so this only has to cover
    // one detector pass plus one MockProvider round trip.
    const POLL_MS = 200;
    const QUIET_POLLS = 8;
    const MAX_POLLS = 100;
    const sendAndWait = async (message: string): Promise<void> => {
      const before = await assistantCount();
      await client.sendChatMessage(gezelId, { message, projectId: 'default' });
      let replied = false;
      let last = before;
      let quiet = 0;
      for (let i = 0; i < MAX_POLLS; i++) {
        const now = await assistantCount();
        if (now > before) replied = true;
        if (now === last) quiet++;
        else quiet = 0;
        last = now;
        if (replied && quiet >= QUIET_POLLS) return;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      throw new Error(
        replied
          ? 'assistant turn never settled (continuations still arriving)'
          : 'assistant turn never completed',
      );
    };

    await sendAndWait('How do dovetail joints hold together without glue in fine woodworking?');

    const injected = await client.listHistory({ kind: 'retrieval.context-injected' });
    const events = injected.entries.filter(
      (entry): entry is Extract<typeof entry, { details?: Record<string, unknown> }> =>
        'details' in entry,
    );
    const withKnowledge = events.find((entry) => {
      const hits = (entry.details as { hits?: Array<{ source?: string; uri?: string }> })?.hits;
      return hits?.some((h) => h.source === 'knowledge');
    });
    expect(withKnowledge, 'no retrieval event carried a knowledge hit').toBeDefined();
    const details = withKnowledge?.details as {
      estimatedTokens: number;
      maxTokens: number;
      hits: Array<{ source: string; uri?: string; catalogId?: string; path?: string }>;
    };
    expect(details.estimatedTokens).toBeLessThanOrEqual(details.maxTokens);
    const knowledgeHits = details.hits.filter((h) => h.source === 'knowledge');
    expect(knowledgeHits.length).toBeLessThanOrEqual(2); // balanced ceiling
    for (const hit of knowledgeHits) {
      expect(hit.uri).toMatch(/^knowledge:\/\/gezel-tests\/test-notes\//);
      expect(hit.catalogId).toBe('test-notes');
    }

    // Disable the catalog: the next turn injects no reference content.
    await client.updateKnowledgeCatalog('test-notes', { enabled: false });
    await sendAndWait('Tell me more about mortise and tenon joinery techniques please.');
    const after = await client.listHistory({ kind: 'retrieval.context-injected' });
    const newest = after.entries.filter(
      (e): e is Extract<typeof e, { details?: Record<string, unknown> }> =>
        'details' in e && !injected.entries.some((p) => p.id === e.id),
    );
    // Retrieval always leaves a trace: hits above the floor log the
    // injection, and nothing above the floor logs the zero-injection probe.
    // No event at all means the turn under test never ran retrieval.
    expect(
      newest.length,
      'the second turn logged no retrieval event — it never ran retrieval',
    ).toBeGreaterThan(0);
    for (const entry of newest) {
      const hits = (entry.details as { hits?: Array<{ source?: string }> })?.hits ?? [];
      expect(hits.every((h) => h.source !== 'knowledge')).toBe(true);
    }
    await client.updateKnowledgeCatalog('test-notes', { enabled: true });
  }, 60_000);

  it('answers the gilde-backed browse, update and job surfaces', async () => {
    // The pinned gilde content ships no knowledge catalogs yet, so the
    // browser is empty and nothing is updatable — every surface still answers.
    expect((await client.listAvailableKnowledgeCatalogs()).catalogs).toEqual([]);
    const updates = await client.knowledgeUpdates();
    expect(updates.source).toBe('gilde');
    expect(updates.updates).toEqual([]);
    expect((await client.listKnowledgeActiveInstalls()).installs).toEqual([]);
    expect((await client.listIncompleteKnowledgeDownloads()).incomplete).toEqual([]);
    const installed = (await client.listKnowledgeCatalogs()).catalogs.find(
      (c) => c.ref.catalogId === 'test-notes',
    );
    expect(installed).toMatchObject({ source: 'url', updateAvailable: false });

    // An unknown catalog id fails the SSE install with a terminal error, and
    // the finished job stays observable through the job surface.
    const events: KnowledgeInstallEvent[] = [];
    await client.installKnowledgeCatalogFromCatalog('no-such-catalog', (event) => {
      events.push(event);
    });
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') expect(last.error).toContain('no knowledge catalog');
    const job = await client.getKnowledgeJob('no-such-catalog');
    expect(job.finished).toBe(true);
    expect(job.error).toContain('no knowledge catalog');
    expect(
      await client.deleteIncompleteKnowledgeDownload('0'.repeat(16)).catch((e) => e),
    ).toBeInstanceOf(Error);
  }, 30_000);
});
