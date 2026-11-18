/**
 * The `web-page` rule's connector: a web address in a draft is saved by the
 * website connector, and a saved page the person names is handed to their
 * turn as a summary, the passages that fit, and the path of the local copy.
 * Saving is the person's (Send, or Save now); the turn only reads the copy.
 */

import { readFile } from 'node:fs/promises';
import {
  type ProjectDetail,
  type PromptConnectorCandidate,
  type PromptInclusion,
  WEB_PAGE_RULE,
  type WebPageEntry,
} from '@bendyline/gezel';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import type { WebsiteService } from '../connectors/natives/website-service.js';
import type { Store } from '../fs/store.js';
import { parseFrontmatter } from '../index-store/frontmatter.js';
import { type PageDigest, digestPage } from './page-digest.js';
import type { PromptConnectorResolver, TurnInclusion } from './service.js';

const isSaved = (entry: WebPageEntry | null): entry is WebPageEntry & { path: string } =>
  Boolean(entry?.path) && entry?.state !== 'gone';

/** Tools that open a saved page, best first. Named in a turn only when wired. */
const READ_TOOLS = ['read_web_page', 'read_artifact'] as const;

/** Budget for the synopsis shown in the strip, where no question exists yet. */
const ACCEPT_DIGEST_CHARS = 2_000;

export function webPageResolver(deps: {
  websites: Pick<WebsiteService, 'find' | 'savePage' | 'savable'>;
  store: Pick<Store, 'projectArtifactsDir'>;
}): PromptConnectorResolver {
  const readRecord = async (
    projectId: string,
    path: string,
  ): Promise<{ data: Record<string, string>; body: string } | null> => {
    const abs = safeJoin(deps.store.projectArtifactsDir(projectId), path);
    const raw = abs ? await readFile(abs, 'utf8').catch(() => null) : null;
    return raw ? parseFrontmatter(raw) : null;
  };

  const digestOf = async (
    projectId: string,
    entry: WebPageEntry & { path: string },
    query: string,
    budgetChars: number,
  ): Promise<PageDigest | null> => {
    const record = await readRecord(projectId, entry.path);
    if (!record) return null;
    return digestPage({
      markdown: record.body,
      ...(record.data.description ? { description: record.data.description } : {}),
      ...(entry.summary ? { synopsis: entry.summary } : {}),
      query,
      budgetChars,
    });
  };

  const inclusionOf = (
    candidate: PromptConnectorCandidate,
    entry: WebPageEntry,
    digest: PageDigest | null,
  ): PromptInclusion => ({
    connectorType: candidate.connectorType,
    subject: candidate.subject,
    label: candidate.label,
    ...(entry.title ? { title: entry.title } : {}),
    ...(isSaved(entry)
      ? { path: entry.path, ...(digest?.summary ? { summary: digest.summary } : {}) }
      : { reason: entry.reason ?? 'The page could not be saved.' }),
  });

  return {
    rule: WEB_PAGE_RULE.id,

    async open(project, candidates) {
      const open: PromptConnectorCandidate[] = [];
      for (const candidate of candidates) {
        if (!deps.websites.savable(candidate.subject)) continue;
        const entry = await deps.websites.find(project, candidate.subject).catch(() => null);
        if (!isSaved(entry)) open.push(candidate);
      }
      return open;
    },

    async accept(project, candidate) {
      const { page } = await deps.websites.savePage(project, candidate.subject);
      const digest = isSaved(page)
        ? await digestOf(project.id, page, '', ACCEPT_DIGEST_CHARS)
        : null;
      return inclusionOf(candidate, page, digest);
    },

    async turnContext(project: ProjectDetail, candidates, opts) {
      const known: { candidate: PromptConnectorCandidate; entry: WebPageEntry }[] = [];
      for (const candidate of candidates) {
        const entry = await deps.websites.find(project, candidate.subject).catch(() => null);
        if (entry && (isSaved(entry) || entry.state === 'failed' || entry.state === 'blocked')) {
          known.push({ candidate, entry });
        }
      }
      const savedCount = known.filter((k) => isSaved(k.entry)).length;
      const perPage = Math.floor(opts.budgetChars / Math.max(1, savedCount));
      const readTool = READ_TOOLS.find((name) => opts.toolNames?.has(name));
      const out: TurnInclusion[] = [];
      for (const { candidate, entry } of known) {
        if (!isSaved(entry)) {
          const reason = entry.reason ?? 'The page could not be saved.';
          out.push({
            inclusion: inclusionOf(candidate, entry, null),
            text: [
              `Address: ${entry.url}`,
              `No saved copy: ${reason}`,
              'Tell the person this page could not be read. Do not guess what it says.',
            ].join('\n'),
          });
          continue;
        }
        const digest = await digestOf(project.id, entry, opts.query, perPage);
        if (!digest) continue;
        const title = entry.title ?? candidate.label;
        const cited = opts.cite?.(digest.text, { title, ref: entry.url });
        const savedOn = entry.capturedAt ? `, saved ${entry.capturedAt.slice(0, 10)}` : '';
        const readHint =
          readTool === 'read_web_page'
            ? '; read_web_page with this address returns all of it'
            : readTool === 'read_artifact'
              ? '; read_artifact with this path returns all of it'
              : '';
        const from =
          digest.summarySource === 'synopsis'
            ? 'Summary'
            : digest.summarySource === 'description'
              ? "Summary (the page's own description)"
              : 'Summary (its opening lines)';
        out.push({
          inclusion: inclusionOf(candidate, entry, digest),
          text: [
            `${cited ? `[${cited}] ` : ''}Page: ${title}`,
            `Address: ${entry.url}`,
            `Saved copy: ${entry.path} in this project's artifacts${savedOn}${readHint}`,
            `${from}: ${digest.summary}`,
            digest.whole
              ? `Text of the page (${digest.words} words):`
              : `Passages from the page (${digest.shownWords} of ${digest.words} words; […] marks text left out):`,
            digest.text,
          ].join('\n'),
        });
      }
      return out;
    },
  };
}
