import { SCORECARD } from '@bendyline/gezel';
import {
  type ScorecardRoundNote,
  renderScorecardRoundPages,
  scorecardRoundPageId,
} from '@bendyline/gezel-service/handboek';
import { MODELS_AND_TESTING, type SiteCatalogPage } from './handboek-site-catalog.js';

/**
 * One site page per model scorecard round, at `model-scorecard/<run id>/`.
 *
 * The scorecard article lists the rounds under its all-results table and
 * links each one here; this page holds what the article used to stack for
 * every round at once — the stamp, the per-task-set tables, the task
 * measurements — followed by any hand-written notes on it. A note that
 * covers several rounds (one campaign split into segments) appears on each
 * of their pages, with links between them.
 *
 * Generated rather than authored, so a new sweep gets its page from the
 * shard alone; a note is the only thing a person adds by hand. Not listed
 * in the sidebar, like the per-model pages: the article is the way in.
 */
export function scorecardRoundSitePages(notes: readonly ScorecardRoundNote[]): SiteCatalogPage[] {
  const pages = renderScorecardRoundPages(SCORECARD);
  const titles = new Map(pages.map((page) => [page.runId, page.title]));
  return pages.map((page) => {
    const covering = notes.filter((note) => note.runs.includes(page.runId));
    const markdown = [
      `# ${page.title}`,
      '',
      `${page.summary} Every round is listed in the [model scorecard](../model-scorecard.md), with its results side by side in one table.`,
      '',
      page.html,
      ...covering.flatMap((note) => {
        const siblings = note.runs.filter((id) => id !== page.runId && titles.has(id));
        return [
          '',
          `## ${note.title}`,
          '',
          ...(siblings.length > 0
            ? [
                `This note also covers ${siblings
                  .map((id) => `[${titles.get(id)}](../${id}/)`)
                  .join(', ')}.`,
                '',
              ]
            : []),
          note.body,
        ];
      }),
      '',
    ].join('\n');
    return {
      entry: {
        id: scorecardRoundPageId(page.runId),
        title: page.title,
        area: 'technical' as const,
        order: 200,
        summary: page.summary,
        generated: true,
        subcategory: MODELS_AND_TESTING,
      },
      markdown,
      listed: false,
    };
  });
}
