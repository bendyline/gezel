import { corpusDirFor } from '../connectors/manager.js';
import {
  type CraftbookSuggestionDeps,
  listGlobalCraftbookCandidates,
} from '../craftbook/suggest.js';
import type { HandboekEngine } from '../handboek/engine.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { mailCatalogEntries } from '../mail/search-catalog.js';
import type { ExtraSearchCatalogs } from './search-service.js';

export interface ExtraSearchCatalogDeps extends CraftbookSuggestionDeps {
  handboek: HandboekEngine;
  contentIndex: ContentIndex;
}

/**
 * Late-boot name-catalog arms for the titlebar search: Handboek articles
 * (previously the least findable content in the app) plus globally invokable
 * craftbooks and mail. Tasks ride the Store directly inside SearchService.
 */
export function buildExtraSearchCatalogs(deps: ExtraSearchCatalogDeps): ExtraSearchCatalogs {
  const { handboek, store, contentIndex } = deps;
  return {
    handboekEntries: async () => {
      const toc = await handboek.toc();
      return toc.areas.flatMap((area) =>
        area.entries.map((entry) => ({
          id: entry.id,
          title: entry.title,
          keywords: [area.title, ...(entry.summary ? [entry.summary] : [])],
        })),
      );
    },
    craftbookEntries: async () =>
      (await listGlobalCraftbookCandidates(deps)).map((c) => ({
        id: c.id,
        name: c.name,
        source: c.source,
      })),
    // Mail messages by subject/sender: derived entirely from the connector
    // corpus paths in the artifacts index — zero file reads. Bodies are
    // already searchable through the artifacts content arm; this is the
    // mail-shaped quick-open layer on top.
    mailEntries: async () => {
      const projects = await store.listProjects().catch(() => []);
      const all: Awaited<ReturnType<NonNullable<ExtraSearchCatalogs['mailEntries']>>> = [];
      for (const summary of projects) {
        const project = await store.getProject(summary.id).catch(() => null);
        const bindings = project?.connectors ?? [];
        const corpusDirs = bindings
          .filter((b) => b.type.startsWith('mail-'))
          .map((b) => corpusDirFor(bindings, b));
        if (corpusDirs.length === 0) continue;
        const paths = await contentIndex.listArtifactIndexFiles(summary.id).catch(() => []);
        all.push(...mailCatalogEntries(summary.id, corpusDirs, paths));
      }
      return all;
    },
  };
}
