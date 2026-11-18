/**
 * Synopses for the website connector's saved pages (`kind: web-page` records
 * in a project's artifacts index), written with the same prompt and model as
 * workspace files. Keyed by content hash, so a page is summarized again only
 * when its text changed. No embeddings: the corpus has no measured vector
 * floor yet. `ContentIndex` owns the index handle and calls in here.
 */

import { readFile } from 'node:fs/promises';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { type EnrichDeps, buildSummaryPrompt, resolveEnrichCompletion } from './enrich.js';
import { parseFrontmatter } from './frontmatter.js';
import type { IndexStore } from './index-store.js';

export interface WebPageSummaryHost {
  openArtifacts(): Promise<IndexStore | null>;
  artifactsDir: string;
}

const MAX_ATTEMPTS = 3;
/** Failed attempts per page content hash, for this process: a restart retries. */
const attempts = new Map<string, number>();

export async function summarizeWebPages(
  host: WebPageSummaryHost,
  deps: EnrichDeps,
  limit: number,
): Promise<{ files: number; summaries: { path: string; summary: string }[] } | null> {
  const index = await host.openArtifacts();
  if (!index) return null;
  const failed = (hash: string) => attempts.set(hash, (attempts.get(hash) ?? 0) + 1);
  const summaries: { path: string; summary: string }[] = [];
  let files = 0;
  try {
    for (const [path, meta] of index.metadataValuesForKeys(['kind'])) {
      if (files >= limit) break;
      if (meta.kind !== 'web-page') continue;
      const file = index.getFile(path);
      if (!file?.hash || index.getSummary(file.hash)) continue;
      if ((attempts.get(file.hash) ?? 0) >= MAX_ATTEMPTS) continue;
      const abs = safeJoin(host.artifactsDir, path);
      const raw = abs ? await readFile(abs, 'utf8').catch(() => null) : null;
      if (!raw) continue;
      // The screenshots section is image links, not something to summarize.
      const body = parseFrontmatter(raw)
        .body.replace(/\n## How the page looked[\s\S]*$/, '')
        .trim();
      if (body.length < 80) continue;
      files++;
      try {
        const completion = resolveEnrichCompletion(
          await deps.summarize(
            buildSummaryPrompt(file, body),
            `Summarizing the saved page ${path}`,
          ),
          deps,
        );
        const summary = completion.text.trim();
        if (!summary || completion.deferred) {
          failed(file.hash);
          continue;
        }
        index.upsertSummary({
          contentHash: file.hash,
          filePath: path,
          summaryMd: summary,
          model: completion.model ?? deps.model ?? 'unknown',
          ...(completion.provenance ? { provenance: completion.provenance } : {}),
        });
        summaries.push({ path, summary });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        failed(file.hash);
      }
    }
    return { files, summaries };
  } finally {
    index.close();
  }
}
